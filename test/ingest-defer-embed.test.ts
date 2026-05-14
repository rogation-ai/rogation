import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestEvidence, type IngestContext } from "@/lib/evidence/ingest";

/*
  Defer-mode embed path: when a caller sets `embed: "defer"`, the
  evidence row is inserted synchronously but the 1536-d vector is NOT
  computed inside the request. Instead we emit an Inngest event and
  the worker (lib/inngest/functions/embed-evidence.ts) embeds out of
  band.

  This test asserts the contract by stubbing the DB chain + the
  router's embed() + inngest.send() and checking:
    1. embed() is NOT called during ingest.
    2. evidence_embedding is NOT inserted during ingest.
    3. inngest.send() IS called with the expected event name + data.

  Default mode (sync) still does all three inline — covered by the
  existing ingest-dedup-order tests.
*/

vi.mock("@/lib/plans", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plans")>(
    "@/lib/plans",
  );
  return {
    ...actual,
    assertResourceLimit: vi.fn(async () => ({
      resource: "evidence" as const,
      current: 0,
      max: 10,
      plan: "free" as const,
    })),
  };
});
vi.mock("@/lib/llm/router", () => ({
  embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
}));
vi.mock("@/lib/inngest/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/inngest/client")>(
      "@/lib/inngest/client",
    );
  return {
    ...actual,
    inngest: { send: vi.fn(async () => ({ ids: ["evt-1"] })) },
  };
});
vi.mock("@/lib/evidence/exclusions", () => ({
  matchExclusionCentroid: vi.fn(async () => null),
}));

import { embed } from "@/lib/llm/router";
import { inngest } from "@/lib/inngest/client";

/*
  Build a fluent Drizzle stub:
   - select(...).from(...).where(...).limit(...) → no existing row
   - insert(evidence).values(...).returning(...) → { id: "new-evi" }
   - insert(evidenceEmbeddings) must NOT be called in defer mode
*/
function mockTxNoDupNoEmbedding(): unknown {
  const insertEmbeddings = vi.fn(() => {
    throw new Error(
      "evidence_embedding insert must not run in defer mode",
    );
  });
  const insertEvidence = {
    values: () => ({
      returning: () => Promise.resolve([{ id: "new-evi" }]),
    }),
  };
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve([]),
  };
  return {
    select: () => selectChain,
    insert: (table: unknown) => {
      // Drizzle passes the table object. We distinguish by shape —
      // evidence has `contentHash`, evidence_embedding doesn't.
      const t = table as { contentHash?: unknown };
      if (t && "contentHash" in t) return insertEvidence;
      insertEmbeddings();
      return insertEvidence;
    },
  };
}

const ctx = (tx: unknown): IngestContext => ({
  db: tx as IngestContext["db"],
  accountId: "00000000-0000-0000-0000-000000000001",
  plan: "free",
});

describe("ingestEvidence: defer-mode embed", () => {
  beforeEach(() => {
    vi.mocked(embed).mockClear();
    vi.mocked(inngest.send).mockClear();
  });

  it("does NOT call embed() and DOES emit an Inngest event", async () => {
    const tx = mockTxNoDupNoEmbedding();
    const result = await ingestEvidence(ctx(tx), {
      content: "the dashboard is confusing on first login",
      sourceType: "upload_text",
      sourceRef: "upload:alice.txt",
      embed: "defer",
    });

    expect(result).toEqual({ id: "new-evi", deduped: false });
    expect(embed).not.toHaveBeenCalled();
    expect(inngest.send).toHaveBeenCalledTimes(1);
    const sentArg = vi.mocked(inngest.send).mock.calls[0]?.[0];
    expect(sentArg).toMatchObject({
      name: "evidence/embed.requested",
      data: {
        accountId: "00000000-0000-0000-0000-000000000001",
        evidenceId: "new-evi",
      },
    });
  });

  it("sync mode still calls embed() and does NOT emit an event", async () => {
    // Build a stub that accepts both evidence AND embedding inserts
    // (sync mode writes both).
    const chain = {
      values: () => ({
        returning: () => Promise.resolve([{ id: "sync-evi" }]),
      }),
    };
    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      limit: () => Promise.resolve([]),
    };
    const tx = {
      select: () => selectChain,
      insert: () => chain,
    } as unknown as IngestContext["db"];

    const result = await ingestEvidence(ctx(tx), {
      content: "same payload, sync",
      sourceType: "paste_ticket",
      // no embed field → defaults to sync
    });

    expect(result.id).toBe("sync-evi");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
