import { and, desc, eq } from "drizzle-orm";
import {
  integrationCredentials,
  integrationState,
  type LinearIntegrationConfig,
  opportunities as opportunitiesTbl,
  specs,
} from "@/db/schema";
import { decrypt } from "@/lib/crypto/envelope";
import { createIssue, LinearApiError } from "@/lib/integrations/linear/client";
import type { SpecIR } from "@/lib/spec/ir";
import type { Tx } from "@/db/scoped";

/*
  Spec → Linear issue push.

  Preconditions (checked in order, each maps to a specific caller
  response so the UI can show the right CTA):

    1. A spec exists for the opportunity          → NOT_FOUND
    2. Linear integration is connected            → PRECONDITION_FAILED ("not-connected")
    3. A default team has been picked             → PRECONDITION_FAILED ("no-default-team")
    4. Linear token is valid                      → FORBIDDEN         ("token-invalid")
                                                    (mirror of the
                                                    integrations router;
                                                    caller marks state)

  Happy path:
    - Decrypt token server-side (never crosses the tRPC wire).
    - createIssue → {id, identifier, url} back from Linear.
    - Update the latest-version spec row with linear_issue_* + pushed_at.

  Idempotency: the caller decides. We always create a new issue in
  Linear and overwrite the spec row's linear_issue_* fields. Pushing
  the same spec twice produces two Linear issues — PMs know this
  already from Linear's own "duplicate import" semantics.

  RLS: this helper runs inside the authed tRPC middleware's
  transaction, so every read/write is already bound to
  ctx.accountId via app.current_account_id().
*/

export interface PushSpecCtx {
  db: Tx;
  accountId: string;
}

export type PushSpecError =
  | "spec-not-found"
  | "not-connected"
  | "no-default-team"
  | "token-invalid"
  | "linear-api-error";

export interface PushSpecResult {
  ok: true;
  specId: string;
  url: string;
  identifier: string;
}

export interface PushSpecFailure {
  ok: false;
  error: PushSpecError;
  message: string;
}

function isLinearConfig(v: unknown): v is LinearIntegrationConfig {
  return typeof v === "object" && v !== null;
}

export async function pushSpecToLinear(
  ctx: PushSpecCtx,
  opportunityId: string,
): Promise<PushSpecResult | PushSpecFailure> {
  // 1. Latest spec + opportunity title (for sensible fallback title).
  const [spec] = await ctx.db
    .select({
      id: specs.id,
      contentIr: specs.contentIr,
      contentMd: specs.contentMd,
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

  // 2. Credential exists?
  const [cred] = await ctx.db
    .select({
      ciphertext: integrationCredentials.ciphertext,
      nonce: integrationCredentials.nonce,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, "linear"))
    .limit(1);

  if (!cred) {
    return {
      ok: false,
      error: "not-connected",
      message: "Linear is not connected for this account.",
    };
  }

  // 3. Default team picked?
  const [state] = await ctx.db
    .select({ config: integrationState.config })
    .from(integrationState)
    .where(eq(integrationState.provider, "linear"))
    .limit(1);

  const config = isLinearConfig(state?.config) ? state.config : null;
  const teamId = config?.defaultTeamId;
  if (!teamId) {
    return {
      ok: false,
      error: "no-default-team",
      message: "Pick a default Linear team in /settings/integrations first.",
    };
  }

  // 4. Build payload. IR title wins; opportunity title as fallback.
  const ir = spec.contentIr as SpecIR;
  const title = (ir.title && ir.title.trim()) || spec.oppTitle;
  const description = spec.contentMd ?? "";

  // 5. Call Linear. 401 → mark token_invalid + surface to caller.
  let issue;
  try {
    const token = decrypt(cred);
    issue = await createIssue(token, {
      teamId,
      title,
      description,
    });
  } catch (err) {
    if (err instanceof LinearApiError && err.status === 401) {
      await ctx.db
        .update(integrationState)
        .set({ status: "token_invalid", lastError: err.message })
        .where(eq(integrationState.provider, "linear"));
      return {
        ok: false,
        error: "token-invalid",
        message: "Linear token was revoked. Reconnect to continue.",
      };
    }
    return {
      ok: false,
      error: "linear-api-error",
      message:
        err instanceof Error ? err.message : "Linear API call failed.",
    };
  }

  // 6. Persist pushed-state on the spec row.
  await ctx.db
    .update(specs)
    .set({
      linearIssueId: issue.id,
      linearIssueIdentifier: issue.identifier,
      linearIssueUrl: issue.url,
      linearPushedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(specs.id, spec.id));

  return {
    ok: true,
    specId: spec.id,
    url: issue.url,
    identifier: issue.identifier,
  };
}
