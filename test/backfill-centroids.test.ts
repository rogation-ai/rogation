import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  evidence,
  evidenceEmbeddings,
  evidenceToCluster,
  insightClusters,
  users,
} from "@/db/schema";
import { backfillOne } from "@/scripts/backfill-centroids";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Lane F centroid backfill tests. DB-gated.

  Covers:
    - Cluster with 3 embeddings → centroid = mean, frequency = 3
    - Cluster with 0 attached evidence → centroid stays NULL, frequency = 0
    - Cluster that already has a centroid → idempotent (re-run matches)
*/

describe.skipIf(!hasTestDb)("backfillOne (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountA: string;

  beforeAll(async () => {
    handle = await setupTestDb("backfill_centroids");
    accountA = await seedAccount(handle, "a-backfill@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`
      TRUNCATE TABLE evidence_to_cluster, evidence_embedding,
        evidence, insight_cluster RESTART IDENTITY CASCADE
    `);
  });

  it("cluster with 3 attached embeddings → centroid equals the mean, frequency = 3", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);

      const clusterId = await insertCluster(tx, accountA, "null-centroid");
      const ids = [
        await insertEvidenceWithEmbedding(tx, accountA, "a", vec(1, 0, 0)),
        await insertEvidenceWithEmbedding(tx, accountA, "b", vec(0, 1, 0)),
        await insertEvidenceWithEmbedding(tx, accountA, "c", vec(0, 0, 1)),
      ];
      for (const id of ids) {
        await tx.insert(evidenceToCluster).values({
          evidenceId: id,
          clusterId,
          relevanceScore: 1,
        });
      }

      // Confirm centroid starts NULL.
      const [before] = await tx
        .select({ centroid: insightClusters.centroid })
        .from(insightClusters)
        .where(eq(insightClusters.id, clusterId))
        .limit(1);
      expect(before?.centroid).toBeNull();

      const outcome = await backfillOne(tx, clusterId, accountA);
      expect(outcome).toBe("updated");

      const [after] = await tx
        .select({
          centroid: insightClusters.centroid,
          frequency: insightClusters.frequency,
        })
        .from(insightClusters)
        .where(eq(insightClusters.id, clusterId))
        .limit(1);
      expect(after?.frequency).toBe(3);
      // Mean of the three one-hot vectors = (1/3, 1/3, 1/3, 0, 0, ...).
      const c = after?.centroid as number[] | null;
      expect(c).not.toBeNull();
      expect(c![0]!).toBeCloseTo(1 / 3, 5);
      expect(c![1]!).toBeCloseTo(1 / 3, 5);
      expect(c![2]!).toBeCloseTo(1 / 3, 5);
      expect(c![3]!).toBe(0);
    });
  });

  it("cluster with zero attached evidence → centroid stays NULL, frequency = 0", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);

      const clusterId = await insertCluster(tx, accountA, "empty");
      const outcome = await backfillOne(tx, clusterId, accountA);
      expect(outcome).toBe("empty");

      const [after] = await tx
        .select({
          centroid: insightClusters.centroid,
          frequency: insightClusters.frequency,
        })
        .from(insightClusters)
        .where(eq(insightClusters.id, clusterId))
        .limit(1);
      expect(after?.centroid).toBeNull();
      expect(after?.frequency).toBe(0);
    });
  });

  it("idempotent: second backfill on same cluster produces the same centroid value", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);

      const clusterId = await insertCluster(tx, accountA, "idempotent");
      const e1 = await insertEvidenceWithEmbedding(tx, accountA, "e1", vec(1, 0));
      const e2 = await insertEvidenceWithEmbedding(tx, accountA, "e2", vec(0, 1));
      for (const id of [e1, e2]) {
        await tx.insert(evidenceToCluster).values({
          evidenceId: id,
          clusterId,
          relevanceScore: 1,
        });
      }

      await backfillOne(tx, clusterId, accountA);
      const [first] = await tx
        .select({ centroid: insightClusters.centroid })
        .from(insightClusters)
        .where(eq(insightClusters.id, clusterId))
        .limit(1);

      await backfillOne(tx, clusterId, accountA);
      const [second] = await tx
        .select({ centroid: insightClusters.centroid })
        .from(insightClusters)
        .where(eq(insightClusters.id, clusterId))
        .limit(1);

      expect(second?.centroid).toEqual(first?.centroid);
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

async function seedAccount(
  handle: TestDbHandle,
  email: string,
): Promise<string> {
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
      // Intentionally no centroid — simulates pre-Lane-D rows.
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
