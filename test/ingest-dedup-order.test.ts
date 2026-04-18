import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { ingestEvidence, type IngestContext } from "@/lib/evidence/ingest";

/*
  Regression: cap-before-dedup ordering bug.

  Before the fix, `assertResourceLimit` ran BEFORE the dedup lookup, so
  a Free-plan account at 10/10 evidence cap would throw FORBIDDEN on
  every attempt — even an attempt that would have returned
  `deduped: true` without inserting a row.

  Surfaced by /qa on 2026-04-18: clicking "Use sample data" a second
  time on a filled Free account showed "0 samples already present.
  Plan cap reached." instead of "10 samples already present."

  Now dedup runs first; the cap check only gates NEW inserts.

  Stubs plans.ts + embed() + the DB so we exercise the exact
  pre-insert ordering without standing up Postgres.
*/

vi.mock("@/lib/plans", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plans")>(
    "@/lib/plans",
  );
  return {
    ...actual,
    assertResourceLimit: vi.fn<typeof actual.assertResourceLimit>(),
  };
});
vi.mock("@/lib/llm/router", async () => ({
  embed: vi.fn(async () => [[0]]),
}));

import { assertResourceLimit } from "@/lib/plans";

function mockTxWithExistingRow(id: string) {
  // Drizzle's query builder is fluent + awaitable. Stub it as a
  // promise-returning chain that resolves to one row on the SELECT.
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([{ id }]),
  };
  return {
    select: () => chain,
    // insert/values/returning would only be called on a fresh row; if
    // the dedup fix works, it's never reached.
    insert: () => {
      throw new Error("insert should not be called when a dup exists");
    },
  };
}

const mockCtx = (tx: unknown): IngestContext => ({
  db: tx as IngestContext["db"],
  accountId: "00000000-0000-0000-0000-000000000001",
  plan: "free",
});

describe("ingestEvidence: dedup runs BEFORE cap check", () => {
  beforeEach(() => {
    vi.mocked(assertResourceLimit).mockReset();
  });

  it("returns deduped=true without calling assertResourceLimit when a content-hash match exists", async () => {
    const tx = mockTxWithExistingRow("dup-row-id");
    const result = await ingestEvidence(mockCtx(tx), {
      content: "I signed up yesterday and stared at the dashboard.",
      sourceType: "paste_ticket",
      sourceRef: "sample:onboarding-01",
    });

    expect(result).toEqual({ id: "dup-row-id", deduped: true });
    expect(assertResourceLimit).not.toHaveBeenCalled();
  });

  it("a Free-plan account at cap can still DEDUP (re-seed idempotency)", async () => {
    // Simulate: if assertResourceLimit WERE called, it would throw.
    // The fix guarantees it isn't called on the dedup path.
    vi.mocked(assertResourceLimit).mockRejectedValue(
      new TRPCError({
        code: "FORBIDDEN",
        message: "Plan cap reached",
        cause: { type: "plan_limit_reached" },
      }),
    );

    const tx = mockTxWithExistingRow("existing-id");
    const result = await ingestEvidence(mockCtx(tx), {
      content: "Already ingested content",
      sourceType: "paste_ticket",
      sourceRef: "sample:dup",
    });

    expect(result.deduped).toBe(true);
    expect(assertResourceLimit).not.toHaveBeenCalled();
  });
});
