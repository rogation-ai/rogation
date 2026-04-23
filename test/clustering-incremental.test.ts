import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  evidence,
  evidenceEmbeddings,
  evidenceToCluster,
  insightClusters,
  users,
} from "@/db/schema";
import { runIncrementalClustering } from "@/lib/evidence/clustering/incremental";
import { ClusteringError } from "@/lib/evidence/clustering/errors";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Incremental path integration tests. Mocks the LLM via vi.mock so
  the tests don't need ANTHROPIC_API_KEY. Focus:
    - HIGH_CONF candidate auto-attaches, never hits the LLM
    - Missing-embedding → embeddings_pending error
    - Uncertain + NEW candidates go to LLM, plan merges correctly
    - Auto-attach KEEP dedupes with LLM-emitted KEEP on same cluster
*/

// Mock the LLM router's complete() so tests are deterministic.
const mockComplete = vi.fn();
vi.mock("@/lib/llm/router", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm/router")>(
    "@/lib/llm/router",
  );
  return {
    ...actual,
    complete: (...args: unknown[]) => mockComplete(...args),
  };
});

describe.skipIf(!hasTestDb)(
  "runIncrementalClustering (DB-backed, mocked LLM)",
  () => {
    let handle: TestDbHandle;
    let accountA: string;

    beforeAll(async () => {
      handle = await setupTestDb("clustering_incremental");
      accountA = await seedAccount(handle, "a-inc@test.dev");
    });

    afterAll(async () => {
      await handle?.teardown();
    });

    // Each test commits its writes, so clean cluster+evidence state between
    // tests or leftover rows pollute sibling tests (e.g. a no-embedding row
    // from one test triggers embeddings_pending in another).
    beforeEach(async () => {
      await handle.db.execute(sql`
        TRUNCATE TABLE evidence_to_cluster, evidence_embedding,
          evidence, insight_cluster RESTART IDENTITY CASCADE
      `);
    });

    it("HIGH_CONF candidate auto-attaches without calling the LLM", async () => {
      await handle.db.transaction(async (tx) => {
        await bind(tx, accountA);

        // Seed one cluster with centroid (1,0,...). Candidate has an
        // identical vector → cosine sim = 1.0, well above HIGH_CONF.
        const cluster = await insertCluster(tx, accountA, "c1");
        await tx
          .update(insightClusters)
          .set({ centroid: vec(1, 0) })
          .where(eq(insightClusters.id, cluster));

        // Attach one piece of evidence to the cluster so it's not
        // an empty cluster.
        const attached = await insertEvidenceWithEmbedding(
          tx,
          accountA,
          "attached",
          vec(1, 0),
        );
        await tx
          .insert(evidenceToCluster)
          .values({ evidenceId: attached, clusterId: cluster, relevanceScore: 1 });

        // New candidate with the same embedding → HIGH_CONF.
        const cand = await insertEvidenceWithEmbedding(
          tx,
          accountA,
          "candidate",
          vec(1, 0),
        );

        mockComplete.mockClear();
        const result = await runIncrementalClustering({
          db: tx,
          accountId: accountA,
        });

        expect(mockComplete).not.toHaveBeenCalled();
        expect(result.autoAttached).toBe(1);
        expect(result.sentToLlm).toBe(0);
        expect(result.plan.keeps).toHaveLength(1);
        expect(result.plan.keeps[0]!.clusterId).toBe(cluster);
        expect(result.plan.keeps[0]!.attachEvidenceIds).toEqual([cand]);
      });
    });

    it("throws embeddings_pending when any evidence lacks an embedding", async () => {
      await handle.db.transaction(async (tx) => {
        await bind(tx, accountA);

        const cluster = await insertCluster(tx, accountA, "with-centroid");
        await tx
          .update(insightClusters)
          .set({ centroid: vec(1) })
          .where(eq(insightClusters.id, cluster));

        // Evidence row with NO embedding — simulates still-embedding state.
        await insertEvidenceNoEmbedding(tx, accountA, "pending");

        try {
          await runIncrementalClustering({
            db: tx,
            accountId: accountA,
          });
          expect.fail("expected ClusteringError");
        } catch (e) {
          expect(e).toBeInstanceOf(ClusteringError);
          expect((e as ClusteringError).code).toBe("embeddings_pending");
        }
      });
    });

    it("uncertain candidate goes to LLM, plan includes KNN-derived KEEP", async () => {
      await handle.db.transaction(async (tx) => {
        await bind(tx, accountA);

        const cluster = await insertCluster(tx, accountA, "c-uncertain");
        await tx
          .update(insightClusters)
          .set({ centroid: vec(1, 0) })
          .where(eq(insightClusters.id, cluster));

        // Attach some evidence so the cluster has frequency > 0.
        const attached = await insertEvidenceWithEmbedding(
          tx,
          accountA,
          "attached-u",
          vec(1, 0),
        );
        await tx
          .insert(evidenceToCluster)
          .values({ evidenceId: attached, clusterId: cluster, relevanceScore: 1 });

        // Candidate with embedding that lands in the uncertain band.
        // vec(0.7, 0.7) vs (1, 0) = ~0.7 cosine sim, between LOW=0.65 and HIGH=0.82.
        const cand = await insertEvidenceWithEmbedding(
          tx,
          accountA,
          "uncertain-cand",
          vec(0.7, 0.7),
        );

        // Capture the input the LLM would see to verify the prompt shape.
        mockComplete.mockClear();
        mockComplete.mockResolvedValueOnce({
          raw: "",
          output: {
            actions: [
              {
                type: "KEEP",
                clusterLabel: "C1",
                newTitle: null,
                newDescription: null,
                attachEvidence: ["E2"], // candidate's label
              },
            ],
          },
        });

        const result = await runIncrementalClustering({
          db: tx,
          accountId: accountA,
        });

        expect(mockComplete).toHaveBeenCalledOnce();
        expect(result.sentToLlm).toBe(1);
        expect(result.autoAttached).toBe(0);
        // Plan from the LLM: KEEP C1 with E2 attached.
        expect(result.plan.keeps).toHaveLength(1);
        expect(result.plan.keeps[0]!.clusterId).toBe(cluster);
        expect(result.plan.keeps[0]!.attachEvidenceIds).toEqual([cand]);
      });
    });

    it("merges HIGH_CONF auto-attach with LLM KEEP on same cluster", async () => {
      await handle.db.transaction(async (tx) => {
        await bind(tx, accountA);

        const cluster = await insertCluster(tx, accountA, "c-merge-both");
        await tx
          .update(insightClusters)
          .set({ centroid: vec(1, 0) })
          .where(eq(insightClusters.id, cluster));

        const attached = await insertEvidenceWithEmbedding(
          tx,
          accountA,
          "attached-m",
          vec(1, 0),
        );
        await tx
          .insert(evidenceToCluster)
          .values({ evidenceId: attached, clusterId: cluster, relevanceScore: 1 });

        // One HIGH_CONF candidate (auto-attach) + one uncertain (goes to LLM).
        const high = await insertEvidenceWithEmbedding(
          tx,
          accountA,
          "high",
          vec(1, 0),
        );
        const uncertain = await insertEvidenceWithEmbedding(
          tx,
          accountA,
          "unc",
          vec(0.7, 0.7),
        );

        mockComplete.mockClear();
        mockComplete.mockResolvedValueOnce({
          raw: "",
          output: {
            actions: [
              {
                type: "KEEP",
                clusterLabel: "C1",
                newTitle: null,
                newDescription: null,
                // LLM attaches the uncertain candidate.
                attachEvidence: ["E2"],
              },
            ],
          },
        });

        const result = await runIncrementalClustering({
          db: tx,
          accountId: accountA,
        });

        expect(result.autoAttached).toBe(1);
        expect(result.sentToLlm).toBe(1);
        expect(result.plan.keeps).toHaveLength(1);
        // Both candidate evidence ids present on the merged KEEP.
        const ids = result.plan.keeps[0]!.attachEvidenceIds.slice().sort();
        expect(ids).toEqual([high, uncertain].sort());
      });
    });
  },
);

