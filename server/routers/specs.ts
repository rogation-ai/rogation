import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  generateSpec,
  getLatestSpec,
  listRefinements,
  listSpecs,
} from "@/lib/evidence/specs";
import { pushSpecToLinear } from "@/lib/evidence/push-linear";
import { canExport } from "@/lib/plans";
import { checkLimit } from "@/lib/rate-limit";
import { authedProcedure, router } from "@/server/trpc";

/*
  Specs router. Four procedures:

  - list:          all latest-version specs for this account.
  - getLatest:     latest spec for an opportunity (or null).
  - generate:      call the LLM → IR → grade → persist. Synchronous.
                   Streaming variant lands with the next commit.
  - exportMarkdown:read-only fetch of contentMd. Keeps the client
                   download a single tRPC call instead of rendering
                   IR → Markdown on every click.
*/

export const specsRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    return listSpecs({ db: ctx.db, accountId: ctx.accountId });
  }),

  getLatest: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return getLatestSpec(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
      );
    }),

  generate: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return generateSpec(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
        {
          onUsage: async (u) => {
            await ctx.chargeLLM(u);
          },
          onTrace: ctx.traceLLM,
        },
      );
    }),

  exportMarkdown: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const spec = await getLatestSpec(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
      );
      if (!spec) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No spec for this opportunity — generate one first",
        });
      }
      if (!spec.markdown) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Spec has no rendered markdown",
        });
      }
      return {
        filename: sanitizeFilename(spec.ir.title) + ".md",
        content: spec.markdown,
      };
    }),

  refinements: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return listRefinements(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
      );
    }),

  /*
    Push the latest spec for an opportunity as a Linear issue.

    Gates (in order):
      1. Plan must allow Linear export (Solo+ today, not Free).
      2. Rate limit: 30 / hour / account (presets table).
      3. Integration connected + default team picked + token valid.
         All checked inside pushSpecToLinear; structured error codes
         drive which CTA the UI shows.

    On success: spec row's linear_issue_* fields are set; caller
    should invalidate trpc.specs.getLatest so the editor swaps the
    "Push" button for "View in Linear".
  */
  pushToLinear: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!canExport(ctx.plan, "linear")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Linear export requires the Solo plan or higher.",
          cause: { type: "plan_limit_reached", feature: "linear-export" },
        });
      }

      const rl = await checkLimit("linear-push", ctx.accountId);
      if (!rl.success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many Linear pushes. Try again shortly.",
          cause: { type: "rate_limited", limit: rl.limit, resetAt: rl.reset },
        });
      }

      const result = await pushSpecToLinear(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
      );

      if (!result.ok) {
        const code =
          result.error === "spec-not-found"
            ? "NOT_FOUND"
            : result.error === "token-invalid"
              ? "FORBIDDEN"
              : result.error === "linear-api-error"
                ? "INTERNAL_SERVER_ERROR"
                : "PRECONDITION_FAILED";
        throw new TRPCError({
          code,
          message: result.message,
          cause: { type: "linear-push-failed", reason: result.error },
        });
      }

      return {
        url: result.url,
        identifier: result.identifier,
      };
    }),
});

function sanitizeFilename(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "spec";
}
