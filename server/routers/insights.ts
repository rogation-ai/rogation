import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getClusterDetail,
  listClusters,
  runFullClustering,
} from "@/lib/evidence/synthesis";
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

  run: authedProcedure.mutation(async ({ ctx }) => {
    return runFullClustering(
      { db: ctx.db, accountId: ctx.accountId },
      {
        // chargeLLM returns the monthly totals so feature code can
        // branch on them; the onUsage hook doesn't care about the
        // payload, only whether a throw aborts the call. Wrap to
        // drop the return value.
        onUsage: async (u) => {
          await ctx.chargeLLM(u);
        },
        onTrace: ctx.traceLLM,
      },
    );
  }),
});
