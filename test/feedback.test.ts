import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  entityFeedback,
  insightClusters,
  users,
} from "@/db/schema";
import {
  aggregateByPrompt,
  myVotes,
  removeVote,
  voteOnEntity,
} from "@/lib/evidence/feedback";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  DB-backed tests for the feedback loop.

  Locks down the invariants that close the eval loop:

  1. Vote captures prompt_hash from the target row server-side. The
     client never sends it — a client passing a fake hash must not
     end up in the aggregate.

  2. UPSERT semantics: re-voting the same entity by the same user
     replaces, never duplicates. Migration 0003 adds the partial
     unique index that backs this.

  3. RLS: attempting to vote on another account's entity fails
     (lookupPromptHash returns null, we throw not-found).

  4. aggregateByPrompt groups correctly by prompt_hash.

  Skip if no TEST_DATABASE_URL. The CI service container sets it.
*/

describe.skipIf(!hasTestDb)("feedback (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountA: string;
  let accountB: string;
  let userA: string;
  let userB: string;
  let clusterAId: string;
  let clusterBId: string;
  const PROMPT_HASH_A = "prompthash_cluster_a_abc123";
  const PROMPT_HASH_B = "prompthash_cluster_b_def456";

  beforeAll(async () => {
    handle = await setupTestDb("feedback");
    accountA = await seedAccount(handle, "a-fb@test.dev");
    accountB = await seedAccount(handle, "b-fb@test.dev");
    userA = await readFirstUser(handle, accountA);
    userB = await readFirstUser(handle, accountB);

    // Seed one cluster per account with a known prompt_hash so the
    // vote helper has something to look up + capture.
    clusterAId = await seedCluster(handle, accountA, PROMPT_HASH_A);
    clusterBId = await seedCluster(handle, accountB, PROMPT_HASH_B);
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("captures prompt_hash from the target row on vote", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const result = await voteOnEntity(
        { db: tx, accountId: accountA, userId: userA },
        { entityType: "insight_cluster", entityId: clusterAId, rating: "up" },
      );
      expect(result.promptHash).toBe(PROMPT_HASH_A);
    });
  });

  it("UPSERTs when the same user re-votes the same entity", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      // First: up vote.
      await voteOnEntity(
        { db: tx, accountId: accountA, userId: userA },
        { entityType: "insight_cluster", entityId: clusterAId, rating: "up" },
      );
      // Second: change to down.
      await voteOnEntity(
        { db: tx, accountId: accountA, userId: userA },
        { entityType: "insight_cluster", entityId: clusterAId, rating: "down" },
      );
      const rows = await tx
        .select({ id: entityFeedback.id, rating: entityFeedback.rating })
        .from(entityFeedback)
        .where(eq(entityFeedback.entityId, clusterAId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rating).toBe("down");
    });
  });

  it("RLS blocks voting on another account's entity", async () => {
    // Account A tries to vote on Account B's cluster. lookupPromptHash
    // sees zero rows (RLS filter) and voteOnEntity throws.
    await expect(
      handle.db.transaction(async (tx) => {
        await bind(tx, accountA);
        await voteOnEntity(
          { db: tx, accountId: accountA, userId: userA },
          {
            entityType: "insight_cluster",
            entityId: clusterBId,
            rating: "up",
          },
        );
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it("myVotes batch-reads the current user's votes", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      // Re-seed vote (prior tests may have cleared it).
      await voteOnEntity(
        { db: tx, accountId: accountA, userId: userA },
        { entityType: "insight_cluster", entityId: clusterAId, rating: "up" },
      );
      const votes = await myVotes(
        { db: tx, accountId: accountA, userId: userA },
        "insight_cluster",
        [clusterAId, "00000000-0000-0000-0000-000000000fff"],
      );
      expect(votes).toHaveLength(1);
      expect(votes[0]?.entityId).toBe(clusterAId);
      expect(votes[0]?.rating).toBe("up");
    });
  });

  it("removeVote deletes the user's vote", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      await voteOnEntity(
        { db: tx, accountId: accountA, userId: userA },
        { entityType: "insight_cluster", entityId: clusterAId, rating: "down" },
      );
      const { removed } = await removeVote(
        { db: tx, accountId: accountA, userId: userA },
        "insight_cluster",
        clusterAId,
      );
      expect(removed).toBe(true);

      const rows = await tx
        .select({ id: entityFeedback.id })
        .from(entityFeedback)
        .where(eq(entityFeedback.entityId, clusterAId));
      expect(rows).toHaveLength(0);
    });
  });

  it("aggregateByPrompt groups votes per prompt_hash", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      await voteOnEntity(
        { db: tx, accountId: accountA, userId: userA },
        { entityType: "insight_cluster", entityId: clusterAId, rating: "up" },
      );
      const agg = await aggregateByPrompt({
        db: tx,
        accountId: accountA,
        userId: userA,
      });
      const row = agg.find((r) => r.promptHash === PROMPT_HASH_A);
      expect(row).toBeTruthy();
      if (!row) return;
      expect(row.total).toBeGreaterThanOrEqual(1);
      expect(row.ups + row.downs).toBe(row.total);
    });
  });
});

/* ----------------------------- helpers ----------------------------- */

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
    if (!account) throw new Error("seed account insert failed");
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

async function readFirstUser(
  handle: TestDbHandle,
  accountId: string,
): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.accountId, accountId))
      .limit(1);
    await tx.execute(sql`ALTER TABLE "user" ENABLE ROW LEVEL SECURITY`);
    if (!row) throw new Error("seed user missing");
    return row.id;
  });
}

async function seedCluster(
  handle: TestDbHandle,
  accountId: string,
  promptHash: string,
): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await bind(tx, accountId);
    const [row] = await tx
      .insert(insightClusters)
      .values({
        accountId,
        title: "seed cluster",
        description: "for feedback test",
        severity: "medium",
        frequency: 1,
        promptHash,
      })
      .returning({ id: insightClusters.id });
    if (!row) throw new Error("seed cluster insert failed");
    return row.id;
  });
}
