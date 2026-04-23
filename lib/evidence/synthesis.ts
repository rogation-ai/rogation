import { desc, eq, inArray } from "drizzle-orm";
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

/*
  Clustering orchestrator — Phase A.

  Phase A = full re-cluster. Read every evidence row for the account,
  call the synthesis prompt once, write new insight_cluster rows + the
  evidence_to_cluster join. Previous clusters for this account are
  deleted first; cluster IDs are fresh on every run.

  Phase B (next commit) introduces the incremental strategy the eng
  review locked in (KNN against existing clusters + LLM merge/split on
  touched only). The existing cluster IDs become stable across runs at
  that point.

  Why kick off with full re-cluster:
  - Implementation is straightforward: one LLM call, deterministic
    write path, easy to test with a mocked provider.
  - Typical onboarding corpus (10-30 pieces) fits in a single Sonnet
    4.6 call with room to spare.
  - Stable IDs matter most once opportunities reference clusters;
    opportunities don't exist yet, so churn is harmless.

  Guardrails:
  - Cap corpus at MAX_EVIDENCE_PER_RUN to keep the prompt size
    bounded. Above the cap, throw — the incremental path is the
    right answer for large corpora.
  - Wrap the entire write in the caller's existing RLS-bound tx so
    the orchestrator never bypasses tenant isolation.
*/

const MAX_EVIDENCE_PER_RUN = 50;

export interface SynthesisContext {
  db: Tx;
  accountId: string;
}

export interface SynthesisResult {
  clustersCreated: number;
  evidenceUsed: number;
  promptHash: string;
}

export async function runFullClustering(
  ctx: SynthesisContext,
  opts: CompleteOpts = {},
): Promise<SynthesisResult> {
  // Read every evidence row for this account. RLS scopes us.
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

  // Short labels keep the JSON output compact. E1, E2, ... map back to
  // UUIDs after parsing.
  const labeled = rows.map((r, i) => ({
    label: `E${i + 1}`,
    content: r.content,
    id: r.id,
  }));

  const labelToId = new Map(labeled.map((r) => [r.label, r.id]));

  // One LLM call to cluster the whole corpus. cache=true so the
  // evidence blob re-hits Anthropic's cache on subsequent runs in
  // the same ~5-minute window (plan §Perf decision #4).
  const { output } = await complete(
    synthesisCluster,
    { evidence: labeled.map((r) => ({ label: r.label, content: r.content })) },
    { cache: true, ...opts },
  );

  // Validate every returned label resolves to an evidence id we
  // actually asked about. Defends against a hallucinated label
  // leaking a FK violation into the DB. Shared with the incremental
  // path via lib/evidence/clustering/validators.ts.
  const allLabelsInOutput = new Set(
    output.clusters.flatMap((c) => c.evidenceLabels),
  );
  assertLabelsResolve(
    allLabelsInOutput,
    new Set(labelToId.keys()),
    "evidence",
  );

  // Write atomically inside the caller's tx. Wipe prior clusters for
  // this account; evidence_to_cluster cascades.
  const clustersCreated = await persistClusters(
    ctx,
    output,
    labelToId,
  );

  return {
    clustersCreated,
    evidenceUsed: labeled.length,
    promptHash: synthesisCluster.hash,
  };
}

async function persistClusters(
  ctx: SynthesisContext,
  output: SynthesisOutput,
  labelToId: Map<string, string>,
): Promise<number> {
  // Delete all existing clusters for this account. RLS scopes the
  // DELETE; evidence_to_cluster FK cascades.
  await ctx.db
    .delete(insightClusters)
    .where(eq(insightClusters.accountId, ctx.accountId));

  // Insert new clusters. Return ids so we can write the join.
  const insertedClusters = await ctx.db
    .insert(insightClusters)
    .values(
      output.clusters.map((c) => ({
        accountId: ctx.accountId,
        title: c.title,
        description: c.description,
        severity: c.severity,
        frequency: c.evidenceLabels.length,
        promptHash: synthesisCluster.hash,
      })),
    )
    .returning({ id: insightClusters.id });

  // Build the evidence_to_cluster rows. We also compute a naive
  // relevance_score = 1 (everything the LLM picked is "in") for now;
  // the incremental pass later sets real per-edge scores from KNN.
  const edges: Array<{
    evidenceId: string;
    clusterId: string;
    relevanceScore: number;
  }> = [];

  output.clusters.forEach((cluster, idx) => {
    const clusterId = insertedClusters[idx]?.id;
    if (!clusterId) return;
    for (const label of cluster.evidenceLabels) {
      const evidenceId = labelToId.get(label);
      if (!evidenceId) continue;
      edges.push({ evidenceId, clusterId, relevanceScore: 1 });
    }
  });

  if (edges.length > 0) {
    // insertMany + resilient dedup: if the LLM assigned the same
    // evidence to two clusters (rule violation), the composite PK
    // on evidence_to_cluster rejects duplicates. We prefer the first
    // assignment by filtering here rather than relying on DB throws.
    const seen = new Set<string>();
    const unique = edges.filter((e) => {
      if (seen.has(e.evidenceId)) return false;
      seen.add(e.evidenceId);
      return true;
    });
    await ctx.db.insert(evidenceToCluster).values(unique);
  }

  return insertedClusters.length;
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
    .where(eq(insightClusters.accountId, ctx.accountId))
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
    .where(eq(insightClusters.id, clusterId))
    .limit(1);

  if (!cluster) return null;

  // Look up the evidence rows via the join. RLS keeps cross-account
  // reads impossible even if clusterId were leaked.
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
