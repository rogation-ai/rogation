import { and, eq, sql, inArray, desc } from "drizzle-orm";
import {
  clusterExclusions,
  evidence,
  evidenceToCluster,
  insightClusters,
} from "@/db/schema";
import type { Tx } from "@/db/scoped";
import { markDownstreamStale } from "@/lib/evidence/clustering/apply";

export const EXCLUSION_THRESHOLD = 0.75;
export const DECAY_RATE = 0.02;
const DECAY_WINDOW_DAYS = 180;

export interface ExclusionCtx {
  db: Tx;
  accountId: string;
  userId: string;
  scopeId?: string;
}

/**
 * Dismiss a cluster: flag evidence + create exclusion + tombstone.
 *
 * 1. Load the cluster (fail if missing or already tombstoned).
 * 2. Insert a cluster_exclusion row (centroid may be null).
 * 3. Flag every evidence row attached to this cluster as excluded.
 * 4. Tombstone the cluster (self-reference + reason = 'dismiss').
 * 5. Mark downstream opportunities + specs as stale.
 */
export async function dismissCluster(
  ctx: ExclusionCtx,
  clusterId: string,
  reason?: string,
): Promise<{ exclusionId: string; evidenceFlagged: number }> {
  // 1. Load the cluster
  const [cluster] = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      centroid: insightClusters.centroid,
      tombstonedInto: insightClusters.tombstonedInto,
      accountId: insightClusters.accountId,
      scopeId: insightClusters.scopeId,
    })
    .from(insightClusters)
    .where(
      and(eq(insightClusters.id, clusterId), eq(insightClusters.accountId, ctx.accountId)),
    )
    .limit(1);

  if (!cluster) throw new Error("Cluster not found");
  if (cluster.tombstonedInto) throw new Error("Cluster already dismissed");

  // 2. Create exclusion row (centroid can be null)
  const [exclusion] = await ctx.db
    .insert(clusterExclusions)
    .values({
      accountId: ctx.accountId,
      scopeId: cluster.scopeId,
      sourceClusterId: clusterId,
      centroid: cluster.centroid ?? undefined,
      label: cluster.title,
      reason,
      dismissedBy: ctx.userId,
    })
    .returning({ id: clusterExclusions.id });

  if (!exclusion) throw new Error("Exclusion insert returned no row");

  // 3. Flag all evidence attached to this cluster
  const attachedEvidence = await ctx.db
    .select({ evidenceId: evidenceToCluster.evidenceId })
    .from(evidenceToCluster)
    .where(eq(evidenceToCluster.clusterId, clusterId));

  const evidenceIds = attachedEvidence.map((e) => e.evidenceId);
  let flagged = 0;

  if (evidenceIds.length > 0) {
    await ctx.db
      .update(evidence)
      .set({
        excluded: true,
        flaggedByExclusionId: exclusion.id,
      })
      .where(
        and(
          eq(evidence.accountId, ctx.accountId),
          inArray(evidence.id, evidenceIds),
        ),
      );
    flagged = evidenceIds.length;
  }

  // 4. Tombstone the cluster (self-reference = tombstoned)
  await ctx.db
    .update(insightClusters)
    .set({
      tombstonedInto: clusterId,
      tombstoneReason: "dismiss",
    })
    .where(eq(insightClusters.id, clusterId));

  // 5. Mark downstream stale
  await markDownstreamStale(ctx.db, ctx.accountId, new Set([clusterId]));

  return { exclusionId: exclusion.id, evidenceFlagged: flagged };
}

/**
 * List exclusions for the account, ordered newest-first,
 * with per-exclusion evidence counts.
 */
export async function listExclusions(
  ctx: { db: Tx; accountId: string },
  scopeId?: string,
) {
  const conditions = [eq(clusterExclusions.accountId, ctx.accountId)];
  if (scopeId) conditions.push(eq(clusterExclusions.scopeId, scopeId));

  const rows = await ctx.db
    .select({
      id: clusterExclusions.id,
      label: clusterExclusions.label,
      reason: clusterExclusions.reason,
      strength: clusterExclusions.strength,
      isActive: clusterExclusions.isActive,
      sourceClusterId: clusterExclusions.sourceClusterId,
      dismissedAt: clusterExclusions.dismissedAt,
      lastUsedAt: clusterExclusions.lastUsedAt,
      scopeId: clusterExclusions.scopeId,
    })
    .from(clusterExclusions)
    .where(and(...conditions))
    .orderBy(desc(clusterExclusions.dismissedAt));

  // Get evidence counts per exclusion
  const exclusionIds = rows.map((r) => r.id);
  if (exclusionIds.length === 0) return [];

  const counts = await ctx.db
    .select({
      exclusionId: evidence.flaggedByExclusionId,
      count: sql<number>`count(*)::int`,
    })
    .from(evidence)
    .where(
      and(
        eq(evidence.accountId, ctx.accountId),
        inArray(evidence.flaggedByExclusionId, exclusionIds),
      ),
    )
    .groupBy(evidence.flaggedByExclusionId);

  const countMap = new Map(counts.map((c) => [c.exclusionId, c.count]));

  return rows.map((r) => ({
    ...r,
    evidenceCount: countMap.get(r.id) ?? 0,
  }));
}

