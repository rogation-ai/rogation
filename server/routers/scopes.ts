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
});
