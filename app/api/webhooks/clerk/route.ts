import { type NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { db } from "@/db/client";
import { accounts, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { env } from "@/env";
import { EVENTS } from "@/lib/analytics/events";
import {
  captureServer,
  flushServer,
  identifyServer,
} from "@/lib/analytics/posthog-server";

/*
  Clerk webhook handler.

  Responsibilities:
  - Verify signature using svix (Clerk's webhook SDK). Reject anything unsigned.
  - On user.created: create account + user rows in ONE transaction.
  - Idempotent: if Clerk redelivers (retry, duplicate event), we no-op on
    the existing (account, user) pair. Never create duplicates.

  Stripe customer is NOT created here — that's lazy on first upgrade
  (eng review decision #3: "Stripe customer lazily on first upgrade").
  See /api/webhooks/stripe for subscription state wiring (follow-up commit).
*/

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req, {
      signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch (err) {
    console.error("Clerk webhook signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (evt.type === "user.created") {
    const { id: clerkUserId, email_addresses } = evt.data;
    const email = email_addresses?.[0]?.email_address;

    if (!clerkUserId || !email) {
      return NextResponse.json(
        { error: "Missing clerk user id or email" },
        { status: 400 },
      );
    }

    // Idempotency: check if this Clerk user already has a row.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    // Transactional create: account first, then user, then set owner.
    // If any step fails, the whole thing rolls back so we never leave
    // an orphan account with no owner (or vice versa).
    await db.transaction(async (tx) => {
      const [account] = await tx
        .insert(accounts)
        .values({ plan: "free" })
        .returning({ id: accounts.id });

      if (!account) throw new Error("Failed to create account row");

      const [user] = await tx
        .insert(users)
        .values({ accountId: account.id, clerkUserId, email })
        .returning({ id: users.id });

      if (!user) throw new Error("Failed to create user row");

      await tx
        .update(accounts)
        .set({ ownerUserId: user.id })
        .where(eq(accounts.id, account.id));
    });

    // Activation funnel step 1 (plan §7). PostHog no-ops when the
    // server key isn't set, so this is safe in dev. Flush before
    // responding so Vercel's serverless worker doesn't kill the
    // background batch.
    identifyServer(clerkUserId, { email, plan: "free" });
    captureServer(clerkUserId, EVENTS.SIGNUP_COMPLETED, { plan: "free" });
    await flushServer();

    return NextResponse.json({ ok: true });
  }

  // Ignore other event types for now. user.updated / user.deleted / session.*
  // handlers land in follow-up commits.
  return NextResponse.json({ ok: true, ignored: evt.type });
}
