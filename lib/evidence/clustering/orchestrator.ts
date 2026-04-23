import { and, count, eq, isNull, sql } from "drizzle-orm";
import { evidence, insightClusters } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import type { CompleteOpts } from "@/lib/llm/router";
import {
  deleteAllClustersForAccount,
  runFullClustering,
} from "@/lib/evidence/synthesis";
import { runIncrementalClustering } from "./incremental";
import { applyClusterActions } from "./apply";
import type { InsightRunMode } from "@/db/schema";

/*
  Re-cluster dispatch (design §7 rule).

  Cold start: zero live clusters AND ≤50 evidence → runFullClustering.
    Rationale: no opportunity rows reference cluster ids yet, so a
    fresh rebuild is safe; the full path is simpler and gets a
    reliable v1 result for the first real run.

  Otherwise: runIncrementalClustering.
    Preserves cluster ids (critical once opportunity_to_cluster FKs
    exist), uses KNN to skip the LLM on high-confidence attachments,
    scales past the 50-row cap.

  This is the single public entrypoint for "re-cluster this account."
  tRPC + Inngest worker both call it; no other caller should decide
  between full/incremental directly.
*/

const COLD_START_EVIDENCE_CAP = 50;

export interface OrchestratorContext {
  db: Tx;
  accountId: string;
}

export interface OrchestratorResult {
  mode: InsightRunMode;
  clustersCreated: number;
  evidenceUsed: number;
  promptHash: string;
}

export async function runClustering(
  ctx: OrchestratorContext,
  opts: CompleteOpts = {},
): Promise<OrchestratorResult> {
  // Serialize per account. Two concurrent re-cluster runs on the same
  // account would race each other: overlapping reads of existing
  // clusters, duplicate NEW inserts, tombstone collisions, corrupt
  // centroids. The Inngest worker enforces concurrency.limit=1 per
  // accountId, but the sync tRPC path bypasses that — this advisory
  // lock closes the gap. Transaction-scoped: released on commit or
  // rollback, no explicit unlock needed.
  await ctx.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('cluster:' || ${ctx.accountId}, 0))`,
  );

  const [clusterCountRow] = await ctx.db
    .select({ n: count() })
    .from(insightClusters)
    .where(
      and(
        eq(insightClusters.accountId, ctx.accountId),
        isNull(insightClusters.tombstonedInto),
      ),
    );
  const [evidenceCountRow] = await ctx.db
    .select({ n: count() })
    .from(evidence)
    .where(eq(evidence.accountId, ctx.accountId));

  const existingClusters = Number(clusterCountRow?.n ?? 0);
  const evidenceCount = Number(evidenceCountRow?.n ?? 0);

  if (existingClusters === 0 && evidenceCount <= COLD_START_EVIDENCE_CAP) {
    // Cold start. Wipe any tombstoned remnants (shouldn't exist but
    // belt-and-suspenders) + run full clustering + apply.
    await deleteAllClustersForAccount(ctx.db, ctx.accountId);
    const { plan, evidenceUsed, promptHash } = await runFullClustering(
      { db: ctx.db, accountId: ctx.accountId },
      opts,
    );
    const { clustersCreated } = await applyClusterActions(
      ctx.db,
      plan,
      ctx.accountId,
      promptHash,
    );
    return {
      mode: "full",
      clustersCreated,
      evidenceUsed,
      promptHash,
    };
  }

  // Incremental path.
  const {
    plan,
    evidenceUsed,
    promptHash,
  } = await runIncrementalClustering(
    { db: ctx.db, accountId: ctx.accountId },
    opts,
  );
  const { clustersCreated } = await applyClusterActions(
    ctx.db,
    plan,
    ctx.accountId,
    promptHash,
  );
  return {
    mode: "incremental",
    clustersCreated,
    evidenceUsed,
    promptHash,
  };
}
