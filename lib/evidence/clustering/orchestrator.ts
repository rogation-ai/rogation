import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { evidence, evidenceEmbeddings, insightClusters } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import type { CompleteOpts } from "@/lib/llm/router";
import { embed } from "@/lib/llm/router";
import {
  deleteAllClustersForAccount,
  runFullClustering,
} from "@/lib/evidence/synthesis";
import { runIncrementalClustering } from "./incremental";
import { applyClusterActions } from "./apply";
import { runConsolidationPass } from "./consolidation";
import type { InsightRunMode } from "@/db/schema";
import { loadProductContext } from "@/lib/evidence/load-product-context";
import { withScopeFilter } from "@/lib/evidence/scope-filter";
import { loadDismissedLabels, decayExclusions } from "@/lib/evidence/exclusions";
import { cdataEscape } from "@/lib/llm/prompts/json-shape";

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
  scopeId?: string;
}

export interface OrchestratorResult {
  mode: InsightRunMode;
  clustersCreated: number;
  evidenceUsed: number;
  promptHash: string;
  contextUsed: boolean;
}

async function ensureEmbeddings(db: Tx, accountId: string, scopeId?: string): Promise<number> {
  const scopeWhere = withScopeFilter(scopeId ?? null, evidence.scopeId);
  const missing = await db
    .select({ id: evidence.id, content: evidence.content })
    .from(evidence)
    .leftJoin(evidenceEmbeddings, eq(evidenceEmbeddings.evidenceId, evidence.id))
    .where(
      and(
        eq(evidence.accountId, accountId),
        eq(evidence.excluded, false),
        eq(evidence.exclusionPending, false),
        isNull(evidenceEmbeddings.evidenceId),
        scopeWhere,
      ),
    );

  if (missing.length === 0) return 0;

  const vectors = await embed(missing.map((r) => r.content));
  let inserted = 0;

  for (let i = 0; i < missing.length; i++) {
    const vector = vectors[i];
    if (!vector) continue;
    await db
      .insert(evidenceEmbeddings)
      .values({
        evidenceId: missing[i]!.id,
        embedding: vector,
        model: "text-embedding-3-small",
      })
      .onConflictDoNothing();
    inserted++;
  }

  return inserted;
}

