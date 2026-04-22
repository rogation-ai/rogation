import { type NextRequest, NextResponse } from "next/server";
import {
  integrationCredentials,
  integrationState,
  type NotionIntegrationConfig,
} from "@/db/schema";
import { env } from "@/env";
import { encrypt } from "@/lib/crypto/envelope";
import {
  createSpecDatabase,
  findWritablePage,
  NotionApiError,
} from "@/lib/integrations/notion/client";
import {
  exchangeCodeForToken,
  notionOauthConfigured,
} from "@/lib/integrations/notion/oauth";
import { verifyState } from "@/lib/integrations/state";
import { withAuthedAccountTx } from "@/server/auth";

/*
  Notion OAuth callback. Flow mirrors Linear:

    1. Verify signed state (CSRF + binds to accountId).
    2. Exchange code for access token at Notion.
    3. Auto-create "Rogation Specs" database under the first page the
       bot can write to (A2 — zero PM setup after consent).
    4. AES-256-GCM encrypt token, UPSERT integration_credential.
    5. UPSERT integration_state with workspace + database config.
    6. Redirect to /settings/integrations with a success flag.

  On the "no writable page" branch we still save the credential so the
  user can reconnect with page access instead of losing the token — we
  just flip status to "disabled" + setupReason so the UI shows a
  "Reconnect with page access" CTA.
*/

const SETTINGS_OK = "/settings/integrations?notion=connected";
const SETTINGS_NEEDS_PAGE = "/settings/integrations?notion=needs_page";
const SETTINGS_ERR = "/settings/integrations?notion=error";

function redirect(path: string): NextResponse {
  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}${path}`);
}

export async function GET(req: NextRequest) {
  if (!notionOauthConfigured()) {
    return redirect(`${SETTINGS_ERR}&reason=not_configured`);
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirect(SETTINGS_ERR);
  if (!code || !state) return redirect(SETTINGS_ERR);

  const result = await withAuthedAccountTx(async (ctx) => {
    const verified = verifyState(state);
    if (!verified.ok) return { ok: false as const, reason: verified.reason };
    if (verified.accountId !== ctx.accountId) {
      return { ok: false as const, reason: "account_mismatch" };
    }

    let token;
    try {
      token = await exchangeCodeForToken(code);
    } catch (err) {
      console.warn("Notion OAuth callback: token exchange failed:", err);
      return { ok: false as const, reason: "exchange_failed" };
    }

    // Try to find a writable page + auto-create the spec database.
    // Any failure here falls back to "connected but needs setup" —
    // credential still stored so reconnect-without-reauth is possible.
    let databaseId: string | null = null;
    let databaseName: string | null = null;
    let setupReason: NotionIntegrationConfig["setupReason"] = undefined;
    try {
      const parentPageId = await findWritablePage(token.access_token);
      if (!parentPageId) {
        setupReason = "no_writable_page";
      } else {
        const db = await createSpecDatabase(token.access_token, parentPageId);
        databaseId = db.id;
        databaseName =
          db.title.map((t) => t.plain_text).join("") || "Rogation Specs";
      }
    } catch (err) {
      console.warn(
        "Notion OAuth callback: database provision failed:",
        err instanceof NotionApiError
          ? `${err.status} ${err.code ?? ""}`
          : err,
      );
      setupReason = "provision_failed";
    }

    const config: NotionIntegrationConfig = {
      workspaceId: token.workspace_id,
      workspaceName: token.workspace_name ?? undefined,
      workspaceIcon: token.workspace_icon ?? null,
      botId: token.bot_id,
      ...(databaseId
        ? { defaultDatabaseId: databaseId, defaultDatabaseName: databaseName ?? undefined }
        : {}),
      ...(setupReason ? { setupReason } : {}),
    };

    const blob = encrypt(token.access_token);

    await ctx.db
      .insert(integrationCredentials)
      .values({
        accountId: ctx.accountId,
        provider: "notion",
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

    // Status is "active" when the DB is wired, "disabled" when setup
    // didn't complete — the UI reads this to pick the right CTA.
    const status = databaseId ? "active" : "disabled";
    const lastError = setupReason
      ? setupReason === "no_writable_page"
        ? "No writable page found. Reconnect and share a page with Rogation."
        : "Couldn't create the Rogation Specs database. Try again."
      : null;

    await ctx.db
      .insert(integrationState)
      .values({
        accountId: ctx.accountId,
        provider: "notion",
        status,
        lastSyncedAt: new Date(),
        lastError,
        config,
      })
      .onConflictDoUpdate({
        target: [integrationState.accountId, integrationState.provider],
        set: {
          status,
          lastError,
          config,
          updatedAt: new Date(),
        },
      });

    return { ok: true as const, needsSetup: !!setupReason };
  });

  if (!result) {
    // withAuthedAccountTx returned null — caller wasn't authed, rare at
    // this point but bounce to a recoverable place.
    return redirect(SETTINGS_ERR);
  }

  if (!result.ok) {
    console.warn("Notion OAuth callback rejected:", result.reason);
    return redirect(SETTINGS_ERR);
  }

  // Drop the user at a specific state so the settings banner matches.
  return redirect(result.needsSetup ? SETTINGS_NEEDS_PAGE : SETTINGS_OK);
}
