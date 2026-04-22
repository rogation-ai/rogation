import { type NextRequest, NextResponse } from "next/server";
import { withAuthedAccountTx } from "@/server/auth";
import {
  buildAuthorizeUrl,
  notionOauthConfigured,
} from "@/lib/integrations/notion/oauth";
import { signState } from "@/lib/integrations/state";
import { env } from "@/env";

/*
  Kick off the Notion OAuth flow. Mirror of the Linear start route.
  Signed state binds the callback to the authed accountId; every
  non-success path redirects to /settings/integrations with a typed
  reason so the UI surfaces a specific banner instead of dead-ending
  on a JSON response.
*/

function settingsUrl(req: NextRequest, params: string): string {
  const base = env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  return `${base}/settings/integrations?${params}`;
}

export async function GET(req: NextRequest) {
  if (!notionOauthConfigured()) {
    return NextResponse.redirect(
      settingsUrl(req, "notion=error&reason=not_configured"),
    );
  }

  const url = await withAuthedAccountTx(async (ctx) => {
    const state = signState(ctx.accountId);
    return buildAuthorizeUrl(state);
  });

  if (!url) {
    return NextResponse.redirect(
      settingsUrl(req, "notion=error&reason=unauthorized"),
    );
  }

  return NextResponse.redirect(url);
}
