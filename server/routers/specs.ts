import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  generateSpec,
  getLatestSpec,
  listSpecs,
} from "@/lib/evidence/specs";
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
});

function sanitizeFilename(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "spec";
}
