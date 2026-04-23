/*
  Shared validators for synthesis-cluster (full re-cluster) and
  synthesis-incremental (KEEP/MERGE/SPLIT/NEW) prompts. Single source
  of truth for "is this LLM output safe to apply?"

  Every validator throws ClusteringError on rejection. Callers run
  them BEFORE starting any DB write so a bad LLM response never
  half-applies. Same pattern as lib/spec/validators.ts.
*/

import { ClusteringError } from "./errors";

/**
 * Every label the LLM mentions must appear in the set of labels we
 * sent it. Catches hallucinated E-labels and hallucinated C-ids that
 * would otherwise cause a FK violation inside the apply tx.
 */
export function assertLabelsResolve(
  labels: Iterable<string>,
  known: ReadonlySet<string>,
  kind: "evidence" | "cluster",
): void {
  for (const label of labels) {
    if (!known.has(label)) {
      throw new ClusteringError(
        "unknown_label",
        `${kind} label "${label}" was not in the prompt input; aborting write`,
      );
    }
  }
}

/**
 * Evidence may belong to exactly one cluster after a run. If the LLM
 * assigns the same E-label into two clusters (KEEP.attachEvidence,
 * SPLIT.children[].evidenceIds, or NEW.evidenceIds), the composite
 * PK on evidence_to_cluster would reject the second insert mid-apply.
 * Catching it pre-commit lets us abort cleanly with a typed error.
 */
export function assertNoDuplicateAssignments(
  labelLists: ReadonlyArray<ReadonlyArray<string>>,
): void {
  const seen = new Set<string>();
  for (const list of labelLists) {
    for (const label of list) {
      if (seen.has(label)) {
        throw new ClusteringError(
          "duplicate_assignment",
          `evidence label "${label}" assigned to more than one cluster`,
        );
      }
      seen.add(label);
    }
  }
}

/**
 * MERGE.winnerId must be one of the cluster ids we sent in. If the
 * LLM picks a winner that isn't in the input, we'd tombstone real
 * clusters *into* a nonexistent id. Worse than a loud error.
 *
 * Note: SPLIT doesn't use this — its originId is validated via
 * assertLabelsResolve against the same known set.
 */
export function assertMergeWinnersPresent(
  winners: Iterable<string>,
  known: ReadonlySet<string>,
): void {
  for (const id of winners) {
    if (!known.has(id)) {
      throw new ClusteringError(
        "merge_winner_missing",
        `MERGE winner "${id}" was not in the prompt input`,
      );
    }
  }
}

/**
 * A SPLIT with zero children is a contradiction — the LLM declared
 * "this cluster should become N clusters" with N=0. Reject pre-apply.
 */
export function assertSplitsHaveChildren(
  splits: ReadonlyArray<{ children: ReadonlyArray<unknown> }>,
): void {
  for (let i = 0; i < splits.length; i++) {
    if (splits[i]!.children.length === 0) {
      throw new ClusteringError(
        "split_no_children",
        `SPLIT[${i}] has no children; each SPLIT must produce ≥1 child cluster`,
      );
    }
  }
}
