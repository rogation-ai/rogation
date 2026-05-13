import { and, eq, inArray, sql, notInArray, isNull } from "drizzle-orm";
import {
  evidence,
  evidenceEmbeddings,
  evidenceToCluster,
  insightClusters,
  opportunities,
  opportunityToCluster,
  specs,
} from "@/db/schema";
import type { Tx } from "@/db/scoped";
import { centroidOf } from "./knn";
import type { ClusterPlan } from "./actions";
import { ClusteringError } from "./errors";

/*
  Shared DB write executor for every cluster re-compute path.

  Both runFullClustering and runIncrementalClustering produce a
  ClusterPlan (the typed IR from actions.ts). This module is the ONLY
  code that writes to insight_cluster + evidence_to_cluster. Keeping
  one write path:
    - guarantees the same invariants hold on every re-cluster
    - makes stale-wiring + centroid recompute consistent across paths
    - lets unit tests exercise the plan translator without a DB, then
      integration tests exercise this one file against real pgvector

  Runs inside the caller's RLS-bound tx. Never opens its own
  transaction — the caller owns the atomicity boundary. A throw here
  rolls back the caller's entire write.

  Idempotency: not idempotent. The caller must guarantee that a given
  plan is applied at most once. In practice that's trivially true
  because plans are generated + applied in the same tx.

  Centroid semantics (design §6):
    - Every cluster in plan.centroidsToRecompute has its centroid
      reset to the mean of its (post-apply) attached evidence
      embeddings.
    - A cluster whose evidence count drops to zero has centroid set
      to NULL. The partial HNSW index already skips NULL, so this is
      invisible to KNN but keeps the schema honest.
    - Newly-inserted clusters compute centroid on insert from their
      initial evidence labels. No separate recompute pass needed.

  Stale wiring (design §18):
    - Any cluster touched by a KEEP / MERGE / SPLIT / NEW action →
      stale = false.
    - Any untouched live cluster whose newest evidence is >14 days
      older than the account's newest evidence → stale = true.
    - Computed in one SQL statement at the end, not per-cluster.
*/

const STALE_THRESHOLD_DAYS = 14;

export interface ApplyResult {
  clustersCreated: number;
  /** Unique cluster ids touched by any action in the plan. */
  touchedClusterIds: Set<string>;
  /**
   * Cluster ids that were freshly inserted by this apply (NEW + the
   * non-first children of every SPLIT). Used by the consolidation
   * pass to identify candidates for the post-apply micro-cluster
   * sweep — we only fold clusters this run created, never ones the
   * user has been looking at across previous runs.
   */
  createdClusterIds: Set<string>;
}

export interface ApplyOpts {
  /**
   * Skip the markDownstreamStale fan-out at the end of apply. Used
   * by the consolidation pass (lib/evidence/clustering/consolidation.ts),
   * which folds system-spawned micro-clusters into their nearest
   * neighbour right after the main re-cluster commits. The main pass
   * already fired downstream-stale signals for any MERGE/SPLIT/
   * tombstone it produced; re-firing on the consolidation MERGEs
   * would re-stale opportunities that the same run just touched —
   * training PMs to ignore the banner. Default false; only the
   * consolidation caller flips it.
   */
  skipDownstreamStale?: boolean;
  scopeId?: string;
}

