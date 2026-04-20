import { NextResponse } from "next/server";
import { withAuthedAccountTx } from "@/server/auth";
import { buildAuthorizeUrl, linearOauthConfigured } from "@/lib/integrations/linear/oauth";
import { signState } from "@/lib/integrations/state";

/*
  Kicks off the Linear OAuth flow. Requires an authed session — the
  accountId is baked into the signed state param so the callback can
  bind the resulting token to the right tenant without trusting any
  client-supplied value.

  Never import @/db/client here — the authed helper handles that.
*/

export async function GET() {
  if (!linearOauthConfigured()) {
    return NextResponse.json(
      { error: "Linear OAuth not configured" },
      { status: 503 },
    );
  }

  const url = await withAuthedAccountTx(async (ctx) => {
    const state = signState(ctx.accountId);
    return buildAuthorizeUrl(state);
  });

  if (!url) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.redirect(url);
}
