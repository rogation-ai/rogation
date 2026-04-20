import { eq } from "drizzle-orm";
import { accounts, users } from "@/db/schema";
import {
  PLAN_LIMITS,
  countResource,
  exportHasWatermark,
  shareLinksHaveWatermark,
} from "@/lib/plans";
import { readBudget } from "@/lib/llm/usage";
import { authedProcedure, router } from "@/server/trpc";

/*
  account.me — returns the caller's own account + user row + current
  plan limits + resource usage counts. This one payload drives both
  the welcome screen and the PlanMeter component on every gated surface
  (design review Pass 7).
*/
export const accountRouter = router({
  me: authedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({
        user: {
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
        },
        account: {
          id: accounts.id,
          plan: accounts.plan,
          subscriptionStatus: accounts.subscriptionStatus,
          trialEndsAt: accounts.trialEndsAt,
          createdAt: accounts.createdAt,
        },
      })
      .from(users)
      .innerJoin(accounts, eq(users.accountId, accounts.id))
      .where(eq(users.id, ctx.userId))
      .limit(1);

    if (!row) {
      // Impossible in practice: the authed middleware already resolved
      // ctx.userId off this join. If we get here, the DB changed
      // underneath us.
      throw new Error("Account row missing for authenticated user");
    }

    // Count all gated resources + read the monthly budget in parallel so
    // PlanMeter + token banner render in one round-trip. RLS keeps each
    // count account-bound.
    const [evidence, insights, opportunities, specs, integrations, budget] =
      await Promise.all([
        countResource(ctx.db, "evidence", ctx.accountId),
        countResource(ctx.db, "insights", ctx.accountId),
        countResource(ctx.db, "opportunities", ctx.accountId),
        countResource(ctx.db, "specs", ctx.accountId),
        countResource(ctx.db, "integrations", ctx.accountId),
        readBudget(ctx.db, ctx.plan, ctx.accountId),
      ]);

    const limits = PLAN_LIMITS[ctx.plan];

    return {
      ...row,
      usage: {
        evidence: { current: evidence, max: limits.evidence },
        insights: { current: insights, max: limits.insights },
        opportunities: { current: opportunities, max: limits.opportunities },
        specs: { current: specs, max: limits.specs },
        integrations: { current: integrations, max: limits.integrations },
      },
      features: {
        exports: limits.exports,
        exportHasWatermark: exportHasWatermark(ctx.plan),
        shareLinksHaveWatermark: shareLinksHaveWatermark(ctx.plan),
        outcomeTracking: limits.outcomeTracking,
        monthlyTokenBudget: limits.monthlyTokenBudget,
      },
      budget,
    };
  }),
});
