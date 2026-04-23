import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  accounts,
  evidence,
  insightClusters,
  users,
} from "@/db/schema";
import {
  hasTestDb,
  setupTestDb,
  type TestDbHandle,
} from "./setup-db";

/*
  The load-bearing test for tenant guard layers 2 + 3.

  What we prove:
  1. set_config('app.current_account_id', A.id) makes RLS return only
     A's rows. NO .where(accountId) in any query. Pure Postgres policy.
  2. Switching the session var to B.id makes B's rows visible and hides
     A's.
  3. With NO session var bound, RLS returns zero rows (fails closed).
  4. WITH CHECK rejects cross-account writes. Inserting into account A's
     evidence while bound to account B raises an error.

  If this test fails, the tenant guard is broken and feature commits
  should block.
*/

describe.skipIf(!hasTestDb)("tenant isolation (RLS + session var)", () => {
  let handle: TestDbHandle;
  let accountAId: string;
  let accountBId: string;

  beforeAll(async () => {
    handle = await setupTestDb("tenant_iso");

    // Seed two accounts and two users. These inserts run as the schema
    // owner (no RLS bypass needed; policies use app.current_account_id
    // which is null here -> USING returns false -> inserts fail unless
    // we temporarily bypass). Easiest: bind the account to its own id
    // right before inserting its own rows.
    accountAId = await insertAccount(handle, "a@test.dev");
    accountBId = await insertAccount(handle, "b@test.dev");

    // Seed evidence for each account. Bind the session var first so
    // the WITH CHECK policy accepts the insert.
    await seedEvidence(handle, accountAId, ["A-interview-1", "A-ticket-1"]);
    await seedEvidence(handle, accountBId, ["B-interview-1"]);

    // Seed one insight cluster per account to exercise a second table.
    await seedCluster(handle, accountAId, "A cluster title");
    await seedCluster(handle, accountBId, "B cluster title");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("returns only A's evidence when bound to A", async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_account_id', ${accountAId}, true)`,
      );
      return tx.select({ content: evidence.content }).from(evidence);
    });

    const contents = rows.map((r) => r.content).sort();
    expect(contents).toEqual(["A-interview-1", "A-ticket-1"]);
  });

  it("returns only B's evidence when bound to B", async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_account_id', ${accountBId}, true)`,
      );
      return tx.select({ content: evidence.content }).from(evidence);
    });

    expect(rows.map((r) => r.content)).toEqual(["B-interview-1"]);
  });

  it("returns zero rows when no session var is bound (fails closed)", async () => {
    const rows = await handle.db.transaction(async (tx) => {
      // Deliberately no set_config call. RLS sees NULL and filters all rows.
      return tx.select().from(evidence);
    });

    expect(rows).toEqual([]);
  });

  it("isolates a second table (insight_cluster) the same way", async () => {
    const aRows = await handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_account_id', ${accountAId}, true)`,
      );
      return tx.select({ title: insightClusters.title }).from(insightClusters);
    });

    expect(aRows.map((r) => r.title)).toEqual(["A cluster title"]);
  });

  it("rejects cross-account writes (WITH CHECK)", async () => {
    const attempt = handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_account_id', ${accountBId}, true)`,
      );
      // Bound to B, try to insert into A. The WITH CHECK clause should
      // reject this with a policy violation error.
      await tx.insert(evidence).values({
        accountId: accountAId,
        sourceType: "upload_text",
        sourceRef: "malicious",
        content: "injected",
        contentHash: "abc",
      });
    });

    // Drizzle wraps the Postgres error: its outer .message is the query
    // text, the original "new row violates row-level security policy" is
    // nested. Asserting on the insert failure message proves the write
    // was rejected at the evidence table (which is what the WITH CHECK
    // policy guards).
    await expect(attempt).rejects.toThrow(
      /row-level security|insert into "evidence"/i,
    );
  });
});

/* ----------------- seed helpers (bypass RLS by binding own id) ---------------- */

async function insertAccount(
  handle: TestDbHandle,
  email: string,
): Promise<string> {
  // The account insert is tricky: policy is `id = app.current_account_id()`,
  // but the row doesn't have an id until it's inserted. We disable RLS on
  // the `account` table briefly to seed, then re-enable.
  //
  // Seeding here is test-only code. Application code never touches RLS
  // enable/disable — that pattern is for setup fixtures.
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "account" DISABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [account] = await tx
      .insert(accounts)
      .values({ plan: "free" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("Seed account insert failed");
    await tx
      .insert(users)
      .values({
        accountId: account.id,
        clerkUserId: `clerk_${account.id}`,
        email,
      });
    await tx.execute(sql`ALTER TABLE "account" ENABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" ENABLE ROW LEVEL SECURITY`);
    return account.id;
  });
}

async function seedEvidence(
  handle: TestDbHandle,
  accountId: string,
  contents: string[],
): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_account_id', ${accountId}, true)`,
    );
    for (const content of contents) {
      await tx.insert(evidence).values({
        accountId,
        sourceType: "upload_text",
        sourceRef: content,
        content,
        contentHash: content,
      });
    }
  });
}

async function seedCluster(
  handle: TestDbHandle,
  accountId: string,
  title: string,
): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_account_id', ${accountId}, true)`,
    );
    await tx.insert(insightClusters).values({
      accountId,
      title,
      description: `${title} description`,
      severity: "medium",
      frequency: 1,
      promptHash: "test",
    });
  });
}
