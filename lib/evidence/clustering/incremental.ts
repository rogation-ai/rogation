import { and, desc, eq, gt, isNull, inArray } from "drizzle-orm";
import {
  evidence,
  evidenceEmbeddings,
  evidenceToCluster,
  insightClusters,
} from "@/db/schema";
import type { Tx } from "@/db/scoped";
import { complete, type CompleteOpts } from "@/lib/llm/router";
import {
  synthesisIncremental,
  type SynthesisIncrementalInput,
} from "@/lib/llm/prompts/synthesis-incremental";
import {
  planClusterActions,
  type ClusterPlan,
  type IncrementalInputState,
  type PlanKeep,
} from "./actions";
import { cosineSim, nearestClusters } from "./knn";
import { CLUSTERING_THRESHOLDS } from "./thresholds";
import { ClusteringError } from "./errors";
import { withScopeFilter } from "@/lib/evidence/scope-filter";

/*
  Incremental clustering (Phase B).

  Unlike runFullClustering, this path PRESERVES cluster ids across
  runs. New evidence that clearly fits an existing cluster attaches
  to it via KEEP — no LLM call, no churn. Uncertain + NEW-candidate
  evidence goes to the LLM, which emits KEEP / MERGE / SPLIT / NEW
  actions against existing cluster + candidate labels. The plan
  translator (planClusterActions from actions.ts) converts those to
  uuid-space, then applyClusterActions executes the writes.

  Flow:
    1. Load existing live (non-tombstoned) clusters + centroids.
    2. Load all evidence + embeddings. Any missing embedding →
       throw embeddings_pending; the worker maps that to a friendly
       "still embedding — retry in ~30s" UI message.
    3. Partition: evidence already attached vs. unattached. Only
       unattached evidence becomes a candidate for this run.
    4. For each candidate: cosine-score vs every cluster centroid.
       Bucket by design-§6 thresholds:
         sim ≥ HIGH_CONF   → auto-attach KEEP (skip LLM)
         LOW_CONF ≤ sim    → uncertain (goes to LLM)
         sim < LOW_CONF    → NEW-candidate (goes to LLM)
    5. Build SynthesisIncrementalInput with:
         - up to MAX_REPRESENTATIVE_QUOTES evidence rows per cluster
         - uncertain + NEW-candidates with top-2 KNN hints
    6. Call synthesisIncremental, plan the result, merge in the
       HIGH_CONF auto-attaches from step 4 (dedupe against any KEEP
       the LLM emitted on the same cluster).
    7. Return { plan, usage }. The caller (orchestrator) applies.

  Caps (design §8): 50 clusters × 3 evidence in prompt + 50
  candidates. Over-cap throws — either upload fewer rows at once or
  wait for Phase C.
*/

const MAX_CLUSTERS_IN_PROMPT = 50;
const MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER = 6;
const MAX_CANDIDATES_PER_RUN = 50;
const KNN_HINT_COUNT = 4;

export interface IncrementalContext {
  db: Tx;
  accountId: string;
  scopeId?: string;
}

export interface IncrementalResult {
  plan: ClusterPlan;
  evidenceUsed: number;
  promptHash: string;
  /** Candidates auto-attached via KNN without calling the LLM. */
  autoAttached: number;
  /** Candidates that went into the LLM prompt (uncertain + NEW). */
  sentToLlm: number;
  /**
   * Candidates left over after this run hit MAX_CANDIDATES_PER_RUN.
   * The orchestrator inspects this to decide whether to loop another
   * chunk. Zero means "nothing left, run is complete."
   */
  candidatesRemaining: number;
}

