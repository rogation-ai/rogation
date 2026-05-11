/*
  Pure planner for the incremental clustering path.

  The LLM returns a list of KEEP / MERGE / SPLIT / NEW actions against
  labeled inputs (C1, C2 for clusters; E1, E2 for evidence). This file
  turns that label-space output into a uuid-space plan that Lane D
  executes inside a tx.

  Everything here is pure — no DB, no I/O. That lets us unit-test the
  tricky parts (winner tiebreak rules, label→id translation, centroid
  recompute set) in milliseconds without a Postgres roundtrip.

  Why "plan, then apply":
  - Validation runs end-to-end before any write lands. A malformed
    LLM output can't half-apply.
  - The plan is a simple JS object — serializable, dumpable into a
    Sentry trace on failure, easy to snapshot-test.
  - Lane D consumes this same shape whether the orchestrator is full
    or incremental (runFullClustering can emit an equivalent plan).

  Winner selection (MERGE): determined by pickWinner(), NOT the LLM.
  See docs/designs/incremental-reclustering.md §4: determinism matters
  for eval reproducibility — a prompt tweak that reorders losers must
  not change which id survives.
*/

import * as Sentry from "@sentry/nextjs";
import { ClusteringError } from "./errors";
import {
  assertLabelsResolve,
  assertMergeWinnersPresent,
  dedupeAssignmentsAcrossActions,
  assertSplitsHaveChildren,
} from "./validators";

export type Severity = "low" | "medium" | "high" | "critical";

/* ---------- Types the LLM parser (Lane C) produces ---------- */

export type ClusterActionInput =
  | {
      type: "KEEP";
      clusterLabel: string;
      newTitle: string | null;
      newDescription: string | null;
      attachEvidence: string[];
    }
  | {
      type: "MERGE";
      /** Two or more cluster labels to collapse. Server picks winner. */
      clusterLabels: string[];
      newTitle: string;
      newDescription: string;
    }
  | {
      type: "SPLIT";
      originLabel: string;
      children: Array<{
        title: string;
        description: string;
        severity: Severity;
        evidenceLabels: string[];
      }>;
    }
  | {
      type: "NEW";
      title: string;
      description: string;
      severity: Severity;
      evidenceLabels: string[];
    };

export interface IncrementalLlmOutput {
  actions: ClusterActionInput[];
}

export interface ClusterMeta {
  id: string;
  frequency: number;
  createdAt: Date;
}

export interface IncrementalInputState {
  /** cluster label (C1, C2, ...) → meta used for pickWinner + id resolution */
  clusters: Map<string, ClusterMeta>;
  /** evidence label (E1, E2, ...) → row uuid */
  evidenceLabelToId: Map<string, string>;
}

/* ---------- Plan shape the Lane D applier consumes ---------- */

export interface PlanKeep {
  clusterId: string;
  newTitle: string | null;
  newDescription: string | null;
  attachEvidenceIds: string[];
}

export interface PlanMerge {
  winnerId: string;
  loserIds: string[];
  newTitle: string;
  newDescription: string;
}

export interface PlanSplitChild {
  title: string;
  description: string;
  severity: Severity;
  evidenceIds: string[];
  /** First child reuses the origin's id; the rest get fresh uuids. */
  keepOriginId: boolean;
}

export interface PlanSplit {
  originId: string;
  children: PlanSplitChild[];
}

export interface PlanNew {
  title: string;
  description: string;
  severity: Severity;
  evidenceIds: string[];
}

export interface ClusterPlan {
  keeps: PlanKeep[];
  merges: PlanMerge[];
  splits: PlanSplit[];
  newClusters: PlanNew[];
  /**
   * Cluster ids whose evidence edges changed. Lane D recomputes the
   * centroid for each. Survivors of a MERGE appear here; tombstoned
   * losers do NOT (their centroid becomes meaningless — readers follow
   * tombstoned_into).
   */
  centroidsToRecompute: Set<string>;
}

/**
 * Deterministic winner selection for MERGE.
 *
 * Rule (highest priority first):
 *  1. highest `frequency`
 *  2. oldest `createdAt` — older clusters have more history tied to
 *     them (opportunities, feedback)
 *  3. lexicographically lowest `id` — final deterministic tiebreak
 *
 * Never let the LLM choose. A prompt edit that reorders the
 * `clusterLabels` array must not change which id survives.
 */
