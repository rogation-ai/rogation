import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "@/env";

/*
  Rate limiting. Addresses two of the critical gaps the eng review
  flagged:
    1. /s/*  share-link enumeration (by IP).
    2. Spec-chat refinement abuse (by accountId).

  Both surfaces land in later feature commits; this module ships the
  infrastructure + one immediate application (billing.createCheckout,
  which costs real Stripe API calls when spammed).

  Fail-open semantics: when Upstash isn't configured (dev / CI / a
  temporary Redis outage), checkLimit() returns { success: true } so
  no request gets blocked by a missing dep. Production-grade protection
  requires the keys set; the tradeoff is that a missing key in prod
  is silent — rely on env.ts to require them later when we can't boot
  without Redis.

  Adding a new surface:
    1. Pick a PRESET in RATE_LIMIT_PRESETS below (or add one).
    2. In the handler: const result = await checkLimit("share-link", ip);
       if (!result.success) return TooManyRequests();
*/

const DEV_WARNED = new Set<string>();

let sharedRedis: Redis | null = null;

function getRedis(): Redis | null {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  if (sharedRedis) return sharedRedis;
  sharedRedis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return sharedRedis;
}

/*
  Preset limit configurations per surface. Keep them here in one table
  so a rate-limit audit is one file read. Tune based on real traffic;
  the eng review's specific fears (share-link enumeration, chat
  flooding) set the starting envelope.
*/
export const RATE_LIMIT_PRESETS = {
  /**
   * Share-link views. By client IP. Generous per minute so legitimate
   * link-sharers (copy link → slack → 5 colleagues click in 10s)
   * aren't blocked; tight enough per hour that a token-enumeration
   * script gets stopped early.
   */
  "share-link": {
    requests: 60,
    window: "1 m",
    hourly: { requests: 600, window: "1 h" },
  },
  /**
   * Spec-editor chat refinement. By accountId. Real use is ~1
   * turn/20s; 20/min leaves headroom for rapid iteration but blocks
   * a scripted spam.
   */
  "spec-chat": {
    requests: 20,
    window: "1 m",
  },
  /**
   * Billing checkout-session creation. By accountId. Each call hits
   * the Stripe API — we don't want a tight loop accidentally opening
   * 100 sessions. Generous enough for normal plan-switching flows.
   */
  "checkout-create": {
    requests: 10,
    window: "1 h",
  },
  /**
   * Soft limit on signed webhook endpoints. Signature is the real
   * gate; this is defense in depth against replay attacks with a
   * leaked signature. Per-IP key.
   */
  "webhook": {
    requests: 120,
    window: "1 m",
  },
  /**
   * Push-spec-to-Linear. By accountId. Each call does a Linear
   * GraphQL mutation AND writes our DB. 30/hour leaves plenty of
   * slack for a PM legitimately pushing 10-20 specs in a session
   * while stopping an accidental loop or a rogue script from
   * hammering Linear's API (which would get us rate-limited by
   * them with a fallout that affects every other tenant using
   * the same integration).
   */
  "linear-push": {
    requests: 30,
    window: "1 h",
  },
  /**
   * Re-cluster runs. By accountId. Each run can call Sonnet 4.6 with
   * a 20k-token prompt — that's real money. 10/hour is plenty for a
   * PM iterating on a corpus (re-cluster after adding evidence, then
   * again after adding more) but stops a tight loop from burning
   * $5 in 10 seconds.
   */
  "cluster-run": {
    requests: 10,
    window: "1 h",
  },
  /**
   * Nango webhook ingestion. By accountId. Each event triggers an
   * ingestEvidence call + embed. 100/hour is generous for a single
   * Slack channel (~4 msg/hour avg) but caps a runaway backfill or
   * misconfigured sync from burning embed budget.
   */
  "connector-ingest": {
    requests: 100,
    window: "1 h",
  },
  /**
   * Manual scope re-route. By accountId. routeAllEvidence is O(rows ×
   * scopes) sequential UPDATEs in a single transaction. A PM clicking
   * the "Re-route now" button on /settings/scopes shouldn't be able to
   * stack concurrent re-routes (or hold a long tx via mash-clicking
   * across tabs). 10/hour is well above any human iteration rhythm
   * (re-route after adding new evidence, after editing a brief, etc.)
   * while blocking a tight script.
   */
  "scope-reroute": {
    requests: 10,
    window: "1 h",
  },
} as const;

export type RateLimitPreset = keyof typeof RATE_LIMIT_PRESETS;

/*
  Lazy per-preset limiter. Each Ratelimit instance has its own sliding
  window in Redis keyed by preset name, so one surface hitting its cap
  doesn't starve another.
*/
const limiters = new Map<RateLimitPreset, Ratelimit>();

function getLimiter(preset: RateLimitPreset): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;

  const cached = limiters.get(preset);
  if (cached) return cached;

  const cfg = RATE_LIMIT_PRESETS[preset];
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      cfg.requests,
      cfg.window as Parameters<typeof Ratelimit.slidingWindow>[1],
    ),
    analytics: true,
    prefix: `rl:${preset}`,
  });
  limiters.set(preset, limiter);
  return limiter;
}

export interface RateLimitResult {
  /** True when the request is allowed. False when limit was hit. */
  success: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Unix epoch ms when the window resets. */
  reset: number;
  /** Configured cap for this preset. */
  limit: number;
}

/**
 * Check if a request should be allowed under the preset's rate. When
 * Upstash isn't configured, fails OPEN — the dev loop never blocks on
 * a missing Redis. Production should ensure the env vars are set.
 *
 * `identifier` is the key the limit applies to (IP, accountId, etc.).
 */
export async function checkLimit(
  preset: RateLimitPreset,
  identifier: string,
): Promise<RateLimitResult> {
  const limiter = getLimiter(preset);

  if (!limiter) {
    // Warn once per preset so the missing config is visible in dev logs.
    if (process.env.NODE_ENV !== "production" && !DEV_WARNED.has(preset)) {
      DEV_WARNED.add(preset);
      console.warn(
        `[rate-limit] Upstash not configured; '${preset}' failing OPEN. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable.`,
      );
    }
    return {
      success: true,
      remaining: Number.POSITIVE_INFINITY,
      reset: 0,
      limit: RATE_LIMIT_PRESETS[preset].requests,
    };
  }

  const res = await limiter.limit(identifier);
  return {
    success: res.success,
    remaining: res.remaining,
    reset: res.reset,
    limit: res.limit,
  };
}

/**
 * Test seam. Reset the module's private state so unit tests can
 * flip env values between cases without carrying cached singletons.
 */
export function __resetRateLimitForTest(): void {
  sharedRedis = null;
  limiters.clear();
  DEV_WARNED.clear();
}
