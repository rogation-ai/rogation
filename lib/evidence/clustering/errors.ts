/*
  Typed error for the incremental clustering path. Mirrors the shape of
  NotionApiError / LinearApiError in lib/integrations/*: one class, a
  discriminated `code`, and a human-readable message.

  Every code maps to a specific failure in docs/designs/incremental-reclustering.md §21
  (consolidated failure modes). tRPC + Inngest map codes back to typed
  UI errors so PMs see actionable copy instead of raw throws.
*/

export type ClusteringErrorCode =
  | "unknown_label"
  | "duplicate_assignment"
  | "merge_winner_missing"
  | "split_no_children"
  | "centroid_stale"
  | "embeddings_pending"
  | "budget_exhausted"
  | "concurrent_run"
  | "tombstone_cycle";

export class ClusteringError extends Error {
  readonly code: ClusteringErrorCode;
  constructor(code: ClusteringErrorCode, message: string) {
    super(message);
    this.name = "ClusteringError";
    this.code = code;
  }
}