export async function runIncrementalClustering(
  ctx: IncrementalContext,
  opts: CompleteOpts = {},
  productContext?: string,
): Promise<IncrementalResult> {
  // 1. Load live clusters + centroids.
  const scopeClusterWhere = withScopeFilter(ctx.scopeId ?? null, insightClusters.scopeId);
  const existingClusters = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
      severity: insightClusters.severity,
      frequency: insightClusters.frequency,
      createdAt: insightClusters.createdAt,
      centroid: insightClusters.centroid,
    })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
        gt(insightClusters.frequency, 0),
        scopeClusterWhere,
      ),
    )
    .orderBy(desc(insightClusters.frequency))
    .limit(MAX_CLUSTERS_IN_PROMPT + 1);

  if (existingClusters.length === 0) {
    throw new Error(
      "runIncrementalClustering: no live clusters. Use runFullClustering for cold start.",
    );
  }
  if (existingClusters.length > MAX_CLUSTERS_IN_PROMPT) {
    throw new Error(
      `runIncrementalClustering: account has more than ${MAX_CLUSTERS_IN_PROMPT} live clusters; prompt budget exceeded`,
    );
  }

  // 2. Load all evidence + embeddings for this scope.
  const scopeEvidenceWhere = withScopeFilter(ctx.scopeId ?? null, evidence.scopeId);
  const evidenceRows = await ctx.db
    .select({
      id: evidence.id,
      content: evidence.content,
      createdAt: evidence.createdAt,
      embedding: evidenceEmbeddings.embedding,
    })
    .from(evidence)
    .leftJoin(
      evidenceEmbeddings,
      eq(evidenceEmbeddings.evidenceId, evidence.id),
    )
    .where(and(eq(evidence.accountId, ctx.accountId), scopeEvidenceWhere));

  // Validate each row's embedding shape before narrowing. A blanket
  // `as` cast would silently pass non-array values from a driver
  // quirk, and downstream cosineSim would return NaN. Check both the
  // null case (row actually missing an embedding) and the shape case
  // (wrong dimension or wrong type).
  const EMBED_DIM = 1536;
  const evidenceWithEmbedding: Array<{
    id: string;
    content: string;
    createdAt: Date;
    embedding: number[];
  }> = [];
  for (const r of evidenceRows) {
    if (r.embedding === null) {
      throw new ClusteringError(
        "embeddings_pending",
        `evidence ${r.id} has no embedding yet; retry after embeddings complete`,
      );
    }
    if (!Array.isArray(r.embedding) || r.embedding.length !== EMBED_DIM) {
      throw new ClusteringError(
        "centroid_stale",
        `evidence ${r.id} has malformed embedding (expected number[${EMBED_DIM}])`,
      );
    }
    evidenceWithEmbedding.push({
      id: r.id,
      content: r.content,
      createdAt: r.createdAt,
      embedding: r.embedding,
    });
  }

  // 3. Partition: attached (already in a cluster) vs. candidates.
  const attachedIds = new Set(
    (
      await ctx.db
        .select({ evidenceId: evidenceToCluster.evidenceId })
        .from(evidenceToCluster)
        .innerJoin(
          insightClusters,
          eq(insightClusters.id, evidenceToCluster.clusterId),
        )
        .where(
          and(
            eq(insightClusters.accountId, ctx.accountId),
            isNull(insightClusters.tombstonedInto),
          ),
        )
    ).map((r) => r.evidenceId),
  );

  // Candidates are evidence rows not yet attached to any live cluster.
  // We process up to MAX_CANDIDATES_PER_RUN per call; the orchestrator
  // loops if more remain (capped at MAX_CHUNKS to bound LLM cost). The
  // ordering here (createdAt DESC from the earlier query) means newest
  // evidence gets clustered first — fine because re-running the
  // orchestrator picks up the leftover on the next chunk.
  const allCandidates = evidenceWithEmbedding.filter(
    (e) => !attachedIds.has(e.id),
  );
  const candidates = allCandidates.slice(0, MAX_CANDIDATES_PER_RUN);
  const candidatesRemaining = Math.max(
    0,
    allCandidates.length - candidates.length,
  );

  if (candidates.length === 0) {
    // Nothing new to cluster — return a no-op plan. Still a valid
    // run so the orchestrator writes a clean insight_run row.
    return {
      plan: emptyPlan(),
      evidenceUsed: 0,
      promptHash: synthesisIncremental.hash,
      autoAttached: 0,
      sentToLlm: 0,
      candidatesRemaining: 0,
    };
  }

  // 4. KNN bucketing against existing cluster centroids.
  const clustersWithCentroid = existingClusters.filter(
    (c): c is typeof c & { centroid: number[] } => c.centroid !== null,
  );

  const autoAttaches: Array<{ clusterId: string; evidenceId: string }> = [];
  const forLlm: Array<{
    id: string;
    content: string;
    knnNearest: string[];
  }> = [];

  // Label every cluster C1, C2, ... for the LLM prompt + plan
  // translation. Order matches existingClusters order (freq desc).
  const clusterLabels = new Map<string, string>();
  existingClusters.forEach((c, i) => clusterLabels.set(c.id, `C${i + 1}`));

  for (const cand of candidates) {
    if (clustersWithCentroid.length === 0) {
      // No centroids at all — every candidate is uncertain.
      forLlm.push({ id: cand.id, content: cand.content, knnNearest: [] });
      continue;
    }
    const topK = nearestClusters(
      cand.embedding,
      clustersWithCentroid.map((c) => ({ id: c.id, centroid: c.centroid })),
      KNN_HINT_COUNT,
    );
    const best = topK[0];
    if (best && best.sim >= CLUSTERING_THRESHOLDS.HIGH_CONF) {
      autoAttaches.push({ clusterId: best.id, evidenceId: cand.id });
    } else {
      // Uncertain (LOW_CONF ≤ sim < HIGH_CONF) and genuinely-new
      // (sim < LOW_CONF) both go to the LLM with the same knn_nearest
      // hint. The distinction exists in the threshold semantics but
      // not in the prompt input — the LLM inspects the evidence and
      // decides KEEP vs NEW vs SPLIT on its own, informed by the hint.
      forLlm.push({
        id: cand.id,
        content: cand.content,
        knnNearest: topK
          .map((h) => clusterLabels.get(h.id))
          .filter((l): l is string => l !== undefined),
      });
    }
  }

  // Short-circuit: if every candidate auto-attached, skip the LLM
  // call entirely. Save tokens; still produce a valid plan.
  if (forLlm.length === 0) {
    const keeps = buildAutoAttachKeeps(autoAttaches);
    return {
      plan: {
        keeps,
        merges: [],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set(keeps.map((k) => k.clusterId)),
      },
      evidenceUsed: autoAttaches.length,
      promptHash: synthesisIncremental.hash,
      autoAttached: autoAttaches.length,
      sentToLlm: 0,
      candidatesRemaining,
    };
  }

  // 5. Build the LLM input. Sample MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER
  //    centroid-nearest quotes per cluster (with fallback to recency
  //    for clusters whose centroid hasn't been backfilled yet). Label
  //    candidates E1, E2, ... and build a reverse map.
  const clusterCentroidById = new Map<string, number[]>();
  for (const c of clustersWithCentroid) clusterCentroidById.set(c.id, c.centroid);
  const clusterIdsForQuotes = existingClusters.map((c) => c.id);
  const representativeQuotes = await loadRepresentativeQuotes(
    ctx,
    clusterIdsForQuotes,
    clusterCentroidById,
  );

  let evidenceCounter = 0;
  const evidenceLabelToId = new Map<string, string>();

  const llmInput: SynthesisIncrementalInput = {
    productContext,
    existing: existingClusters.map((c) => {
      const quotes = representativeQuotes.get(c.id) ?? [];
      return {
        label: clusterLabels.get(c.id)!,
        title: c.title,
        description: c.description,
        severity: c.severity,
        evidence: quotes.map((q) => {
          evidenceCounter += 1;
          const label = `E${evidenceCounter}`;
          evidenceLabelToId.set(label, q.id);
          return { label, content: q.content };
        }),
      };
    }),
    candidates: forLlm.map((cand) => {
      evidenceCounter += 1;
      const label = `E${evidenceCounter}`;
      evidenceLabelToId.set(label, cand.id);
      return {
        label,
        content: cand.content,
        knnNearest: cand.knnNearest.length > 0 ? cand.knnNearest : undefined,
      };
    }),
  };

  // 6. Call the LLM.
  const { output } = await complete(synthesisIncremental, llmInput, {
    cache: true,
    ...opts,
  });

  // 7. Translate label-space output to uuid-space plan.
  const state: IncrementalInputState = {
    clusters: new Map(
      existingClusters.map((c) => [
        clusterLabels.get(c.id)!,
        {
          id: c.id,
          frequency: c.frequency,
          createdAt: c.createdAt,
        },
      ]),
    ),
    evidenceLabelToId,
  };

  const llmPlan = planClusterActions(output, state);

  // 8. Merge HIGH_CONF auto-attaches with the LLM-emitted plan.
  //    Group by clusterId. If the LLM also emitted a KEEP on the
  //    same cluster, merge evidence lists (dedupe).
  const mergedKeeps = mergeAutoAttaches(llmPlan.keeps, autoAttaches);

  const plan: ClusterPlan = {
    keeps: mergedKeeps,
    merges: llmPlan.merges,
    splits: llmPlan.splits,
    newClusters: llmPlan.newClusters,
    centroidsToRecompute: new Set([
      ...llmPlan.centroidsToRecompute,
      ...autoAttaches.map((a) => a.clusterId),
    ]),
  };

  return {
    plan,
    evidenceUsed: autoAttaches.length + forLlm.length,
    promptHash: synthesisIncremental.hash,
    autoAttached: autoAttaches.length,
    sentToLlm: forLlm.length,
    candidatesRemaining,
  };
}

