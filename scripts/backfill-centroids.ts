import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { bindAccountToTx, type Tx } from "@/db/scoped";
import { evidenceToCluster, insightClusters } from "@/db/schema";
import { recomputeClusterAggregates } from "@/lib/evidence/clustering/apply";

/*
  Centroid backfill (Lane F).

  Populates insight_cluster.centroid for every live cluster whose
  centroid is NULL. Clusters created before the incremental lane
  (pre-Lane-D) never got a centroid; the incremental path uses
  centroids as KNN anchors, so NULL-centroid clusters miss
  HIGH_CONF auto-attach and every candidate gets sent to the LLM.

  Runs as the app's DB role (owner → RLS bypassed) to scan across
  every account in one pass. Per-cluster tx with bindAccountToTx
  so the actual UPDATE goes through the same RLS-scoped path the
  orchestrator uses — a single bad row can't roll back the run.

  Safe to re-run. A cluster that already has the correct centroid
  gets UPDATEd to the same value (+ updatedAt bump). A cluster with
  zero attached evidence stays NULL (matches the orchestrator).

  Usage:
    bun run scripts/backfill-centroids.ts [--dry-run] [--limit=N]
*/

interface Args {
  dryRun: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const dryRun = argv.includes("--dry-run");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg
    ? Number.parseInt(limitArg.slice("--limit=".length), 10)
    : null;
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`invalid --limit value: ${limitArg}`);
  }
  return { dryRun, limit };
}

export interface BackfillResult {
  updated: number;
  skippedEmpty: number;
  failed: number;
  total: number;
}

async function countAttached(
  tx: Tx | typeof db,
  clusterId: string,
): Promise<number> {
  const rows = await tx
    .select({ evidenceId: evidenceToCluster.evidenceId })
    .from(evidenceToCluster)
    .where(eq(evidenceToCluster.clusterId, clusterId));
  return rows.length;
}

/**
 * Backfill a single cluster. Exported for unit testing. Expects the
 * caller to own the tx and have called bindAccountToTx on it.
 * Returns "updated" when evidence was attached (centroid now set),
 * or "empty" when no evidence was attached (centroid stays NULL).
 */
export async function backfillOne(
  tx: Tx,
  clusterId: string,
  accountId: string,
): Promise<"updated" | "empty"> {
  const n = await countAttached(tx, clusterId);
  await recomputeClusterAggregates(tx, clusterId, accountId);
  return n === 0 ? "empty" : "updated";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `backfill-centroids: dryRun=${args.dryRun} limit=${args.limit ?? "none"}`,
  );

  const baseQuery = db
    .select({
      id: insightClusters.id,
      accountId: insightClusters.accountId,
    })
    .from(insightClusters)
    .where(
      and(
        isNull(insightClusters.centroid),
        isNull(insightClusters.tombstonedInto),
      ),
    );
  const targets = args.limit
    ? await baseQuery.limit(args.limit)
    : await baseQuery;

  console.log(`Found ${targets.length} clusters with NULL centroid`);

  const result: BackfillResult = {
    updated: 0,
    skippedEmpty: 0,
    failed: 0,
    total: targets.length,
  };

  for (const cluster of targets) {
    try {
      if (args.dryRun) {
        const n = await countAttached(db, cluster.id);
        if (n === 0) result.skippedEmpty++;
        else result.updated++;
      } else {
        const outcome = await db.transaction(async (tx) => {
          await bindAccountToTx(tx, cluster.accountId);
          return backfillOne(tx, cluster.id, cluster.accountId);
        });
        if (outcome === "empty") result.skippedEmpty++;
        else result.updated++;
      }
    } catch (err) {
      result.failed++;
      console.error(
        `cluster ${cluster.id} (account ${cluster.accountId}): ${(err as Error).message}`,
      );
    }

    const done = result.updated + result.skippedEmpty + result.failed;
    if (done % 100 === 0) {
      console.log(`Progress: ${done}/${result.total}`);
    }
  }

  console.log(
    `Done. updated=${result.updated} skipped_empty=${result.skippedEmpty} failed=${result.failed} total=${result.total}`,
  );
  if (result.failed > 0) process.exit(1);
}

// Only run main() when executed directly; importing from tests should
// not kick off the backfill.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
