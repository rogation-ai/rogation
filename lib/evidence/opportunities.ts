import { desc, eq, inArray } from "drizzle-orm";
import {
  insightClusters,
  opportunities as opportunitiesTbl,
  opportunityScoreWeights,
  opportunityToCluster,
} from "@/db/schema";
import { complete, type CompleteOpts } from "@/lib/llm/router";
import {
  opportunityScore,
  type EffortEstimate,
  type OpportunityPrimitive,
} from "@/lib/llm/prompts/opportunity-score";
import type { Tx } from "@/db/scoped";

/*
  Opportunity scoring pipeline.

  One LLM call generates opportunity primitives (impact / strategy /
  effort / confidence). The server then computes a numeric score from
  those primitives + the user's current weight sliders. Dragging a
  slider never re-calls the LLM — it only re-computes the score
  mechanically (design review §14.4).

  Two public entry points:
  - runFullOpportunities(ctx, opts) re-generates by calling the LLM
    against the current clusters. Wipes prior opportunities the same
    way synthesis does — Phase B will add incremental support.
  - rescoreOpportunities(ctx, weights) recomputes `score` in-place
    from stored primitives. Cheap, no LLM.

  Weights live in opportunity_score_weights (one row per account).
  Defaults to all 1s. Sliders are treated as multipliers.
*/

const MAX_CLUSTERS_PER_RUN = 50;
const QUOTES_PER_CLUSTER = 3;

export interface WeightSet {
  frequencyW: number;
  revenueW: number;
  retentionW: number;
  strategyW: number;
  effortW: number;
}

const DEFAULT_WEIGHTS: WeightSet = {
  frequencyW: 1,
  revenueW: 1,
  retentionW: 1,
  strategyW: 1,
  effortW: 1,
};

export interface OpportunityCtx {
  db: Tx;
  accountId: string;
}

export interface OpportunityRunResult {
  opportunitiesCreated: number;
  clustersUsed: number;
  promptHash: string;
}

export async function runFullOpportunities(
  ctx: OpportunityCtx,
  opts: CompleteOpts = {},
): Promise<OpportunityRunResult> {
  const clusters = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
      severity: insightClusters.severity,
      frequency: insightClusters.frequency,
    })
    .from(insightClusters)
    .where(eq(insightClusters.accountId, ctx.accountId))
    .orderBy(desc(insightClusters.frequency))
    .limit(MAX_CLUSTERS_PER_RUN + 1);

  if (clusters.length === 0) {
    throw new Error(
      "No clusters to score — run synthesis first (Insights > Generate clusters).",
    );
  }
  if (clusters.length > MAX_CLUSTERS_PER_RUN) {
    throw new Error(
      `Opportunity scoring is capped at ${MAX_CLUSTERS_PER_RUN} clusters this run.`,
    );
  }

  const labeled = clusters.map((c, i) => ({
    ...c,
    label: `C${i + 1}`,
  }));
  const labelToClusterId = new Map(labeled.map((c) => [c.label, c.id]));
  // Title fallback: Sonnet occasionally echoes the cluster title
  // instead of the C1/C2/... label despite the prompt's instruction
  // (seen in /qa on 2026-04-18). Accept titles as a secondary match
  // so a single stray answer doesn't crash the whole run.
  const titleToClusterId = new Map(
    labeled.map((c) => [c.title.toLowerCase().trim(), c.id]),
  );

  // Pull a few representative quotes per cluster to give the LLM
  // enough signal to estimate impact dimensions. This is best-effort;
  // if the join table is empty (shouldn't be post-synthesis), we still
  // send titles + descriptions.
  const quotes = await sampleQuotes(
    ctx,
    labeled.map((c) => c.id),
    QUOTES_PER_CLUSTER,
  );

  const weights = await readWeights(ctx);

  const { output } = await complete(
    opportunityScore,
    {
      clusters: labeled.map((c) => ({
        label: c.label,
        title: c.title,
        description: c.description,
        severity: c.severity,
        frequency: c.frequency,
        sampleQuotes: quotes.get(c.id),
      })),
    },
    { cache: true, ...opts },
  );

  // Validate cluster labels and map back to real ids BEFORE any write.
  // Rewrite title-matches back to their canonical C1/C2 label so the
  // downstream persist path can use a single lookup map.
  for (const opp of output.opportunities) {
    opp.clusterLabels = opp.clusterLabels.map((label) => {
      if (labelToClusterId.has(label)) return label;
      const canonical = resolveByTitle(label, labeled, titleToClusterId);
      if (canonical) return canonical;
      throw new Error(
        `opportunity-score returned unknown cluster label "${label}"`,
      );
    });
  }

  const created = await persistOpportunities(
    ctx,
    output.opportunities,
    labelToClusterId,
    weights,
  );

  return {
    opportunitiesCreated: created,
    clustersUsed: labeled.length,
    promptHash: opportunityScore.hash,
  };
}

