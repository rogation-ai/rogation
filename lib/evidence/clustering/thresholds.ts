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
   * no LLM call. Conservative enough that a false positive is rare,
   * loose enough that obvious belongs-here cases skip the LLM. The
   * earlier 0.82 produced too much LLM-side fragmentation; 0.78 still
   * sits comfortably above the "uncertain" band.
   */
  HIGH_CONF: 0.78,

  /**
   * `LOW_CONF <= sim < HIGH_CONF` — uncertain. Goes to the LLM with
   * KNN hints so the LLM can decide KEEP vs NEW with cluster context.
   */
  LOW_CONF: 0.65,

  /**
   * Synthetic-MERGE bar for the consolidation pass: an LLM-produced
   * micro-cluster only merges into a sibling whose centroid sim is
   * at least this high. Sits just below HIGH_CONF (0.78) by design —
   * close enough that we'd auto-attach a new piece of evidence to
   * the merge target on the next run, far enough that we don't
   * silently fold themes the LLM may have meant to keep apart.
   */
  CONSOLIDATION_MERGE_SIM: 0.7,

  /**
   * Display + consolidation eligibility floor. Clusters with fewer
   * than this many attached evidence rows are "micro-clusters."
   * Consolidation tries to merge them; read paths can choose to hide
   * them. 2 means "at least one corroborating quote."
   */
  MIN_CLUSTER_SIZE: 2,
} as const;

export type ClusteringThresholds = typeof CLUSTERING_THRESHOLDS;
