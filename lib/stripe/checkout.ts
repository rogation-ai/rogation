import { eq } from "drizzle-orm";
import { accounts } from "@/db/schema";
import { env } from "@/env";
import { stripe } from "./client";
import { priceIdForPaidTier, type PaidTier } from "./prices";
import type { DbLike } from "@/server/trpc";

/*
  Checkout + customer-portal entrypoints.

  Stripe customer is created lazily on first upgrade (eng review
  decision #3). Signed-up users on the free tier never have a Stripe
  customer until they click "Upgrade" — keeps the Stripe account clean
  + reduces the Clerk webhook's blast radius.
*/

interface CreateCheckoutInput {
  db: DbLike;
  accountId: string;
  /** Clerk user's email; Stripe attaches this to the customer + receipts. */
  email: string;
  tier: PaidTier;
}

export async function createCheckoutSession({
  db,
  accountId,
  email,
  tier,
}: CreateCheckoutInput): Promise<{ url: string }> {
  const customerId = await ensureStripeCustomer(db, accountId, email);

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceIdForPaidTier(tier), quantity: 1 }],
    success_url: `${env.NEXT_PUBLIC_APP_URL}/app?billing=success`,
    cancel_url: `${env.NEXT_PUBLIC_APP_URL}/app?billing=canceled`,
    allow_promotion_codes: true,
    // Account id in metadata is belt-and-suspenders; the webhook
    // resolves via stripe_customer_id FK on the account row as the
    // primary path.
    metadata: { accountId, tier },
    subscription_data: {
      metadata: { accountId, tier },
    },
  });

  if (!session.url) {
    throw new Error("Stripe returned a session with no URL");
  }
  return { url: session.url };
}

interface CreatePortalInput {
  db: DbLike;
  accountId: string;
}

export async function createPortalSession({
  db,
  accountId,
}: CreatePortalInput): Promise<{ url: string }> {
  const [account] = await db
    .select({ stripeCustomerId: accounts.stripeCustomerId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account?.stripeCustomerId) {
    // Free users without a Stripe customer can't open the portal.
    // The UI should only show the "Manage subscription" link on paid
    // tiers; this is the defensive backstop.
    throw new Error("Account has no Stripe customer; upgrade first");
  }

  const session = await stripe().billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: `${env.NEXT_PUBLIC_APP_URL}/app`,
  });

  return { url: session.url };
}

/*
  Lazily create a Stripe customer for an account and persist its id.
  Safe to call on every checkout — returns the existing id on repeat
  calls. Transactional write of stripe_customer_id so a crash
  between "customer created at Stripe" and "id persisted in our DB"
  can be repaired by the next call (Stripe idempotency keys would be
  cleaner; future improvement).
*/
async function ensureStripeCustomer(
  db: DbLike,
  accountId: string,
  email: string,
): Promise<string> {
  const [account] = await db
    .select({
      stripeCustomerId: accounts.stripeCustomerId,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (account?.stripeCustomerId) return account.stripeCustomerId;

  const customer = await stripe().customers.create({
    email,
    metadata: { accountId },
  });

  await db
    .update(accounts)
    .set({ stripeCustomerId: customer.id })
    .where(eq(accounts.id, accountId));

  return customer.id;
}
