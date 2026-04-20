/*
  Thin Linear GraphQL client. We don't pull a SDK — one fetch + typed
  responses is 30 lines and avoids the 400KB @linear/sdk bundle from
  creeping into a serverless lambda.

  Auth: Bearer <access_token> header. Tokens come from
  integration_credential decrypted at the call site (lib/crypto/envelope.ts).
  Never accept a token from the client.

  Errors: Linear wraps both HTTP failures AND GraphQL-level errors.
  `linearRequest` throws on either — the caller decides whether to set
  integration_state.status = 'token_invalid' on 401 / 'rate_limited' on 429.
*/

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

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

async function linearRequest<T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(LINEAR_GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      // Hard cap so a hung provider doesn't pin a serverless invocation.
      // 10s covers p99 Linear GraphQL latency with plenty of headroom.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new LinearApiError("Linear request timed out after 10s", 504);
    }
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LinearApiError(
      `Linear HTTP ${res.status}: ${body.slice(0, 200)}`,
      res.status,
    );
  }
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) {
    // Linear returns HTTP 200 with a GraphQL error envelope on revoked
    // tokens. Detect AUTHENTICATION_ERROR via extensions.type so callers
    // take the reconnect path instead of showing a generic failure.
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
  // Surface it as a LinearApiError so the caller's 401/401-like
  // handling path fires instead of a TypeError on null deref.
  if (!data.organization) {
    throw new LinearApiError("Linear workspace unavailable", 401);
  }
  return {
    workspace: data.organization,
    teams: data.teams.nodes,
  };
}

/*
  Create an issue. Markdown supported in `description`. Returns the
  issue's public URL + identifier so the UI can deep-link.
*/
export async function createIssue(
  accessToken: string,
  input: { teamId: string; title: string; description: string },
): Promise<{ id: string; identifier: string; url: string }> {
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }
  `;
  const data = await linearRequest<{
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string; url: string } | null;
    };
  }>(accessToken, mutation, { input });
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new LinearApiError("Linear issueCreate returned no issue", 200);
  }
  return data.issueCreate.issue;
}
