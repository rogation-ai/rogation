import { desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { opportunities, outcomes } from "@/db/schema";
import { hasOutcomeTracking, type PlanTier } from "@/lib/plans";
import type { Tx } from "@/db/scoped";

/*
  Outcome tracking. The closing loop on "did what we shipped move the needle?"

  A Pro-plan PM fills an outcome row per metric after the spec lands in
  production: "Retention 7d — predicted 40, actual 43." The numbers go
  back into the /build screen as a "shipped → won / lost / mixed" badge
  so future rank decisions compound on real data instead of guesses.

  Writes are gated by hasOutcomeTracking(plan). Reads are open — if a
  Pro user downgrades, their history stays visible (just no new writes).
  This is the shape every plan-gated feature should follow: no silent
  data loss on downgrade, just no more rows.

  v1 scope: manual entry only. metricSource='posthog' + posthogMetricId
  already exist on the schema for the auto-sync follow-up, but no wiring
  yet — the UI only writes 'manual' rows today.
*/

export interface OutcomeCtx {
  db: Tx;
  accountId: string;
  plan: PlanTier;
}

export interface OutcomeRow {
  id: string;
  opportunityId: string;
  metricName: string;
  metricSource: "manual" | "posthog";
  predicted: number | null;
  actual: number | null;
  measuredAt: Date | null;
  createdAt: Date;
}

export interface OutcomeSummary {
  /** Count of outcome rows attached to this opportunity. */
  count: number;
  /** Rows where both predicted + actual are populated (i.e. we can compare). */
  measuredCount: number;
  /**
   * Verdict over measured rows:
   *   - "win"  if every measured metric hit or beat its predicted value
   *   - "loss" if every measured metric fell short
   *   - "mixed" if the results disagree
   *   - null if nothing is measured yet
   */
  verdict: "win" | "loss" | "mixed" | null;
  /**
   * Average delta (actual / predicted - 1) across measured rows where
   * predicted is non-zero. Positive = beat predictions. null when
   * nothing measurable. Clamped to [-1, 3] so one wild metric can't
   * swing the badge.
   */
  avgDelta: number | null;
}

/*
  Pure summariser. No DB, no network — takes an array of outcome rows
  and produces the shape the /build badge renders. Unit-tested so the
  verdict logic doesn't silently drift when new metric sources land.
*/
export function summarizeOutcomes(
  rows: ReadonlyArray<Pick<OutcomeRow, "predicted" | "actual">>,
): OutcomeSummary {
  const measured = rows.filter(
    (r) => r.predicted !== null && r.actual !== null,
  );

  if (measured.length === 0) {
    return {
      count: rows.length,
      measuredCount: 0,
      verdict: null,
      avgDelta: null,
    };
  }

  let hits = 0;
  let misses = 0;
  let deltaSum = 0;
  let deltaCount = 0;

  for (const r of measured) {
    const predicted = r.predicted as number;
    const actual = r.actual as number;
    if (actual >= predicted) hits++;
    else misses++;
    if (predicted !== 0) {
      const raw = actual / predicted - 1;
      const clamped = Math.max(-1, Math.min(3, raw));
      deltaSum += clamped;
      deltaCount++;
    }
  }

  const verdict: OutcomeSummary["verdict"] =
    misses === 0 ? "win" : hits === 0 ? "loss" : "mixed";

  return {
    count: rows.length,
    measuredCount: measured.length,
    verdict,
    avgDelta: deltaCount === 0 ? null : deltaSum / deltaCount,
  };
}

/* --------------------------------- CRUD --------------------------------- */

function assertWriteGate(plan: PlanTier): void {
  if (!hasOutcomeTracking(plan)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Outcome tracking is a Pro-plan feature. Upgrade to record metrics.",
      cause: { type: "plan_feature_required", feature: "outcome_tracking" },
    });
  }
}

async function assertOpportunityOwned(
  ctx: OutcomeCtx,
  opportunityId: string,
): Promise<void> {
  const [row] = await ctx.db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.id, opportunityId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Opportunity not found",
    });
  }
}

