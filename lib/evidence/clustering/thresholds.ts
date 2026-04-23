/*
  Cosine-similarity thresholds for the incremental clustering path.

  Values are constants (not env vars) so every change is a commit and
  the eval baseline can be re-run against the old + new together. See
  docs/designs/incremental-reclustering.md §6.

  Tuning plan: these are starting values. After the first real-user
  corpus runs through incremental clustering, pull the actual sim
  distribution of KNN hits from the Langfuse trace and move the
  thresholds to roughly the 80th / 30th percentiles if the current
  split is wrong.
*/

export const CLUSTERING_THRESHOLDS = {
  /**
   * `sim >= HIGH_CONF` — auto-attach evidence to the nearest cluster,
   * no LLM call. Picked to be conservative: a false positive here
   * silently mislabels evidence, which poisons the cluster centroid
   * for all future runs. Prefer false negatives (drop to the LLM
   * pass) over false positives.
   */
  HIGH_CONF: 0.82,

  /**
   * `sim < LOW_CONF` — evidence is a candidate for a brand-new
   * cluster. Between LOW and HIGH is the "uncertain" band that the
   * LLM decides with full context.
   */
  LOW_CONF: 0.65,
} as const;

export type ClusteringThresholds = typeof CLUSTERING_THRESHOLDS;
