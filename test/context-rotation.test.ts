import { describe, expect, it } from "vitest";
import { shouldUseContext } from "@/lib/evidence/context-rotation";

describe("shouldUseContext", () => {
  it("returns true for 'on' flag regardless of inputs", () => {
    expect(shouldUseContext("on", "acct-1", "run-1", "clustering")).toBe(true);
    expect(shouldUseContext("on", "acct-1", "run-1", "opportunity")).toBe(true);
  });

  it("returns false for 'off' flag regardless of inputs", () => {
    expect(shouldUseContext("off", "acct-1", "run-1", "clustering")).toBe(false);
    expect(shouldUseContext("off", "acct-1", "run-1", "spec")).toBe(false);
  });

  it("is deterministic for clustering with same accountId + runId", () => {
    const a = shouldUseContext("rotate", "acct-1", "run-42", "clustering");
    const b = shouldUseContext("rotate", "acct-1", "run-42", "clustering");
    expect(a).toBe(b);
  });

  it("varies for clustering with different runId", () => {
    const results = new Set<boolean>();
    for (let i = 0; i < 20; i++) {
      results.add(shouldUseContext("rotate", "acct-test", `run-${i}`, "clustering"));
    }
    expect(results.size).toBe(2);
  });

  it("is per-day for opportunity calls (same day = same result)", () => {
    const a = shouldUseContext("rotate", "acct-1", "uuid-A", "opportunity");
    const b = shouldUseContext("rotate", "acct-1", "uuid-B", "opportunity");
    expect(a).toBe(b);
  });

  it("is per-day for spec calls (same day = same result)", () => {
    const a = shouldUseContext("rotate", "acct-1", "uuid-X", "spec");
    const b = shouldUseContext("rotate", "acct-1", "uuid-Y", "spec");
    expect(a).toBe(b);
  });
});
