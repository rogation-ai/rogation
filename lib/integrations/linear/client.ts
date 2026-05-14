/*
  Thin Linear GraphQL client. We don't pull a SDK — every mutation we
  need is one fetch + typed response, which beats the 400KB @linear/sdk
  bundle creeping into a serverless lambda.

  Auth: Bearer <access_token> header. Tokens come from
  integration_credential decrypted at the call site (lib/crypto/envelope.ts).
  Never accept a token from the client.

  Errors: Linear wraps both HTTP failures AND GraphQL-level errors.
  `linearRequest` throws on either. The caller decides whether to set
  integration_state.status = 'token_invalid' on 401 / 'rate_limited' on 429.

  Rate-limit handling: 429 (HTTP) and the GraphQL `RATELIMITED`
  extension trigger an exponential backoff retry within the request
  itself. After 3 retries the error bubbles up as LinearApiError(429).

  Mutation success: every Linear mutation we use returns a
  `{success, [entity]}` envelope. linearRequest does not auto-check
  this — each wrapper below verifies its own envelope and throws
  LinearApiError on success=false. Skipping this check was a known
  pitfall flagged in the autoplan eng review (item E1).
*/

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

// Hard cap so a hung provider doesn't pin a serverless invocation.
// 10s covers p99 Linear GraphQL latency with plenty of headroom.
const REQUEST_TIMEOUT_MS = 10_000;

// Exponential backoff schedule for rate-limit retries. Three retries
// after the initial attempt = four total attempts. Last-attempt
// failure bubbles up as LinearApiError(429).
const RATE_LIMIT_BACKOFFS_MS = [1000, 4000, 16000] as const;

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export class LinearApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/*
  Sleep helper for retry backoff. Inlined so the client has zero deps
  beyond fetch + AbortSignal.
*/
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(body: string, status: number): string {
  try {
    const json = JSON.parse(body) as {
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      const msgs = json.errors
        .map((e) => e.message)
        .filter(Boolean)
        .join("; ");
      if (msgs) return msgs;
    }
  } catch {
    // Not JSON — fall through to raw truncation.
  }
  return body.slice(0, 200) || `HTTP ${status}`;
}

/*
  Detect a rate-limit signal from a Linear response. Linear can signal
  in two ways:
    1. HTTP 429 (rare in practice, but possible at the edge).
    2. HTTP 200 with a GraphQL error envelope where some error has
       extensions.type === "RATELIMITED" (or substring "rate limit" /
       "ratelimit" as a defensive fallback if Linear renames the code).
*/
function isRateLimited(
  res: Response | null,
  json: GqlResponse<unknown> | null,
): boolean {
  if (res && res.status === 429) return true;
  if (json?.errors?.length) {
    return json.errors.some((e) => {
      const type = e.extensions?.type;
      if (typeof type === "string" && type === "RATELIMITED") return true;
      const msg = e.message?.toLowerCase() ?? "";
      return msg.includes("rate limit") || msg.includes("ratelimit");
    });
  }
  return false;
}

