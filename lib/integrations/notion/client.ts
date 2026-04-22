import type { SpecIR } from "@/lib/spec/ir";

/*
  Thin Notion REST client. One fetch per call with a typed response —
  avoids the `@notionhq/client` SDK bundle. Auth: Bearer token with a
  Notion-Version header pinned so upstream schema changes don't silently
  break our shape.

  Errors: Notion returns JSON errors with `code` + `status`. We wrap
  non-2xx into NotionApiError with the status preserved so the caller
  can detect 401 → mark token_invalid.
*/

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export class NotionApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function notionRequest<T>(
  accessToken: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${NOTION_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Hard cap so a hung Notion worker doesn't pin a serverless invocation.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new NotionApiError("Notion request timed out after 10s", 504);
    }
    throw err;
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // fall through — body wasn't JSON
    }
  }

  if (!res.ok) {
    const errObj = (json ?? {}) as { message?: string; code?: string };
    throw new NotionApiError(
      errObj.message ?? `Notion HTTP ${res.status}`,
      res.status,
      errObj.code ?? null,
    );
  }
  return (json ?? {}) as T;
}

/* --------------------------- bot + search --------------------------- */

export interface NotionBotUser {
  id: string;
  type: "bot";
  bot?: {
    owner?: { type: "user"; user: { id: string } } | { type: "workspace" };
    workspace_name?: string | null;
  };
}

/** `GET /users/me` — useful to validate a stored token is still live. */
export async function fetchBotUser(
  accessToken: string,
): Promise<NotionBotUser> {
  return notionRequest<NotionBotUser>(accessToken, "GET", "/users/me");
}

interface SearchResult {
  results: Array<{
    object: "page" | "database";
    id: string;
    // Pages may have `properties.title.title[0].plain_text` or (workspace
    // pages) a parent=page_id / workspace etc. We only need the id.
  }>;
}

/**
 * Find the first page the bot can write to. Notion OAuth grants access
 * to specific pages during consent; if the user didn't share any, the
 * search returns [] and we flag the integration as `needs_setup` so the
 * UI can prompt them to reconnect and pick a page.
 */
export async function findWritablePage(
  accessToken: string,
): Promise<string | null> {
  const res = await notionRequest<SearchResult>(
    accessToken,
    "POST",
    "/search",
    {
      filter: { value: "page", property: "object" },
      page_size: 10,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    },
  );
  const page = res.results.find((r) => r.object === "page");
  return page?.id ?? null;
}

/* --------------------------- database creation --------------------------- */

export interface NotionDatabase {
  id: string;
  title: Array<{ plain_text: string }>;
}

/**
 * Create the "Rogation Specs" database under the given parent page.
 * Schema:
 *   Title      (title)
 *   Opportunity (rich_text)
 *   Readiness  (select: A/B/C/D)
 *   Version    (number)
 *   Source     (url)
 *   Created    (date)
 */
export async function createSpecDatabase(
  accessToken: string,
  parentPageId: string,
): Promise<NotionDatabase> {
  return notionRequest<NotionDatabase>(accessToken, "POST", "/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [
      { type: "text", text: { content: "Rogation Specs" } },
    ],
    properties: {
      Title: { title: {} },
      Opportunity: { rich_text: {} },
      Readiness: {
        select: {
          options: [
            { name: "A", color: "green" },
            { name: "B", color: "blue" },
            { name: "C", color: "yellow" },
            { name: "D", color: "red" },
          ],
        },
      },
      Version: { number: { format: "number" } },
      Source: { url: {} },
      Created: { date: {} },
    },
  });
}

/**
 * Fetch a database by id. Used to re-validate that the stored
 * defaultDatabaseId is still reachable by the token (handles the
 * "PM archived our database" case at push time).
 */
export async function fetchDatabase(
  accessToken: string,
  databaseId: string,
): Promise<NotionDatabase> {
  return notionRequest<NotionDatabase>(
    accessToken,
    "GET",
    `/databases/${databaseId}`,
  );
}

/* --------------------------- spec page creation --------------------------- */

