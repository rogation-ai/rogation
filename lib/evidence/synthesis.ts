import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  evidence,
  evidenceToCluster,
  insightClusters,
} from "@/db/schema";
import { complete, type CompleteOpts } from "@/lib/llm/router";
import {
  synthesisCluster,
  type SynthesisOutput,
} from "@/lib/llm/prompts/synthesis-cluster";
import type { Tx } from "@/db/scoped";
import { assertLabelsResolve } from "@/lib/evidence/clustering/validators";
import type { ClusterPlan } from "@/lib/evidence/clustering/actions";

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
  const rows = await ctx.db
    .select({
      id: evidence.id,
      content: evidence.content,
    })
    .from(evidence)
    .where(eq(evidence.accountId, ctx.accountId))
    .orderBy(desc(evidence.createdAt))
    .limit(MAX_EVIDENCE_PER_RUN + 1);

  if (rows.length === 0) {
    throw new Error("No evidence to cluster — upload at least 1 piece first");
  }

  if (rows.length > MAX_EVIDENCE_PER_RUN) {
    throw new Error(
      `Full re-cluster is capped at ${MAX_EVIDENCE_PER_RUN} evidence rows; ` +
        `incremental clustering ships in a follow-up commit.`,
    );
  }

  const labeled = rows.map((r, i) => ({
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
  // Every LLM-produced cluster is a NEW in the plan. The orchestrator
  // is responsible for wiping prior rows (design §5 — cold start
  // doesn't tombstone; it starts over).
  const newClusters = output.clusters.map((c) => ({
    title: c.title,
    description: c.description,
    severity: c.severity,
    evidenceIds: c.evidenceLabels
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
): Promise<void> {
  await tx
    .delete(insightClusters)
    .where(eq(insightClusters.accountId, accountId));
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