export async function runClustering(
  ctx: OrchestratorContext,
  opts: CompleteOpts = {},
  runId?: string,
): Promise<OrchestratorResult> {
  const lockKey = ctx.scopeId
    ? `cluster:${ctx.accountId}:${ctx.scopeId}`
    : `cluster:${ctx.accountId}`;
  await ctx.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );

  // Backfill any evidence rows missing embeddings (deferred embed
  // that Inngest never processed). Runs before the clustering branch
  // decision so both full and incremental paths see a complete set.
  await ensureEmbeddings(ctx.db, ctx.accountId, ctx.scopeId);

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
  const scopeClusterWhere = withScopeFilter(ctx.scopeId ?? null, insightClusters.scopeId);
  await ctx.db
    .delete(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
        eq(insightClusters.frequency, 0),
        scopeClusterWhere,
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

  const dismissedLabels = await loadDismissedLabels(ctx.db, ctx.accountId, ctx.scopeId);
  let effectiveProductContext = productContextBlock;
  if (dismissedLabels.length > 0) {
    const dismissedBlock = dismissedLabels
      .map((d) => {
        const reasonSuffix = d.reason ? ` (reason: ${cdataEscape(d.reason)})` : "";
        return `- ${cdataEscape(d.label)}${reasonSuffix}`;
      })
      .join("\n");
    const block = `<dismissed-patterns>\nThe following patterns were previously dismissed by this PM as not relevant. Do NOT resurface these themes or create clusters similar to them:\n${dismissedBlock}\n</dismissed-patterns>`;
    effectiveProductContext = effectiveProductContext
      ? `${effectiveProductContext}\n\n${block}`
      : block;
  }

  const [clusterCountRow] = await ctx.db
    .select({ n: count() })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
        gt(insightClusters.frequency, 0),
        scopeClusterWhere,
      ),
    );

  const existingClusters = Number(clusterCountRow?.n ?? 0);

  // Cold start: zero live clusters → run the full path once to seed,
  // then fall through to the incremental loop below to pick up any
  // evidence left over after the full path's diversity sample. The
  // full path caps at MAX_EVIDENCE_PER_RUN (50); with a 200-row
  // corpus, 150 rows are still unattached after the seed call, and
  // the incremental chunk loop handles them under the same advisory
  // lock + tx.
  let mode: InsightRunMode = "incremental";
  let totalClustersCreated = 0;
  let totalEvidenceUsed = 0;
  let lastPromptHash = "";
  // Track every cluster id created during this runClustering call so
  // the consolidation pass at the end can pick from them. Includes
  // NEW clusters and non-first SPLIT children from every apply.
  const createdThisRun = new Set<string>();

  if (existingClusters === 0) {
    mode = "full";
    await deleteAllClustersForAccount(ctx.db, ctx.accountId, ctx.scopeId);
    const { plan, evidenceUsed, promptHash } = await runFullClustering(
      { db: ctx.db, accountId: ctx.accountId, scopeId: ctx.scopeId },
      mergedOpts,
      effectiveProductContext,
    );
    const { clustersCreated, createdClusterIds } = await applyClusterActions(
      ctx.db,
      plan,
      ctx.accountId,
      promptHash,
      contextUsed,
      { scopeId: ctx.scopeId },
    );
    totalClustersCreated += clustersCreated;
    totalEvidenceUsed += evidenceUsed;
    lastPromptHash = promptHash;
    for (const id of createdClusterIds) createdThisRun.add(id);
  }

  // Incremental loop. Runs:
  //   - after a cold-start full pass to mop up any leftovers
  //   - as the only path when existingClusters > 0
  //
  // Chunks of MAX_CANDIDATES_PER_RUN (50) per LLM call. A PM pasting
  // 200 new transcripts shouldn't see a "too much at once" throw —
  // the orchestrator quietly chunks until either nothing is left or
  // the safety cap (MAX_INCREMENTAL_CHUNKS = 5) kicks in. Above that
  // something is unusual (bulk import? broken dedupe?) and a partial
  // pass beats blowing the LLM budget. Leftovers stay unattached and
  // pick up on the next run.
  for (let chunk = 0; chunk < MAX_INCREMENTAL_CHUNKS; chunk += 1) {
    let chunkResult: Awaited<ReturnType<typeof runIncrementalClustering>>;
    try {
      chunkResult = await runIncrementalClustering(
        { db: ctx.db, accountId: ctx.accountId, scopeId: ctx.scopeId },
        mergedOpts,
        productContextBlock,
      );
    } catch (err) {
      // The only expected throw at this point is "no live clusters"
      // — happens iff the cold-start full call above produced zero
      // clusters from zero evidence. In that case there's nothing
      // for incremental to do anyway. Re-throw anything else.
      if (
        err instanceof Error &&
        err.message.includes("no live clusters")
      ) {
        break;
      }
      throw err;
    }
    const { plan, evidenceUsed, promptHash, candidatesRemaining } =
      chunkResult;
    lastPromptHash = promptHash;
    const { clustersCreated, createdClusterIds } = await applyClusterActions(
      ctx.db,
      plan,
      ctx.accountId,
      promptHash,
      contextUsed,
      { scopeId: ctx.scopeId },
    );
    totalClustersCreated += clustersCreated;
    totalEvidenceUsed += evidenceUsed;
    for (const id of createdClusterIds) createdThisRun.add(id);
    // Stop early when the chunk was a no-op (zero candidates) or
    // when nothing remains. evidenceUsed===0 protects against an
    // infinite loop if a chunk somehow processes no candidates while
    // candidatesRemaining stays positive — shouldn't happen, but
    // belt-and-suspenders for a loop under a long-held advisory lock.
    if (evidenceUsed === 0 || candidatesRemaining === 0) break;
  }

  // Consolidation pass: fold any micro-clusters (frequency < MIN)
  // created during this run into their nearest non-created sibling
  // if the centroid sim is high enough. Runs at most once per
  // runClustering call. Skips downstream-stale fan-out because we
  // already fired it for any real MERGE/SPLIT/tombstone above and
  // re-firing on the consolidation MERGEs would train PMs to ignore
  // the banner.
  if (createdThisRun.size > 0 && lastPromptHash) {
    await runConsolidationPass(
      { db: ctx.db, accountId: ctx.accountId },
      createdThisRun,
      lastPromptHash,
    );
  }

  if (dismissedLabels.length > 0) {
    await decayExclusions(ctx.db, ctx.accountId);
  }

  return {
    mode,
    clustersCreated: totalClustersCreated,
    evidenceUsed: totalEvidenceUsed,
    promptHash: lastPromptHash,
    contextUsed,
  };
}

const MAX_INCREMENTAL_CHUNKS = 5;