/* ----------------------------- helpers ----------------------------- */

function vec(...vals: number[]): number[] {
  const v = new Array(1536).fill(0);
  for (let i = 0; i < vals.length; i++) v[i] = vals[i]!;
  return v;
}

async function bind(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  accountId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.current_account_id', ${accountId}, true)`,
  );
}

async function seedAccount(handle: TestDbHandle, email: string): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "account" DISABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [account] = await tx
      .insert(accounts)
      .values({ plan: "free" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed account");
    await tx.insert(users).values({
      accountId: account.id,
      clerkUserId: `clerk_${account.id}`,
      email,
    });
    await tx.execute(sql`ALTER TABLE "account" ENABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" ENABLE ROW LEVEL SECURITY`);
    return account.id;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertCluster(tx: any, accountId: string, title: string): Promise<string> {
  const [row] = await tx
    .insert(insightClusters)
    .values({
      accountId,
      title,
      description: `${title} desc`,
      severity: "medium",
      frequency: 0,
      promptHash: "testhash",
    })
    .returning({ id: insightClusters.id });
  if (!row) throw new Error("insertCluster");
  return row.id as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertEvidenceWithEmbedding(
  tx: any,
  accountId: string,
  marker: string,
  embedding: number[],
): Promise<string> {
  const id = await insertEvidenceNoEmbedding(tx, accountId, marker);
  await tx.insert(evidenceEmbeddings).values({
    evidenceId: id,
    embedding,
    model: "text-embedding-3-small",
  });
  return id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertEvidenceNoEmbedding(
  tx: any,
  accountId: string,
  marker: string,
): Promise<string> {
  const [row] = await tx
    .insert(evidence)
    .values({
      accountId,
      sourceType: "upload_text",
      sourceRef: `src_${marker}_${Date.now()}_${Math.random()}`,
      content: `content_${marker}`,
      contentHash: `hash_${marker}_${Date.now()}_${Math.random()}`,
    })
    .returning({ id: evidence.id });
  if (!row) throw new Error("insertEvidence");
  return row.id as string;
}
