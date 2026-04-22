import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Unit coverage for Notion OAuth helpers. We stub env so the module
  picks up fresh values between cases (configured vs unconfigured),
  and mock fetch for the token exchange path.

  Why these matter: if buildAuthorizeUrl forgets `owner=user` Notion
  redirects back with `internal` token scope, which our bot-level
  endpoints can't call. Guarding the exact shape here prevents a
  regression that would land silently and break every first connect.
*/

// The env module caches. Import afresh per test via dynamic import.
async function loadModule(env: Record<string, string | undefined>) {
  vi.resetModules();
  // Stub env via the shared env.ts — skip validation so we can set partial.
  process.env = {
    ...process.env,
    ...env,
    SKIP_ENV_VALIDATION: "true",
    NEXT_PUBLIC_APP_URL: "https://rogation.example",
  };
  return import("@/lib/integrations/notion/oauth");
}

describe("notion oauth", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("notionOauthConfigured is false without creds", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: undefined,
      NOTION_CLIENT_SECRET: undefined,
    });
    expect(m.notionOauthConfigured()).toBe(false);
  });

  it("notionOauthConfigured is true when both keys set", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: "id",
      NOTION_CLIENT_SECRET: "secret",
    });
    expect(m.notionOauthConfigured()).toBe(true);
  });

  it("redirectUri uses NEXT_PUBLIC_APP_URL", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: "id",
      NOTION_CLIENT_SECRET: "secret",
    });
    expect(m.redirectUri()).toBe(
      "https://rogation.example/api/oauth/notion/callback",
    );
  });

  it("buildAuthorizeUrl includes client_id, state, owner=user, response_type=code", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: "abc",
      NOTION_CLIENT_SECRET: "s",
    });
    const u = new URL(m.buildAuthorizeUrl("state-xyz"));
    expect(u.origin + u.pathname).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(u.searchParams.get("client_id")).toBe("abc");
    expect(u.searchParams.get("state")).toBe("state-xyz");
    expect(u.searchParams.get("owner")).toBe("user");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://rogation.example/api/oauth/notion/callback",
    );
  });

  it("buildAuthorizeUrl throws when client id missing", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: undefined,
      NOTION_CLIENT_SECRET: "s",
    });
    expect(() => m.buildAuthorizeUrl("s")).toThrow(/NOTION_CLIENT_ID/);
  });

  it("exchangeCodeForToken sends Basic auth + returns parsed token", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: "cid",
      NOTION_CLIENT_SECRET: "csec",
    });
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.notion.com/v1/oauth/token");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      const expectedBasic = `Basic ${Buffer.from("cid:csec").toString("base64")}`;
      expect(headers.Authorization).toBe(expectedBasic);
      const body = JSON.parse(init.body as string);
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("code-1");
      return new Response(
        JSON.stringify({
          access_token: "secret_123",
          token_type: "bearer",
          bot_id: "bot-1",
          workspace_id: "ws-1",
          workspace_name: "Acme",
          workspace_icon: null,
          owner: { type: "user" },
          duplicated_template_id: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = await m.exchangeCodeForToken("code-1");
    expect(token.access_token).toBe("secret_123");
    expect(token.workspace_id).toBe("ws-1");
  });

  it("exchangeCodeForToken throws when notion rejects", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: "cid",
      NOTION_CLIENT_SECRET: "csec",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("bad code", { status: 400, statusText: "Bad Request" }),
      ),
    );
    await expect(m.exchangeCodeForToken("x")).rejects.toThrow(
      /Notion token exchange failed/,
    );
  });

  it("exchangeCodeForToken throws when not configured", async () => {
    const m = await loadModule({
      NOTION_CLIENT_ID: undefined,
      NOTION_CLIENT_SECRET: undefined,
    });
    await expect(m.exchangeCodeForToken("x")).rejects.toThrow(
      /Notion OAuth not configured/,
    );
  });
});
