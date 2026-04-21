import { type NextRequest, NextResponse } from "next/server";
import { withAuthedAccountTx } from "@/server/auth";
import { buildAuthorizeUrl, linearOauthConfigured } from "@/lib/integrations/linear/oauth";
import { signState } from "@/lib/integrations/state";
import { env } from "@/env";

/*
  Kicks off the Linear OAuth flow. Requires an authed session — the
  accountId is baked into the signed state param so the callback can
  bind the resulting token to the right tenant without trusting any
  client-supplied value.

  Failure-path UX: every non-success path (unconfigured, unauthenticated)
  redirects back to /settings/integrations with a typed reason so the
  settings page renders a specific banner. Direct JSON responses here
  were a dead-end for any user who browser-navigated to this URL.

  Never import @/db/client here — the authed helper handles that.
*/

function settingsUrl(req: NextRequest, params: string): string {
  // Prefer NEXT_PUBLIC_APP_URL so the redirect still works when the
  // request came through a preview-deploy alias or custom domain.
  const base = env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  return `${base}/settings/integrations?${params}`;
}

export async function GET(req: NextRequest) {
  if (!linearOauthConfigured()) {
    return NextResponse.redirect(
      settingsUrl(req, "linear=error&reason=not_configured"),
    );
  }

  const url = await withAuthedAccountTx(async (ctx) => {
    const state = signState(ctx.accountId);
    return buildAuthorizeUrl(state);
  });

  if (!url) {
    // Unauthenticated users get bounced to sign-in via middleware before
    // hitting this path normally, but if they do land here, send them
    // somewhere recoverable instead of raw JSON.
    return NextResponse.redirect(
      settingsUrl(req, "linear=error&reason=unauthorized"),
    );
  }

  return NextResponse.redirect(url);
}
