import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveIssue,
  createIssue,
  createProject,
  deleteProject,
  fetchViewer,
  isUnknownEntityError,
  LinearApiError,
  updateIssue,
  updateProject,
} from "@/lib/integrations/linear/client";

/*
  Unit tests for the Linear GraphQL client. Mocks global fetch and
  verifies:

  - fetchViewer returns the expected {workspace, teams} shape
  - createIssue returns {id, identifier, url} on success
  - HTTP errors throw LinearApiError with the status preserved (so
    the router can detect 401 and mark the integration token_invalid)
  - GraphQL errors (HTTP 200 + errors[]) throw with the messages joined
  - createIssue throws when the mutation succeeds but returns no issue

  Live calls against api.linear.app aren't made — those need a real
  token + consent to pollute someone's Linear workspace.
*/

function mockFetch(
  responder: (input: RequestInfo, init?: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal("fetch", vi.fn(responder));
}

describe("linear client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchViewer parses workspace + teams", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: {
            organization: { id: "org-1", name: "Acme" },
            teams: {
              nodes: [
                { id: "t-1", name: "Core", key: "CORE" },
                { id: "t-2", name: "Growth", key: "GROW" },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const v = await fetchViewer("tok");
    expect(v.workspace).toEqual({ id: "org-1", name: "Acme" });
    expect(v.teams).toHaveLength(2);
    expect(v.teams[0].key).toBe("CORE");
  });

  it("http 401 throws LinearApiError with status", async () => {
    mockFetch(async () =>
      new Response("unauthorized", { status: 401 }),
    );
    await expect(fetchViewer("bad")).rejects.toMatchObject({
      name: "Error",
      status: 401,
    });
  });

  it("graphql errors throw LinearApiError", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "bad field" }, { message: "also bad" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(fetchViewer("tok")).rejects.toThrow(/bad field.*also bad/);
  });

  it("createIssue returns identifier + url", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "iss-1",
                identifier: "CORE-123",
                url: "https://linear.app/acme/issue/CORE-123",
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const issue = await createIssue("tok", {
      teamId: "t-1",
      title: "t",
      description: "d",
    });
    expect(issue.identifier).toBe("CORE-123");
    expect(issue.url).toContain("CORE-123");
  });

  it("createIssue throws if mutation returns no issue", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: { issueCreate: { success: false, issue: null } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      createIssue("tok", { teamId: "t-1", title: "t", description: "d" }),
    ).rejects.toThrow(LinearApiError);
  });

  /*
    Mutation success-envelope coverage. The /autoplan eng review
    flagged that the old client only checked success on issueCreate;
    extending to the 5 new mutations is a ship-blocker. Each test
    here pins one mutation's envelope-check behavior.
  */

  it("createProject throws when success:false", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: { projectCreate: { success: false, project: null } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      createProject("tok", { teamIds: ["t1"], name: "n", description: "d" }),
    ).rejects.toThrow(LinearApiError);
  });

  it("createProject happy path returns project", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: {
            projectCreate: {
              success: true,
              project: {
                id: "p1",
                name: "Project",
                url: "https://linear.app/acme/project/p1",
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const p = await createProject("tok", {
      teamIds: ["t1"],
      name: "n",
      description: "d",
    });
    expect(p.id).toBe("p1");
    expect(p.url).toContain("/project/p1");
  });

  it("updateProject throws when success:false", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: { projectUpdate: { success: false, project: null } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(updateProject("tok", "p1", { name: "n" })).rejects.toThrow(
      LinearApiError,
    );
  });

  it("deleteProject throws when success:false", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ data: { projectDelete: { success: false } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(deleteProject("tok", "p1")).rejects.toThrow(LinearApiError);
  });

  it("updateIssue throws when success:false", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: { issueUpdate: { success: false, issue: null } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(updateIssue("tok", "i1", { title: "n" })).rejects.toThrow(
      LinearApiError,
    );
  });

  it("archiveIssue throws when success:false", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ data: { issueArchive: { success: false } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(archiveIssue("tok", "i1")).rejects.toThrow(LinearApiError);
  });

  it("createIssue passes projectId through to the GraphQL input", async () => {
    let capturedBody: unknown = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "i1", identifier: "E-1", url: "u" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await createIssue("tok", {
      teamId: "t1",
      title: "T",
      description: "D",
      projectId: "proj-abc",
    });
    expect(
      (capturedBody as { variables: { input: { projectId: string } } }).variables.input
        .projectId,
    ).toBe("proj-abc");
  });

  /*
    isUnknownEntityError is what the orchestrator's auto-recovery
    paths key off (updateProject 404 → fall through to create-new;
    archiveIssue 404 → soft-success). Misclassifying a 401 here as
    "unknown entity" would skip the token-invalid flow and silently
    create duplicate projects.
  */

  it("isUnknownEntityError matches UNKNOWN_ENTITY in the message", () => {
    expect(
      isUnknownEntityError(new LinearApiError("UNKNOWN_ENTITY: gone", 200)),
    ).toBe(true);
  });

  it("isUnknownEntityError matches 'entity not found' phrasing", () => {
    expect(
      isUnknownEntityError(new LinearApiError("entity not found in ws", 200)),
    ).toBe(true);
  });

  it("isUnknownEntityError does NOT match 401 auth errors", () => {
    expect(isUnknownEntityError(new LinearApiError("not found", 401))).toBe(
      false,
    );
  });

  it("isUnknownEntityError does NOT match arbitrary 500 errors", () => {
    expect(isUnknownEntityError(new LinearApiError("server boom", 500))).toBe(
      false,
    );
  });

  it("isUnknownEntityError returns false for non-LinearApiError values", () => {
    expect(isUnknownEntityError(new Error("plain"))).toBe(false);
    expect(isUnknownEntityError(null)).toBe(false);
    expect(isUnknownEntityError("string")).toBe(false);
  });

  /*
    Rate-limit backoff. The /autoplan eng review (item P2) flagged
    that Linear's own GraphQL rate limit is per-request and could
    burst-reject mid-push. linearRequest now retries with backoff
    on either HTTP 429 or a RATELIMITED extension.
  */

  it("retries on RATELIMITED extension and eventually succeeds", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      if (calls < 3) {
        return new Response(
          JSON.stringify({
            errors: [
              { message: "rate limit hit", extensions: { type: "RATELIMITED" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            projectCreate: {
              success: true,
              project: { id: "p1", name: "n", url: "u" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.useFakeTimers();
    const promise = createProject("tok", {
      teamIds: ["t"],
      name: "n",
      description: "d",
    });
    // Backoff: 1s, 4s, 16s. Advance well past the third retry.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
    const result = await promise;
    vi.useRealTimers();

    expect(calls).toBe(3);
    expect(result.id).toBe("p1");
  });
});