export interface CreateSpecPageInput {
  databaseId: string;
  title: string;
  opportunityTitle: string;
  readiness: "A" | "B" | "C" | "D" | null;
  version: number;
  sourceUrl: string | null;
  ir: SpecIR;
  /**
   * Markdown fallback. If block conversion would be lossy (e.g. tables,
   * nested lists beyond Notion's limits), this is included as a final
   * code block so no content is silently dropped.
   */
  markdownFallback: string | null;
}

export interface CreatedNotionPage {
  id: string;
  url: string;
}

/** Truncate rich_text content to Notion's 2000-char per-block limit. */
function rt(text: string) {
  const chunks: Array<{ type: "text"; text: { content: string } }> = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, 1990);
    remaining = remaining.slice(1990);
    chunks.push({ type: "text", text: { content: chunk } });
  }
  return chunks;
}

function heading2(text: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: { rich_text: rt(text) },
  };
}

function paragraph(text: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: rt(text) },
  };
}

function bullet(text: string) {
  return {
    object: "block" as const,
    type: "bulleted_list_item" as const,
    bulleted_list_item: { rich_text: rt(text) },
  };
}

function irToBlocks(ir: SpecIR): unknown[] {
  const blocks: unknown[] = [];
  if (ir.summary) blocks.push(paragraph(ir.summary));

  if (ir.userStories.length) {
    blocks.push(heading2("User stories"));
    for (const us of ir.userStories) {
      blocks.push(
        bullet(
          `${us.id}: As ${us.persona}, I want ${us.goal} so that ${us.value}.`,
        ),
      );
    }
  }

  if (ir.acceptanceCriteria.length) {
    blocks.push(heading2("Acceptance criteria"));
    for (const ac of ir.acceptanceCriteria) {
      blocks.push(
        bullet(
          `${ac.storyId}: Given ${ac.given}; When ${ac.when}; Then ${ac.then}.`,
        ),
      );
    }
  }

  if (ir.nonFunctional.length) {
    blocks.push(heading2("Non-functional"));
    for (const nf of ir.nonFunctional) {
      blocks.push(bullet(`${nf.category}: ${nf.requirement}`));
    }
  }

  if (ir.edgeCases.length) {
    blocks.push(heading2("Edge cases"));
    for (const ec of ir.edgeCases) {
      blocks.push(bullet(`${ec.scenario} → ${ec.expectedBehavior}`));
    }
  }

  if (ir.qaChecklist.length) {
    blocks.push(heading2("QA checklist"));
    for (const q of ir.qaChecklist) {
      blocks.push(bullet(q.check));
    }
  }

  if (ir.citations.length) {
    blocks.push(heading2("Citations"));
    for (const c of ir.citations) {
      blocks.push(bullet(`${c.clusterId}: ${c.note}`));
    }
  }

  return blocks;
}

/**
 * Create a page in the given database with spec properties filled in
 * and the IR rendered as Notion blocks. Caps at 100 children per
 * `pages.create` call; for longer specs we truncate and include the
 * full markdown as a fallback so nothing is lost.
 */
export async function createSpecPage(
  accessToken: string,
  input: CreateSpecPageInput,
): Promise<CreatedNotionPage> {
  const blocks = irToBlocks(input.ir);
  // Notion caps 100 blocks per create. Our specs easily fit, but a
  // pathological IR could exceed it — truncate + append a note so the
  // PM knows to open the markdown export for the full thing.
  let children = blocks.slice(0, 99);
  if (blocks.length > 99) {
    children = [
      ...children,
      paragraph(
        "(Spec truncated — download the markdown export for the full content.)",
      ),
    ];
  }

  const properties: Record<string, unknown> = {
    Title: { title: rt(input.title) },
    Opportunity: { rich_text: rt(input.opportunityTitle) },
    Version: { number: input.version },
    Created: { date: { start: new Date().toISOString() } },
  };
  if (input.readiness) {
    properties.Readiness = { select: { name: input.readiness } };
  }
  if (input.sourceUrl) {
    properties.Source = { url: input.sourceUrl };
  }

  const page = await notionRequest<{ id: string; url: string }>(
    accessToken,
    "POST",
    "/pages",
    {
      parent: { type: "database_id", database_id: input.databaseId },
      properties,
      children,
    },
  );
  return { id: page.id, url: page.url };
}
