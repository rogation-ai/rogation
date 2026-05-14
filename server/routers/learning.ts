import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { checkLimit } from "@/lib/rate-limit";
import { canManageExclusions } from "@/lib/plans";
import {
  dismissCluster,
  listExclusions,
  unexclude,
  deleteExclusion,
  excludedEvidenceByExclusion,
  pendingExclusionCount,
  confirmPendingEvidence,
  dismissPendingEvidence,
} from "@/lib/evidence/exclusions";
import { authedProcedure, router } from "@/server/trpc";

/*
  Learning router — L3 AI Learning Loop.

  Surfaces the exclusion primitives: dismiss a cluster (creates an
  exclusion), list/manage exclusions, review pending evidence flagged
  by exclusion centroids, and confirm or dismiss pending matches.

  Rate-limited at the dismiss endpoint (LLM + DB write) via the
  'cluster-dismiss' preset. Exclusion management (unexclude, delete)
  is gated by plan tier via canManageExclusions().
*/

export const learningRouter = router({
  dismiss: authedProcedure
    .input(
      z.object({
        clusterId: z.string().uuid(),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const limit = await checkLimit("cluster-dismiss", ctx.accountId);
      if (!limit.success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many dismiss actions. Try again later.",
          cause: {
            type: "rate_limited",
            limit: limit.limit,
            resetAt: limit.reset,
          },
        });
      }
      try {
        return await dismissCluster(
          { db: ctx.db, accountId: ctx.accountId, userId: ctx.userId },
          input.clusterId,
          input.reason,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "Cluster not found") {
          throw new TRPCError({ code: "NOT_FOUND", message: msg });
        }
        if (msg === "Cluster already dismissed") {
          throw new TRPCError({ code: "CONFLICT", message: msg });
        }
        throw e;
      }
    }),

  exclusions: authedProcedure.query(async ({ ctx }) => {
    return listExclusions({ db: ctx.db, accountId: ctx.accountId });
  }),

  unexclude: authedProcedure
    .input(z.object({ exclusionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!canManageExclusions(ctx.plan)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Upgrade to Solo or Pro to manage exclusions.",
          cause: { type: "plan_limit_reached" },
        });
      }
      try {
        return await unexclude(
          { db: ctx.db, accountId: ctx.accountId, userId: ctx.userId },
          input.exclusionId,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "Exclusion not found") {
          throw new TRPCError({ code: "NOT_FOUND", message: msg });
        }
        throw e;
      }
    }),

  delete: authedProcedure
    .input(z.object({ exclusionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!canManageExclusions(ctx.plan)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Upgrade to Solo or Pro to manage exclusions.",
          cause: { type: "plan_limit_reached" },
        });
      }
      try {
        return await deleteExclusion(
          { db: ctx.db, accountId: ctx.accountId, userId: ctx.userId },
          input.exclusionId,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "Exclusion not found") {
          throw new TRPCError({ code: "NOT_FOUND", message: msg });
        }
        throw e;
      }
    }),

  excludedEvidence: authedProcedure
    .input(z.object({ exclusionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return excludedEvidenceByExclusion(
        ctx.db,
        ctx.accountId,
        input.exclusionId,
      );
    }),

  pendingCount: authedProcedure.query(async ({ ctx }) => {
    return pendingExclusionCount(ctx.db, ctx.accountId);
  }),

  confirmPending: authedProcedure
    .input(z.object({ evidenceIds: z.array(z.string().uuid()) }))
    .mutation(async ({ ctx, input }) => {
      return confirmPendingEvidence(ctx.db, ctx.accountId, input.evidenceIds);
    }),

  dismissPending: authedProcedure
    .input(z.object({ evidenceIds: z.array(z.string().uuid()) }))
    .mutation(async ({ ctx, input }) => {
      return dismissPendingEvidence(ctx.db, ctx.accountId, input.evidenceIds);
    }),
});
