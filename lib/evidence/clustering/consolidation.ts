import { and, eq, inArray, isNull, not } from "drizzle-orm";
import { insightClusters } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import { applyClusterActions } from "./apply";
import type { ClusterPlan } from "./actions";
import { cosineSim } from "./knn";
import { CLUSTERING_THRESHOLDS } from "./thresholds";

/*
  Post-apply consolidation pass.

  The LLM occasionally spawns a NEW cluster with just one supporting
  evidence row — usually a piece that didn't quite fit any existing
  theme but wasn't different enough to warrant its own pain point.
  Prompt updates ask it to avoid singletons; consolidation is the
  safety net for the cases that slip through.

  How it works:
    1. Of the clusters created this run, pick the micro-clusters
       (frequency < MIN_CLUSTER_SIZE).
    2. For each, find the nearest non-tombstoned cluster (excluding
       OTHER same-run-created clusters — we only merge into clusters
       that existed before this run, never two new micro-clusters
       into each other).
    3. If that nearest cluster has cosine sim ≥ CONSOLIDATION_MERGE_SIM,
       emit a synthetic MERGE (micro into nearest).
    4. Apply via the same apply.ts write path with
       `skipDownstreamStale: true` — we don't want every consolidation
       to re-banner opportunities that were just linked.

  Runs AT MOST ONCE per runClustering call. No re-entrancy. Inside
  the caller's advisory lock + tx, so a throw here rolls back the
  full re-cluster.
*/

export interface ConsolidationContext {
  db: Tx;
  accountId: string;
}

export interface ConsolidationResult {
  /** Micro-clusters that found a home and got merged in. */
  consolidated: number;
  /** Micro-clusters with no neighbour above the threshold; left alone. */
  unmerged: number;
}

export async function runConsolidationPass(
  ctx: ConsolidationContext,
  createdClusterIds: ReadonlySet<string>,
  promptHash: string,
): Promise<ConsolidationResult> {
  if (createdClusterIds.size === 0) {
    return { consolidated: 0, unmerged: 0 };
  }

  // Load every freshly-created cluster's centroid + frequency. Filter
  // to micro-clusters in-memory — cheaper than a CASE clause and
  // there are at most a handful.
  const createdList = Array.from(createdClusterIds);
  const candidates = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
      frequency: insightClusters.frequency,
      centroid: insightClusters.centroid,
    })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        inArray(insightClusters.id, createdList),
        isNull(insightClusters.tombstonedInto),
      ),
    );

  const micros = candidates.filter(
    (c): c is typeof c & { centroid: number[] } =>
      c.frequency < CLUSTERING_THRESHOLDS.MIN_CLUSTER_SIZE &&
      Array.isArray(c.centroid),
  );

  if (micros.length === 0) {
    return { consolidated: 0, unmerged: 0 };
  }

  // Load every other non-tombstoned cluster with a centroid that
  // could serve as a merge target. Exclude the freshly-created set —
  // we never fold two same-run micro-clusters into each other (that
  // would chain merges in unpredictable ways under one tx).
  const targets = await ctx.db
    .select({
      id: insightClusters.id,
      centroid: insightClusters.centroid,
    })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
        not(inArray(insightClusters.id, createdList)),
      ),
    );

  const targetsWithCentroid = targets.filter(
    (t): t is typeof t & { centroid: number[] } => Array.isArray(t.centroid),
  );

  if (targetsWithCentroid.length === 0) {
    // Nothing to merge into. Common on cold-start when the first run
    // produced only micro-clusters — leave them alone, the next run
    // will revisit.
    return { consolidated: 0, unmerged: micros.length };
  }

  // For each micro-cluster, pick the single best target above the
  // CONSOLIDATION_MERGE_SIM bar. Skip if no target qualifies.
  type ConsolidationMerge = {
    winnerId: string;
    loserId: string;
    title: string;
    description: string;
  };
  const merges: ConsolidationMerge[] = [];
  let unmerged = 0;
  for (const micro of micros) {
    let bestId: string | null = null;
    let bestSim = -Infinity;
    for (const target of targetsWithCentroid) {
      const sim = cosineSim(micro.centroid, target.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestId = target.id;
      }
    }
    if (bestId === null || bestSim < CLUSTERING_THRESHOLDS.CONSOLIDATION_MERGE_SIM) {
      unmerged += 1;
      continue;
    }
    merges.push({
      winnerId: bestId,
      loserId: micro.id,
      // Keep the target's existing title/description — the LLM
      // already wrote those when the target cluster was created or
      // last touched. The micro-cluster's title/description is
      // discarded along with the row.
      title: "",
      description: "",
    });
  }

  if (merges.length === 0) {
    return { consolidated: 0, unmerged };
  }

  // Group losers by winner so apply.ts sees one MERGE per target.
  // Two micro-clusters that pick the same winner collapse into a
  // single MERGE with both losers — cheaper than two separate apply
  // passes, identical end state.
  const grouped = new Map<string, ConsolidationMerge[]>();
  for (const m of merges) {
    const list = grouped.get(m.winnerId) ?? [];
    list.push(m);
    grouped.set(m.winnerId, list);
  }

  // Fetch the current title/description for each winner so we can
  // re-pass it through apply (apply.ts overwrites the winner's
  // title + description from the MERGE entry, so we must echo back
  // the original to avoid clobbering it).
  const winnerIds = Array.from(grouped.keys());
  const winners = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
    })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        inArray(insightClusters.id, winnerIds),
      ),
    );
  const winnerById = new Map(winners.map((w) => [w.id, w]));

  const plan: ClusterPlan = {
    keeps: [],
    merges: Array.from(grouped.entries()).map(([winnerId, entries]) => {
      const w = winnerById.get(winnerId);
      return {
        winnerId,
        loserIds: entries.map((e) => e.loserId),
        newTitle: w?.title ?? "",
        newDescription: w?.description ?? "",
      };
    }),
    splits: [],
    newClusters: [],
    centroidsToRecompute: new Set(winnerIds),
  };

  await applyClusterActions(
    ctx.db,
    plan,
    ctx.accountId,
    promptHash,
    undefined,
    { skipDownstreamStale: true },
  );

  return { consolidated: merges.length, unmerged };
}
