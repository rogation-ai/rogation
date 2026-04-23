import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { insightClusters } from "@/db/schema";
import {
  getClusterDetail,
  listClusters,
} from "@/lib/evidence/synthesis";
import { runClustering } from "@/lib/evidence/clustering/orchestrator";
import { checkLimit } from "@/lib/rate-limit";
import { authedProcedure, router } from "@/server/trpc";

/*
  Insights router. Three procedures:

  - list: all clusters for this account, severity/frequency-sorted.
  - detail: one cluster + its supporting evidence quotes.
  - run: kick off a full re-cluster. Synchronous for Phase A — the
    Inngest worker commit moves this off the request path once batch
    sizes grow past what a single request can handle.
*/

export const insightsRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    return listClusters({ db: ctx.db, accountId: ctx.accountId });
  }),

  detail: authedProcedure
    .input(z.object({ clusterId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const detail = await getClusterDetail(
        { db: ctx.db, accountId: ctx.accountId },
        input.clusterId,
      );
      if (!detail) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Cluster not found",
        });
      }
      return detail;
    }),

  byIds: authedProcedure
    .input(z.object({ clusterIds: z.array(z.string().uuid()).max(100) }))
    .query(async ({ ctx, input }) => {
      if (input.clusterIds.length === 0) return [];
      // RLS scopes this to the current account; cross-account ids
      // return zero rows. Minimal shape — enough for CitationChip.
      return ctx.db
        .select({
          id: insightClusters.id,
          title: insightClusters.title,
          severity: insightClusters.severity,
          frequency: insightClusters.frequency,
        })
        .from(insightClusters)
        .where(inArray(insightClusters.id, input.clusterIds));
    }),

  run: authedProcedure.mutation(async ({ ctx }) => {
    // Rate limit BEFORE the LLM call. Each run can burn ~$0.30 of
    // Sonnet tokens; 10/hour/account is plenty for iteration while
    // stopping a tight loop. Failing OPEN in dev is intentional —
    // see lib/rate-limit.ts header.
    const limitResult = await checkLimit("cluster-run", ctx.accountId);
    if (!limitResult.success) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many re-cluster runs. Try again in an hour.",
        cause: {
          type: "rate_limited",
          preset: "cluster-run",
          limit: limitResult.limit,
          resetAt: limitResult.reset,
        },
      });
    }
    // Synchronous for Phase A. Lane E swaps this for event emission
    // + insight_run row + Inngest worker dispatch + UI polling. The
    // orchestrator picks full vs incremental internally per design §7
    // and takes a per-account advisory lock so concurrent requests
    // don't corrupt the write path.
    return runClustering(
      { db: ctx.db, accountId: ctx.accountId },
      {
        onUsage: async (u) => {
          await ctx.chargeLLM(u);
        },
        onTrace: ctx.traceLLM,
      },
    );
  }),
});