function emptyPlan(): ClusterPlan {
  return {
    keeps: [],
    merges: [],
    splits: [],
    newClusters: [],
    centroidsToRecompute: new Set(),
  };
}

function buildAutoAttachKeeps(
  autoAttaches: Array<{ clusterId: string; evidenceId: string }>,
): PlanKeep[] {
  const byCluster = new Map<string, string[]>();
  for (const a of autoAttaches) {
    const list = byCluster.get(a.clusterId) ?? [];
    list.push(a.evidenceId);
    byCluster.set(a.clusterId, list);
  }
  return Array.from(byCluster.entries()).map(([clusterId, evidenceIds]) => ({
    clusterId,
    newTitle: null,
    newDescription: null,
    attachEvidenceIds: evidenceIds,
  }));
}

function mergeAutoAttaches(
  llmKeeps: PlanKeep[],
  autoAttaches: Array<{ clusterId: string; evidenceId: string }>,
): PlanKeep[] {
  if (autoAttaches.length === 0) return llmKeeps;

  const byCluster = new Map<string, PlanKeep>();
  for (const k of llmKeeps) byCluster.set(k.clusterId, { ...k });

  for (const a of autoAttaches) {
    const existing = byCluster.get(a.clusterId);
    if (existing) {
      if (!existing.attachEvidenceIds.includes(a.evidenceId)) {
        existing.attachEvidenceIds.push(a.evidenceId);
      }
    } else {
      byCluster.set(a.clusterId, {
        clusterId: a.clusterId,
        newTitle: null,
        newDescription: null,
        attachEvidenceIds: [a.evidenceId],
      });
    }
  }

  return Array.from(byCluster.values());
}