async function linearRequest<T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFFS_MS.length; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(LINEAR_GRAPHQL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new LinearApiError(
          `Linear request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
          504,
        );
      }
      throw err;
    }

    if (!res.ok) {
      // 429 → retry with backoff.
      if (
        isRateLimited(res, null) &&
        attempt < RATE_LIMIT_BACKOFFS_MS.length
      ) {
        await sleep(RATE_LIMIT_BACKOFFS_MS[attempt]!);
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new LinearApiError(
        `Linear HTTP ${res.status}: ${extractErrorMessage(body, res.status)}`,
        res.status,
      );
    }

    const json = (await res.json()) as GqlResponse<T>;
    if (json.errors?.length) {
      // RATELIMITED inside the GraphQL envelope → retry with backoff.
      if (
        isRateLimited(null, json) &&
        attempt < RATE_LIMIT_BACKOFFS_MS.length
      ) {
        await sleep(RATE_LIMIT_BACKOFFS_MS[attempt]!);
        continue;
      }
      // Linear returns HTTP 200 with a GraphQL error envelope on
      // revoked tokens. Detect AUTHENTICATION_ERROR via extensions.type
      // so callers take the reconnect path instead of showing a
      // generic failure.
      const isAuth = json.errors.some(
        (e) => e.extensions?.type === "AUTHENTICATION_ERROR",
      );
      throw new LinearApiError(
        `Linear GraphQL: ${json.errors.map((e) => e.message).join("; ")}`,
        isAuth ? 401 : 200,
      );
    }
    if (!json.data) throw new LinearApiError("Linear empty response", 200);
    return json.data;
  }

  // Exhausted retries. The exit condition only triggers if every
  // attempt was rate-limited.
  throw new LinearApiError("Linear rate-limit retries exhausted", 429);
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearViewer {
  workspace: { id: string; name: string };
  teams: LinearTeam[];
}

/*
  Single round-trip on first connect: workspace id/name (for display)
  plus every team the granted token can see, so the UI can render the
  picker without a second call.
*/
export async function fetchViewer(accessToken: string): Promise<LinearViewer> {
  const query = `
    query {
      organization { id name }
      teams(first: 100) { nodes { id name key } }
    }
  `;
  const data = await linearRequest<{
    organization: { id: string; name: string } | null;
    teams: { nodes: LinearTeam[] };
  }>(accessToken, query);
  // A revoked-at-org-level token can return `organization: null` with
  // a 200 status (we already checked GraphQL-level errors upstream).
  // Surface it as a LinearApiError so the caller's 401-like handling
  // path fires instead of a TypeError on null deref.
  if (!data.organization) {
    throw new LinearApiError("Linear workspace unavailable", 401);
  }
  return {
    workspace: data.organization,
    teams: data.teams.nodes,
  };
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
}

export interface LinearProject {
  id: string;
  name: string;
  url: string;
}

/*
  Create a Linear project. Projects belong to one or more teams
  (teamIds is a required plural array in ProjectCreateInput). We pass
  a single team — the workspace's defaultTeamId picked at connect time.

  statusId is optional. Linear projects can be created without one and
  default to the workspace's default starting status. The Assignment
  step 0 introspection verifies this against the live API before client
  code ships; if statusId becomes required, the orchestrator will need
  a re-resolve-and-retry path.
*/
export async function createProject(
  accessToken: string,
  input: {
    teamIds: string[];
    name: string;
    description: string;
    statusId?: string;
  },
): Promise<LinearProject> {
  const mutation = `
    mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        success
        project { id name url }
      }
    }
  `;
  const data = await linearRequest<{
    projectCreate: { success: boolean; project: LinearProject | null };
  }>(accessToken, mutation, { input });
  if (!data.projectCreate.success || !data.projectCreate.project) {
    throw new LinearApiError("Linear projectCreate returned success=false", 200);
  }
  return data.projectCreate.project;
}

/*
  Update an existing Linear project's name and/or description. Used in
  the D3 update-in-place flow when a PM re-pushes a spec into its
  existing Linear project.

  If Linear returns UNKNOWN_ENTITY (project was manually deleted in
  Linear since the last push), the orchestrator catches that and falls
  through to the create-new path, surfacing recreatedAfterDelete=true.
*/
export async function updateProject(
  accessToken: string,
  projectId: string,
  input: { name?: string; description?: string },
): Promise<LinearProject> {
  const mutation = `
    mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
      projectUpdate(id: $id, input: $input) {
        success
        project { id name url }
      }
    }
  `;
  const data = await linearRequest<{
    projectUpdate: { success: boolean; project: LinearProject | null };
  }>(accessToken, mutation, { id: projectId, input });
  if (!data.projectUpdate.success || !data.projectUpdate.project) {
    throw new LinearApiError("Linear projectUpdate returned success=false", 200);
  }
  return data.projectUpdate.project;
}

/*
  Delete a Linear project. Used in the partial-failure cleanup path:
  createProject succeeded, then the first createIssue failed for a
  non-auth reason. We delete the empty project rather than leave an
  orphan in the PM's workspace. Best-effort — caller logs but does
  not propagate failures here.
*/
export async function deleteProject(
  accessToken: string,
  projectId: string,
): Promise<{ success: boolean }> {
  const mutation = `
    mutation DeleteProject($id: String!) {
      projectDelete(id: $id) {
        success
      }
    }
  `;
  const data = await linearRequest<{
    projectDelete: { success: boolean };
  }>(accessToken, mutation, { id: projectId });
  if (!data.projectDelete.success) {
    throw new LinearApiError("Linear projectDelete returned success=false", 200);
  }
  return data.projectDelete;
}

/*
  Create an issue. Markdown supported in `description`. Returns the
  issue's public URL + identifier so the UI can deep-link. Optional
  projectId associates the issue with a Linear project — used by the
  project-export path; the legacy single-issue export path is gone.
*/
export async function createIssue(
  accessToken: string,
  input: {
    teamId: string;
    title: string;
    description: string;
    projectId?: string;
  },
): Promise<LinearIssue> {
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }
  `;
  const data = await linearRequest<{
    issueCreate: { success: boolean; issue: LinearIssue | null };
  }>(accessToken, mutation, { input });
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new LinearApiError("Linear issueCreate returned success=false", 200);
  }
  return data.issueCreate.issue;
}

