import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, users, type ProductBriefStructured } from "@/db/schema";
import {
  PLAN_LIMITS,
  countResource,
  exportHasWatermark,
  shareLinksHaveWatermark,
} from "@/lib/plans";
import { readBudget } from "@/lib/llm/usage";
import { authedProcedure, router } from "@/server/trpc";
import { TRPCError } from "@trpc/server";

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

  productContext: authedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({
        productBrief: accounts.productBrief,
        productBriefStructured: accounts.productBriefStructured,
        flagProductContextV1: accounts.flagProductContextV1,
        flagProductContextV1Rotation: accounts.flagProductContextV1Rotation,
      })
      .from(accounts)
      .where(eq(accounts.id, ctx.accountId))
      .limit(1);
    return row ?? null;
  }),

  updateProductContext: authedProcedure
    .input(
      z.object({
        productBrief: z.string().max(8192).optional(),
        productBriefStructured: z
          .object({
            icp: z.string().max(120).optional(),
            stage: z
              .enum(["Pre-seed", "Seed", "Series A", "Series B", "Growth", "Public"])
              .optional(),
            primaryMetrics: z
              .array(z.enum(["Retention", "Revenue", "Activation", "NPS", "Custom"]))
              .max(5)
              .optional(),
            customMetric: z.string().max(120).optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        input.productBrief !== undefined &&
        new TextEncoder().encode(input.productBrief).length > 8192
      ) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: "Product brief exceeds 8KB limit",
          cause: { type: "payload_too_large" },
        });
      }

      const updates: Record<string, unknown> = {};
      if (input.productBrief !== undefined) {
        updates.productBrief = input.productBrief || null;
      }
      if (input.productBriefStructured !== undefined) {
        updates.productBriefStructured =
          (input.productBriefStructured as ProductBriefStructured) ?? null;
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db
          .update(accounts)
          .set(updates)
          .where(eq(accounts.id, ctx.accountId));
      }

      return { ok: true };
    }),
});
