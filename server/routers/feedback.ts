import { z } from "zod";
import {
  aggregateByPrompt,
  myVotes,
  removeVote,
  voteOnEntity,
} from "@/lib/evidence/feedback";
import { authedProcedure, router } from "@/server/trpc";

/*
  Feedback router. Four procedures:

  - vote:      UPSERT a thumbs-up/down on a cluster/opportunity/spec.
               Captures prompt_hash server-side from the target row so
               the eval loop can GROUP BY prompt_hash.
  - remove:    Clear the current user's vote for one entity.
  - mine:      Batch-read the current user's votes for a list of ids.
               Drives the toggled state on FeedbackThumbs.
  - aggregate: Per-prompt-hash tally for eval dashboards. Returns all
               prompt hashes this account has voted on, sorted by
               total vote count desc.
*/

const entityTypeSchema = z.enum(["insight_cluster", "opportunity", "spec"]);
const ratingSchema = z.enum(["up", "down"]);

export const feedbackRouter = router({
  vote: authedProcedure
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string().uuid(),
        rating: ratingSchema,
        note: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return voteOnEntity(
        { db: ctx.db, accountId: ctx.accountId, userId: ctx.userId },
        input,
      );
    }),

  remove: authedProcedure
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return removeVote(
        { db: ctx.db, accountId: ctx.accountId, userId: ctx.userId },
        input.entityType,
        input.entityId,
      );
    }),

  mine: authedProcedure
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityIds: z.array(z.string().uuid()).max(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      return myVotes(
        { db: ctx.db, accountId: ctx.accountId, userId: ctx.userId },
        input.entityType,
        input.entityIds,
      );
    }),

  aggregate: authedProcedure.query(async ({ ctx }) => {
    return aggregateByPrompt({
      db: ctx.db,
      accountId: ctx.accountId,
      userId: ctx.userId,
    });
  }),
});
