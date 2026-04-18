import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  entityFeedback,
  insightClusters,
  opportunities as opportunitiesTbl,
  specs,
} from "@/db/schema";
import type { Tx } from "@/db/scoped";

/*
  Entity feedback. The eval loop's foundation.

  PMs thumbs-up/down a cluster, opportunity, or spec. Every vote
  captures the prompt_hash that produced the target so:

    SELECT prompt_hash,
           COUNT(*) FILTER (WHERE rating = 'down') AS downs,
           COUNT(*) FILTER (WHERE rating = 'up')   AS ups
    FROM entity_feedback
    GROUP BY prompt_hash
    ORDER BY downs::float / NULLIF(ups + downs, 0) DESC;

  gives us "which prompt version is drifting" — run this after every
  prompt edit to confirm the new hash isn't regressing real users.

  UPSERT semantics: one vote per (account, user, entity). Re-voting
  overwrites; the UNIQUE index added in migration 0003 is the conflict
  target.

  Prompt-hash capture is server-side. Clients never send it — we look
  it up on the target row at vote time so a replay attack can't
  poison the eval stream with a fake hash.
*/

export type FeedbackEntityType = "insight_cluster" | "opportunity" | "spec";
export type FeedbackRating = "up" | "down";

export interface FeedbackCtx {
  db: Tx;
  accountId: string;
  userId: string;
}

export interface VoteInput {
  entityType: FeedbackEntityType;
  entityId: string;
  rating: FeedbackRating;
  note?: string;
}

export interface VoteResult {
  id: string;
  rating: FeedbackRating;
  promptHash: string | null;
}

export async function voteOnEntity(
  ctx: FeedbackCtx,
  input: VoteInput,
): Promise<VoteResult> {
  const promptHash = await lookupPromptHash(
    ctx,
    input.entityType,
    input.entityId,
  );

  if (promptHash === null) {
    // Entity doesn't exist (or cross-account, RLS hid it) — treat
    // as not-found rather than inserting a dangling feedback row.
    throw new Error("Target entity not found");
  }

  const [row] = await ctx.db
    .insert(entityFeedback)
    .values({
      accountId: ctx.accountId,
      userId: ctx.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      rating: input.rating,
      note: input.note,
      promptHash,
    })
    .onConflictDoUpdate({
      target: [
        entityFeedback.accountId,
        entityFeedback.userId,
        entityFeedback.entityType,
        entityFeedback.entityId,
      ],
      // The unique index is PARTIAL (WHERE user_id IS NOT NULL) so
      // Postgres requires the same predicate on the ON CONFLICT
      // target, otherwise "there is no unique or exclusion
      // constraint matching the ON CONFLICT specification."
      // Found by /qa on 2026-04-18.
      targetWhere: isNotNull(entityFeedback.userId),
      set: {
        rating: input.rating,
        note: input.note,
        // Refresh prompt_hash on revote so the eval window reflects
        // the most recent generation, not a stale one from before a
        // regenerate + re-vote.
        promptHash,
        createdAt: sql`now()`,
      },
    })
    .returning({
      id: entityFeedback.id,
      rating: entityFeedback.rating,
      promptHash: entityFeedback.promptHash,
    });

  if (!row) {
    throw new Error("feedback insert returned no row");
  }

  return row;
}

export async function removeVote(
  ctx: FeedbackCtx,
  entityType: FeedbackEntityType,
  entityId: string,
): Promise<{ removed: boolean }> {
  const result = await ctx.db
    .delete(entityFeedback)
    .where(
      and(
        eq(entityFeedback.accountId, ctx.accountId),
        eq(entityFeedback.userId, ctx.userId),
        eq(entityFeedback.entityType, entityType),
        eq(entityFeedback.entityId, entityId),
      ),
    )
    .returning({ id: entityFeedback.id });

  return { removed: result.length > 0 };
}

export interface UserVote {
  entityType: FeedbackEntityType;
  entityId: string;
  rating: FeedbackRating;
}

/**
 * Current user's votes for a batch of entities. Drives thumb-rendering
 * state — a toggled-on thumb means "you voted this way already."
 */
export async function myVotes(
  ctx: FeedbackCtx,
  entityType: FeedbackEntityType,
  entityIds: string[],
): Promise<UserVote[]> {
  if (entityIds.length === 0) return [];
  const rows = await ctx.db
    .select({
      entityType: entityFeedback.entityType,
      entityId: entityFeedback.entityId,
      rating: entityFeedback.rating,
    })
    .from(entityFeedback)
    .where(
      and(
        eq(entityFeedback.accountId, ctx.accountId),
        eq(entityFeedback.userId, ctx.userId),
        eq(entityFeedback.entityType, entityType),
        inArray(entityFeedback.entityId, entityIds),
      ),
    );
  return rows.map((r) => ({
    entityType: r.entityType as FeedbackEntityType,
    entityId: r.entityId,
    rating: r.rating as FeedbackRating,
  }));
}

export interface AggregateRow {
  promptHash: string;
  ups: number;
  downs: number;
  total: number;
}

/**
 * Per-prompt-hash aggregate. For eval dashboards + "which prompt
 * regressed" alerting. Account-scoped so each tenant's signal is
 * independent.
 */
export async function aggregateByPrompt(
  ctx: FeedbackCtx,
): Promise<AggregateRow[]> {
  const rows = await ctx.db
    .select({
      promptHash: entityFeedback.promptHash,
      ups: sql<number>`count(*) filter (where ${entityFeedback.rating} = 'up')::int`,
      downs: sql<number>`count(*) filter (where ${entityFeedback.rating} = 'down')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(entityFeedback)
    .where(
      and(
        eq(entityFeedback.accountId, ctx.accountId),
        sql`${entityFeedback.promptHash} is not null`,
      ),
    )
    .groupBy(entityFeedback.promptHash)
    .orderBy(desc(sql`count(*)`));

  return rows.map((r) => ({
    promptHash: r.promptHash ?? "",
    ups: r.ups,
    downs: r.downs,
    total: r.total,
  }));
}

/* --------------------------- internal helpers --------------------------- */

async function lookupPromptHash(
  ctx: FeedbackCtx,
  entityType: FeedbackEntityType,
  entityId: string,
): Promise<string | null> {
  // Per-target table lookup. RLS scopes the SELECT to the current
  // account — cross-account target ids return zero rows, which we
  // treat as not-found.
  switch (entityType) {
    case "insight_cluster": {
      const [row] = await ctx.db
        .select({ h: insightClusters.promptHash })
        .from(insightClusters)
        .where(eq(insightClusters.id, entityId))
        .limit(1);
      return row?.h ?? null;
    }
    case "opportunity": {
      const [row] = await ctx.db
        .select({ h: opportunitiesTbl.promptHash })
        .from(opportunitiesTbl)
        .where(eq(opportunitiesTbl.id, entityId))
        .limit(1);
      return row?.h ?? null;
    }
    case "spec": {
      const [row] = await ctx.db
        .select({ h: specs.promptHash })
        .from(specs)
        .where(eq(specs.id, entityId))
        .limit(1);
      return row?.h ?? null;
    }
  }
}
