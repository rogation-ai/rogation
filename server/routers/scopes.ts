import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createScope,
  deleteScope,
  listScopes,
  previewScope,
  scopeCount,
  updateScope,
} from "@/lib/evidence/scopes";
import { routeAllEvidence } from "@/lib/evidence/scope-routing";
import { checkLimit } from "@/lib/rate-limit";
import { authedProcedure, router } from "@/server/trpc";

export const scopesRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    return listScopes({ db: ctx.db, accountId: ctx.accountId });
  }),

  count: authedProcedure.query(async ({ ctx }) => {
    return { count: await scopeCount({ db: ctx.db, accountId: ctx.accountId }) };
  }),

  create: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(128),
        brief: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createScope(
          { db: ctx.db, accountId: ctx.accountId },
          input,
        );
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to create scope",
        });
      }
    }),

  update: authedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(128).optional(),
        brief: z.string().min(1).max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateScope(
          { db: ctx.db, accountId: ctx.accountId },
          input.id,
          { name: input.name, brief: input.brief },
        );
      } catch (err) {
        if (err instanceof Error && err.message === "Scope not found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Scope not found" });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to update scope",
        });
      }
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await deleteScope(
          { db: ctx.db, accountId: ctx.accountId },
          input.id,
        );
      } catch (err) {
        if (err instanceof Error && err.message === "Scope not found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Scope not found" });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to delete scope",
        });
      }
    }),

  preview: authedProcedure
    .input(z.object({ brief: z.string().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      return previewScope(
        { db: ctx.db, accountId: ctx.accountId },
        input.brief,
      );
    }),

  // Manual re-route: useful when the user adds new evidence after
  // creating a scope, or after lowering the routing threshold. The
  // automatic routes happen on createScope / updateScope (when the
  // brief changes); this is the "do it now" escape hatch.
  // Rate-limited: routeAllEvidence is O(rows × scopes) and runs
  // inside the resolver's transaction; mash-clicking across tabs
  // would hold long txs and contend with concurrent ingest writes.
  reroute: authedProcedure.mutation(async ({ ctx }) => {
    const limit = await checkLimit("scope-reroute", ctx.accountId);
    if (!limit.success) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Re-route is rate-limited. Try again in a few minutes.",
        cause: {
          type: "rate_limited",
          limit: limit.limit,
          resetAt: limit.reset,
        },
      });
    }
    try {
      return await routeAllEvidence(ctx.db, ctx.accountId);
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Failed to re-route evidence",
      });
    }
  }),
});
