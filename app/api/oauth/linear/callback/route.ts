import { type NextRequest, NextResponse } from "next/server";
import { integrationCredentials, integrationState } from "@/db/schema";
import { env } from "@/env";
import { encrypt } from "@/lib/crypto/envelope";
import { fetchViewer } from "@/lib/integrations/linear/client";
import {
  exchangeCodeForToken,
  linearOauthConfigured,
} from "@/lib/integrations/linear/oauth";
import { verifyState } from "@/lib/integrations/state";
import type { LinearIntegrationConfig } from "@/db/schema";
import { withAuthedAccountTx } from "@/server/auth";

/*
  Linear OAuth callback. Flow:

    1. User clicked "Connect Linear" → /api/oauth/linear/start → Linear
       consent screen → back here with `?code=...&state=...`.
    2. Authed session still resolves (we never left our own domain
       cookies). withAuthedAccountTx gives us the accountId.
    3. Verify state: HMAC valid, not expired, state.accountId matches
       the authed accountId. Any mismatch = reject (CSRF / stale tab).
    4. Exchange code for access token at Linear.
    5. AES-256-GCM encrypt the token, UPSERT into
       integration_credential scoped by RLS.
    6. UPSERT integration_state (status: active, lastSyncedAt now).
    7. Redirect to /settings/integrations with a success flag.

  Error-path UX: redirect back to /settings/integrations with an
  error flag so the UI can surface a toast without exposing the
  underlying cause (which may include provider-side messages).
*/

const SETTINGS_OK = "/settings/integrations?linear=connected";
const SETTINGS_ERR = "/settings/integrations?linear=error";

function redirect(path: string): NextResponse {
  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}${path}`);
}

export async function GET(req: NextRequest) {
  if (!linearOauthConfigured()) {
    return NextResponse.json(
      { error: "Linear OAuth not configured" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  // User clicked "Deny" on Linear — bounce back cleanly.
  if (oauthError) return redirect(SETTINGS_ERR);
  if (!code || !state) return redirect(SETTINGS_ERR);

  const result = await withAuthedAccountTx(async (ctx) => {
    const verified = verifyState(state);
    if (!verified.ok) return { ok: false as const, reason: verified.reason };
    if (verified.accountId !== ctx.accountId) {
      return { ok: false as const, reason: "account_mismatch" };
    }

    // Wrap the outbound Linear calls so a provider-side error (network
    // drop, 400 on a stale code, Linear outage) lands the user on the
    // settings error banner instead of a raw Next.js 500. Review Pass 9
    // INFO #1.
    let token;
    let viewer;
    try {
      token = await exchangeCodeForToken(code);
      // One round-trip to learn which workspace the PM just connected —
      // cached in integration_state.config so the settings UI doesn't
      // re-query Linear for display text on every page load.
      viewer = await fetchViewer(token.access_token);
    } catch (err) {
      console.warn("Linear OAuth callback: provider call failed:", err);
      return { ok: false as const, reason: "exchange_failed" };
    }
    const config: LinearIntegrationConfig = {
      workspaceId: viewer.workspace.id,
      workspaceName: viewer.workspace.name,
    };

    const blob = encrypt(token.access_token);

    await ctx.db
      .insert(integrationCredentials)
      .values({
        accountId: ctx.accountId,
        provider: "linear",
        ciphertext: blob.ciphertext,
        nonce: blob.nonce,
        kekVersion: 1,
      })
      .onConflictDoUpdate({
        target: [integrationCredentials.accountId, integrationCredentials.provider],
        set: {
          ciphertext: blob.ciphertext,
          nonce: blob.nonce,
          kekVersion: 1,
          updatedAt: new Date(),
        },
      });

    await ctx.db
      .insert(integrationState)
      .values({
        accountId: ctx.accountId,
        provider: "linear",
        status: "active",
        lastSyncedAt: new Date(),
        lastError: null,
        config,
      })
      .onConflictDoUpdate({
        target: [integrationState.accountId, integrationState.provider],
        set: {
          status: "active",
          lastError: null,
          config,
          updatedAt: new Date(),
        },
      });

    return { ok: true as const };
  });

  if (!result) {
    // Not authenticated — send to sign-in, then Clerk will bounce
    // back to this callback URL (but state will be expired by then
    // unless the Linear consent was seconds ago).
    return redirect(SETTINGS_ERR);
  }

  if (!result.ok) {
    console.warn("Linear OAuth callback rejected:", result.reason);
    return redirect(SETTINGS_ERR);
  }

  return redirect(SETTINGS_OK);
}
