import { and, desc, eq, isNull, inArray } from "drizzle-orm";
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
const MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER = 3;
const MAX_CANDIDATES_PER_RUN = 50;
const KNN_HINT_COUNT = 2;

export interface IncrementalContext {
  db: Tx;
  accountId: string;
}

export interface IncrementalResult {
  plan: ClusterPlan;
  evidenceUsed: number;
  promptHash: string;
  /** Candidates auto-attached via KNN without calling the LLM. */
  autoAttached: number;
  /** Candidates that went into the LLM prompt (uncertain + NEW). */
  sentToLlm: number;
}

export async function runIncrementalClustering(
  ctx: IncrementalContext,
  opts: CompleteOpts = {},
): Promise<IncrementalResult> {
  // 1. Load live clusters + centroids.
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

  // 2. Load all evidence + embeddings for this account.
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
    .where(eq(evidence.accountId, ctx.accountId));

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

  const candidates = evidenceWithEmbedding.filter(
    (e) => !attachedIds.has(e.id),
  );

  if (candidates.length > MAX_CANDIDATES_PER_RUN) {
    throw new Error(
      `runIncrementalClustering: ${candidates.length} candidate rows exceeds MAX_CANDIDATES_PER_RUN (${MAX_CANDIDATES_PER_RUN})`,
    );
  }

  if (candidates.length === 0) {
    // Nothing new to cluster — return a no-op plan. Still a valid
    // run so the orchestrator writes a clean insight_run row.
    return {
      plan: emptyPlan(),
      evidenceUsed: 0,
      promptHash: synthesisIncremental.hash,
      autoAttached: 0,
      sentToLlm: 0,
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
    };
  }

  // 5. Build the LLM input. Sample 3 representative quotes per
  //    cluster. Label candidates E1, E2, ... and build a reverse map.
  const clusterIdsForQuotes = existingClusters.map((c) => c.id);
  const representativeQuotes = await loadRepresentativeQuotes(
    ctx,
    clusterIdsForQuotes,
  );

  let evidenceCounter = 0;
  const evidenceLabelToId = new Map<string, string>();

  const llmInput: SynthesisIncrementalInput = {
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
 * For each cluster, fetch up to MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER
 * attached evidence rows, ordered by recency. "Representative" is a
 * stretch for 3 rows chosen by recency alone — the LLM gets enough
 * to grok the pain; better selection (centroid-nearest) is a Phase C
 * tuning opportunity.
 */
async function loadRepresentativeQuotes(
  ctx: IncrementalContext,
  clusterIds: string[],
): Promise<Map<string, Array<{ id: string; content: string }>>> {
  const result = new Map<string, Array<{ id: string; content: string }>>();
  if (clusterIds.length === 0) return result;

  const rows = await ctx.db
    .select({
      clusterId: evidenceToCluster.clusterId,
      evidenceId: evidence.id,
      content: evidence.content,
      createdAt: evidence.createdAt,
    })
    .from(evidenceToCluster)
    .innerJoin(evidence, eq(evidence.id, evidenceToCluster.evidenceId))
    .where(inArray(evidenceToCluster.clusterId, clusterIds))
    .orderBy(desc(evidence.createdAt));

  for (const row of rows) {
    const bucket = result.get(row.clusterId) ?? [];
    if (bucket.length < MAX_REPRESENTATIVE_QUOTES_PER_CLUSTER) {
      bucket.push({ id: row.evidenceId, content: row.content });
      result.set(row.clusterId, bucket);
    }
  }
  return result;
}

// Export for tests.
export const INTERNAL = {
  buildAutoAttachKeeps,
  mergeAutoAttaches,
  cosineSim,
};