/**
 * Unexclude: restore evidence + deactivate centroid + un-tombstone cluster.
 *
 * 1. Clear excluded / exclusion_pending / flaggedByExclusionId on matching evidence.
 * 2. Deactivate the exclusion (is_active = false).
 * 3. Un-tombstone the source cluster if it was dismissed (not merged).
 */
export async function unexclude(
  ctx: ExclusionCtx,
  exclusionId: string,
): Promise<{ evidenceRestored: number; clusterRestored: boolean }> {
  const [exclusion] = await ctx.db
    .select()
    .from(clusterExclusions)
    .where(
      and(
        eq(clusterExclusions.id, exclusionId),
        eq(clusterExclusions.accountId, ctx.accountId),
      ),
    )
    .limit(1);

  if (!exclusion) throw new Error("Exclusion not found");

  // 1. Clear evidence flags where flaggedByExclusionId matches
  const restored = await ctx.db
    .update(evidence)
    .set({
      excluded: false,
      exclusionPending: false,
      flaggedByExclusionId: null,
    })
    .where(
      and(
        eq(evidence.accountId, ctx.accountId),
        eq(evidence.flaggedByExclusionId, exclusionId),
      ),
    )
    .returning({ id: evidence.id });

  // 2. Deactivate exclusion
  await ctx.db
    .update(clusterExclusions)
    .set({ isActive: false })
    .where(eq(clusterExclusions.id, exclusionId));

  // 3. Un-tombstone source cluster (only if tombstone_reason = 'dismiss')
  let clusterRestored = false;
  if (exclusion.sourceClusterId) {
    const [cluster] = await ctx.db
      .select({
        id: insightClusters.id,
        tombstoneReason: insightClusters.tombstoneReason,
      })
      .from(insightClusters)
      .where(eq(insightClusters.id, exclusion.sourceClusterId))
      .limit(1);

    if (cluster && cluster.tombstoneReason === "dismiss") {
      await ctx.db
        .update(insightClusters)
        .set({
          tombstonedInto: null,
          tombstoneReason: null,
        })
        .where(eq(insightClusters.id, cluster.id));
      clusterRestored = true;
    }
  }

  return { evidenceRestored: restored.length, clusterRestored };
}

/**
 * Delete exclusion permanently: remove evidence flags + hard delete.
 */
export async function deleteExclusion(
  ctx: ExclusionCtx,
  exclusionId: string,
): Promise<{ evidenceRestored: number }> {
  const [exclusion] = await ctx.db
    .select({ id: clusterExclusions.id })
    .from(clusterExclusions)
    .where(
      and(
        eq(clusterExclusions.id, exclusionId),
        eq(clusterExclusions.accountId, ctx.accountId),
      ),
    )
    .limit(1);

  if (!exclusion) throw new Error("Exclusion not found");

  // Clear evidence flags
  const restored = await ctx.db
    .update(evidence)
    .set({
      excluded: false,
      exclusionPending: false,
      flaggedByExclusionId: null,
    })
    .where(
      and(
        eq(evidence.accountId, ctx.accountId),
        eq(evidence.flaggedByExclusionId, exclusionId),
      ),
    )
    .returning({ id: evidence.id });

  // Hard delete the exclusion row
  await ctx.db
    .delete(clusterExclusions)
    .where(eq(clusterExclusions.id, exclusionId));

  return { evidenceRestored: restored.length };
}

/**
 * Match new evidence against exclusion centroids (pending review).
 * Returns the matched exclusion id if any, null otherwise.
 *
 * Uses pgvector's `<=>` operator for cosine distance; converts to
 * similarity via `1 - distance`.
 */
