import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  generateSpec,
  getLatestSpec,
  listRefinements,
  listSpecs,
} from "@/lib/evidence/specs";
import {
  detectPriorProjectConflict,
  priorLinearProject,
  pushSpecToLinear,
  type PushSpecError,
} from "@/lib/evidence/push-linear";
import { canExport } from "@/lib/plans";
import { checkLimit } from "@/lib/rate-limit";
import { authedProcedure, router } from "@/server/trpc";

// PushSpecError → TRPCError code. Adding a new error code on the
// push helper requires extending this map (typed Record forces the
// switch to stay exhaustive). Linter / type-check catches a missing
// entry; missing entries fall through to PRECONDITION_FAILED at
// runtime which is the safe default.
const LINEAR_PUSH_ERROR_CODE_MAP: Record<
  PushSpecError,
  "NOT_FOUND" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR" | "CONFLICT" | "PRECONDITION_FAILED"
> = {
  "spec-not-found": "NOT_FOUND",
  "empty-spec": "PRECONDITION_FAILED",
  "not-connected": "PRECONDITION_FAILED",
  "no-default-team": "PRECONDITION_FAILED",
  "token-invalid": "FORBIDDEN",
  "push-in-flight": "CONFLICT",
  "linear-project-exists": "CONFLICT",
  "linear-project-exists-but-empty": "CONFLICT",
  "spec-too-many-stories": "PRECONDITION_FAILED",
  "linear-api-error": "INTERNAL_SERVER_ERROR",
};

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
  list: authedProcedure
    .input(
      z.object({
        scopeId: z.string().uuid().or(z.literal("unscoped")).nullish(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      return listSpecs({
        db: ctx.db,
        accountId: ctx.accountId,
        scopeId: input?.scopeId,
      });
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
    Push the latest spec for an opportunity as a Linear project +
    one issue per user story (replaces the single-issue path).

    Gates (in order):
      1. Plan must allow Linear export (Pro today, not Free or Solo).
      2. Rate limit: 30 / hour / account (presets table).
      3. Mode handling: omitted on first-click; resolver throws
         CONFLICT(linear-project-exists|linear-project-exists-but-empty)
         when a prior project exists. UI catches → renders D3 modal
         → re-submits with explicit mode.
      4. Integration connected + default team picked + token valid +
         in-flight guard. All checked inside pushSpecToLinear;
         structured error codes drive which CTA the UI shows.

    On success: spec row's linear_project_* fields are set; caller
    should invalidate trpc.specs.getLatest so the editor swaps the
    push CTA for the "Already pushed" two-row state.
  */
  pushToLinear: authedProcedure
    .input(
      z.object({
        opportunityId: z.string().uuid(),
        mode: z.enum(["create-new", "update-in-place"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!canExport(ctx.plan, "linear")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Linear export requires the Pro plan.",
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

      // Mode not provided AND a prior project exists → surface a
      // CONFLICT envelope so the UI can render the D3 modal.
      if (!input.mode) {
        const conflict = await detectPriorProjectConflict(
          { db: ctx.db, accountId: ctx.accountId },
          input.opportunityId,
        );
        if (conflict) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              conflict.kind === "linear-project-exists-but-empty"
                ? "This spec has a Linear project but no issues were created yet. Confirm to continue the first push."
                : "This spec is already a Linear project. Update it or create a new one?",
            cause: {
              type: conflict.kind,
              projectId: conflict.projectId,
              projectUrl: conflict.projectUrl,
              issueCount: conflict.issueCount,
            },
          });
        }
      }

      const result = await pushSpecToLinear(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
        input.mode ?? "create-new",
      );

      if (!result.ok) {
        const code = LINEAR_PUSH_ERROR_CODE_MAP[result.error] ?? "PRECONDITION_FAILED";
        throw new TRPCError({
          code,
          message: result.message,
          cause: { type: "linear-push-failed", reason: result.error },
        });
      }

      return {
        projectId: result.projectId,
        projectUrl: result.projectUrl,
        issueCount: result.issueCount,
        recreatedAfterDelete: result.recreatedAfterDelete,
      };
    }),

  /*
    Latest prior version of this spec that did push to Linear, if any.
    Drives the refinement-gap banner on /spec/[opportunityId]: when a
    refined spec has no linear_project_id but a prior version did,
    show "this refined spec hasn't been pushed; prior project: <link>."

    Cross-spec-version propagation of Linear export fields is
    deferred to a follow-up commit. Until then, refined specs go
    through the first-push path and orphan the prior project.
  */
  priorLinearProject: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return priorLinearProject(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
      );
    }),
});

function sanitizeFilename(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "spec";
}