/**
 * For each cluster, return up to MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER
 * representative quotes. With a centroid available, "representative"
 * means "highest cosine similarity to the cluster's centroid" — the
 * quotes that most define the theme. Without a centroid (newly-
 * created cluster whose backfill hasn't run, or a transient gap),
 * fall back to recency.
 *
 * We pull at most MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER * 4 rows per
 * cluster (sorted by recency) before scoring against centroids. The
 * window cap avoids loading 500 attached rows just to pick six — and
 * recency is a fine seed for "which rows are likely still relevant"
 * within a cluster that's been growing over time.
 */
const QUOTE_CANDIDATE_WINDOW_MULTIPLIER = 4;

async function loadRepresentativeQuotes(
  ctx: IncrementalContext,
  clusterIds: string[],
  centroidsById: ReadonlyMap<string, number[]>,
): Promise<Map<string, Array<{ id: string; content: string }>>> {
  const result = new Map<string, Array<{ id: string; content: string }>>();
  if (clusterIds.length === 0) return result;

  const windowSize =
    MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER * QUOTE_CANDIDATE_WINDOW_MULTIPLIER;

  // Load embeddings alongside content so we can score against the
  // cluster centroid. The LEFT JOIN tolerates the rare case where
  // an attached evidence row's embedding isn't yet present — the
  // centroid path skips those, recency path keeps them.
  const rows = await ctx.db
    .select({
      clusterId: evidenceToCluster.clusterId,
      evidenceId: evidence.id,
      content: evidence.content,
      createdAt: evidence.createdAt,
      embedding: evidenceEmbeddings.embedding,
    })
    .from(evidenceToCluster)
    .innerJoin(evidence, eq(evidence.id, evidenceToCluster.evidenceId))
    .leftJoin(
      evidenceEmbeddings,
      eq(evidenceEmbeddings.evidenceId, evidence.id),
    )
    .where(inArray(evidenceToCluster.clusterId, clusterIds))
    .orderBy(desc(evidence.createdAt));

  // Bucket up to windowSize rows per cluster (recency-ordered from
  // the query). The sort + slice happens per cluster below.
  const perCluster = new Map<
    string,
    Array<{ id: string; content: string; embedding: number[] | null }>
  >();
  for (const row of rows) {
    const bucket = perCluster.get(row.clusterId) ?? [];
    if (bucket.length < windowSize) {
      bucket.push({
        id: row.evidenceId,
        content: row.content,
        embedding: Array.isArray(row.embedding) ? row.embedding : null,
      });
      perCluster.set(row.clusterId, bucket);
    }
  }

  for (const [clusterId, bucket] of perCluster) {
    const centroid = centroidsById.get(clusterId);
    if (!centroid) {
      // No centroid — keep recency ordering (already in the bucket).
      result.set(
        clusterId,
        bucket
          .slice(0, MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER)
          .map(({ id, content }) => ({ id, content })),
      );
      continue;
    }
    // Score every windowed row against the centroid; rows missing an
    // embedding score as -Infinity so they drop to the back. If the
    // centroid path leaves fewer than K rows because too many lack
    // embeddings, the recency tail still fills the slot.
    const scored = bucket.map((b) => ({
      id: b.id,
      content: b.content,
      sim: b.embedding ? cosineSim(centroid, b.embedding) : -Infinity,
    }));
    scored.sort((a, b) => b.sim - a.sim);
    result.set(
      clusterId,
      scored
        .slice(0, MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER)
        .map(({ id, content }) => ({ id, content })),
    );
  }

  return result;
}

// Export for tests.
export const INTERNAL = {
  buildAutoAttachKeeps,
  mergeAutoAttaches,
  cosineSim,
};
