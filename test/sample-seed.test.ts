import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  SAMPLE_EVIDENCE,
  seedSampleEvidence,
} from "@/lib/evidence/sample-seed";
import type { IngestContext, IngestResult } from "@/lib/evidence/ingest";

/*
  Unit tests for the sample-data seeder.

  Static-corpus invariants: every SaaS onboarding demo lives or dies
  on this content, so lock down:
    - Count (15 — design rule from the commit plan).
    - Unique slugs (dedup via UNIQUE(account, source_type, source_ref)
      breaks silently if we duplicate).
    - No empty content (empty rows would throw at ingest time).
    - Reasonable length (nothing absurdly short; nothing novel-length).

  Behavioral: the seeder calls ingestEvidence in a loop and handles
  the Free-plan cap. Mock ingestEvidence to simulate both paths.
*/

vi.mock("@/lib/evidence/ingest", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/evidence/ingest")
  >("@/lib/evidence/ingest");
  return {
    ...actual,
    ingestEvidence: vi.fn<
      (ctx: IngestContext, input: unknown) => Promise<IngestResult>
    >(),
  };
});

import { ingestEvidence } from "@/lib/evidence/ingest";

const mockCtx: IngestContext = {
  db: {} as IngestContext["db"],
  accountId: "00000000-0000-0000-0000-000000000001",
  plan: "free",
};

describe("SAMPLE_EVIDENCE corpus", () => {
  it("ships 15 curated pieces", () => {
    expect(SAMPLE_EVIDENCE.length).toBe(15);
  });

  it("every slug is unique", () => {
    const slugs = SAMPLE_EVIDENCE.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("content is non-empty + not absurdly long", () => {
    for (const s of SAMPLE_EVIDENCE) {
      expect(s.content.trim().length).toBeGreaterThan(30);
      expect(s.content.length).toBeLessThan(1000);
    }
  });

  it("covers 5 distinct segment themes", () => {
    // Segment filter isn't required, but a diverse corpus guarantees
    // the clustering prompt has enough signal. We expect 5+ segments.
    const segments = new Set(
      SAMPLE_EVIDENCE.map((s) => s.segment).filter(Boolean),
    );
    expect(segments.size).toBeGreaterThanOrEqual(5);
  });
});

describe("seedSampleEvidence", () => {
  beforeEach(() => {
    vi.mocked(ingestEvidence).mockReset();
  });

  it("all inserts succeed → inserted = 15, deduped = 0, capReached = false", async () => {
    vi.mocked(ingestEvidence).mockImplementation(async () => ({
      id: "fake-id",
      deduped: false,
    }));

    const result = await seedSampleEvidence(mockCtx);

    expect(result).toEqual({ inserted: 15, deduped: 0, capReached: false });
    expect(ingestEvidence).toHaveBeenCalledTimes(15);
  });

  it("all dedup → inserted = 0, deduped = 15 (idempotent re-run)", async () => {
    vi.mocked(ingestEvidence).mockImplementation(async () => ({
      id: "fake-id",
      deduped: true,
    }));

    const result = await seedSampleEvidence(mockCtx);

    expect(result).toEqual({ inserted: 0, deduped: 15, capReached: false });
    expect(ingestEvidence).toHaveBeenCalledTimes(15);
  });

  it("plan-limit throw bails early with capReached = true", async () => {
    // Simulate: 10 succeed, then the 11th throws the plan_limit
    // FORBIDDEN. Seeder should stop + report capReached without
    // leaking the error.
    let call = 0;
    vi.mocked(ingestEvidence).mockImplementation(async () => {
      call++;
      if (call > 10) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Plan cap reached",
          cause: { type: "plan_limit_reached" },
        });
      }
      return { id: "fake-id", deduped: false };
    });

    const result = await seedSampleEvidence(mockCtx);

    expect(result.inserted).toBe(10);
    expect(result.deduped).toBe(0);
    expect(result.capReached).toBe(true);
    // Ingest was called 11 times: 10 that succeeded + 1 that threw.
    expect(ingestEvidence).toHaveBeenCalledTimes(11);
  });

  it("non-plan-limit errors propagate (not silently swallowed)", async () => {
    vi.mocked(ingestEvidence).mockImplementation(async () => {
      throw new Error("DB connection refused");
    });

    await expect(seedSampleEvidence(mockCtx)).rejects.toThrow(
      /DB connection refused/,
    );
  });

  it("passes sourceType='paste_ticket' and sample: prefixed sourceRef", async () => {
    vi.mocked(ingestEvidence).mockImplementation(async () => ({
      id: "fake-id",
      deduped: false,
    }));

    await seedSampleEvidence(mockCtx);

    const firstCall = vi.mocked(ingestEvidence).mock.calls[0];
    expect(firstCall?.[1]).toMatchObject({
      sourceType: "paste_ticket",
      sourceRef: expect.stringMatching(/^sample:/) as string,
    });
  });
});
