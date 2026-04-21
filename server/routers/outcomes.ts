import { z } from "zod";
import {
  createOutcome,
  deleteOutcome,
  listOutcomesForOpportunity,
  summariesForOpportunities,
  updateOutcome,
} from "@/lib/evidence/outcomes";
import { authedProcedure, router } from "@/server/trpc";

/*
  Outcomes router. Five procedures:

  - list({ opportunityId }): every outcome row for one opportunity,
                             newest first. Open to every plan — a Pro
                             user who downgrades can still read history.
  - summary({ opportunityIds }): batched per-opportunity summary
                             (count + verdict + delta%) for /build cards.
  - create / update / delete:  writes. Plan-gated in the helper lib with
                             TRPCError FORBIDDEN { type:"plan_feature_required" }
                             so the UI can render an upsell instead of a
                             toast error.

  Metric name is freeform but capped (128 chars) because it's a label,
  not free-form notes. Predicted / actual are nullable so a PM can
  record a goal before they have measurements, then edit the row later.
*/

const metricNameSchema = z.string().trim().min(1).max(128);
// Metric values cover retention deltas, activation rates, ARR impact —
// wide but bounded so a stray 1e308 doesn't poison the summary math.
const metricValueSchema = z
  .number()
  .finite()
  .min(-1_000_000_000)
  .max(1_000_000_000);

export const outcomesRouter = router({
  list: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return listOutcomesForOpportunity({ db: ctx.db }, input.opportunityId);
    }),

  summary: authedProcedure
    .input(
      z.object({
        opportunityIds: z.array(z.string().uuid()).max(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      const map = await summariesForOpportunities(
        { db: ctx.db },
        input.opportunityIds,
      );
      // tRPC superjson handles Map fine, but the client React hooks are
      // nicer with a plain object keyed by opportunity id.
      return Object.fromEntries(map);
    }),

  create: authedProcedure
    .input(
      z.object({
        opportunityId: z.string().uuid(),
        metricName: metricNameSchema,
        predicted: metricValueSchema.nullable(),
        actual: metricValueSchema.nullable(),
        measuredAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return createOutcome(
        { db: ctx.db, accountId: ctx.accountId, plan: ctx.plan },
        input,
      );
    }),

  update: authedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        metricName: metricNameSchema.optional(),
        predicted: metricValueSchema.nullable().optional(),
        actual: metricValueSchema.nullable().optional(),
        measuredAt: z.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return updateOutcome(
        { db: ctx.db, accountId: ctx.accountId, plan: ctx.plan },
        input,
      );
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return deleteOutcome(
        { db: ctx.db, accountId: ctx.accountId, plan: ctx.plan },
        input.id,
      );
    }),
});
