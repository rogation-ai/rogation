import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIssue,
  fetchViewer,
  LinearApiError,
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
});
