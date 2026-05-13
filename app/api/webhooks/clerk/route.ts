import { type NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { env } from "@/env";
import {
  provisionAccountForClerkUser,
  provisionAccountForClerkOrg,
} from "@/lib/account/provision";
import { EVENTS } from "@/lib/analytics/events";
import {
  captureServer,
  flushServer,
  identifyServer,
} from "@/lib/analytics/posthog-server";

/*
  Clerk webhook — defense-in-depth backup for account provisioning.

  The CANONICAL provisioning path is `server/trpc.ts > createContext`,
  which lazily creates the account+user row on the first authenticated
  request. That path runs synchronously against the request, so it
  always succeeds before the user sees their first page. This webhook
  is the defense in depth for edge cases where a user signs up via a
  flow that doesn't hit a tRPC surface first.

  Idempotency: the shared provisioning helper is UPSERT-like. If
  createContext already provisioned, this webhook returns the existing
  row with `created: false` and no PostHog event fires. Flipped the
  other way, the webhook also handles the case where the tRPC path
  never runs (OAuth-only, direct-to-share-link, etc.).

  Signature verification still enforced — never trust unsigned payloads.
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

    const result = await provisionAccountForClerkUser({ clerkUserId, email });

    // Only fire the activation event when WE did the insert. If
    // createContext beat us to it, the event was already captured
    // there — firing again would double-count the funnel.
    if (result.created) {
      identifyServer(clerkUserId, { email, plan: result.plan });
      captureServer(clerkUserId, EVENTS.SIGNUP_COMPLETED, {
        plan: result.plan,
      });
      await flushServer();
    }

    return NextResponse.json({
      ok: true,
      created: result.created,
    });
  }

  if (evt.type === "organization.created") {
    const orgData = evt.data as {
      id?: string;
      created_by?: string;
      name?: string;
    };
    const clerkOrgId = orgData.id;
    const createdBy = orgData.created_by;

    if (!clerkOrgId || !createdBy) {
      return NextResponse.json(
        { error: "Missing org id or creator" },
        { status: 400 },
      );
    }

    const result = await provisionAccountForClerkOrg({
      clerkOrgId,
      clerkUserId: createdBy,
      email: "", // org creator's email resolved via lazy fallback in createContext
    });

    return NextResponse.json({ ok: true, created: result.created });
  }

  if (evt.type === "organizationMembership.created") {
    const memberData = evt.data as {
      organization?: { id?: string };
      public_user_data?: { user_id?: string; identifier?: string };
    };
    const clerkOrgId = memberData.organization?.id;
    const clerkUserId = memberData.public_user_data?.user_id;
    const email = memberData.public_user_data?.identifier ?? "";

    if (!clerkOrgId || !clerkUserId) {
      return NextResponse.json(
        { error: "Missing org or user id" },
        { status: 400 },
      );
    }

    await provisionAccountForClerkOrg({ clerkOrgId, clerkUserId, email });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: evt.type });
}
