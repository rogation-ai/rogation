import { z } from "zod";
import {
  defaultWeights,
  listOpportunities,
  listOpportunitiesForCluster,
  readWeights,
  rescoreOpportunities,
  runFullOpportunities,
  writeWeights,
  type WeightSet,
} from "@/lib/evidence/opportunities";
import { authedProcedure, router } from "@/server/trpc";

/*
  Opportunities router. Five procedures:

  - list:            ranked opportunities for this account.
  - forCluster:      opportunities linked to a specific cluster id.
                     Drives the Insights right-rail "Linked opportunities".
  - weights:         read current slider positions.
  - run:             invoke the LLM to (re-)generate opportunities.
  - updateWeights:   persist new slider positions + recompute scores.
                     Called on slider release; client does optimistic
                     re-rank in-between.
*/

const weightSchema: z.ZodType<WeightSet> = z.object({
  frequencyW: z.number().min(0).max(5),
  revenueW: z.number().min(0).max(5),
  retentionW: z.number().min(0).max(5),
  strategyW: z.number().min(0).max(5),
  effortW: z.number().min(0).max(5),
});

export const opportunitiesRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    return listOpportunities({ db: ctx.db, accountId: ctx.accountId });
  }),

  forCluster: authedProcedure
    .input(z.object({ clusterId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return listOpportunitiesForCluster(
        { db: ctx.db, accountId: ctx.accountId },
        input.clusterId,
      );
    }),

  weights: authedProcedure.query(async ({ ctx }) => {
    const saved = await readWeights({ db: ctx.db, accountId: ctx.accountId });
    return { weights: saved, defaults: defaultWeights() };
  }),

  run: authedProcedure.mutation(async ({ ctx }) => {
    return runFullOpportunities(
      { db: ctx.db, accountId: ctx.accountId },
      {
        onUsage: async (u) => {
          await ctx.chargeLLM(u);
        },
        onTrace: ctx.traceLLM,
      },
    );
  }),

  updateWeights: authedProcedure
    .input(z.object({ weights: weightSchema }))
    .mutation(async ({ ctx, input }) => {
      await writeWeights(
        { db: ctx.db, accountId: ctx.accountId },
        input.weights,
      );
      // Cheap — no LLM — so we always re-rank server-side on release
      // for persistence. The UI re-ranks optimistically during drag.
      const rescored = await rescoreOpportunities(
        { db: ctx.db, accountId: ctx.accountId },
        input.weights,
      );
      return { rescored: rescored.length };
    }),
});