/**
 * Try to recover a canonical C1/C2/... label when the LLM echoed a
 * cluster title instead. Case-insensitive exact match on title; if
 * nothing matches, returns null and the caller throws. Exported
 * for unit testing.
 */
export function resolveByTitle(
  candidate: string,
  labeled: Array<{ label: string; title: string; id: string }>,
  titleToClusterId: Map<string, string>,
): string | null {
  const key = candidate.toLowerCase().trim();
  const clusterId = titleToClusterId.get(key);
  if (!clusterId) return null;
  const match = labeled.find((c) => c.id === clusterId);
  return match?.label ?? null;
}

async function persistOpportunities(
  ctx: OpportunityCtx,
  opps: OpportunityPrimitive[],
  labelToClusterId: Map<string, string>,
  weights: WeightSet,
): Promise<number> {
  // Wipe prior opportunities for this account. opportunity_to_cluster
  // cascades; readers see a clean slate.
  await ctx.db
    .delete(opportunitiesTbl)
    .where(eq(opportunitiesTbl.accountId, ctx.accountId));

  // Need cluster frequencies to compute the frequency-weighted piece
  // of each opportunity's score.
  const freqs = await readClusterFrequencies(ctx);

  const rows = opps.map((o) => {
    const clusterIds = o.clusterLabels
      .map((l) => labelToClusterId.get(l))
      .filter((id): id is string => Boolean(id));
    const score = computeScore(o, clusterIds, freqs, weights);
    return {
      accountId: ctx.accountId,
      title: o.title,
      description: o.description,
      reasoning: o.reasoning,
      impactEstimate: o.impact,
      effortEstimate: o.effort,
      score,
      confidence: o.confidence,
      status: "open" as const,
      promptHash: opportunityScore.hash,
      clusterIds,
    };
  });

  const inserted = await ctx.db
    .insert(opportunitiesTbl)
    .values(
      rows.map(({ clusterIds: _cluster, ...r }) => r), // eslint-disable-line @typescript-eslint/no-unused-vars
    )
    .returning({ id: opportunitiesTbl.id });

  // Write opportunity_to_cluster edges in-order.
  const edges = rows.flatMap((r, i) => {
    const oppId = inserted[i]?.id;
    if (!oppId) return [];
    return r.clusterIds.map((clusterId) => ({
      opportunityId: oppId,
      clusterId,
    }));
  });
  if (edges.length > 0) {
    await ctx.db.insert(opportunityToCluster).values(edges);
  }

  return inserted.length;
}

/* ------------------------------ re-ranking ------------------------------ */

/**
 * Recompute score for every opportunity using the supplied weights.
 * Cheap — no LLM call. Run this on every slider release or on a
 * 300ms debounce from the client.
 */
export async function rescoreOpportunities(
  ctx: OpportunityCtx,
  weights: WeightSet,
): Promise<Array<{ id: string; score: number }>> {
  const rows = await ctx.db
    .select({
      id: opportunitiesTbl.id,
      impactEstimate: opportunitiesTbl.impactEstimate,
      effortEstimate: opportunitiesTbl.effortEstimate,
      confidence: opportunitiesTbl.confidence,
    })
    .from(opportunitiesTbl)
    .where(eq(opportunitiesTbl.accountId, ctx.accountId));

  const oppIds = rows.map((r) => r.id);
  const edges =
    oppIds.length > 0
      ? await ctx.db
          .select({
            opportunityId: opportunityToCluster.opportunityId,
            clusterId: opportunityToCluster.clusterId,
          })
          .from(opportunityToCluster)
          .where(inArray(opportunityToCluster.opportunityId, oppIds))
      : [];

  const freqs = await readClusterFrequencies(ctx);

  const oppToClusters = new Map<string, string[]>();
  for (const e of edges) {
    const list = oppToClusters.get(e.opportunityId) ?? [];
    list.push(e.clusterId);
    oppToClusters.set(e.opportunityId, list);
  }

  const updated: Array<{ id: string; score: number }> = [];

  for (const r of rows) {
    const clusterIds = oppToClusters.get(r.id) ?? [];
    const primitive = {
      impact: (r.impactEstimate ?? {}) as OpportunityPrimitive["impact"],
      effort: r.effortEstimate as EffortEstimate,
      strategy: 0.5, // we didn't persist strategy separately; defaults mid
      confidence: r.confidence,
    };
    const score = computeScore(primitive, clusterIds, freqs, weights);
    await ctx.db
      .update(opportunitiesTbl)
      .set({ score })
      .where(eq(opportunitiesTbl.id, r.id));
    updated.push({ id: r.id, score });
  }

  return updated;
}