/*
  Update an existing Linear issue's title and/or description. The
  identifier and URL are immutable for the lifetime of the issue, so
  this only refreshes content. AC checkbox state in the description is
  rebuilt from the spec on every update — engineers ticking boxes in
  Linear will lose those ticks on the next push. Documented in the
  issue description footnote.
*/
export async function updateIssue(
  accessToken: string,
  issueId: string,
  input: { title?: string; description?: string },
): Promise<LinearIssue> {
  const mutation = `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id identifier url }
      }
    }
  `;
  const data = await linearRequest<{
    issueUpdate: { success: boolean; issue: LinearIssue | null };
  }>(accessToken, mutation, { id: issueId, input });
  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new LinearApiError("Linear issueUpdate returned success=false", 200);
  }
  return data.issueUpdate.issue;
}

/*
  Archive an existing Linear issue. Used when a refined spec drops a
  user story — the issue Linear assigned to that US gets archived.
  Linear archives are soft-delete: assignees are NOT notified, but the
  issue stops appearing in default views. The D3 modal copy makes this
  consequence explicit.

  Returns success=true even when the underlying issue was already
  manually deleted in Linear (UNKNOWN_ENTITY GraphQL error). Callers
  treat that case as soft-success and drop the entry from the map.
*/
export async function archiveIssue(
  accessToken: string,
  issueId: string,
): Promise<{ success: boolean }> {
  const mutation = `
    mutation ArchiveIssue($id: String!) {
      issueArchive(id: $id) {
        success
      }
    }
  `;
  const data = await linearRequest<{
    issueArchive: { success: boolean };
  }>(accessToken, mutation, { id: issueId });
  if (!data.issueArchive.success) {
    throw new LinearApiError("Linear issueArchive returned success=false", 200);
  }
  return data.issueArchive;
}

/*
  Detect whether an error is Linear's "this entity doesn't exist"
  signal. Used by the orchestrator to:
    - updateProject failing → fall through to create-new (auto-recover).
    - archiveIssue failing  → soft-success, drop from map.

  Linear surfaces this as either UNKNOWN_ENTITY or ENTITY_NOT_FOUND on
  the GraphQL error envelope. We check both plus a substring fallback
  because Linear has historically renamed error codes without notice.
*/
export function isUnknownEntityError(err: unknown): boolean {
  if (!(err instanceof LinearApiError)) return false;
  // 401 is auth — explicitly NOT "unknown entity".
  if (err.status === 401) return false;
  const msg = err.message.toLowerCase();
  // Narrow match on Linear's documented entity-missing codes. The
  // earlier bare "not found" fallback was over-broad — "team not
  // found" or "workspace not found" would have triggered auto-recover
  // (create-new project) which is the wrong response to a workspace
  // misconfiguration.
  return (
    msg.includes("unknown_entity") ||
    msg.includes("unknown entity") ||
    msg.includes("entity_not_found") ||
    msg.includes("entity not found")
  );
}
