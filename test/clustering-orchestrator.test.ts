import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  evidence,
  evidenceEmbeddings,
  insightClusters,
  users,
} from "@/db/schema";
import { runClustering } from "@/lib/evidence/clustering/orchestrator";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Dispatch tests for the orchestrator. Verifies design §7:
    existingClusters == 0 AND evidence <= 50 → mode = "full"
    everything else                          → mode = "incremental"

  Mocks the LLM via vi.mock so runs are deterministic.
*/

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

describe.skipIf(!hasTestDb)("runClustering dispatch (DB-backed, mocked LLM)", () => {
  let handle: TestDbHandle;
  let accountA: string;

  beforeAll(async () => {
    handle = await setupTestDb("clustering_orchestrator");
    accountA = await seedAccount(handle, "a-orch@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("cold start (0 clusters + 3 evidence) → mode: full", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      await insertEvidenceWithEmbedding(tx, accountA, "1", vec(1));
      await insertEvidenceWithEmbedding(tx, accountA, "2", vec(0, 1));
      await insertEvidenceWithEmbedding(tx, accountA, "3", vec(0, 0, 1));

      mockComplete.mockClear();
      // Full clustering uses synthesis-cluster prompt → returns { clusters: [...] }
      mockComplete.mockResolvedValueOnce({
        raw: "",
        output: {
          clusters: [
            {
              title: "cluster a",
              description: "desc",
              severity: "medium",
              evidenceLabels: ["E1", "E2", "E3"],
            },
          ],
        },
      });

      const result = await runClustering({ db: tx, accountId: accountA });
      expect(result.mode).toBe("full");
      expect(result.clustersCreated).toBeGreaterThan(0);
      expect(mockComplete).toHaveBeenCalledOnce();
    });
  });

  it("warm (existing clusters + new evidence) → mode: incremental", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);

      // Seed 1 existing cluster with a centroid + attached evidence.
      const cluster = await insertCluster(tx, accountA, "existing");
      await tx
        .update(insightClusters)
        .set({ centroid: vec(1, 0) })
        .where(eq(insightClusters.id, cluster));
      const attached = await insertEvidenceWithEmbedding(tx, accountA, "a", vec(1, 0));
      await tx.execute(
        sql`INSERT INTO evidence_to_cluster (evidence_id, cluster_id, relevance_score) VALUES (${attached}::uuid, ${cluster}::uuid, 1)`,
      );

      // New candidate with matching embedding — HIGH_CONF path, no LLM call.
      await insertEvidenceWithEmbedding(tx, accountA, "b", vec(1, 0));

      mockComplete.mockClear();
      const result = await runClustering({ db: tx, accountId: accountA });
      expect(result.mode).toBe("incremental");
      // High-conf path skips the LLM entirely.
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  it("orphans-only (freq=0 clusters + new evidence) → swept + mode: full", async () => {
    // Regression: deleting all evidence leaves clusters with frequency=0
    // and centroid=null. Re-uploading fresh evidence and clicking Generate
    // previously routed to incremental (because the orphan count was >0),
    // which then built an LLM prompt with empty <evidence> blocks and
    // either failed silently or returned an empty plan. The orchestrator
    // must now sweep orphans up front and cold-start over the new corpus.
    const accountB = await seedAccount(handle, "b-orph@test.dev");

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountB);

      // Seed 2 orphan clusters (freq=0, centroid=null, not tombstoned) —
      // exactly what evidence.delete leaves behind after recompute.
      await insertCluster(tx, accountB, "orphan-1");
      await insertCluster(tx, accountB, "orphan-2");

      // Upload 3 fresh evidence pieces (no edges to the orphans).
      await insertEvidenceWithEmbedding(tx, accountB, "n1", vec(1));
      await insertEvidenceWithEmbedding(tx, accountB, "n2", vec(0, 1));
      await insertEvidenceWithEmbedding(tx, accountB, "n3", vec(0, 0, 1));

      mockComplete.mockClear();
      mockComplete.mockResolvedValueOnce({
        raw: "",
        output: {
          clusters: [
            {
              title: "fresh",
              description: "desc",
              severity: "medium",
              evidenceLabels: ["E1", "E2", "E3"],
            },
          ],
        },
      });

      const result = await runClustering({ db: tx, accountId: accountB });
      expect(result.mode).toBe("full");
      expect(result.clustersCreated).toBeGreaterThan(0);
      expect(mockComplete).toHaveBeenCalledOnce();

      // Orphans must be gone after the sweep + cold-start wipe.
      const remaining = await tx
        .select({ id: insightClusters.id, title: insightClusters.title })
        .from(insightClusters)
        .where(eq(insightClusters.accountId, accountB));
      const titles = remaining.map((r) => r.title);
      expect(titles).not.toContain("orphan-1");
      expect(titles).not.toContain("orphan-2");
    });
  });
});

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
      description: "desc",
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
  await tx.insert(evidenceEmbeddings).values({
    evidenceId: row.id,
    embedding,
    model: "text-embedding-3-small",
  });
  return row.id as string;
}
