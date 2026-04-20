import { env } from "@/env";
import type { PlanTier } from "@/lib/plans";

/*
  Plan-tier ↔ Stripe-price mapping. Bidirectional because the
  checkout path needs tier → price and the webhook path needs price
  → tier (to set account.plan from the subscription event).

  Only Solo + Pro are mapped. Free has no Stripe price — free accounts
  never hit checkout. A missing price in a webhook event means someone
  enabled a price in Stripe without mapping it here; fail loudly.
*/

export type PaidTier = "solo" | "pro";

export function priceIdForPaidTier(tier: PaidTier): string {
  switch (tier) {
    case "solo":
      return env.STRIPE_PRICE_ID_SOLO;
    case "pro":
      return env.STRIPE_PRICE_ID_PRO;
  }
}

/**
 * Reverse lookup from a Stripe price id to a PaidTier. Returns null
 * when the price doesn't match either env-configured id — callers
 * (the webhook) treat that as a hard error.
 */
export function paidTierForPriceId(priceId: string): PaidTier | null {
  if (priceId === env.STRIPE_PRICE_ID_SOLO) return "solo";
  if (priceId === env.STRIPE_PRICE_ID_PRO) return "pro";
  return null;
}

/**
 * Tier coercion used by the webhook. "active" or "trialing" status on a
 * known price → that paid tier. Any other status → free (the caller
 * handles the mapping to subscription_status separately).
 */
export function planFromSubscriptionEvent(
  priceId: string,
  status: string,
): PlanTier {
  const paid = paidTierForPriceId(priceId);
  if (!paid) {
    throw new Error(
      `Stripe price ${priceId} is not mapped to a PaidTier; update lib/stripe/prices.ts`,
    );
  }
  if (status === "active" || status === "trialing") return paid;
  return "free";
}
