import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { accounts, llmUsage, users } from "@/db/schema";
import {
  chargeAndEnforce,
  chargeUsage,
  currentMonth,
  readBudget,
} from "@/lib/llm/usage";
import { PLAN_LIMITS } from "@/lib/plans";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Unit + integration coverage for the token-budget accumulator.

  Unit: currentMonth() is deterministic, UTC-based, zero-padded.
  Integration (DB-gated):
    - chargeUsage() UPSERTs: first charge inserts, second accumulates.
    - readBudget() returns zero when no row exists for the month.
    - chargeAndEnforce() throws FORBIDDEN when the charge pushes over
      the hard cap, but STILL records the spend so overruns are
      visible in the log.
    - Cross-month isolation: a charge in a new month starts a fresh row.
*/

describe("currentMonth", () => {
  it("formats as UTC YYYY-MM with zero-padding", () => {
    expect(currentMonth(new Date("2026-01-15T03:00:00Z"))).toBe("2026-01");
    expect(currentMonth(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(currentMonth(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("uses UTC even when local time would flip the month", () => {
    // 2026-02-01 00:30 UTC == 2026-01-31 19:30 in an America/New_York
    // clock. We treat the UTC date as the source of truth.
    expect(currentMonth(new Date("2026-02-01T00:30:00Z"))).toBe("2026-02");
  });
});

describe.skipIf(!hasTestDb)("llm_usage accumulator (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountId: string;

  beforeAll(async () => {
    handle = await setupTestDb("llm_usage");
    accountId = await seedFreeAccount(handle);
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("UPSERTs: first charge inserts, repeat calls accumulate", async () => {
    const usage = {
      promptHash: "abc",
      task: "synthesis" as const,
      model: "claude-sonnet-4-6",
      tokensIn: 1_000,
      tokensOut: 200,
      cacheReadTokens: 0,
      latencyMs: 100,
    };

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountId);
      await chargeUsage(tx, accountId, usage);
      await chargeUsage(tx, accountId, usage);
      await chargeUsage(tx, accountId, usage);
    });

    const month = currentMonth();
    const row = await handle.db.transaction(async (tx) => {
      await bind(tx, accountId);
      const [r] = await tx
        .select()
        .from(llmUsage)
        .where(sql`account_id = ${accountId} AND month = ${month}`)
        .limit(1);
      return r;
    });

    expect(row?.tokensIn).toBe(3_000);
    expect(row?.tokensOut).toBe(600);
    expect(row?.calls).toBe(3);
  });

  it("readBudget returns zero totals when no row exists for the month", async () => {
    const futureAccount = await seedFreeAccount(handle);
    const state = await handle.db.transaction(async (tx) => {
      await bind(tx, futureAccount);
      return readBudget(tx, "free", futureAccount);
    });

    expect(state.totalInputTokens).toBe(0);
    expect(state.overSoftCap).toBe(false);
    expect(state.overHardCap).toBe(false);
    expect(state.hardCap).toBe(PLAN_LIMITS.free.monthlyTokenBudget);
  });

  it("chargeAndEnforce throws when the charge crosses the hard cap but still records the spend", async () => {
    const overrunAccount = await seedFreeAccount(handle);
    const freeCap = PLAN_LIMITS.free.monthlyTokenBudget; // 200_000
    const overshoot = freeCap + 5_000;

    const attempt = handle.db.transaction(async (tx) => {
      await bind(tx, overrunAccount);
      await chargeAndEnforce(tx, "free", overrunAccount, {
        promptHash: "h",
        task: "synthesis",
        model: "claude-sonnet-4-6",
        tokensIn: overshoot,
        tokensOut: 500,
        latencyMs: 10,
      });
    });

    await expect(attempt).rejects.toThrowError(/monthly token budget/i);

    const row = await handle.db.transaction(async (tx) => {
      await bind(tx, overrunAccount);
      const [r] = await tx
        .select()
        .from(llmUsage)
        .where(
          sql`account_id = ${overrunAccount} AND month = ${currentMonth()}`,
        )
        .limit(1);
      return r;
    });

    // The spend was recorded before the error — alerting needs to see it.
    expect(row?.tokensIn).toBe(overshoot);
  });

  it("cross-month isolation: a Feb call does not count Jan's totals", async () => {
    const jan = new Date("2026-01-15T00:00:00Z");
    const feb = new Date("2026-02-15T00:00:00Z");
    const acct = await seedFreeAccount(handle);

    await handle.db.transaction(async (tx) => {
      await bind(tx, acct);
      await chargeUsage(tx, acct, makeUsage(50_000), jan);
      await chargeUsage(tx, acct, makeUsage(70_000), feb);
    });

    const janState = await handle.db.transaction(async (tx) => {
      await bind(tx, acct);
      return readBudget(tx, "free", acct, jan);
    });
    const febState = await handle.db.transaction(async (tx) => {
      await bind(tx, acct);
      return readBudget(tx, "free", acct, feb);
    });

    expect(janState.totalInputTokens).toBe(50_000);
    expect(febState.totalInputTokens).toBe(70_000);
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

async function seedFreeAccount(handle: TestDbHandle): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "account" DISABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [account] = await tx
      .insert(accounts)
      .values({ plan: "free" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("Seed account insert failed");
    await tx.insert(users).values({
      accountId: account.id,
      clerkUserId: `clerk_${account.id}`,
      email: `${account.id}@test.dev`,
    });
    await tx.execute(sql`ALTER TABLE "account" ENABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" ENABLE ROW LEVEL SECURITY`);
    return account.id;
  });
}

function makeUsage(tokensIn: number) {
  return {
    promptHash: "test",
    task: "synthesis" as const,
    model: "claude-sonnet-4-6",
    tokensIn,
    tokensOut: Math.floor(tokensIn / 10),
    cacheReadTokens: 0,
    latencyMs: 10,
  };
}
