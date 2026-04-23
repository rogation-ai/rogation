import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  evidence,
  evidenceEmbeddings,
  insightRuns,
  users,
} from "@/db/schema";
import { runClusterEvidence } from "@/lib/inngest/functions/cluster-evidence";
import { ClusteringError } from "@/lib/evidence/clustering/errors";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Worker integration tests. Exercises the pure handler (not the
  Inngest wrapper) against the real DB + mocked LLM. Validates
  insight_run status transitions on both success and failure paths.
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

describe.skipIf(!hasTestDb)("cluster-evidence worker (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountA: string;

  beforeAll(async () => {
    handle = await setupTestDb("inngest_cluster");
    accountA = await seedAccount(handle, "a-worker@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("happy path: writes running → done transitions with metrics", async () => {
    // Seed evidence so the cold-start path fires.
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      await insertEvidenceWithEmbedding(tx, accountA, "1", vec(1));
      await insertEvidenceWithEmbedding(tx, accountA, "2", vec(0, 1));
    });

    // Pre-create insight_run row (what Lane E's tRPC will do).
    const runId = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const [row] = await tx
        .insert(insightRuns)
        .values({
          accountId: accountA,
          status: "pending",
          mode: "full",
        })
        .returning({ id: insightRuns.id });
      if (!row) throw new Error("insight_run insert failed");
      return row.id;
    });

    mockComplete.mockClear();
    mockComplete.mockResolvedValueOnce({
      raw: "",
      output: {
        clusters: [
          {
            title: "c",
            description: "d",
            severity: "medium",
            evidenceLabels: ["E1", "E2"],
          },
        ],
      },
    });

    const result = await runClusterEvidence({ runId, accountId: accountA });
    expect(result.status).toBe("done");

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const [run] = await tx
        .select()
        .from(insightRuns)
        .where(eq(insightRuns.id, runId));
      expect(run?.status).toBe("done");
      expect(run?.mode).toBe("full");
      expect(run?.clustersCreated).toBeGreaterThan(0);
      expect(run?.evidenceUsed).toBeGreaterThan(0);
      expect(run?.durationMs).toBeGreaterThanOrEqual(0);
      expect(run?.finishedAt).toBeTruthy();
      expect(run?.error).toBeNull();
    });
  });

  it("ClusteringError propagates to insight_run.error as the code", async () => {
    // Seed evidence but no embedding on one row → embeddings_pending.
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      // Wipe account state first.
      await tx.execute(sql`TRUNCATE evidence RESTART IDENTITY CASCADE`);
      await insertEvidenceWithEmbedding(tx, accountA, "x", vec(1));
      await insertEvidenceNoEmbedding(tx, accountA, "pending");
      // Seed one existing cluster with a centroid so the orchestrator
      // picks the incremental path (which enforces embeddings).
      await insertClusterWithCentroid(tx, accountA, vec(1));
    });

    const runId = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const [row] = await tx
        .insert(insightRuns)
        .values({
          accountId: accountA,
          status: "pending",
          mode: "incremental",
        })
        .returning({ id: insightRuns.id });
      if (!row) throw new Error("insight_run insert failed");
      return row.id;
    });

    const result = await runClusterEvidence({ runId, accountId: accountA });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("embeddings_pending");

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const [run] = await tx
        .select()
        .from(insightRuns)
        .where(eq(insightRuns.id, runId));
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("embeddings_pending");
      expect(run?.finishedAt).toBeTruthy();
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertClusterWithCentroid(
  tx: any,
  accountId: string,
  centroid: number[],
): Promise<string> {
  const { insightClusters } = await import("@/db/schema");
  const [row] = await tx
    .insert(insightClusters)
    .values({
      accountId,
      title: "existing",
      description: "d",
      severity: "medium",
      frequency: 0,
      promptHash: "h",
      centroid,
    })
    .returning({ id: insightClusters.id });
  if (!row) throw new Error("insertCluster");
  return row.id as string;
}
