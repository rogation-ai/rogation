import { env } from "@/env";

/*
  Notion OAuth helpers.

  Docs: https://developers.notion.com/docs/authorization

  Unlike Linear, Notion returns a long-lived access token (no refresh),
  along with the workspace id/name/icon, bot id, and owner payload. We
  store the access token encrypted (AES-256-GCM via envelope.ts) and
  cache workspace display text in integration_state.config.

  Endpoints:
  - Authorize: https://api.notion.com/v1/oauth/authorize
  - Token:     https://api.notion.com/v1/oauth/token  (Basic auth)

  The authorize URL does NOT take a `scope` param — Notion scopes are
  fixed per integration, and the user grants access to specific pages
  during consent. `owner=user` signals a user-auth'd token (as opposed
  to an internal integration).
*/

const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export interface NotionTokenResponse {
  access_token: string;
  token_type: string;
  bot_id: string;
  workspace_id: string;
  workspace_name: string | null;
  workspace_icon: string | null;
  owner: unknown;
  duplicated_template_id: string | null;
}

export function notionOauthConfigured(): boolean {
  return Boolean(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET);
}

export function redirectUri(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/oauth/notion/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  if (!env.NOTION_CLIENT_ID) {
    throw new Error("NOTION_CLIENT_ID not configured");
  }
  const params = new URLSearchParams({
    client_id: env.NOTION_CLIENT_ID,
    response_type: "code",
    owner: "user",
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
): Promise<NotionTokenResponse> {
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    throw new Error("Notion OAuth not configured");
  }
  // Notion requires HTTP Basic auth with client_id:client_secret for
  // the token exchange, with the code + redirect_uri in the JSON body.
  const basic = Buffer.from(
    `${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Notion token exchange failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as NotionTokenResponse;
}
