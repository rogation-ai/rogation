import { and, eq } from "drizzle-orm";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db/client";
import { bindAccountToTx } from "@/db/scoped";
import { accounts, insightRuns } from "@/db/schema";
import type { PlanTier } from "@/lib/plans";
import {
  assertTokenBudget,
  chargeAndEnforce,
} from "@/lib/llm/usage";
import {
  inngest,
  EVENT_CLUSTER_REQUESTED,
  type ClusterRequestedData,
} from "@/lib/inngest/client";
import { runClustering } from "@/lib/evidence/clustering/orchestrator";
import { ClusteringError } from "@/lib/evidence/clustering/errors";

const PLAN_TIER_SCHEMA = z.enum(["free", "solo", "pro"]);

/*
  Background worker: run a re-cluster for an account.

  Triggered by the `insights/cluster.requested` event sent from
  `trpc.insights.run` (wired in Lane E). Payload carries a pre-created
  `insight_run` row id so the worker writes status transitions against
  a row the UI is already polling.

  Steps:
    1. Open tx, bind account for RLS.
    2. Mark the run as `running`.
    3. Look up the account's plan tier so we can enforce token budget.
    4. Pre-call budget gate — fail fast instead of burning a provider
       roundtrip on an over-cap account.
    5. Call runClustering — the orchestrator picks full vs incremental
       per design §7.
    6. On success: write `done` + metrics + finished_at.
    7. On failure: write `failed` + error code (for ClusteringError)
       or message (for anything else). Surface unexpected errors to
       Sentry — expected ClusteringError codes are user-actionable,
       not bugs.

  Retries: 0. Design §4 — no mid-stream resume. A failed run shows up
  in the UI; the user retries manually with a new event.

  Concurrency: 1 per account. A second event for the same account
  waits behind the first. Uses Inngest's `concurrency.key` so
  accounts don't block each other.
*/

export async function runClusterEvidence(
  input: ClusterRequestedData,
): Promise<{ status: "done" | "failed"; error?: string }> {
  const { runId, accountId, scopeId } = input;
  const startedAt = Date.now();

  try {
    await db.transaction(async (tx) => {
      await bindAccountToTx(tx, accountId);

      // Verify the run belongs to this account BEFORE any write.
      // RLS alone isn't enough — a crafted event with a runId from
      // one account + accountId from another would let the worker
      // run on B's data while A's run sits in "running" forever.
      // Explicit ownership check fails fast + surfaces the mismatch.
      const [ownedRun] = await tx
        .select({ id: insightRuns.id, status: insightRuns.status })
        .from(insightRuns)
        .where(
          and(
            eq(insightRuns.id, runId),
            eq(insightRuns.accountId, accountId),
          ),
        )
        .limit(1);
      if (!ownedRun) {
        throw new Error(
          `insight_run ${runId} not owned by account ${accountId}`,
        );
      }

      // Mark running. Filter by (id, accountId) defensively.
      await tx
        .update(insightRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(insightRuns.id, runId),
            eq(insightRuns.accountId, accountId),
          ),
        );

      // Look up plan tier for budget enforcement. zod-parse the enum
      // so a manual DB edit that set plan to an unexpected value
      // fails loudly instead of silently collapsing to a default.
      const [account] = await tx
        .select({ plan: accounts.plan })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (!account) {
        throw new Error(`account ${accountId} not found in worker tx`);
      }
      const plan: PlanTier = PLAN_TIER_SCHEMA.parse(account.plan);

      // Pre-call budget gate. Throws TRPCError (FORBIDDEN) if over
      // hard cap — we normalize it to ClusteringError-ish failure
      // below.
      await assertTokenBudget(tx, plan, accountId);

      const orchestratorResult = await runClustering(
        { db: tx, accountId, scopeId },
        {
          onUsage: async (u) => {
            await chargeAndEnforce(tx, plan, accountId, u);
          },
        },
      );

      // Success. Write metrics + finished_at. Double-filter by
      // (id, accountId) belt-and-suspenders.
      await tx
        .update(insightRuns)
        .set({
          status: "done",
          mode: orchestratorResult.mode,
          clustersCreated: orchestratorResult.clustersCreated,
          evidenceUsed: orchestratorResult.evidenceUsed,
          durationMs: Date.now() - startedAt,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(insightRuns.id, runId),
            eq(insightRuns.accountId, accountId),
          ),
        );
    });

    return { status: "done" as const };
  } catch (err) {
    const isExpected = err instanceof ClusteringError;
    const errorText = isExpected
      ? (err as ClusteringError).code
      : err instanceof Error
        ? err.message
        : String(err);

    // Best-effort failure persistence in its own tx — the outer tx
    // rolled back, so the "running" update is gone. Write an error
    // row directly. RLS still applies via a fresh binding, and the
    // double filter by (id, accountId) makes a malformed event
    // payload a no-op rather than cross-account mutation.
    try {
      await db.transaction(async (tx) => {
        await bindAccountToTx(tx, accountId);
        await tx
          .update(insightRuns)
          .set({
            status: "failed",
            error: errorText,
            durationMs: Date.now() - startedAt,
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(insightRuns.id, runId),
              eq(insightRuns.accountId, accountId),
            ),
          );
      });
    } catch (recoveryErr) {
      // Recovery tx itself failed (DB flap). The run row is now
      // stuck in "running" until a reaper job flips it — Lane E's
      // status-polling UI surfaces stuck runs and lets the user
      // retry. Surface both errors to Sentry so we see the chain.
      Sentry.captureException(recoveryErr, {
        tags: {
          worker: "cluster-evidence",
          phase: "recovery_tx",
          runId,
          accountId,
        },
        extra: {
          originalError: errorText,
        },
      });
    }

    if (!isExpected) {
      Sentry.captureException(err, {
        tags: { worker: "cluster-evidence", runId, accountId },
      });
    }

    return { status: "failed" as const, error: errorText };
  }
}

export const clusterEvidence = inngest.createFunction(
  {
    id: "cluster-evidence",
    // One re-cluster per account at a time. Different accounts run
    // in parallel.
    concurrency: {
      limit: 1,
      key: "event.data.accountId",
    },
    retries: 0,
    triggers: [{ event: EVENT_CLUSTER_REQUESTED }],
  },
  async ({ event, step }) => {
    const data = event.data as ClusterRequestedData;
    return step.run("cluster", async () =>
      runClusterEvidence({
        runId: data.runId,
        accountId: data.accountId,
        scopeId: data.scopeId,
      }),
    );
  },
);
