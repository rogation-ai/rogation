import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSpecDatabase,
  createSpecPage,
  fetchBotUser,
  findWritablePage,
  NotionApiError,
} from "@/lib/integrations/notion/client";
import type { SpecIR } from "@/lib/spec/ir";

/*
  Unit tests for the Notion REST client. Mock global fetch; assert the
  request shape (auth header, Notion-Version, JSON body) and response
  parsing. No live api.notion.com calls — they'd need a real workspace
  token and would leave litter pages in someone's account.
*/

function mockFetch(responder: (url: string, init: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) => responder(url as string, init as RequestInit)),
  );
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sampleIr(): SpecIR {
  return {
    title: "Fix onboarding",
    summary: "Reduce churn at step 2.",
    userStories: [
      { id: "US1", persona: "new user", goal: "skip the tour", value: "start fast" },
    ],
    acceptanceCriteria: [
      { storyId: "US1", given: "landing", when: "click skip", then: "no tour" },
    ],
    nonFunctional: [{ category: "performance", requirement: "<200ms" }],
    edgeCases: [{ scenario: "offline", expectedBehavior: "queue" }],
    qaChecklist: [{ check: "tour can be dismissed", status: "untested" }],
    citations: [{ clusterId: "c-1", note: "seen 8x" }],
  };
}

describe("notion client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchBotUser sends Bearer + Notion-Version, parses response", async () => {
    mockFetch(async (url, init) => {
      expect(url).toBe("https://api.notion.com/v1/users/me");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok");
      expect(headers["Notion-Version"]).toBeDefined();
      return jsonRes({ id: "bot-1", type: "bot" });
    });
    const bot = await fetchBotUser("tok");
    expect(bot.id).toBe("bot-1");
  });

  it("404 throws NotionApiError with status", async () => {
    mockFetch(async () =>
      jsonRes({ code: "object_not_found", message: "not found" }, 404),
    );
    await expect(fetchBotUser("tok")).rejects.toMatchObject({
      status: 404,
      code: "object_not_found",
    });
  });

  it("findWritablePage returns the first page id", async () => {
    mockFetch(async () =>
      jsonRes({
        results: [
          { object: "page", id: "p-1" },
          { object: "page", id: "p-2" },
        ],
      }),
    );
    const id = await findWritablePage("tok");
    expect(id).toBe("p-1");
  });

  it("findWritablePage returns null when no pages", async () => {
    mockFetch(async () => jsonRes({ results: [] }));
    const id = await findWritablePage("tok");
    expect(id).toBeNull();
  });

  it("findWritablePage skips databases, returns first page", async () => {
    mockFetch(async () =>
      jsonRes({
        results: [
          { object: "database", id: "db-1" },
          { object: "page", id: "p-2" },
        ],
      }),
    );
    const id = await findWritablePage("tok");
    expect(id).toBe("p-2");
  });

  it("createSpecDatabase posts the right schema + parent", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (url, init) => {
      expect(url).toBe("https://api.notion.com/v1/databases");
      expect(init.method).toBe("POST");
      captured = JSON.parse(init.body as string);
      return jsonRes({
        id: "db-1",
        title: [{ plain_text: "Rogation Specs" }],
      });
    });
    const db = await createSpecDatabase("tok", "page-root");
    expect(db.id).toBe("db-1");
    expect(captured).not.toBeNull();
    const body = captured as unknown as Record<string, unknown>;
    expect(body.parent).toEqual({ type: "page_id", page_id: "page-root" });
    const properties = body.properties as Record<string, unknown>;
    expect(properties.Title).toBeDefined();
    expect(properties.Opportunity).toBeDefined();
    expect(properties.Readiness).toBeDefined();
    expect(properties.Version).toBeDefined();
    expect(properties.Source).toBeDefined();
    expect(properties.Created).toBeDefined();
    // Readiness has A/B/C/D options
    const readiness = properties.Readiness as {
      select: { options: Array<{ name: string }> };
    };
    expect(readiness.select.options.map((o) => o.name)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("createSpecPage sends database parent + properties + blocks", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (url, init) => {
      expect(url).toBe("https://api.notion.com/v1/pages");
      captured = JSON.parse(init.body as string);
      return jsonRes({ id: "page-1", url: "https://notion.so/page-1" });
    });
    const page = await createSpecPage("tok", {
      databaseId: "db-1",
      title: "Fix onboarding",
      opportunityTitle: "Onboarding churn",
      readiness: "B",
      version: 2,
      sourceUrl: "https://rogation.example/spec/opp-1",
      ir: sampleIr(),
      markdownFallback: null,
    });
    expect(page.id).toBe("page-1");
    expect(page.url).toContain("notion.so");

    const body = captured as unknown as Record<string, unknown>;
    expect(body.parent).toEqual({
      type: "database_id",
      database_id: "db-1",
    });
    const props = body.properties as Record<string, unknown>;
    expect(props.Title).toBeDefined();
    expect(props.Version).toEqual({ number: 2 });
    expect(props.Readiness).toEqual({ select: { name: "B" } });
    expect(props.Source).toEqual({
      url: "https://rogation.example/spec/opp-1",
    });
    // Body should contain heading_2 blocks for each section
    const children = body.children as Array<{ type: string }>;
    const types = children.map((b) => b.type);
    expect(types).toContain("heading_2");
    expect(types).toContain("bulleted_list_item");
    expect(types).toContain("paragraph");
  });

  it("createSpecPage omits Readiness when null", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init.body as string);
      return jsonRes({ id: "page-1", url: "https://notion.so/page-1" });
    });
    await createSpecPage("tok", {
      databaseId: "db-1",
      title: "t",
      opportunityTitle: "o",
      readiness: null,
      version: 1,
      sourceUrl: null,
      ir: sampleIr(),
      markdownFallback: null,
    });
    const props = (captured as unknown as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    expect(props.Readiness).toBeUndefined();
    expect(props.Source).toBeUndefined();
  });

  it("401 on createSpecPage throws NotionApiError with status 401", async () => {
    mockFetch(async () =>
      jsonRes({ code: "unauthorized", message: "token revoked" }, 401),
    );
    await expect(
      createSpecPage("tok", {
        databaseId: "db-1",
        title: "t",
        opportunityTitle: "o",
        readiness: null,
        version: 1,
        sourceUrl: null,
        ir: sampleIr(),
        markdownFallback: null,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("NotionApiError preserves both status and code", () => {
    const err = new NotionApiError("x", 429, "rate_limited");
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
  });
});
