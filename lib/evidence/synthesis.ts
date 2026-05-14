import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import {
  evidence,
  evidenceEmbeddings,
  evidenceToCluster,
  insightClusters,
} from "@/db/schema";
import { complete, type CompleteOpts } from "@/lib/llm/router";
import {
  synthesisCluster,
  type SynthesisOutput,
} from "@/lib/llm/prompts/synthesis-cluster";
import type { Tx } from "@/db/scoped";
import {
  assertLabelsResolve,
  dedupeAssignmentsAcrossActions,
} from "@/lib/evidence/clustering/validators";
import { farthestFirstIndices } from "@/lib/evidence/clustering/knn";
import type { ClusterPlan } from "@/lib/evidence/clustering/actions";
import { withScopeFilter, type ScopeFilter } from "@/lib/evidence/scope-filter";

/*
  Full-corpus clustering — Phase A path, now refactored to emit a
  ClusterPlan that the shared applyClusterActions executor consumes.
  Same LLM contract (synthesis.cluster.v1), same input shape, same
  per-evidence label mapping — only the write half moved out.

  Why the seam: Lane D adds an incremental clustering path
  (lib/evidence/clustering/incremental.ts). Both paths produce a
  ClusterPlan; apply.ts is the single DB writer for both. That means:
    - stale wiring + centroid recompute are consistent regardless of
      which path produced the plan
    - prompt_hash captured on every newly written row is always the
      hash of the prompt that actually built the row
    - tests unit-test the plan translator without a DB and
      integration-test the apply step against a real DB

  When to use: cold-start path when no existing clusters exist and
  evidence count <= 50. The orchestrator (clustering/orchestrator.ts)
  decides; callers should not pick between full + incremental
  directly.
*/

const MAX_EVIDENCE_PER_RUN = 50;

export interface SynthesisContext {
  db: Tx;
  accountId: string;
  scopeId?: ScopeFilter;
}

export interface SynthesisResult {
  plan: ClusterPlan;
  evidenceUsed: number;
  promptHash: string;
}

export async function runFullClustering(
  ctx: SynthesisContext,
  opts: CompleteOpts = {},
  productContext?: string,
): Promise<SynthesisResult> {
  // Load every evidence row + its embedding. We need embeddings any
  // time the corpus is larger than the per-run cap so we can pick a
  // representative sample via farthest-first traversal (diversity
  // sampling) instead of the 50 newest, which would skew toward
  // whatever the PM uploaded last and miss the shape of the corpus.
  const scopeWhere = withScopeFilter(ctx.scopeId ?? null, evidence.scopeId);
  const rows = await ctx.db
    .select({
      id: evidence.id,
      content: evidence.content,
      embedding: evidenceEmbeddings.embedding,
    })
    .from(evidence)
    .leftJoin(
      evidenceEmbeddings,
      eq(evidenceEmbeddings.evidenceId, evidence.id),
    )
    .where(
      and(
        eq(evidence.accountId, ctx.accountId),
        eq(evidence.excluded, false),
        eq(evidence.exclusionPending, false),
        scopeWhere,
      ),
    )
    .orderBy(desc(evidence.createdAt));

  if (rows.length === 0) {
    throw new Error("No evidence to cluster — upload at least 1 piece first");
  }

  // Pick the input set the LLM will see.
  // - Corpus fits in budget: take everything in recency order.
  // - Corpus is over budget AND every row has an embedding: FFT a
  //   diverse 50 across the whole corpus, then re-attach the rest
  //   via incremental on subsequent runs.
  // - Over budget but missing embeddings: degrade to the 50 newest
  //   (same behaviour as before) and log so we can chase the gap.
  let selectedRows: Array<{ id: string; content: string }>;
  if (rows.length <= MAX_EVIDENCE_PER_RUN) {
    selectedRows = rows.map((r) => ({ id: r.id, content: r.content }));
  } else {
    const allEmbedded = rows.every(
      (r): r is typeof r & { embedding: number[] } =>
        Array.isArray(r.embedding) && r.embedding.length > 0,
    );
    if (allEmbedded) {
      const pickedIndices = farthestFirstIndices(
        rows as Array<{ id: string; content: string; embedding: number[] }>,
        MAX_EVIDENCE_PER_RUN,
      );
      selectedRows = pickedIndices.map((i) => ({
        id: rows[i]!.id,
        content: rows[i]!.content,
      }));
    } else {
      Sentry.captureMessage("clustering_full_missing_embeddings", {
        level: "warning",
        extra: {
          total: rows.length,
          missing: rows.filter((r) => !Array.isArray(r.embedding)).length,
        },
      });
      selectedRows = rows
        .slice(0, MAX_EVIDENCE_PER_RUN)
        .map((r) => ({ id: r.id, content: r.content }));
    }
  }

  const labeled = selectedRows.map((r, i) => ({
    label: `E${i + 1}`,
    content: r.content,
    id: r.id,
  }));
  const labelToId = new Map(labeled.map((r) => [r.label, r.id]));

  const { output } = await complete(
    synthesisCluster,
    {
      evidence: labeled.map((r) => ({ label: r.label, content: r.content })),
      productContext,
    },
    { cache: true, ...opts },
  );

  // Defense at the label boundary. The shared validator throws
  // ClusteringError{code:"unknown_label"} on drift.
  const allLabelsInOutput = new Set(
    output.clusters.flatMap((c) => c.evidenceLabels),
  );
  assertLabelsResolve(
    allLabelsInOutput,
    new Set(labelToId.keys()),
    "evidence",
  );

  // Full-cluster translation: delete prior clusters first, then emit
  // everything as NEW. applyClusterActions handles the creates +
  // centroid compute + stale wiring. The delete step isn't
  // representable in the ClusterPlan shape (no DELETE action — we
  // tombstone instead of delete in the incremental path), so callers
  // of runFullClustering MUST wipe the account's clusters first if
  // they want a literal rebuild. The orchestrator does this before
  // calling apply.
  const plan = buildFullPlan(output, labelToId);

  return {
    plan,
    evidenceUsed: labeled.length,
    promptHash: synthesisCluster.hash,
  };
}

