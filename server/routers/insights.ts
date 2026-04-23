import { TRPCError } from "@trpc/server";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { insightClusters, insightRuns } from "@/db/schema";
import {
  getClusterDetail,
  listClusters,
} from "@/lib/evidence/synthesis";
import { dispatchClusterRun } from "@/lib/evidence/clustering/dispatch";
import { authedProcedure, router } from "@/server/trpc";

/*
  Insights router.

  - list / detail / byIds: read paths over clusters.
  - run: create an `insight_run` row + emit `EVENT_CLUSTER_REQUESTED`;
    the Inngest worker in lib/inngest/functions/cluster-evidence.ts
    picks it up, flips status to running/done/failed, and writes
    metrics. Synchronous clustering lived here through Lane D; Lane E
    moved it off the request path so a 10–30s re-cluster doesn't hold
    the tRPC request open.
  - runStatus / latestRun: power the UI polling loop on /insights.
*/

const RUN_COLUMNS = {
  id: insightRuns.id,
  status: insightRuns.status,
  mode: insightRuns.mode,
  clustersCreated: insightRuns.clustersCreated,
  evidenceUsed: insightRuns.evidenceUsed,
  durationMs: insightRuns.durationMs,
  error: insightRuns.error,
  startedAt: insightRuns.startedAt,
  finishedAt: insightRuns.finishedAt,
} as const;

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
    return dispatchClusterRun({ db: ctx.db, accountId: ctx.accountId });
  }),

  runStatus: authedProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // RLS scopes this to the caller's account. A runId from a
      // different account returns zero rows → NOT_FOUND.
      const [row] = await ctx.db
        .select(RUN_COLUMNS)
        .from(insightRuns)
        .where(eq(insightRuns.id, input.runId))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Run not found",
        });
      }
      return row;
    }),

  latestRun: authedProcedure.query(async ({ ctx }) => {
    // Drives "resume polling after a page reload" — the UI seeds its
    // activeRunId from this if the latest run is non-terminal.
    const [row] = await ctx.db
      .select(RUN_COLUMNS)
      .from(insightRuns)
      .where(eq(insightRuns.accountId, ctx.accountId))
      .orderBy(desc(insightRuns.startedAt))
      .limit(1);
    return row ?? null;
  }),
});
