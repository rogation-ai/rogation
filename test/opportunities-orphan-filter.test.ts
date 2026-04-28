import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  insightClusters,
  opportunities,
  opportunityToCluster,
  users,
} from "@/db/schema";
import {
  listOpportunities,
  runFullOpportunities,
} from "@/lib/evidence/opportunities";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Regression tests for orphan-cluster cleanup on the opportunity layer.

  Bug: after evidence delete, clusters drop to frequency=0 and disappear
  from /insights, but opportunities linked to those orphan clusters
  kept appearing on /build. Re-rank didn't clear them; regen threw
  "no clusters" if every cluster went orphan.

  Fix:
    - listOpportunities filters opps with no live linked cluster.
    - runFullOpportunities wipes prior opps and returns 0 instead of
      throwing when zero live clusters remain.
*/

describe.skipIf(!hasTestDb)("opportunities orphan filter", () => {
  let handle: TestDbHandle;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    handle = await setupTestDb("opps_orphan_filter");
    accountA = await seedAccount(handle, "a-orphan@test.dev");
    // Separate account for the wipe test — handle.db.transaction
    // commits at the end, so cluster rows from the first test would
    // otherwise leak into the second's `runFullOpportunities` call
    // and trigger a real LLM call (no API key in CI).
    accountB = await seedAccount(handle, "b-orphan@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("listOpportunities hides opps whose linked clusters are all orphan", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const liveCluster = await insertCluster(tx, accountA, 5);
      const orphanCluster = await insertCluster(tx, accountA, 0);

      const liveOpp = await insertOpportunity(tx, accountA, [liveCluster]);
      const orphanOpp = await insertOpportunity(tx, accountA, [orphanCluster]);
      const mixedOpp = await insertOpportunity(tx, accountA, [
        liveCluster,
        orphanCluster,
      ]);

      const rows = await listOpportunities({ db: tx, accountId: accountA });
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual([liveOpp, mixedOpp].sort());

      const mixed = rows.find((r) => r.id === mixedOpp);
      // Dead cluster is dropped from the citation list so the UI
      // doesn't deep-link to a hidden insight.
      expect(mixed?.linkedClusterIds).toEqual([liveCluster]);

      // The orphan-only opp row is preserved in the DB — only the
      // read path filters it. Re-clustering can revive it later.
      const stillThere = await tx
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.id, orphanOpp));
      expect(stillThere).toHaveLength(1);
    });
  });

  it("runFullOpportunities wipes prior opps when no live clusters remain", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountB);
      // All clusters orphan: simulates "user deleted every piece of
      // evidence." Should not throw — should wipe.
      const orphan = await insertCluster(tx, accountB, 0);
      await insertOpportunity(tx, accountB, [orphan]);

      const result = await runFullOpportunities({
        db: tx,
        accountId: accountB,
      });
      expect(result.opportunitiesCreated).toBe(0);
      expect(result.clustersUsed).toBe(0);

      const remaining = await tx
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.accountId, accountB));
      expect(remaining).toHaveLength(0);
    });
  });
});

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertCluster(
  tx: any,
  accountId: string,
  frequency: number,
): Promise<string> {
  const [row] = await tx
    .insert(insightClusters)
    .values({
      accountId,
      title: `c_${Math.random()}`,
      description: "d",
      severity: "medium",
      frequency,
      promptHash: "h",
    })
    .returning({ id: insightClusters.id });
  if (!row) throw new Error("insertCluster failed");
  return row.id as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertOpportunity(
  tx: any,
  accountId: string,
  linkedClusterIds: string[],
): Promise<string> {
  const [row] = await tx
    .insert(opportunities)
    .values({
      accountId,
      title: "opp",
      description: "d",
      reasoning: "r",
      effortEstimate: "M",
      score: 1,
      confidence: 0.5,
      promptHash: "opphash",
    })
    .returning({ id: opportunities.id });
  if (!row) throw new Error("insertOpportunity failed");
  if (linkedClusterIds.length > 0) {
    await tx.insert(opportunityToCluster).values(
      linkedClusterIds.map((clusterId) => ({
        opportunityId: row.id,
        clusterId,
      })),
    );
  }
  return row.id as string;
}
