import { and, desc, eq, sql } from "drizzle-orm";
import {
  integrationCredentials,
  integrationState,
  type LinearIntegrationConfig,
  opportunities as opportunitiesTbl,
  specs,
} from "@/db/schema";
import { decrypt } from "@/lib/crypto/envelope";
import {
  archiveIssue,
  createIssue,
  createProject,
  deleteProject,
  isUnknownEntityError,
  LinearApiError,
  updateIssue,
  updateProject,
} from "@/lib/integrations/linear/client";
import {
  renderLinearExport,
  type LinearExportPlan,
  type LinearExportPrior,
} from "@/lib/spec/renderers/linear";
import type { SpecIR } from "@/lib/spec/ir";
import type { Tx } from "@/db/scoped";

/*
  Spec → Linear project push (rewrite of the single-issue path).

  See:
  ~/.gstack/projects/rogation-ai-rogation/hamza-sanxore-linear-project-spec-export-design-20260514-160230.md

  Flow:

    1. Preconditions (spec → cred → team → token) — same gate as the
       prior single-issue path; only the persistence shape changed.
    2. In-flight guard via specs.linear_push_status. Flip 'idle' →
       'pushing' atomically. CONFLICT(push-in-flight) on collision.
    3. Load prior project + issue map from the same spec row (already
       in hand from precondition 1). Pass to renderer.
    4. renderLinearExport(ir, oppTitle, prior?) returns a plan. Pure.
    5. Execute the plan:
       - First push (no prior or auto-recovery from deleted project):
         createProject → Promise.all(createIssues).
       - Update-in-place: updateProject → Promise.all(updates) →
         Promise.all(creates) → sequential(archives).
       - If updateProject fails with UNKNOWN_ENTITY, fall through to
         the first-push path and return recreatedAfterDelete=true.
    6. Persist the issue map ONCE at end of loop (success or first
       non-auth failure). Write-once semantics — partial state moves
       the system forward, not sideways.
    7. Always reset linear_push_status to 'idle' in a finally block.

  Errors:

    - 'spec-not-found' (404)
    - 'empty-spec' (no title and no opportunity title fallback)
    - 'not-connected' (no Linear OAuth)
    - 'no-default-team' (PM didn't pick a team in /settings/integrations)
    - 'token-invalid' (401 — decrypt or live API)
    - 'push-in-flight' (in-flight guard tripped)
    - 'linear-project-exists' (resolver-only, when mode is omitted on
      a spec that already has a project — UI catches → D3 modal)
    - 'linear-project-exists-but-empty' (same case + empty issueMap —
      UI shows the third modal state)
    - 'spec-too-many-stories' (>50 stories — DB row hygiene cap)
    - 'linear-api-error' (everything else from Linear)

  RLS: this helper runs inside the authed tRPC middleware's
  transaction, so every read/write is already bound to ctx.accountId
  via app.current_account_id().
*/

const MAX_STORIES = 50;

export interface PushSpecCtx {
  db: Tx;
  accountId: string;
}

export type PushSpecError =
  | "spec-not-found"
  | "empty-spec"
  | "not-connected"
  | "no-default-team"
  | "token-invalid"
  | "push-in-flight"
  | "linear-project-exists"
  | "linear-project-exists-but-empty"
  | "spec-too-many-stories"
  | "linear-api-error";

export interface PushSpecResult {
  ok: true;
  specId: string;
  projectId: string;
  projectUrl: string;
  issueCount: number;
  /**
   * True when the orchestrator detected a deleted prior project and
   * auto-recovered via the create-new path. UI surfaces a dismissible
   * note: "Your previous Linear project was deleted; we created a
   * new one."
   */
  recreatedAfterDelete: boolean;
}

export interface PushSpecFailure {
  ok: false;
  error: PushSpecError;
  message: string;
  /**
   * Present on 'linear-project-exists' / 'linear-project-exists-but-empty'
   * conflicts so the UI's D3 modal can render the project context.
   */
  conflict?: {
    projectId: string;
    projectUrl: string;
    issueCount: number;
  };
}