export async function matchExclusionCentroid(
  db: Tx,
  accountId: string,
  evidenceId: string,
  scopeId?: string,
): Promise<{ exclusionId: string; label: string; similarity: number } | null> {
  const scopeCondition = scopeId
    ? sql`AND ce.scope_id = ${scopeId}`
    : sql``;

  const rows = await db.execute(sql`
    SELECT ce.id, ce.label, 1 - (ee.embedding <=> ce.centroid) AS similarity
    FROM cluster_exclusion ce
    JOIN evidence_embedding ee ON ee.evidence_id = ${evidenceId}
    WHERE ce.account_id = ${accountId}
      AND ce.is_active = true
      AND ce.centroid IS NOT NULL
      AND 1 - (ee.embedding <=> ce.centroid) >= ${EXCLUSION_THRESHOLD}
      ${scopeCondition}
    ORDER BY similarity DESC
    LIMIT 1
  `);

  const row = rows[0] as
    | { id: string; label: string; similarity: number }
    | undefined;
  if (!row) return null;

  // Update last_used_at on the matched exclusion
  await db
    .update(clusterExclusions)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(clusterExclusions.id, row.id));

  return { exclusionId: row.id, label: row.label, similarity: row.similarity };
}

/**
 * Decay exclusion strengths. Called after clustering, outside the
 * advisory lock. Reduces strength by DECAY_RATE per call; deactivates
 * exclusions that hit zero or exceed the decay window.
 */
export async function decayExclusions(
  db: Tx,
  accountId: string,
): Promise<{ decayed: number; deactivated: number }> {
  const resultRows = await db.execute(sql`
    UPDATE cluster_exclusion
    SET strength = GREATEST(strength - ${DECAY_RATE}, 0),
        is_active = CASE
          WHEN strength - ${DECAY_RATE} <= 0 THEN false
          WHEN dismissed_at < now() - make_interval(days => ${DECAY_WINDOW_DAYS}) THEN false
          ELSE is_active
        END
    WHERE account_id = ${accountId}
      AND is_active = true
      AND last_used_at IS NOT NULL
    RETURNING id, is_active
  `);

  const rows = resultRows as unknown as Array<{
    id: string;
    is_active: boolean;
  }>;
  return {
    decayed: rows.length,
    deactivated: rows.filter((r) => !r.is_active).length,
  };
}

/**
 * List evidence flagged by a specific exclusion.
 */
export async function excludedEvidenceByExclusion(
  db: Tx,
  accountId: string,
  exclusionId: string,
) {
  return db
    .select({
      id: evidence.id,
      content: evidence.content,
      sourceType: evidence.sourceType,
      excluded: evidence.excluded,
      exclusionPending: evidence.exclusionPending,
      createdAt: evidence.createdAt,
    })
    .from(evidence)
    .where(
      and(
        eq(evidence.accountId, accountId),
        eq(evidence.flaggedByExclusionId, exclusionId),
      ),
    )
    .orderBy(desc(evidence.createdAt));
}

/**
 * Count pending-exclusion evidence for the account.
 */
export async function pendingExclusionCount(
  db: Tx,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(evidence)
    .where(
      and(
        eq(evidence.accountId, accountId),
        eq(evidence.exclusionPending, true),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Confirm pending evidence: set excluded=true, clear the pending flag.
 */
export async function confirmPendingEvidence(
  db: Tx,
  accountId: string,
  evidenceIds: string[],
): Promise<number> {
  if (evidenceIds.length === 0) return 0;
  const result = await db
    .update(evidence)
    .set({ excluded: true, exclusionPending: false })
    .where(
      and(
        eq(evidence.accountId, accountId),
        inArray(evidence.id, evidenceIds),
        eq(evidence.exclusionPending, true),
      ),
    )
    .returning({ id: evidence.id });
  return result.length;
}

/**
 * Dismiss pending match: clear exclusion_pending, keep evidence active.
 */
export async function dismissPendingEvidence(
  db: Tx,
  accountId: string,
  evidenceIds: string[],
): Promise<number> {
  if (evidenceIds.length === 0) return 0;
  const result = await db
    .update(evidence)
    .set({ exclusionPending: false, flaggedByExclusionId: null })
    .where(
      and(
        eq(evidence.accountId, accountId),
        inArray(evidence.id, evidenceIds),
        eq(evidence.exclusionPending, true),
      ),
    )
    .returning({ id: evidence.id });
  return result.length;
}

/**
 * Load dismissed labels for LLM prompt augmentation.
 * Returns active exclusion labels so the clustering prompt can
 * avoid re-creating clusters the PM already dismissed.
 */
export async function loadDismissedLabels(
  db: Tx,
  accountId: string,
  scopeId?: string,
): Promise<Array<{ label: string; reason: string | null }>> {
  const conditions = [
    eq(clusterExclusions.accountId, accountId),
    eq(clusterExclusions.isActive, true),
  ];
  if (scopeId) conditions.push(eq(clusterExclusions.scopeId, scopeId));

  return db
    .select({
      label: clusterExclusions.label,
      reason: clusterExclusions.reason,
    })
    .from(clusterExclusions)
    .where(and(...conditions))
    .orderBy(desc(clusterExclusions.dismissedAt));
}