export async function applyClusterActions(
  tx: Tx,
  plan: ClusterPlan,
  accountId: string,
  promptHash: string,
  contextUsed?: boolean,
  opts: ApplyOpts = {},
): Promise<ApplyResult> {
  const touched = new Set<string>();
  const created = new Set<string>();
  // Subset of `touched` that should fan out staleness to downstream
  // opportunities + specs. Per design (D1 in plan-eng-review):
  //   MERGE winners + losers, SPLIT origins + children, tombstones → stale
  //   KEEP (centroid drift only) + NEW (added cluster) → NOT stale
  // Marking on every KEEP would banner every opportunity on every
  // re-cluster pass, training PMs to ignore the warning.
  const staleSourceClusterIds = new Set<string>();
  let clustersCreated = 0;

  // Clone plan.centroidsToRecompute so the NEW-cluster insert loop
  // below (which .add()'s freshly-inserted ids) doesn't mutate the
  // caller's input Set. Caller may want to inspect the original plan
  // after apply (e.g. metrics, test assertions).
  const centroidsToRecompute = new Set(plan.centroidsToRecompute);

  // Defense in depth against malformed plans. planClusterActions
  // should prevent these, but apply.ts is the last line before the
  // DB gets touched — belt-and-suspenders.
  for (const merge of plan.merges) {
    if (merge.loserIds.includes(merge.winnerId)) {
      throw new ClusteringError(
        "merge_winner_missing",
        `MERGE winner ${merge.winnerId} appears in loserIds; refusing self-tombstone`,
      );
    }
  }

  // 1. KEEPs: update title/desc in place + attach evidence.
  for (const keep of plan.keeps) {
    touched.add(keep.clusterId);
    if (keep.newTitle !== null || keep.newDescription !== null) {
      await tx
        .update(insightClusters)
        .set({
          ...(keep.newTitle !== null ? { title: keep.newTitle } : {}),
          ...(keep.newDescription !== null
            ? { description: keep.newDescription }
            : {}),
          promptHash,
          contextUsed: contextUsed ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(insightClusters.id, keep.clusterId),
            eq(insightClusters.accountId, accountId),
          ),
        );
    }
    if (keep.attachEvidenceIds.length > 0) {
      await insertEdges(
        tx,
        keep.attachEvidenceIds.map((evId) => ({
          evidenceId: evId,
          clusterId: keep.clusterId,
        })),
      );
    }
  }

  // 2. MERGEs: tombstone losers, re-parent their edges onto the
  //    winner, update the winner's title/description.
  for (const merge of plan.merges) {
    touched.add(merge.winnerId);
    staleSourceClusterIds.add(merge.winnerId);
    for (const id of merge.loserIds) {
      touched.add(id);
      staleSourceClusterIds.add(id);
    }

    // Move edges from losers → winner. INSERT ON CONFLICT DO NOTHING
    // dedupes if the same evidence was attached to winner + loser.
    const loserEdges = await tx
      .select({
        evidenceId: evidenceToCluster.evidenceId,
      })
      .from(evidenceToCluster)
      .where(inArray(evidenceToCluster.clusterId, merge.loserIds));

    if (loserEdges.length > 0) {
      await insertEdges(
        tx,
        loserEdges.map((e) => ({
          evidenceId: e.evidenceId,
          clusterId: merge.winnerId,
        })),
      );
      // Remove loser edges after re-parenting.
      await tx
        .delete(evidenceToCluster)
        .where(inArray(evidenceToCluster.clusterId, merge.loserIds));
    }

    // Tombstone the losers. FORCE RLS + RLS policy still allow this
    // because the row's account_id matches the bound session var.
    await tx
      .update(insightClusters)
      .set({
        tombstonedInto: merge.winnerId,
        // Tombstoned clusters get centroid NULL — they're never a
        // KNN match anyway (partial index), but NULL is honest.
        centroid: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(insightClusters.id, merge.loserIds),
          eq(insightClusters.accountId, accountId),
        ),
      );

    // Update the winner's title/description + prompt_hash.
    await tx
      .update(insightClusters)
      .set({
        title: merge.newTitle,
        description: merge.newDescription,
        promptHash,
        contextUsed: contextUsed ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(insightClusters.id, merge.winnerId),
          eq(insightClusters.accountId, accountId),
        ),
      );
  }

  // 3. SPLITs: first child reuses origin row; rest are fresh.
  for (const split of plan.splits) {
    touched.add(split.originId);
    staleSourceClusterIds.add(split.originId);

    // Remove existing edges for the origin. Edges re-materialize per
    // child below.
    await tx
      .delete(evidenceToCluster)
      .where(eq(evidenceToCluster.clusterId, split.originId));

    const [firstChild, ...rest] = split.children;
    if (!firstChild) {
      // Validator should have caught this, but belt-and-suspenders.
      throw new ClusteringError(
        "split_no_children",
        `SPLIT for origin ${split.originId} has no children`,
      );
    }

    // First child reuses the origin id.
    await tx
      .update(insightClusters)
      .set({
        title: firstChild.title,
        description: firstChild.description,
        severity: firstChild.severity,
        promptHash,
        contextUsed: contextUsed ?? null,
        stale: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(insightClusters.id, split.originId),
          eq(insightClusters.accountId, accountId),
        ),
      );
    if (firstChild.evidenceIds.length > 0) {
      await insertEdges(
        tx,
        firstChild.evidenceIds.map((evId) => ({
          evidenceId: evId,
          clusterId: split.originId,
        })),
      );
    }

    // Remaining children are fresh inserts.
    for (const child of rest) {
      const [inserted] = await tx
        .insert(insightClusters)
        .values({
          accountId,
          title: child.title,
          description: child.description,
          severity: child.severity,
          frequency: child.evidenceIds.length,
          promptHash,
          contextUsed: contextUsed ?? null,
        })
        .returning({ id: insightClusters.id });
      if (!inserted) {
        throw new ClusteringError(
          "centroid_stale",
          "SPLIT child insert returned no row",
        );
      }
      touched.add(inserted.id);
      staleSourceClusterIds.add(inserted.id);
      created.add(inserted.id);
      clustersCreated += 1;
      if (child.evidenceIds.length > 0) {
        await insertEdges(
          tx,
          child.evidenceIds.map((evId) => ({
            evidenceId: evId,
            clusterId: inserted.id,
          })),
        );
      }
    }
  }

  // 4. NEWs: fresh cluster rows.
  for (const newCluster of plan.newClusters) {
    const [inserted] = await tx
      .insert(insightClusters)
      .values({
        accountId,
        title: newCluster.title,
        description: newCluster.description,
        severity: newCluster.severity,
        frequency: newCluster.evidenceIds.length,
        promptHash,
        contextUsed: contextUsed ?? null,
        scopeId: opts.scopeId ?? null,
      })
      .returning({ id: insightClusters.id });
    if (!inserted) {
      throw new ClusteringError(
        "centroid_stale",
        "NEW cluster insert returned no row",
      );
    }
    touched.add(inserted.id);
    created.add(inserted.id);
    clustersCreated += 1;
    if (newCluster.evidenceIds.length > 0) {
      await insertEdges(
        tx,
        newCluster.evidenceIds.map((evId) => ({
          evidenceId: evId,
          clusterId: inserted.id,
        })),
      );
    }
    // NEW clusters need their centroid computed from scratch since
    // they don't appear in plan.centroidsToRecompute (Lane A's
    // planner only tracks edge changes, not insertions). Add to the
    // local clone so the caller's plan stays untouched.
    centroidsToRecompute.add(inserted.id);
  }

  // 5. Recompute frequency + centroid for every cluster whose edges
  //    changed. Frequency lags otherwise — SPLITs move rows around
  //    and KEEP attachments bump counts. Every touched cluster's
  //    frequency may have moved — include it even if the planner
  //    didn't mark it for centroid recompute (e.g., a title-only KEEP).
  for (const id of touched) centroidsToRecompute.add(id);

  for (const clusterId of centroidsToRecompute) {
    await recomputeClusterAggregates(tx, clusterId, accountId);
  }

  // 6. Stale wiring. One pass after all writes.
  await updateStaleness(tx, accountId, touched);

  // 7. Fan staleness out to downstream artifacts. Opportunities linked
  //    to MERGE/SPLIT/tombstone clusters get stale=true; specs of
  //    those opportunities get stale=true. Cleared by regen
  //    (runFullOpportunities / generateSpec). Consolidation passes
  //    skip this — see ApplyOpts.skipDownstreamStale.
  if (!opts.skipDownstreamStale) {
    await markDownstreamStale(tx, accountId, staleSourceClusterIds);
  }

  return {
    clustersCreated,
    touchedClusterIds: touched,
    createdClusterIds: created,
  };
}