export type PushMode = "create-new" | "update-in-place";

function isLinearConfig(v: unknown): v is LinearIntegrationConfig {
  return typeof v === "object" && v !== null;
}

/*
  Run preconditions and return the spec row + decrypted token + teamId.
  Throws by returning a PushSpecFailure-shaped value on any failure;
  the orchestrator narrows from there.
*/
async function checkPreconditions(
  ctx: PushSpecCtx,
  opportunityId: string,
): Promise<
  | { ok: true; spec: SpecRow; token: string; teamId: string }
  | PushSpecFailure
> {
  // 1. Latest spec + opportunity title (sensible fallback title).
  const [spec] = await ctx.db
    .select({
      id: specs.id,
      contentIr: specs.contentIr,
      contentMd: specs.contentMd,
      oppTitle: opportunitiesTbl.title,
      linearProjectId: specs.linearProjectId,
      linearProjectUrl: specs.linearProjectUrl,
      linearIssueMap: specs.linearIssueMap,
      linearPushStatus: specs.linearPushStatus,
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
  if (typeof teamId !== "string" || teamId.length === 0) {
    return {
      ok: false,
      error: "no-default-team",
      message: "Pick a default Linear team in /settings/integrations first.",
    };
  }

  // 4. Decrypt token. Failure means the encryption key rotated since
  // the token was stored — Node surfaces as the cryptic "Unsupported
  // state or unable to authenticate data". Mark token_invalid so the
  // UI shows "Reconnect" instead of the raw crypto error.
  let token: string;
  try {
    token = decrypt(cred);
  } catch (err) {
    await ctx.db
      .update(integrationState)
      .set({
        status: "token_invalid",
        lastError:
          err instanceof Error
            ? `decrypt failed: ${err.message}`
            : "decrypt failed",
      })
      .where(
        and(
          eq(integrationState.accountId, ctx.accountId),
          eq(integrationState.provider, "linear"),
        ),
      );
    return {
      ok: false,
      error: "token-invalid",
      message:
        "Stored Linear token can't be read (encryption key changed). Disconnect and reconnect Linear.",
    };
  }

  return { ok: true, spec, token, teamId };
}

interface SpecRow {
  id: string;
  contentIr: unknown;
  contentMd: string | null;
  oppTitle: string;
  linearProjectId: string | null;
  linearProjectUrl: string | null;
  linearIssueMap: Record<
    string,
    { id: string; identifier: string; url: string }
  > | null;
  linearPushStatus: string;
}

/*
  Mark the live token invalid + return the standardized failure. Used
  by every 401 path so the persisted state is consistent regardless of
  which call surfaced the auth failure.
*/
async function markTokenInvalid(
  ctx: PushSpecCtx,
  err: LinearApiError,
): Promise<PushSpecFailure> {
  await ctx.db
    .update(integrationState)
    .set({ status: "token_invalid", lastError: err.message })
    .where(
      and(
        eq(integrationState.accountId, ctx.accountId),
        eq(integrationState.provider, "linear"),
      ),
    );
  return {
    ok: false,
    error: "token-invalid",
    message: `Linear rejected the request: ${err.message}. Disconnect and reconnect Linear in Settings.`,
  };
}

/*
  Acquire the in-flight guard on the spec row. Returns false when the
  row is already marked 'pushing'. Atomicity comes from the WHERE
  clause: only the transition idle → pushing succeeds.
*/
async function acquireInFlightLock(
  ctx: PushSpecCtx,
  specId: string,
): Promise<boolean> {
  const result = await ctx.db
    .update(specs)
    .set({ linearPushStatus: "pushing" })
    .where(
      and(
        eq(specs.id, specId),
        eq(specs.accountId, ctx.accountId),
        eq(specs.linearPushStatus, "idle"),
      ),
    )
    .returning({ id: specs.id });
  return result.length > 0;
}

async function releaseInFlightLock(
  ctx: PushSpecCtx,
  specId: string,
): Promise<void> {
  await ctx.db
    .update(specs)
    .set({ linearPushStatus: "idle" })
    .where(and(eq(specs.id, specId), eq(specs.accountId, ctx.accountId)));
}

/*
  Execute a plan that has zero prior context (first push, or
  auto-recovery after a deleted project). Returns the new project id +
  the issue map built from the create results.

  Partial-failure handling:
    - createProject fails: surface up; nothing to clean.
    - First createIssue fails for non-auth reason: best-effort delete
      the empty project, surface linear-api-error.
    - createIssue fails for 401 mid-loop: persist the partial map of
      successfully-created issues onto the spec row, mark
      integration_state.status='token_invalid', return token-invalid.
*/
async function executeFirstPush(
  ctx: PushSpecCtx,
  spec: SpecRow,
  token: string,
  teamId: string,
  plan: LinearExportPlan,
): Promise<PushSpecResult | PushSpecFailure> {
  // 1. Create the project.
  let project: { id: string; url: string };
  try {
    const created = await createProject(token, {
      teamIds: [teamId],
      name: plan.project.name,
      description: plan.project.description,
    });
    project = { id: created.id, url: created.url };
  } catch (err) {
    if (err instanceof LinearApiError && err.status === 401) {
      return markTokenInvalid(ctx, err);
    }
    return {
      ok: false,
      error: "linear-api-error",
      message:
        err instanceof Error ? err.message : "Linear projectCreate failed.",
    };
  }

  // 2. Issue creates in parallel. Collect results + any auth failure.
  // We don't use Promise.all directly — we need per-call failure
  // routing (cleanup on first non-auth fail, partial-state persist on
  // auth fail).
  const creates = plan.actions.filter(
    (a): a is Extract<LinearExportPlan["actions"][number], { kind: "create-issue" }> =>
      a.kind === "create-issue",
  );

  const results = await Promise.allSettled(
    creates.map((a) =>
      createIssue(token, {
        teamId,
        projectId: project.id,
        title: a.payload.title,
        description: a.payload.description,
      }).then((issue) => ({ usId: a.payload.usId, issue })),
    ),
  );

  const issueMap: Record<
    string,
    { id: string; identifier: string; url: string }
  > = {};
  let authFailure: LinearApiError | null = null;
  let firstNonAuthFailure: Error | null = null;

  for (const r of results) {
    if (r.status === "fulfilled") {
      issueMap[r.value.usId] = {
        id: r.value.issue.id,
        identifier: r.value.issue.identifier,
        url: r.value.issue.url,
      };
    } else {
      const err = r.reason;
      if (err instanceof LinearApiError && err.status === 401) {
        authFailure = err;
      } else if (!firstNonAuthFailure) {
        firstNonAuthFailure = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  // 3. All-failure cleanup: createProject succeeded but every issue
  // create failed for non-auth reasons. Delete the empty project to
  // avoid orphan clutter in the PM's workspace.
  if (Object.keys(issueMap).length === 0 && !authFailure && firstNonAuthFailure) {
    try {
      await deleteProject(token, project.id);
    } catch {
      // Best effort. The project URL is in the surfaced message so the
      // PM can clean up manually if delete also failed.
    }
    return {
      ok: false,
      error: "linear-api-error",
      message: `Linear issueCreate failed. Empty project ${project.url} was cleaned up. (${firstNonAuthFailure.message})`,
    };
  }

  // 4. Persist whatever succeeded. Write-once semantics.
  await ctx.db
    .update(specs)
    .set({
      linearProjectId: project.id,
      linearProjectUrl: project.url,
      linearIssueMap: issueMap,
      linearPushedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(specs.id, spec.id), eq(specs.accountId, ctx.accountId)));

  // 5. Auth failure during the loop: persist partial + surface
  // token-invalid. Non-auth failure on a subset: persist partial +
  // surface linear-api-error.
  if (authFailure) {
    return markTokenInvalid(ctx, authFailure);
  }
  if (firstNonAuthFailure) {
    return {
      ok: false,
      error: "linear-api-error",
      message: `Some issues failed to create: ${firstNonAuthFailure.message}. Retry the push to fix.`,
    };
  }

  return {
    ok: true,
    specId: spec.id,
    projectId: project.id,
    projectUrl: project.url,
    issueCount: Object.keys(issueMap).length,
    recreatedAfterDelete: false,
  };
}

/*
  Execute a plan in update-in-place mode. updateProject → parallel
  updates + creates → sequential archives.

  Auto-recovery: if updateProject returns UNKNOWN_ENTITY (the prior
  project was manually deleted in Linear), fall through to first-push
  semantics and return recreatedAfterDelete=true.
*/
async function executeUpdatePush(
  ctx: PushSpecCtx,
  spec: SpecRow,
  token: string,
  teamId: string,
  plan: LinearExportPlan,
  priorProjectId: string,
): Promise<PushSpecResult | PushSpecFailure> {
  // 1. Update the project (name + description).
  try {
    await updateProject(token, priorProjectId, {
      name: plan.project.name,
      description: plan.project.description,
    });
  } catch (err) {
    if (err instanceof LinearApiError && err.status === 401) {
      return markTokenInvalid(ctx, err);
    }
    if (isUnknownEntityError(err)) {
      // Auto-recover: prior project was deleted in Linear. Fall
      // through to first-push semantics with an empty issueMap on
      // the spec row, then flag recreatedAfterDelete on success.
      const result = await executeFirstPush(ctx, spec, token, teamId, plan);
      if (result.ok) {
        return { ...result, recreatedAfterDelete: true };
      }
      return result;
    }
    return {
      ok: false,
      error: "linear-api-error",
      message:
        err instanceof Error ? err.message : "Linear projectUpdate failed.",
    };
  }

  const startingMap = spec.linearIssueMap ?? {};
  const runningMap: Record<
    string,
    { id: string; identifier: string; url: string }
  > = { ...startingMap };

  // 2. Parallel: creates + updates.
  const creates = plan.actions.filter(
    (a): a is Extract<LinearExportPlan["actions"][number], { kind: "create-issue" }> =>
      a.kind === "create-issue",
  );
  const updates = plan.actions.filter(
    (a): a is Extract<LinearExportPlan["actions"][number], { kind: "update-issue" }> =>
      a.kind === "update-issue",
  );
  const archives = plan.actions.filter(
    (a): a is Extract<LinearExportPlan["actions"][number], { kind: "archive-issue" }> =>
      a.kind === "archive-issue",
  );

  const createResults = await Promise.allSettled(
    creates.map((a) =>
      createIssue(token, {
        teamId,
        projectId: priorProjectId,
        title: a.payload.title,
        description: a.payload.description,
      }).then((issue) => ({ usId: a.payload.usId, issue })),
    ),
  );

  const updateResults = await Promise.allSettled(
    updates.map((a) =>
      updateIssue(token, a.issueId, {
        title: a.payload.title,
        description: a.payload.description,
      }).then((issue) => ({ usId: a.payload.usId, issue })),
    ),
  );

  let authFailure: LinearApiError | null = null;
  let firstNonAuthFailure: Error | null = null;

  for (const r of createResults) {
    if (r.status === "fulfilled") {
      runningMap[r.value.usId] = {
        id: r.value.issue.id,
        identifier: r.value.issue.identifier,
        url: r.value.issue.url,
      };
    } else {
      const err = r.reason;
      if (err instanceof LinearApiError && err.status === 401) {
        authFailure = err;
      } else if (!firstNonAuthFailure) {
        firstNonAuthFailure = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  for (const r of updateResults) {
    if (r.status === "fulfilled") {
      // Update doesn't change id/identifier/url, but refresh anyway
      // so the type matches and we don't carry stale entries.
      runningMap[r.value.usId] = {
        id: r.value.issue.id,
        identifier: r.value.issue.identifier,
        url: r.value.issue.url,
      };
    } else {
      const err = r.reason;
      if (err instanceof LinearApiError && err.status === 401) {
        authFailure = err;
      } else if (!firstNonAuthFailure) {
        firstNonAuthFailure = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  // 3. Sequential archives (run AFTER all creates+updates resolved).
  // Soft-success on UNKNOWN_ENTITY — the issue was manually deleted
  // in Linear, drop from map and continue.
  if (!authFailure) {
    for (const a of archives) {
      try {
        await archiveIssue(token, a.issueId);
        delete runningMap[a.usId];
      } catch (err) {
        if (err instanceof LinearApiError && err.status === 401) {
          authFailure = err;
          break;
        }
        if (isUnknownEntityError(err)) {
          // Already gone in Linear. Drop from map, keep going.
          delete runningMap[a.usId];
          continue;
        }
        if (!firstNonAuthFailure) {
          firstNonAuthFailure = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
  }

  // 4. Persist running map ONCE.
  await ctx.db
    .update(specs)
    .set({
      linearIssueMap: runningMap,
      linearPushedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(specs.id, spec.id), eq(specs.accountId, ctx.accountId)));

  if (authFailure) return markTokenInvalid(ctx, authFailure);
  if (firstNonAuthFailure) {
    return {
      ok: false,
      error: "linear-api-error",
      message: `Some Linear actions failed: ${firstNonAuthFailure.message}. Retry the push to fix.`,
    };
  }

  // spec.linearProjectUrl is guaranteed non-null here: this function is
  // only entered when the caller passed prior, and detectPriorProjectConflict
  // only flags rows where linearProjectId is non-null (URL is written in
  // the same transaction as the id). The fallback to the project's GraphQL
  // URL via Linear's REST convention is defensive against schema drift if
  // someone ever sets the id without the url in a future migration.
  const projectUrl =
    spec.linearProjectUrl ??
    `https://linear.app/project/${priorProjectId}`;

  return {
    ok: true,
    specId: spec.id,
    projectId: priorProjectId,
    projectUrl,
    issueCount: Object.keys(runningMap).length,
    recreatedAfterDelete: false,
  };
}

/*
  KNOWN LIMITATION (TODO: async push via Inngest worker, follow-up commit):

  This orchestrator runs Linear API calls (1 + N issue creates, plus
  any updates / archives in update mode) inside the authedProcedure's
  Postgres transaction. The resolver's tx therefore holds a pool
  connection for the entire Linear round-trip — typically 3-5 seconds
  for a 6-story spec, up to ~80 seconds in the worst case
  (3 rate-limit retries on every call: 21s per call × 7 calls).

  Pre-customer state means concurrent PMs are 0-2; current connection
  pool tolerates this. Once multiple accounts ship in parallel, move
  the push to an Inngest worker (mirrors the cluster-evidence.ts
  pattern in lib/inngest/functions/). The resolver becomes async-
  dispatch + a polling status query. Filed in TODOS.md.
*/
export async function pushSpecToLinear(
  ctx: PushSpecCtx,
  opportunityId: string,
  mode: PushMode = "create-new",
): Promise<PushSpecResult | PushSpecFailure> {
  const pre = await checkPreconditions(ctx, opportunityId);
  if (!pre.ok) return pre;
  const { spec, token, teamId } = pre;

  const ir = spec.contentIr as SpecIR;
  const title = (ir.title && ir.title.trim()) || spec.oppTitle;
  if (!title.trim()) {
    return {
      ok: false,
      error: "empty-spec",
      message: "Spec has no title yet. Regenerate before pushing.",
    };
  }

  // Story-count sanity cap (DB row hygiene; not Linear cost).
  if (ir.userStories.length > MAX_STORIES) {
    return {
      ok: false,
      error: "spec-too-many-stories",
      message: `Spec has ${ir.userStories.length} user stories. Split it into smaller specs before pushing (max ${MAX_STORIES}).`,
    };
  }

  // In-flight guard.
  const acquired = await acquireInFlightLock(ctx, spec.id);
  if (!acquired) {
    return {
      ok: false,
      error: "push-in-flight",
      message:
        "Another push is already in flight for this spec. Wait a few seconds and retry.",
    };
  }

  try {
    const prior: LinearExportPrior | undefined =
      spec.linearProjectId !== null
        ? {
            projectId: spec.linearProjectId,
            issueMap: spec.linearIssueMap ?? {},
          }
        : undefined;

    const plan = renderLinearExport(
      ir,
      spec.oppTitle,
      mode === "update-in-place" ? prior : undefined,
    );

    if (mode === "update-in-place" && prior) {
      return await executeUpdatePush(
        ctx,
        spec,
        token,
        teamId,
        plan,
        prior.projectId,
      );
    }
    return await executeFirstPush(ctx, spec, token, teamId, plan);
  } finally {
    // Always release the in-flight lock. The serverless invocation
    // may still be killed before this runs — the partial index on
    // linear_push_status lets ops reap stuck 'pushing' rows.
    await releaseInFlightLock(ctx, spec.id);
  }
}

/*
  Resolver-side helper: detect the D3 conflict variant without
  duplicating the precondition reads. Returns null if there's no
  prior project (resolver proceeds to first push) or a conflict
  envelope the resolver throws as TRPCError(CONFLICT).
*/
export async function detectPriorProjectConflict(
  ctx: PushSpecCtx,
  opportunityId: string,
): Promise<
  | {
      kind: "linear-project-exists" | "linear-project-exists-but-empty";
      projectId: string;
      projectUrl: string;
      issueCount: number;
    }
  | null
> {
  const [row] = await ctx.db
    .select({
      linearProjectId: specs.linearProjectId,
      linearProjectUrl: specs.linearProjectUrl,
      linearIssueMap: specs.linearIssueMap,
    })
    .from(specs)
    .where(
      and(
        eq(specs.opportunityId, opportunityId),
        eq(specs.accountId, ctx.accountId),
      ),
    )
    .orderBy(desc(specs.version))
    .limit(1);

  if (!row || !row.linearProjectId) return null;

  const issueCount = Object.keys(row.linearIssueMap ?? {}).length;
  return {
    kind:
      issueCount === 0
        ? "linear-project-exists-but-empty"
        : "linear-project-exists",
    projectId: row.linearProjectId,
    projectUrl: row.linearProjectUrl ?? "",
    issueCount,
  };
}

/*
  Resolver-side helper: latest spec version (across versions) for the
  given opportunity that DID push to Linear. Drives the
  refinement-gap banner on /spec/[opportunityId].
*/
export async function priorLinearProject(
  ctx: PushSpecCtx,
  opportunityId: string,
): Promise<{ projectId: string; projectUrl: string } | null> {
  const [row] = await ctx.db
    .select({
      linearProjectId: specs.linearProjectId,
      linearProjectUrl: specs.linearProjectUrl,
    })
    .from(specs)
    .where(
      and(
        eq(specs.opportunityId, opportunityId),
        eq(specs.accountId, ctx.accountId),
        sql`${specs.linearProjectId} IS NOT NULL`,
      ),
    )
    .orderBy(desc(specs.version))
    .limit(1);

  if (!row || !row.linearProjectId) return null;
  return {
    projectId: row.linearProjectId,
    projectUrl: row.linearProjectUrl ?? "",
  };
}
