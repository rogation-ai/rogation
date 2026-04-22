import { and, desc, eq } from "drizzle-orm";
import {
  integrationCredentials,
  integrationState,
  type NotionIntegrationConfig,
  opportunities as opportunitiesTbl,
  specs,
} from "@/db/schema";
import { decrypt } from "@/lib/crypto/envelope";
import {
  createSpecPage,
  NotionApiError,
} from "@/lib/integrations/notion/client";
import { env } from "@/env";
import type { SpecIR } from "@/lib/spec/ir";
import type { Tx } from "@/db/scoped";

/*
  Spec → Notion page push.

  Preconditions (mirror of push-linear.ts — structured error codes
  drive which CTA the editor shows):

    1. Latest spec exists for the opportunity   → NOT_FOUND ("spec-not-found")
    2. Notion integration connected             → PRECONDITION_FAILED ("not-connected")
    3. Default database provisioned             → PRECONDITION_FAILED ("no-default-database")
    4. Non-empty spec title                     → PRECONDITION_FAILED ("empty-spec")
    5. Notion token valid                       → FORBIDDEN ("token-invalid")
    6. Other Notion API failure                 → INTERNAL_SERVER_ERROR ("notion-api-error")
*/

export interface PushSpecCtx {
  db: Tx;
  accountId: string;
}

export type PushSpecNotionError =
  | "spec-not-found"
  | "empty-spec"
  | "not-connected"
  | "no-default-database"
  | "token-invalid"
  | "notion-api-error";

export interface PushSpecNotionResult {
  ok: true;
  specId: string;
  url: string;
  pageId: string;
}

export interface PushSpecNotionFailure {
  ok: false;
  error: PushSpecNotionError;
  message: string;
}

function isNotionConfig(v: unknown): v is NotionIntegrationConfig {
  return typeof v === "object" && v !== null;
}

export async function pushSpecToNotion(
  ctx: PushSpecCtx,
  opportunityId: string,
): Promise<PushSpecNotionResult | PushSpecNotionFailure> {
  const [spec] = await ctx.db
    .select({
      id: specs.id,
      version: specs.version,
      contentIr: specs.contentIr,
      contentMd: specs.contentMd,
      readinessGrade: specs.readinessGrade,
      oppTitle: opportunitiesTbl.title,
    })
    .from(specs)
    .innerJoin(opportunitiesTbl, eq(specs.opportunityId, opportunitiesTbl.id))
    .where(
      and(
        eq(specs.opportunityId, opportunityId),
        eq(specs.accountId, ctx.accountId),
      ),
    )
    .orderBy(desc(specs.version))
    .limit(1);

  if (!spec) {
    return {
      ok: false,
      error: "spec-not-found",
      message: "No spec for this opportunity. Generate one first.",
    };
  }

  const [cred] = await ctx.db
    .select({
      ciphertext: integrationCredentials.ciphertext,
      nonce: integrationCredentials.nonce,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.accountId, ctx.accountId),
        eq(integrationCredentials.provider, "notion"),
      ),
    )
    .limit(1);

  if (!cred) {
    return {
      ok: false,
      error: "not-connected",
      message: "Notion is not connected for this account.",
    };
  }

  const [state] = await ctx.db
    .select({ config: integrationState.config })
    .from(integrationState)
    .where(
      and(
        eq(integrationState.accountId, ctx.accountId),
        eq(integrationState.provider, "notion"),
      ),
    )
    .limit(1);

  const config = isNotionConfig(state?.config) ? state.config : null;
  const databaseId = config?.defaultDatabaseId;
  if (!databaseId) {
    return {
      ok: false,
      error: "no-default-database",
      message:
        "Reconnect Notion with page access so we can provision the Rogation Specs database.",
    };
  }

  const ir = spec.contentIr as SpecIR;
  const title = (ir.title && ir.title.trim()) || spec.oppTitle;
  if (!title.trim()) {
    return {
      ok: false,
      error: "empty-spec",
      message: "Spec has no title yet. Regenerate before pushing.",
    };
  }

  const sourceUrl = env.NEXT_PUBLIC_APP_URL
    ? `${env.NEXT_PUBLIC_APP_URL}/spec/${opportunityId}`
    : null;

  let page;
  try {
    const token = decrypt(cred);
    page = await createSpecPage(token, {
      databaseId,
      title,
      opportunityTitle: spec.oppTitle,
      readiness: spec.readinessGrade ?? null,
      version: spec.version,
      sourceUrl,
      ir,
      markdownFallback: spec.contentMd ?? null,
    });
  } catch (err) {
    if (err instanceof NotionApiError && err.status === 401) {
      await ctx.db
        .update(integrationState)
        .set({ status: "token_invalid", lastError: err.message })
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, "notion"),
          ),
        );
      return {
        ok: false,
        error: "token-invalid",
        message: "Notion token was revoked. Reconnect to continue.",
      };
    }
    return {
      ok: false,
      error: "notion-api-error",
      message:
        err instanceof Error ? err.message : "Notion API call failed.",
    };
  }

  return {
    ok: true,
    specId: spec.id,
    url: page.url,
    pageId: page.id,
  };
}