/**
 * Fan-out staleness from reshaped clusters to downstream artifacts.
 *
 * Trigger set (per design D1): MERGE winners + losers, SPLIT origins
 * + freshly-inserted children, tombstones. NOT KEEPs or NEWs — see
 * the rationale at the staleSourceClusterIds declaration site.
 *
 * Two updates, both set-based:
 *   1. Mark every opportunity whose opportunity_to_cluster row points
 *      at one of the trigger clusters.
 *   2. Mark every spec whose opportunity_id is one of the staled
 *      opportunities.
 *
 * Empty trigger set → no-op (no UPDATE statements issued).
 *
 * Caller owns the transaction. Both updates run inside the same RLS-
 * bound tx as applyClusterActions, so a rollback unwinds both.
 *
 * Exported for unit testing against a stub tx.
 */
export async function markDownstreamStale(
  tx: Tx,
  accountId: string,
  clusterIds: ReadonlySet<string>,
): Promise<void> {
  if (clusterIds.size === 0) return;

  const ids = Array.from(clusterIds);

  // Step 1: collect the opportunity ids whose links touch any
  // trigger cluster. We materialize the list (rather than using a
  // single UPDATE … WHERE EXISTS) so step 2 can reuse it for the
  // spec cascade without re-running the join.
  const linkedOpps = await tx
    .selectDistinct({ opportunityId: opportunityToCluster.opportunityId })
    .from(opportunityToCluster)
    .innerJoin(
      opportunities,
      eq(opportunityToCluster.opportunityId, opportunities.id),
    )
    .where(
      and(
        eq(opportunities.accountId, accountId),
        inArray(opportunityToCluster.clusterId, ids),
      ),
    );

  if (linkedOpps.length === 0) return;

  const oppIds = linkedOpps.map((r) => r.opportunityId);

  await tx
    .update(opportunities)
    .set({ stale: true, updatedAt: new Date() })
    .where(
      and(
        eq(opportunities.accountId, accountId),
        inArray(opportunities.id, oppIds),
      ),
    );

  await tx
    .update(specs)
    .set({ stale: true, updatedAt: new Date() })
    .where(
      and(
        eq(specs.accountId, accountId),
        inArray(specs.opportunityId, oppIds),
      ),
    );
}

