/*
  Pure vector math for KNN-based incremental clustering.

  The "real" KNN happens in Postgres via the partial HNSW index on
  insight_cluster.centroid (migration 0006). These helpers are the
  in-memory primitives used for:
    - computing centroids before writing them back to the DB
    - post-query ranking when we fetch a handful of candidates
    - unit tests that exercise the math without a DB round-trip

  All vectors are 1536-d (matches OpenAI text-embedding-3-small, the
  model wired in lib/llm/router.ts). The functions accept any length
  as long as the inputs agree — enforced per-call, not at the type
  level, because JS number[] has no dim information to check against.
*/

import { ClusteringError } from "./errors";

/**
 * Element-wise mean of N equal-length vectors. Throws on empty input
 * (a cluster with zero evidence has no meaningful centroid) and on
 * dimension mismatch (would silently produce garbage otherwise).
 */
export function centroidOf(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new ClusteringError(
      "centroid_stale",
      "centroidOf: cannot compute centroid of zero vectors",
    );
  }
  const dim = vectors[0]!.length;
  if (dim === 0) {
    throw new ClusteringError(
      "centroid_stale",
      "centroidOf: vectors must be non-empty",
    );
  }

  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new ClusteringError(
        "centroid_stale",
        `centroidOf: dimension mismatch (expected ${dim}, got ${v.length})`,
      );
    }
    for (let i = 0; i < dim; i++) {
      sum[i] = sum[i]! + v[i]!;
    }
  }
  const n = vectors.length;
  return sum.map((s) => s / n);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector is zero
 * (would otherwise divide by zero). Callers that care about the
 * distinction can check for an all-zero vector themselves.
 */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new ClusteringError(
      "centroid_stale",
      `cosineSim: dimension mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface CentroidCandidate {
  id: string;
  centroid: number[];
}

export interface KnnHit {
  id: string;
  sim: number;
}

/**
 * Rank candidates by similarity to queryVec, return top `k` descending.
 * Used after a pgvector query returns ~k+buffer candidates and we need
 * a stable in-memory ranker (pgvector returns ordered but we may
 * post-filter, e.g. exclude tombstones the index already skips).
 */
export function nearestClusters(
  queryVec: number[],
  candidates: CentroidCandidate[],
  k: number,
): KnnHit[] {
  if (k <= 0) return [];
  const scored = candidates.map((c) => ({
    id: c.id,
    sim: cosineSim(queryVec, c.centroid),
  }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k);
}