/* ---------------------------- pure helpers ---------------------------- */

const EFFORT_WEIGHT: Record<EffortEstimate, number> = {
  XS: 0.1,
  S: 0.25,
  M: 0.5,
  L: 0.75,
  XL: 1,
};

export function effortToNumber(e: EffortEstimate): number {
  return EFFORT_WEIGHT[e];
}

/**
 * Weighted sum of {frequency, revenue, retention, strategy} minus
 * effort penalty, multiplied by confidence. Pure — unit tested.
 *
 *   frequencyScore = avg(cluster.frequency normalised to [0,1])
 *   impactScore    = weighted sum of impact dimensions
 *   strategyScore  = raw strategy
 *   effortPenalty  = EFFORT_WEIGHT[effort]
 *   raw            = sum(weighted) - w.effort * effortPenalty
 *   score          = max(0, raw) * confidence
 */
export function computeScore(
  p: Pick<OpportunityPrimitive, "impact" | "strategy" | "effort" | "confidence">,
  clusterIds: string[],
  clusterFrequencies: Map<string, number>,
  weights: WeightSet,
): number {
  // Normalise frequency against the MAX across clusters (so the
  // biggest pain point caps at 1.0). Guarded against empty map.
  const maxFreq = Math.max(
    1,
    ...Array.from(clusterFrequencies.values(), (n) => Math.max(n, 1)),
  );
  const frequencyComponent =
    clusterIds.length === 0
      ? 0
      : clusterIds.reduce(
          (sum, id) =>
            sum + (clusterFrequencies.get(id) ?? 0) / maxFreq,
          0,
        ) / clusterIds.length;

  const impact = p.impact;
  const impactComponent =
    (weights.revenueW * (impact.revenue ?? 0) +
      weights.retentionW *
        ((impact.retention ?? 0) + (impact.activation ?? 0))) /
    // Normalise so weights that sum high don't explode the score.
    (weights.revenueW + weights.retentionW * 2 || 1);

  const raw =
    weights.frequencyW * frequencyComponent +
    impactComponent +
    weights.strategyW * p.strategy -
    weights.effortW * effortToNumber(p.effort);

  return Math.max(0, raw) * p.confidence;
}

/* -------------------------- weights read/write -------------------------- */

export async function readWeights(ctx: OpportunityCtx): Promise<WeightSet> {
  const [row] = await ctx.db
    .select({
      frequencyW: opportunityScoreWeights.frequencyW,
      revenueW: opportunityScoreWeights.revenueW,
      retentionW: opportunityScoreWeights.retentionW,
      strategyW: opportunityScoreWeights.strategyW,
      effortW: opportunityScoreWeights.effortW,
    })
    .from(opportunityScoreWeights)
    .where(eq(opportunityScoreWeights.accountId, ctx.accountId))
    .limit(1);
  return row ?? { ...DEFAULT_WEIGHTS };
}

export async function writeWeights(
  ctx: OpportunityCtx,
  weights: WeightSet,
): Promise<void> {
  // UPSERT the single row per account.
  await ctx.db
    .insert(opportunityScoreWeights)
    .values({ accountId: ctx.accountId, ...weights })
    .onConflictDoUpdate({
      target: opportunityScoreWeights.accountId,
      set: weights,
    });
}

export function defaultWeights(): WeightSet {
  return { ...DEFAULT_WEIGHTS };
}

/* ------------------------- read helpers (reused) ------------------------- */

