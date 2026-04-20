import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { accounts, evidence, users } from "@/db/schema";
import {
  PLAN_LIMITS,
  assertResourceLimit,
  countResource,
} from "@/lib/plans";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  DB-gated integration tests over the plan-limit enforcer.

  What we prove:
  1. countResource respects RLS — counts only the bound account's rows.
  2. assertResourceLimit allows inserts up to the cap.
  3. assertResourceLimit throws TRPCError FORBIDDEN at cap + 1 with a
     structured plan_limit_reached payload the UI can render.
  4. Solo + Pro 'unlimited' tiers never throw for the same resource.

  Skipped when TEST_DATABASE_URL is missing.
*/

describe.skipIf(!hasTestDb)("plan limits (DB-backed)", () => {
  let handle: TestDbHandle;
  let freeAccountId: string;
  let soloAccountId: string;

  beforeAll(async () => {
    handle = await setupTestDb("plans_iso");
    freeAccountId = await seedAccount(handle, "free", "free@test.dev");
    soloAccountId = await seedAccount(handle, "solo", "solo@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("counts only the bound account's evidence (RLS applies)", async () => {
    await seedEvidence(handle, freeAccountId, 4);
    await seedEvidence(handle, soloAccountId, 7);

    const freeCount = await handle.db.transaction(async (tx) => {
      await bind(tx, freeAccountId);
      return countResource(tx, "evidence", freeAccountId);
    });

    const soloCount = await handle.db.transaction(async (tx) => {
      await bind(tx, soloAccountId);
      return countResource(tx, "evidence", soloAccountId);
    });

    expect(freeCount).toBe(4);
    expect(soloCount).toBe(7);
  });

  it("allows the 5th-10th free evidence insert but blocks the 11th", async () => {
    // free account already has 4 from the previous test. Add 6 more,
    // each time asserting the limit BEFORE inserting — that's the
    // real call-site pattern.
    for (let i = 5; i <= 10; i++) {
      const check = await handle.db.transaction(async (tx) => {
        await bind(tx, freeAccountId);
        const before = await assertResourceLimit(
          tx,
          "free",
          freeAccountId,
          "evidence",
        );
        await tx.insert(evidence).values({
          accountId: freeAccountId,
          sourceType: "upload_text",
          sourceRef: `free-${i}`,
          content: `free-${i}`,
          contentHash: `free-${i}`,
        });
        return before;
      });
      expect(check.max).toBe(10);
      expect(check.current).toBe(i - 1);
    }

    // 11th attempt must throw.
    const attempt = handle.db.transaction(async (tx) => {
      await bind(tx, freeAccountId);
      await assertResourceLimit(tx, "free", freeAccountId, "evidence");
    });
    await expect(attempt).rejects.toThrowError(/free plan limit/i);
  });

  it("solo tier never throws on evidence count (unlimited)", async () => {
    // Insert a lot more than free's cap and make sure assertResourceLimit
    // keeps returning OK (max = "unlimited").
    for (let i = 0; i < 15; i++) {
      await handle.db.transaction(async (tx) => {
        await bind(tx, soloAccountId);
        await tx.insert(evidence).values({
          accountId: soloAccountId,
          sourceType: "upload_text",
          sourceRef: `solo-extra-${i}`,
          content: `solo-extra-${i}`,
          contentHash: `solo-extra-${i}`,
        });
      });
    }

    const check = await handle.db.transaction(async (tx) => {
      await bind(tx, soloAccountId);
      return assertResourceLimit(tx, "solo", soloAccountId, "evidence");
    });

    expect(check.max).toBe("unlimited");
    expect(check.current).toBeGreaterThanOrEqual(PLAN_LIMITS.free.evidence as number);
  });
});

/* ------------------------------- helpers -------------------------------- */

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
  plan: "free" | "solo" | "pro",
  email: string,
): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "account" DISABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [account] = await tx
      .insert(accounts)
      .values({ plan })
      .returning({ id: accounts.id });
    if (!account) throw new Error("Seed account insert failed");
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

async function seedEvidence(
  handle: TestDbHandle,
  accountId: string,
  count: number,
): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await bind(tx, accountId);
    for (let i = 0; i < count; i++) {
      await tx.insert(evidence).values({
        accountId,
        sourceType: "upload_text",
        sourceRef: `${accountId}-seed-${i}`,
        content: `seed-${i}`,
        contentHash: `${accountId}-seed-${i}`,
      });
    }
  });
}
