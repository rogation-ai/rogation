import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db/client";
import { accounts, subscriptionStatus as subStatusEnum } from "@/db/schema";
import { env } from "@/env";
import { stripe } from "@/lib/stripe/client";
import { planFromSubscriptionEvent } from "@/lib/stripe/prices";
import { flushLangfuse } from "@/lib/llm/langfuse";
import { flushServer } from "@/lib/analytics/posthog-server";

/*
  Stripe webhook handler. Keeps account.plan + account.stripe_subscription_id
  + account.subscription_status in sync with Stripe (source of truth).

  Design:
  - Idempotent by design. Every handler writes a SET (not accumulating)
    so redelivery of the same event converges to the correct state.
  - Signature-verified via stripe.webhooks.constructEvent — refuses
    unsigned or re-timed payloads.
  - Handlers resolve the target account via stripe_customer_id (FK-like).
    The metadata.accountId on the event is belt-and-suspenders; the
    customer id is the primary key.
  - Bypasses RLS intentionally: connects as the schema owner (no
    set_config on the session), so it can update any account row
    regardless of which tenant the event belongs to. This mirrors the
    Clerk webhook pattern — signed webhooks are the trust boundary.

  Events handled:
  - customer.subscription.created    set plan + subscription fields
  - customer.subscription.updated    plan change or status change
  - customer.subscription.deleted    revert to free
  - invoice.payment_failed           status -> past_due

  Everything else is acknowledged with { ok, ignored } so Stripe's
  retry queue doesn't spin on events we don't process yet.
*/

export async function POST(req: NextRequest): Promise<NextResponse> {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // The raw request body string is required for signature verification.
  // Don't JSON.parse first — Stripe signs the exact bytes.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SIGNING_SECRET,
    );
  } catch (err) {
    console.error("[stripe webhook] signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpsert(event.data.object);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;

      case "invoice.payment_failed":
        await handlePaymentFailed(event.data.object);
        break;

      default:
        return NextResponse.json({ ok: true, ignored: event.type });
    }

    // Side-channel flushes so Vercel's serverless teardown doesn't lose
    // the events captured during handler execution.
    await Promise.all([flushServer(), flushLangfuse()]);

    return NextResponse.json({ ok: true, handled: event.type });
  } catch (err) {
    console.error(`[stripe webhook] handler error for ${event.type}`, err);
    // Return 500 so Stripe retries. The error is logged to Sentry via
    // the instrumentation onRequestError hook.
    return NextResponse.json(
      { error: "Handler failed" },
      { status: 500 },
    );
  }
}

/* --------------------------- handlers --------------------------- */

async function handleSubscriptionUpsert(
  sub: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const item = sub.items.data[0];
  if (!item) {
    throw new Error(
      `Subscription ${sub.id} has no line items; cannot derive plan`,
    );
  }

  const priceId = item.price.id;
  const plan = planFromSubscriptionEvent(priceId, sub.status);

  await db
    .update(accounts)
    .set({
      plan,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: toEnumStatus(sub.status),
      trialEndsAt: sub.trial_end
        ? new Date(sub.trial_end * 1000)
        : null,
    })
    .where(eq(accounts.stripeCustomerId, customerId));
}

async function handleSubscriptionDeleted(
  sub: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  // Revert to free tier, keep the stripe_customer_id so if the user
  // re-subscribes we don't spawn a second Stripe customer. Drop the
  // subscription_id since it's now ended.
  await db
    .update(accounts)
    .set({
      plan: "free",
      stripeSubscriptionId: null,
      subscriptionStatus: "canceled",
      trialEndsAt: null,
    })
    .where(eq(accounts.stripeCustomerId, customerId));
}

async function handlePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<void> {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return;

  // Mark past_due. Access stays granted (Stripe's default dunning
  // behavior + our plan enforcement tolerate past_due for a bit);
  // if Stripe ultimately cancels, subscription.deleted fires and
  // we drop to free.
  await db
    .update(accounts)
    .set({ subscriptionStatus: "past_due" })
    .where(eq(accounts.stripeCustomerId, customerId));
}

/*
  Narrows Stripe's broader string status to our enum's allowed values.
  Any unknown status (rare) falls back to "incomplete" so we never
  leave the column in a mismatched state.
*/
function toEnumStatus(
  status: Stripe.Subscription.Status,
): (typeof subStatusEnum.enumValues)[number] {
  switch (status) {
    case "active":
    case "past_due":
    case "canceled":
    case "trialing":
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
      return status;
    default:
      return "incomplete";
  }
}
