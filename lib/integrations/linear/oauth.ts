import { env } from "@/env";

/*
  Linear OAuth helpers.

  Docs: https://developers.linear.app/docs/oauth/authentication

  Scopes used:
  - read        : query viewer + teams + projects
  - write       : create issues + comments
  - issues:create: narrowed create capability (Linear requires this
                   alongside write for issue creation from third-party apps)

  Endpoints:
  - Authorize: https://linear.app/oauth/authorize
  - Token:     https://api.linear.app/oauth/token
*/

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const SCOPES = ["read", "write", "issues:create"];

export interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export function linearOauthConfigured(): boolean {
  return Boolean(env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET);
}

export function redirectUri(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/oauth/linear/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  if (!env.LINEAR_CLIENT_ID) {
    throw new Error("LINEAR_CLIENT_ID not configured");
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINEAR_CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: SCOPES.join(","),
    state,
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
): Promise<LinearTokenResponse> {
  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
    throw new Error("Linear OAuth not configured");
  }
  const body = new URLSearchParams({
    code,
    redirect_uri: redirectUri(),
    client_id: env.LINEAR_CLIENT_ID,
    client_secret: env.LINEAR_CLIENT_SECRET,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Linear token exchange failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  return (await res.json()) as LinearTokenResponse;
}
