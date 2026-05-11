import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { insightClusters } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import type { CompleteOpts } from "@/lib/llm/router";
import {
  deleteAllClustersForAccount,
  runFullClustering,
} from "@/lib/evidence/synthesis";
import { runIncrementalClustering } from "./incremental";
import { applyClusterActions } from "./apply";
import type { InsightRunMode } from "@/db/schema";
import { loadProductContext } from "@/lib/evidence/load-product-context";

/*
  Re-cluster dispatch (design §7 rule).

  Cold start: zero live clusters → runFullClustering.
    Rationale: no prior cluster shape to incrementalize from, so a
    fresh rebuild is the only correct path. runFullClustering caps at
    its own MAX_EVIDENCE_PER_RUN and throws a clear error past that —
    much better signal than routing to incremental and dying on "no
    live clusters".

  Otherwise: runIncrementalClustering.
    Preserves cluster ids (critical for opportunity_to_cluster FK
    stability), uses KNN to skip the LLM on high-confidence
    attachments, scales past the full-cluster cap.

  Before either branch: sweep orphan clusters (frequency=0, not
  tombstoned). evidence.delete recomputes aggregates to zero but leaves
  the row in place — that's pure dispatch poison once the user re-uploads
  and clicks Generate, since the orphan count flips the branch and the
  incremental path then builds an LLM prompt with empty <evidence>
  blocks. Re-cluster is the canonical cleanup point (runs under the
  per-account advisory lock); downstream opportunities/specs were
  already markDownstreamStale'd at delete time.

  This is the single public entrypoint for "re-cluster this account."
  tRPC + Inngest worker both call it; no other caller should decide
  between full/incremental directly.
*/

export interface OrchestratorContext {
  db: Tx;
  accountId: string;
}

export interface OrchestratorResult {
  mode: InsightRunMode;
  clustersCreated: number;
  evidenceUsed: number;
  promptHash: string;
  contextUsed: boolean;
}

export async function runClustering(
  ctx: OrchestratorContext,
  opts: CompleteOpts = {},
  runId?: string,
): Promise<OrchestratorResult> {
  await ctx.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('cluster:' || ${ctx.accountId}, 0))`,
  );

  // Sweep orphan clusters (frequency=0, not tombstoned). These are
  // remnants of `evidence.delete` that recomputed aggregates to zero
  // but kept the row. Insights/opportunities already filter them out
  // (gt(frequency, 0)) and the delete path already markDownstreamStale'd
  // linked opportunities, so the rows are pure dispatch poison: their
  // presence makes the orchestrator count > 0 → routes to incremental,
  // then incremental builds an LLM prompt with empty <evidence> blocks
  // because no edges exist. ON DELETE CASCADE on opportunity_to_cluster
  // removes the dangling edges; CitationChip renders "Cluster
  // unavailable" for any spec citation still naming the gone id.
  await ctx.db
    .delete(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
        eq(insightClusters.frequency, 0),
      ),
    );

  const effectiveRunId = runId ?? crypto.randomUUID();
  const { contextUsed, promptOpts, productContextBlock } = await loadProductContext(
    ctx.db,
    ctx.accountId,
    effectiveRunId,
    "clustering",
    opts,
  );
  const mergedOpts = { ...opts, ...promptOpts };

  const [clusterCountRow] = await ctx.db
    .select({ n: count() })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
        gt(insightClusters.frequency, 0),
      ),
    );

  const existingClusters = Number(clusterCountRow?.n ?? 0);

  // Zero live clusters → cold-start is the only correct path; there's
  // no prior shape to incrementalize from. If the corpus is over the
  // full-cluster cap, runFullClustering throws a clear "capped at N"
  // error the worker surfaces as a failed run — strictly better than
  // routing to incremental and dying on "no live clusters".
  if (existingClusters === 0) {
    // Cold start. Wipe any tombstoned remnants (shouldn't exist but
    // belt-and-suspenders) + run full clustering + apply.
    await deleteAllClustersForAccount(ctx.db, ctx.accountId);
    const { plan, evidenceUsed, promptHash } = await runFullClustering(
      { db: ctx.db, accountId: ctx.accountId },
      mergedOpts,
      productContextBlock,
    );
    const { clustersCreated } = await applyClusterActions(
      ctx.db,
      plan,
      ctx.accountId,
      promptHash,
      contextUsed,
    );
    return {
      mode: "full",
      clustersCreated,
      evidenceUsed,
      promptHash,
      contextUsed,
    };
  }

  const {
    plan,
    evidenceUsed,
    promptHash,
  } = await runIncrementalClustering(
    { db: ctx.db, accountId: ctx.accountId },
    mergedOpts,
    productContextBlock,
  );
  const { clustersCreated } = await applyClusterActions(
    ctx.db,
    plan,
    ctx.accountId,
    promptHash,
    contextUsed,
  );
  return {
    mode: "incremental",
    clustersCreated,
    evidenceUsed,
    promptHash,
    contextUsed,
  };
}