function buildFullPlan(
  output: SynthesisOutput,
  labelToId: Map<string, string>,
): ClusterPlan {
  // Dedupe across clusters: if the LLM emitted the same evidence
  // label in two clusters, keep the first occurrence. Mirrors the
  // incremental path's behaviour so the eval signal is parallel.
  // Without this the second insert silently no-ops via
  // onConflictDoNothing on the evidence_to_cluster PK; logging gives
  // us visibility into how often the LLM violates "exactly one
  // cluster per label."
  const labelLists = output.clusters.map((c) => [...c.evidenceLabels]);
  const dropped = dedupeAssignmentsAcrossActions(labelLists);
  if (dropped.length > 0) {
    Sentry.captureMessage("clustering_duplicate_label", {
      level: "warning",
      extra: { droppedLabels: dropped, path: "full" },
    });
  }

  // Every LLM-produced cluster is a NEW in the plan. The orchestrator
  // is responsible for wiping prior rows (design §5 — cold start
  // doesn't tombstone; it starts over).
  const newClusters = output.clusters.map((c, i) => ({
    title: c.title,
    description: c.description,
    severity: c.severity,
    evidenceIds: labelLists[i]!
      .map((label) => labelToId.get(label))
      .filter((id): id is string => id !== undefined),
  }));
  return {
    keeps: [],
    merges: [],
    splits: [],
    newClusters,
    centroidsToRecompute: new Set(),
  };
}

/**
 * Wipe every live cluster for the account. Used by the orchestrator
 * before running `runFullClustering` on a cold start — the full path
 * rebuilds from scratch, so prior rows are deleted (not tombstoned).
 *
 * Runs inside the caller's RLS-bound tx. `evidence_to_cluster`
 * cascades via FK.
 */
export async function deleteAllClustersForAccount(
  tx: Tx,
  accountId: string,
  scopeId?: string,
): Promise<void> {
  const scopeWhere = withScopeFilter(scopeId ?? null, insightClusters.scopeId);
  await tx
    .delete(insightClusters)
    .where(and(eq(insightClusters.accountId, accountId), scopeWhere));
}

/* ----------------------- read helpers for the router ----------------------- */

export interface ClusterListRow {
  id: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  frequency: number;
  updatedAt: Date;
}

export async function listClusters(
  ctx: SynthesisContext,
): Promise<ClusterListRow[]> {
  const scopeWhere = withScopeFilter(ctx.scopeId, insightClusters.scopeId);
  return ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
      severity: insightClusters.severity,
      frequency: insightClusters.frequency,
      updatedAt: insightClusters.updatedAt,
    })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
        gt(insightClusters.frequency, 0),
        scopeWhere,
      ),
    )
    .orderBy(desc(insightClusters.frequency));
}

export interface ClusterDetail extends ClusterListRow {
  quotes: Array<{ evidenceId: string; content: string }>;
}

export async function getClusterDetail(
  ctx: SynthesisContext,
  clusterId: string,
): Promise<ClusterDetail | null> {
  const [cluster] = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
      severity: insightClusters.severity,
      frequency: insightClusters.frequency,
      updatedAt: insightClusters.updatedAt,
    })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.id, clusterId),
        isNull(insightClusters.tombstonedInto),
        gt(insightClusters.frequency, 0),
      ),
    )
    .limit(1);

  if (!cluster) return null;

  const joins = await ctx.db
    .select({ evidenceId: evidenceToCluster.evidenceId })
    .from(evidenceToCluster)
    .where(eq(evidenceToCluster.clusterId, clusterId));

  const evidenceIds = joins.map((j) => j.evidenceId);
  const quotes =
    evidenceIds.length > 0
      ? await ctx.db
          .select({
            evidenceId: evidence.id,
            content: evidence.content,
          })
          .from(evidence)
          .where(inArray(evidence.id, evidenceIds))
      : [];

  return { ...cluster, quotes };
}
