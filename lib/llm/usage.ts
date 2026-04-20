import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { llmUsage } from "@/db/schema";
import {
  PLAN_LIMITS,
  tokenBudgetSoftCap,
  type PlanTier,
} from "@/lib/plans";
import type { Usage } from "@/lib/llm/router";
import type { DbLike } from "@/server/trpc";

/*
  Token-budget accumulator. Completes the LLM router's onUsage story:

  1. Router calls onUsage({ tokensIn, tokensOut, cacheReadTokens, ... })
     right after every LLM call.
  2. onUsage -> chargeUsage(): UPSERTs the current-month row in
     llm_usage (account_id, month) and returns the post-charge totals.
  3. If post-charge totals blow the hard cap, we throw so the caller
     sees the error AND the DB still records the overrun (useful for
     alerting / "account abused the ceiling" reporting).

  Pre-call enforcement is separate: assertTokenBudget() reads the
  current-month row and throws before the LLM spend if the account is
  already at hard cap. Feature code that does many calls in a loop
  (batch embedding, cluster refresh) should call this once up front to
  skip the provider roundtrip entirely when over cap.
*/

/** UTC month key for the current wall clock, shape `YYYY-MM`. */
export function currentMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

export interface MonthlyTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  calls: number;
}

export interface BudgetState {
  plan: PlanTier;
  totalInputTokens: number;
  softCap: number;
  hardCap: number;
  overSoftCap: boolean;
  overHardCap: boolean;
  month: string;
}

/**
 * Charge the current month's usage row for an account. Upserts — one
 * row per (account, month). Input/output token columns accumulate.
 *
 * Returns the post-charge totals so the caller can decide whether to
 * warn or block.
 */
export async function chargeUsage(
  db: DbLike,
  accountId: string,
  usage: Usage,
  now: Date = new Date(),
): Promise<MonthlyTotals> {
  const month = currentMonth(now);

  const [row] = await db
    .insert(llmUsage)
    .values({
      accountId,
      month,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreateTokens: usage.cacheCreateTokens ?? 0,
      calls: 1,
    })
    .onConflictDoUpdate({
      target: [llmUsage.accountId, llmUsage.month],
      set: {
        tokensIn: sql`${llmUsage.tokensIn} + ${usage.tokensIn}`,
        tokensOut: sql`${llmUsage.tokensOut} + ${usage.tokensOut}`,
        cacheReadTokens: sql`${llmUsage.cacheReadTokens} + ${usage.cacheReadTokens ?? 0}`,
        cacheCreateTokens: sql`${llmUsage.cacheCreateTokens} + ${usage.cacheCreateTokens ?? 0}`,
        calls: sql`${llmUsage.calls} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      tokensIn: llmUsage.tokensIn,
      tokensOut: llmUsage.tokensOut,
      cacheReadTokens: llmUsage.cacheReadTokens,
      cacheCreateTokens: llmUsage.cacheCreateTokens,
      calls: llmUsage.calls,
    });

  if (!row) {
    // Unreachable under postgres-js; documented for readers.
    throw new Error("llm_usage UPSERT returned no row");
  }

  return row;
}

/**
 * Read the current-month budget state without charging. Use this
 * before kicking off a batch LLM job (embedding a whole upload) to
 * reject early when the account is already over.
 */
export async function readBudget(
  db: DbLike,
  plan: PlanTier,
  accountId: string,
  now: Date = new Date(),
): Promise<BudgetState> {
  const month = currentMonth(now);

  const [row] = await db
    .select({
      tokensIn: llmUsage.tokensIn,
      tokensOut: llmUsage.tokensOut,
    })
    .from(llmUsage)
    .where(and(eq(llmUsage.accountId, accountId), eq(llmUsage.month, month)))
    .limit(1);

  const totalInputTokens = row?.tokensIn ?? 0;
  const hardCap = PLAN_LIMITS[plan].monthlyTokenBudget;
  const softCap = tokenBudgetSoftCap(plan);

  return {
    plan,
    totalInputTokens,
    softCap,
    hardCap,
    overSoftCap: totalInputTokens >= softCap,
    overHardCap: totalInputTokens >= hardCap,
    month,
  };
}

/**
 * Pre-call gate. Throws FORBIDDEN when the account is already over the
 * hard cap. Call once before a batch job or expensive single call.
 */
export async function assertTokenBudget(
  db: DbLike,
  plan: PlanTier,
  accountId: string,
  now: Date = new Date(),
): Promise<BudgetState> {
  const state = await readBudget(db, plan, accountId, now);
  if (state.overHardCap) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Monthly token budget reached on the ${plan} plan. Upgrade or wait for the next cycle.`,
      cause: {
        type: "token_budget_exhausted",
        plan,
        totalInputTokens: state.totalInputTokens,
        hardCap: state.hardCap,
        month: state.month,
      },
    });
  }
  return state;
}

/**
 * Post-call hook bound into the LLM router's onUsage. Charges the
 * current-month row + throws AFTER charging if the call pushed the
 * account past the hard cap. The spend is recorded either way so we
 * can see overruns in the logs.
 */
export async function chargeAndEnforce(
  db: DbLike,
  plan: PlanTier,
  accountId: string,
  usage: Usage,
  now: Date = new Date(),
): Promise<MonthlyTotals> {
  const totals = await chargeUsage(db, accountId, usage, now);
  const hardCap = PLAN_LIMITS[plan].monthlyTokenBudget;

  if (totals.tokensIn >= hardCap) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This call put you over the monthly token budget for the ${plan} plan.`,
      cause: {
        type: "token_budget_exhausted",
        plan,
        totalInputTokens: totals.tokensIn,
        hardCap,
      },
    });
  }

  return totals;
}