async function readClusterFrequencies(
  ctx: OpportunityCtx,
): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({
      id: insightClusters.id,
      frequency: insightClusters.frequency,
    })
    .from(insightClusters)
    .where(eq(insightClusters.accountId, ctx.accountId));
  return new Map(rows.map((r) => [r.id, r.frequency]));
}

async function sampleQuotes(
  ctx: OpportunityCtx,
  clusterIds: string[],
  perCluster: number,
): Promise<Map<string, string[]>> {
  // Import here to avoid a circular import through lib/evidence/synthesis.
  const { evidence: evidenceTbl, evidenceToCluster: etc } = await import(
    "@/db/schema"
  );
  if (clusterIds.length === 0) return new Map();
  const edges = await ctx.db
    .select({
      clusterId: etc.clusterId,
      evidenceId: etc.evidenceId,
    })
    .from(etc)
    .where(inArray(etc.clusterId, clusterIds));

  const evidenceIds = Array.from(new Set(edges.map((e) => e.evidenceId)));
  if (evidenceIds.length === 0) return new Map();

  const bodies = await ctx.db
    .select({
      id: evidenceTbl.id,
      content: evidenceTbl.content,
    })
    .from(evidenceTbl)
    .where(inArray(evidenceTbl.id, evidenceIds));
  const bodyById = new Map(bodies.map((b) => [b.id, b.content]));

  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const list = out.get(edge.clusterId) ?? [];
    if (list.length < perCluster) {
      const content = bodyById.get(edge.evidenceId);
      if (content) list.push(content.slice(0, 240));
    }
    out.set(edge.clusterId, list);
  }
  return out;
}

/* ----------------------------- list helpers ----------------------------- */

export interface OpportunityRow {
  id: string;
  title: string;
  description: string;
  reasoning: string;
  impactEstimate: OpportunityPrimitive["impact"];
  effortEstimate: string;
  score: number;
  confidence: number;
  status: "open" | "in_progress" | "shipped" | "archived";
  linkedClusterIds: string[];
}

export async function listOpportunities(
  ctx: OpportunityCtx,
): Promise<OpportunityRow[]> {
  const opps = await ctx.db
    .select({
      id: opportunitiesTbl.id,
      title: opportunitiesTbl.title,
      description: opportunitiesTbl.description,
      reasoning: opportunitiesTbl.reasoning,
      impactEstimate: opportunitiesTbl.impactEstimate,
      effortEstimate: opportunitiesTbl.effortEstimate,
      score: opportunitiesTbl.score,
      confidence: opportunitiesTbl.confidence,
      status: opportunitiesTbl.status,
    })
    .from(opportunitiesTbl)
    .where(eq(opportunitiesTbl.accountId, ctx.accountId))
    .orderBy(desc(opportunitiesTbl.score));

  const oppIds = opps.map((o) => o.id);
  const edges =
    oppIds.length > 0
      ? await ctx.db
          .select({
            opportunityId: opportunityToCluster.opportunityId,
            clusterId: opportunityToCluster.clusterId,
          })
          .from(opportunityToCluster)
          .where(inArray(opportunityToCluster.opportunityId, oppIds))
      : [];

  const oppToClusters = new Map<string, string[]>();
  for (const e of edges) {
    const list = oppToClusters.get(e.opportunityId) ?? [];
    list.push(e.clusterId);
    oppToClusters.set(e.opportunityId, list);
  }

  return opps.map((o) => ({
    ...o,
    impactEstimate: (o.impactEstimate ?? {}) as OpportunityPrimitive["impact"],
    linkedClusterIds: oppToClusters.get(o.id) ?? [],
  }));
}

export async function listOpportunitiesForCluster(
  ctx: OpportunityCtx,
  clusterId: string,
): Promise<
  Array<Pick<OpportunityRow, "id" | "title" | "score" | "confidence">>
> {
  const rows = await ctx.db
    .select({
      id: opportunitiesTbl.id,
      title: opportunitiesTbl.title,
      score: opportunitiesTbl.score,
      confidence: opportunitiesTbl.confidence,
    })
    .from(opportunitiesTbl)
    .innerJoin(
      opportunityToCluster,
      eq(opportunityToCluster.opportunityId, opportunitiesTbl.id),
    )
    .where(eq(opportunityToCluster.clusterId, clusterId))
    .orderBy(desc(opportunitiesTbl.score));
  return rows;
}