export interface CreateOutcomeInput {
  opportunityId: string;
  metricName: string;
  predicted: number | null;
  actual: number | null;
  measuredAt: Date | null;
}

export async function createOutcome(
  ctx: OutcomeCtx,
  input: CreateOutcomeInput,
): Promise<OutcomeRow> {
  assertWriteGate(ctx.plan);
  await assertOpportunityOwned(ctx, input.opportunityId);

  const [row] = await ctx.db
    .insert(outcomes)
    .values({
      accountId: ctx.accountId,
      opportunityId: input.opportunityId,
      metricName: input.metricName,
      metricSource: "manual",
      predicted: input.predicted,
      actual: input.actual,
      measuredAt: input.measuredAt,
    })
    .returning();

  if (!row) throw new Error("outcome insert returned no row");
  return toOutcomeRow(row);
}

export interface UpdateOutcomeInput {
  id: string;
  metricName?: string;
  predicted?: number | null;
  actual?: number | null;
  measuredAt?: Date | null;
}

export async function updateOutcome(
  ctx: OutcomeCtx,
  input: UpdateOutcomeInput,
): Promise<OutcomeRow> {
  assertWriteGate(ctx.plan);

  // RLS scopes the update. We still narrow by id — a missing row means
  // the id was invalid or belonged to another account.
  const patch: Record<string, unknown> = {};
  if (input.metricName !== undefined) patch.metricName = input.metricName;
  if (input.predicted !== undefined) patch.predicted = input.predicted;
  if (input.actual !== undefined) patch.actual = input.actual;
  if (input.measuredAt !== undefined) patch.measuredAt = input.measuredAt;

  const [row] = await ctx.db
    .update(outcomes)
    .set(patch)
    .where(eq(outcomes.id, input.id))
    .returning();

  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Outcome not found" });
  }
  return toOutcomeRow(row);
}

export async function deleteOutcome(
  ctx: OutcomeCtx,
  id: string,
): Promise<{ removed: boolean }> {
  assertWriteGate(ctx.plan);
  const result = await ctx.db
    .delete(outcomes)
    .where(eq(outcomes.id, id))
    .returning({ id: outcomes.id });
  return { removed: result.length > 0 };
}

export async function listOutcomesForOpportunity(
  ctx: Pick<OutcomeCtx, "db">,
  opportunityId: string,
): Promise<OutcomeRow[]> {
  const rows = await ctx.db
    .select()
    .from(outcomes)
    .where(eq(outcomes.opportunityId, opportunityId))
    .orderBy(desc(outcomes.createdAt));
  return rows.map(toOutcomeRow);
}

export async function summariesForOpportunities(
  ctx: Pick<OutcomeCtx, "db">,
  opportunityIds: string[],
): Promise<Map<string, OutcomeSummary>> {
  const out = new Map<string, OutcomeSummary>();
  if (opportunityIds.length === 0) return out;

  const rows = await ctx.db
    .select({
      opportunityId: outcomes.opportunityId,
      predicted: outcomes.predicted,
      actual: outcomes.actual,
    })
    .from(outcomes)
    .where(inArray(outcomes.opportunityId, opportunityIds));

  const grouped = new Map<string, Array<{ predicted: number | null; actual: number | null }>>();
  for (const r of rows) {
    const arr = grouped.get(r.opportunityId) ?? [];
    arr.push({ predicted: r.predicted, actual: r.actual });
    grouped.set(r.opportunityId, arr);
  }
  for (const [oppId, bucket] of grouped) {
    out.set(oppId, summarizeOutcomes(bucket));
  }
  return out;
}

function toOutcomeRow(row: typeof outcomes.$inferSelect): OutcomeRow {
  return {
    id: row.id,
    opportunityId: row.opportunityId,
    metricName: row.metricName,
    metricSource: row.metricSource as "manual" | "posthog",
    predicted: row.predicted,
    actual: row.actual,
    measuredAt: row.measuredAt,
    createdAt: row.createdAt,
  };
}

// Re-export so callers don't have to also grab it from @/lib/plans.
export { hasOutcomeTracking } from "@/lib/plans";