/**
 * Insert edges with ON CONFLICT DO NOTHING on the composite PK
 * (evidence_id, cluster_id). Same evidence attached twice to the
 * same cluster is a no-op — not an error.
 */
async function insertEdges(
  tx: Tx,
  edges: Array<{ evidenceId: string; clusterId: string }>,
): Promise<void> {
  if (edges.length === 0) return;
  await tx
    .insert(evidenceToCluster)
    .values(
      edges.map((e) => ({
        evidenceId: e.evidenceId,
        clusterId: e.clusterId,
        // Real relevance scores land when KNN wires up in incremental.
        // For KEEP/SPLIT/NEW edges from the LLM, we trust the LLM's
        // assignment and use 1.0.
        relevanceScore: 1,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Recompute frequency + centroid for a single cluster. Centroid is
 * the mean of the embedding vectors of every attached evidence row.
 * If the cluster has zero attached evidence, centroid is set to
 * NULL (partial HNSW index already excludes tombstones; NULL-centroid
 * rows are also excluded).
 */
export async function recomputeClusterAggregates(
  tx: Tx,
  clusterId: string,
  accountId: string,
): Promise<void> {
  const rows = await tx
    .select({ embedding: evidenceEmbeddings.embedding })
    .from(evidenceToCluster)
    .innerJoin(
      evidenceEmbeddings,
      eq(evidenceEmbeddings.evidenceId, evidenceToCluster.evidenceId),
    )
    .where(eq(evidenceToCluster.clusterId, clusterId));

  const frequency = rows.length;
  const centroid =
    frequency === 0 ? null : centroidOf(rows.map((r) => r.embedding));

  await tx
    .update(insightClusters)
    .set({
      frequency,
      centroid,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(insightClusters.id, clusterId),
        eq(insightClusters.accountId, accountId),
      ),
    );
}

/**
 * Stale-flag update (design §18). Two SQL statements:
 *   1. Clear stale on every touched live cluster.
 *   2. Set stale=true on every untouched live cluster whose newest
 *      attached evidence is >14 days older than the account's newest
 *      evidence.
 *
 * If the account has zero evidence, everything stays as-is — no
 * meaningful "staleness" without a reference point.
 */
async function updateStaleness(
  tx: Tx,
  accountId: string,
  touched: Set<string>,
): Promise<void> {
  const touchedList = Array.from(touched);
  if (touchedList.length > 0) {
    await tx
      .update(insightClusters)
      .set({ stale: false, updatedAt: new Date() })
      .where(
        and(
          inArray(insightClusters.id, touchedList),
          eq(insightClusters.accountId, accountId),
        ),
      );
  }

  // Find the account's newest evidence timestamp. If none, skip.
  const [newest] = await tx
    .select({ latest: sql<Date | null>`MAX(${evidence.createdAt})` })
    .from(evidence)
    .where(eq(evidence.accountId, accountId));

  if (!newest?.latest) return;

  // Mark stale: untouched live clusters whose newest attached
  // evidence is >14 days older than the account's newest evidence.
  // Subquery via drizzle is awkward for "max(join) per cluster", so
  // use raw SQL inside the WHERE. Parameterize the interval via
  // `make_interval(days => N)` so the day count is a bound param,
  // never string-interpolated — defense against a future refactor
  // that makes STALE_THRESHOLD_DAYS config-driven.
  const staleCutoff = sql<Date>`${newest.latest}::timestamptz - make_interval(days => ${STALE_THRESHOLD_DAYS})`;

  const whereClause = [
    eq(insightClusters.accountId, accountId),
    isNull(insightClusters.tombstonedInto),
  ];
  if (touchedList.length > 0) {
    whereClause.push(notInArray(insightClusters.id, touchedList));
  }

  await tx
    .update(insightClusters)
    .set({
      stale: sql`(
        SELECT COALESCE(MAX(e.created_at), 'epoch'::timestamptz) < ${staleCutoff}
        FROM evidence_to_cluster etc
        JOIN evidence e ON e.id = etc.evidence_id
        WHERE etc.cluster_id = ${insightClusters.id}
      )`,
      updatedAt: new Date(),
    })
    .where(and(...whereClause));
}
