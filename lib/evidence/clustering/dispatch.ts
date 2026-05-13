import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/scoped";
import { insightRuns } from "@/db/schema";
import {
  EVENT_CLUSTER_REQUESTED,
  inngest,
} from "@/lib/inngest/client";
import { checkLimit } from "@/lib/rate-limit";

/*
  Async re-cluster dispatch. Called from trpc.insights.run (Lane E).

  Writes a pending insight_run row, emits EVENT_CLUSTER_REQUESTED,
  returns the run id. The worker in
  lib/inngest/functions/cluster-evidence.ts picks up the event and
  transitions status to running → done/failed.

  The caller's RLS-bound tx owns the row insert + send so a failed
  dispatch rolls back the insert. A row never lingers in "pending"
  because inngest was unreachable.

  `mode` is NOT NULL in schema but the orchestrator picks it per
  design §7 — "incremental" is a placeholder the worker overwrites on
  its success UPDATE.
*/

export interface DispatchContext {
  db: Tx;
  accountId: string;
  scopeId?: string;
}

const NON_TERMINAL_STATUSES = ["pending", "running"] as const;

export async function dispatchClusterRun(
  ctx: DispatchContext,
): Promise<{ runId: string; deduped: boolean }> {
  // Dedupe: if an earlier run is still pending/running for this
  // account, return its id instead of spawning a second. PMs do
  // double-click, retries fire, tabs reload. Worker's
  // concurrency.limit=1 per account serializes correctness either
  // way, but each re-cluster burns ~$0.30 of Sonnet — spending twice
  // for the same intent is pure waste. RLS scopes this SELECT to the
  // caller's account.
  const scopeDedup = ctx.scopeId
    ? eq(insightRuns.scopeId, ctx.scopeId)
    : isNull(insightRuns.scopeId);
  const [existing] = await ctx.db
    .select({ id: insightRuns.id })
    .from(insightRuns)
    .where(
      and(
        eq(insightRuns.accountId, ctx.accountId),
        inArray(insightRuns.status, NON_TERMINAL_STATUSES),
        scopeDedup,
      ),
    )
    .limit(1);
  if (existing) {
    return { runId: existing.id, deduped: true };
  }

  // Rate-limit BEFORE creating the row. A runaway client loop would
  // otherwise spam insight_run + Inngest events.
  const limit = await checkLimit("cluster-run", ctx.accountId);
  if (!limit.success) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many re-cluster runs. Try again in an hour.",
      cause: {
        type: "rate_limited",
        preset: "cluster-run",
        limit: limit.limit,
        resetAt: limit.reset,
      },
    });
  }

  const [row] = await ctx.db
    .insert(insightRuns)
    .values({
      accountId: ctx.accountId,
      status: "pending",
      mode: "incremental",
      scopeId: ctx.scopeId ?? null,
    })
    .returning({ id: insightRuns.id });
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create insight_run row",
    });
  }

  // Ordering note: send runs inside the caller's tx, before commit.
  // If send succeeds and commit then fails, the worker wakes up on a
  // runId whose row was rolled back — its ownership check
  // (SELECT ... WHERE id AND accountId) returns zero rows and it
  // throws cleanly. We chose this over commit-first-then-send
  // because the inverse failure (committed row, send never made it)
  // leaves a stranded pending row that needs a reaper. A phantom
  // event that no-ops inside the worker is the better failure mode.
  await inngest.send({
    name: EVENT_CLUSTER_REQUESTED,
    data: {
      runId: row.id,
      accountId: ctx.accountId,
      ...(ctx.scopeId ? { scopeId: ctx.scopeId } : {}),
    },
  });

  return { runId: row.id, deduped: false };
}
