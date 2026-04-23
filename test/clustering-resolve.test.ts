import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { accounts, insightClusters, users } from "@/db/schema";
import { resolveClusterIds } from "@/lib/evidence/clustering/resolve-cluster-id";
import { ClusteringError } from "@/lib/evidence/clustering/errors";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  DB-gated test for the batched tombstone-chain resolver.

  The in-memory chain follower is unit-testable without a DB, but the
  important behaviors are exactly at the DB boundary:
    - the `= ANY(uuid[])` batch query resolves
    - RLS scopes the lookup (cross-account rows invisible)
    - an accidental cycle throws instead of looping

  Skip if no TEST_DATABASE_URL.
*/

describe.skipIf(!hasTestDb)("resolveClusterIds (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    handle = await setupTestDb("clustering_resolve");
    accountA = await seedAccount(handle, "a-rc@test.dev");
    accountB = await seedAccount(handle, "b-rc@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("empty input returns empty map", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const out = await resolveClusterIds({ db: tx }, []);
      expect(out.size).toBe(0);
    });
  });

  it("no tombstones: identity map", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const c1 = await insertCluster(tx, accountA, "c1");
      const c2 = await insertCluster(tx, accountA, "c2");
      const out = await resolveClusterIds({ db: tx }, [c1, c2]);
      expect(out.get(c1)).toBe(c1);
      expect(out.get(c2)).toBe(c2);
    });
  });

  it("single-hop chain: loser → winner", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const winner = await insertCluster(tx, accountA, "winner");
      const loser = await insertCluster(tx, accountA, "loser");
      await tx.execute(
        sql`UPDATE insight_cluster SET tombstoned_into = ${winner}::uuid WHERE id = ${loser}::uuid`,
      );
      const out = await resolveClusterIds({ db: tx }, [loser, winner]);
      expect(out.get(loser)).toBe(winner);
      expect(out.get(winner)).toBe(winner);
    });
  });

  it("two-hop chain: A → B → C resolves to C", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const a = await insertCluster(tx, accountA, "a");
      const b = await insertCluster(tx, accountA, "b");
      const c = await insertCluster(tx, accountA, "c");
      await tx.execute(
        sql`UPDATE insight_cluster SET tombstoned_into = ${b}::uuid WHERE id = ${a}::uuid`,
      );
      await tx.execute(
        sql`UPDATE insight_cluster SET tombstoned_into = ${c}::uuid WHERE id = ${b}::uuid`,
      );
      const out = await resolveClusterIds({ db: tx }, [a]);
      expect(out.get(a)).toBe(c);
    });
  });

  it("throws tombstone_cycle on a self-referential cycle", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const x = await insertCluster(tx, accountA, "x");
      const y = await insertCluster(tx, accountA, "y");
      await tx.execute(
        sql`UPDATE insight_cluster SET tombstoned_into = ${y}::uuid WHERE id = ${x}::uuid`,
      );
      await tx.execute(
        sql`UPDATE insight_cluster SET tombstoned_into = ${x}::uuid WHERE id = ${y}::uuid`,
      );
      try {
        await resolveClusterIds({ db: tx }, [x]);
        expect.fail("expected tombstone_cycle");
      } catch (e) {
        expect(e).toBeInstanceOf(ClusteringError);
        expect((e as ClusteringError).code).toBe("tombstone_cycle");
      }
    });
  });

  it("cross-account row is invisible via RLS (resolves to self)", async () => {
    // Create a cluster on account B, then query from account A. The
    // batch fetch returns zero rows (RLS), so the input id maps to
    // itself — caller's downstream join simply finds nothing.
    let bClusterId: string = "";
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountB);
      bClusterId = await insertCluster(tx, accountB, "b-only");
    });

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const out = await resolveClusterIds({ db: tx }, [bClusterId]);
      expect(out.get(bClusterId)).toBe(bClusterId);
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

async function insertCluster(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  accountId: string,
  title: string,
): Promise<string> {
  const [row] = await tx
    .insert(insightClusters)
    .values({
      accountId,
      title,
      description: `${title} desc`,
      severity: "medium",
      frequency: 1,
      promptHash: "test",
    })
    .returning({ id: insightClusters.id });
  if (!row) throw new Error("insertCluster failed");
  return row.id as string;
}