export function pickWinner<T extends ClusterMeta>(clusters: T[]): T {
  if (clusters.length === 0) {
    throw new ClusteringError(
      "merge_winner_missing",
      "pickWinner: cannot pick a winner from zero clusters",
    );
  }
  const sorted = [...clusters].sort((a, b) => {
    if (b.frequency !== a.frequency) return b.frequency - a.frequency;
    const aTime = a.createdAt.getTime();
    const bTime = b.createdAt.getTime();
    if (aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });
  return sorted[0]!;
}

/**
 * Translate validated LLM output into a uuid-space plan.
 * Runs all validators first; throws ClusteringError on any issue.
 */
export function planClusterActions(
  output: IncrementalLlmOutput,
  state: IncrementalInputState,
): ClusterPlan {
  const clusterLabels = new Set(state.clusters.keys());
  const evidenceLabels = new Set(state.evidenceLabelToId.keys());

  // Collect every cluster label the output references — KEEP targets,
  // MERGE inputs, SPLIT origins — and verify each resolves.
  const referencedClusters: string[] = [];
  const mergeInputs: string[] = [];
  const splitsForAssert: Array<{ children: unknown[] }> = [];
  const evidenceAssignments: string[][] = [];

  for (const a of output.actions) {
    if (a.type === "KEEP") {
      referencedClusters.push(a.clusterLabel);
      evidenceAssignments.push(a.attachEvidence);
    } else if (a.type === "MERGE") {
      if (a.clusterLabels.length < 2) {
        throw new ClusteringError(
          "merge_winner_missing",
          `MERGE must name ≥2 clusters; got ${a.clusterLabels.length}`,
        );
      }
      referencedClusters.push(...a.clusterLabels);
      mergeInputs.push(...a.clusterLabels);
    } else if (a.type === "SPLIT") {
      referencedClusters.push(a.originLabel);
      splitsForAssert.push({ children: a.children });
      for (const child of a.children) {
        evidenceAssignments.push(child.evidenceLabels);
      }
    } else {
      evidenceAssignments.push(a.evidenceLabels);
    }
  }

  assertLabelsResolve(referencedClusters, clusterLabels, "cluster");
  assertMergeWinnersPresent(mergeInputs, clusterLabels);
  assertSplitsHaveChildren(splitsForAssert);

  const allEvidence = evidenceAssignments.flat();
  assertLabelsResolve(allEvidence, evidenceLabels, "evidence");

  // Dedupe instead of throw: if the LLM assigns the same evidence
  // label to two actions, keep the first and drop the rest. Logs the
  // drop to Sentry so eval review can spot regressions. The downstream
  // apply path already dedupes via onConflictDoNothing on the
  // evidence_to_cluster PK, so this only changes visibility, not the
  // final DB state.
  const dropped = dedupeAssignmentsAcrossActions(evidenceAssignments);
  if (dropped.length > 0) {
    Sentry.captureMessage("clustering_duplicate_label", {
      level: "warning",
      extra: { droppedLabels: dropped },
    });
  }

  // Build the plan. Resolve every label to its uuid.
  const keeps: PlanKeep[] = [];
  const merges: PlanMerge[] = [];
  const splits: PlanSplit[] = [];
  const newClusters: PlanNew[] = [];
  const centroidsToRecompute = new Set<string>();

  for (const a of output.actions) {
    if (a.type === "KEEP") {
      const meta = state.clusters.get(a.clusterLabel)!;
      const attachEvidenceIds = a.attachEvidence.map(
        (l) => state.evidenceLabelToId.get(l)!,
      );
      keeps.push({
        clusterId: meta.id,
        newTitle: a.newTitle,
        newDescription: a.newDescription,
        attachEvidenceIds,
      });
      if (attachEvidenceIds.length > 0) centroidsToRecompute.add(meta.id);
    } else if (a.type === "MERGE") {
      const metas = a.clusterLabels.map((l) => state.clusters.get(l)!);
      const winner = pickWinner(metas);
      const losers = metas.filter((m) => m.id !== winner.id);
      merges.push({
        winnerId: winner.id,
        loserIds: losers.map((m) => m.id),
        newTitle: a.newTitle,
        newDescription: a.newDescription,
      });
      // Winner absorbs all loser edges → its centroid shifts.
      centroidsToRecompute.add(winner.id);
    } else if (a.type === "SPLIT") {
      const origin = state.clusters.get(a.originLabel)!;
      const children: PlanSplitChild[] = a.children.map((c, i) => ({
        title: c.title,
        description: c.description,
        severity: c.severity,
        evidenceIds: c.evidenceLabels.map(
          (l) => state.evidenceLabelToId.get(l)!,
        ),
        keepOriginId: i === 0,
      }));
      splits.push({ originId: origin.id, children });
      // Origin id's centroid is reused by the first child; the rest
      // are new rows, centroid set on insert. Lane D handles both.
      centroidsToRecompute.add(origin.id);
    } else {
      newClusters.push({
        title: a.title,
        description: a.description,
        severity: a.severity,
        evidenceIds: a.evidenceLabels.map(
          (l) => state.evidenceLabelToId.get(l)!,
        ),
      });
      // New cluster centroids are computed at insert time in Lane D,
      // not retroactively. Not added here.
    }
  }

  return { keeps, merges, splits, newClusters, centroidsToRecompute };
}
