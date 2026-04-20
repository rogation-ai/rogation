import { count, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  evidence,
  insightClusters,
  integrationCredentials,
  opportunities,
  specs,
} from "@/db/schema";
import type { DbLike } from "@/server/trpc";

/*
  Single source of truth for plan tiers + their caps + feature gates.

  Pricing shape (plan §8, locked in during Section 11 walkthrough):
  - Free: 10 evidence, 3 insights, 1 opportunity, 1 spec. Markdown
    export only, watermarked. No integrations. No outcome tracking.
  - Solo ($49/mo): unlimited synthesis, 1 integration, Markdown export
    (no watermark). No Linear/Notion, no outcome tracking.
  - Pro ($99/mo): unlimited integrations, Linear + Notion + Markdown
    export, outcome tracking, share links without watermark.

  Feature-gate rule: any mutation that creates a resource OR uses a
  gated feature MUST consult this module. The tRPC authed middleware
  exposes `ctx.assertLimit(resource)` as a one-liner — use that.
*/

export type PlanTier = "free" | "solo" | "pro";

/**
 * Resources counted against the per-account cap. Adding a new countable
 * resource means: (1) extend this union, (2) add a row to RESOURCE_TABLE,
 * (3) extend PLAN_LIMITS.
 */
export type CountableResource =
  | "evidence"
  | "insights"
  | "opportunities"
  | "specs"
  | "integrations";

export type LimitValue = number | "unlimited";

export interface PlanLimits {
  evidence: LimitValue;
  insights: LimitValue;
  opportunities: LimitValue;
  specs: LimitValue;
  integrations: LimitValue;
  /** Monthly token-ceiling for the LLM router. Hard cap enforced via onUsage hook. */
  monthlyTokenBudget: number;
  /** Export targets available on this tier. */
  exports: {
    markdown: boolean;
    linear: boolean;
    notion: boolean;
    watermark: boolean;
  };
  /** Public share links include the "Built with Rogation" watermark. */
  shareLinksWatermark: boolean;
  /** Outcome-tracking screen + PostHog pairing are visible. */
  outcomeTracking: boolean;
}

/*
  Ballpark token budgets derived from the unit-economics TODO. Revisit
  after the real cost model lands (see TODOS.md). Current assumption:
    - Free  : ~200k tokens/mo covers ~10 short interviews being
              clustered once with Sonnet 4.6.
    - Solo  : ~5M tokens/mo comfortably covers weekly re-cluster +
              spec generation for one active PM.
    - Pro   : ~15M tokens/mo supports dense usage + eval telemetry.
*/
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    evidence: 10,
    insights: 3,
    opportunities: 1,
    specs: 1,
    integrations: 0,
    monthlyTokenBudget: 200_000,
    exports: {
      markdown: true,
      linear: false,
      notion: false,
      watermark: true,
    },
    shareLinksWatermark: true,
    outcomeTracking: false,
  },
  solo: {
    evidence: "unlimited",
    insights: "unlimited",
    opportunities: "unlimited",
    specs: "unlimited",
    integrations: 1,
    monthlyTokenBudget: 5_000_000,
    exports: {
      markdown: true,
      linear: false,
      notion: false,
      watermark: false,
    },
    shareLinksWatermark: false,
    outcomeTracking: false,
  },
  pro: {
    evidence: "unlimited",
    insights: "unlimited",
    opportunities: "unlimited",
    specs: "unlimited",
    integrations: "unlimited",
    monthlyTokenBudget: 15_000_000,
    exports: {
      markdown: true,
      linear: true,
      notion: true,
      watermark: false,
    },
    shareLinksWatermark: false,
    outcomeTracking: true,
  },
};

/** Tables whose row count represents the resource's current usage. */
const RESOURCE_TABLE = {
  evidence: evidence,
  insights: insightClusters,
  opportunities: opportunities,
  specs: specs,
  integrations: integrationCredentials,
} as const;

export interface LimitCheck {
  resource: CountableResource;
  current: number;
  max: LimitValue;
  plan: PlanTier;
}

export interface PlanLimitErrorData {
  type: "plan_limit_reached";
  resource: CountableResource;
  current: number;
  max: number;
  currentPlan: PlanTier;
}

/**
 * Count how many of `resource` this account currently has. Runs inside
 * the caller's tRPC transaction, so RLS applies automatically — the
 * count is scoped without an explicit account_id clause.
 */
export async function countResource(
  db: DbLike,
  resource: CountableResource,
  accountId: string,
): Promise<number> {
  const table = RESOURCE_TABLE[resource];
  // The account_id column is named the same across all tables in this
  // map; RLS also filters, but we add the explicit clause for query
  // planner benefit + defense in depth.
  const [row] = await db
    .select({ n: count() })
    .from(table)
    .where(eq(table.accountId, accountId));
  return row?.n ?? 0;
}

/**
 * Assert the account has headroom for one more `resource`. Throws
 * TRPCError FORBIDDEN with a structured payload when the cap is hit so
 * the UI can render the paywall modal (design review Pass 7).
 *
 * Returns { current, max } on success so the caller can expose a
 * "Evidence 7/10" meter without a second count.
 */
export async function assertResourceLimit(
  db: DbLike,
  plan: PlanTier,
  accountId: string,
  resource: CountableResource,
): Promise<LimitCheck> {
  const max = PLAN_LIMITS[plan][resource];
  const current = await countResource(db, resource, accountId);

  if (max !== "unlimited" && current >= max) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You've reached the ${plan} plan limit for ${resource} (${max}). Upgrade to continue.`,
      cause: {
        type: "plan_limit_reached",
        resource,
        current,
        max,
        currentPlan: plan,
      } satisfies PlanLimitErrorData,
    });
  }

  return { resource, current, max, plan };
}

/* ------------------------------ feature gates ----------------------------- */

export function canExport(plan: PlanTier, target: "markdown" | "linear" | "notion"): boolean {
  return PLAN_LIMITS[plan].exports[target];
}

export function exportHasWatermark(plan: PlanTier): boolean {
  return PLAN_LIMITS[plan].exports.watermark;
}

export function shareLinksHaveWatermark(plan: PlanTier): boolean {
  return PLAN_LIMITS[plan].shareLinksWatermark;
}

export function hasOutcomeTracking(plan: PlanTier): boolean {
  return PLAN_LIMITS[plan].outcomeTracking;
}

/* --------------------------- budget soft-warning -------------------------- */

/** 80% of the monthly token budget — emit a warning banner + email above this line. */
export function tokenBudgetSoftCap(plan: PlanTier): number {
  return Math.floor(PLAN_LIMITS[plan].monthlyTokenBudget * 0.8);
}
