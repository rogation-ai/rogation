import { describe, expect, it } from "vitest";
import {
  PLAN_LIMITS,
  canExport,
  exportHasWatermark,
  hasOutcomeTracking,
  shareLinksHaveWatermark,
  tokenBudgetSoftCap,
} from "@/lib/plans";

/*
  Unit tests over the PLAN_LIMITS table and its feature-gate helpers.
  Pure functions, no DB — fast, run on every commit, catch accidental
  edits to the cap shape (e.g., someone setting Free.integrations=1).

  The cap + integration-iso behavior (seed 10 evidence, 11th blocked)
  is covered separately in test/tenant-isolation.test.ts because it
  requires a real Postgres.
*/

describe("plan caps", () => {
  it("free tier has the expected hard caps from Section 11", () => {
    expect(PLAN_LIMITS.free.evidence).toBe(10);
    expect(PLAN_LIMITS.free.insights).toBe(3);
    expect(PLAN_LIMITS.free.opportunities).toBe(1);
    expect(PLAN_LIMITS.free.specs).toBe(1);
    expect(PLAN_LIMITS.free.integrations).toBe(0);
  });

  it("solo tier allows unlimited synthesis and exactly 1 integration", () => {
    expect(PLAN_LIMITS.solo.evidence).toBe("unlimited");
    expect(PLAN_LIMITS.solo.insights).toBe("unlimited");
    expect(PLAN_LIMITS.solo.opportunities).toBe("unlimited");
    expect(PLAN_LIMITS.solo.specs).toBe("unlimited");
    expect(PLAN_LIMITS.solo.integrations).toBe(1);
  });

  it("pro tier is fully unlimited", () => {
    expect(PLAN_LIMITS.pro.evidence).toBe("unlimited");
    expect(PLAN_LIMITS.pro.integrations).toBe("unlimited");
  });
});

describe("feature gates", () => {
  it("gates Linear + Notion export to Pro only", () => {
    expect(canExport("free", "linear")).toBe(false);
    expect(canExport("solo", "linear")).toBe(false);
    expect(canExport("pro", "linear")).toBe(true);

    expect(canExport("free", "notion")).toBe(false);
    expect(canExport("solo", "notion")).toBe(false);
    expect(canExport("pro", "notion")).toBe(true);
  });

  it("allows Markdown export on every tier", () => {
    expect(canExport("free", "markdown")).toBe(true);
    expect(canExport("solo", "markdown")).toBe(true);
    expect(canExport("pro", "markdown")).toBe(true);
  });

  it("watermarks exports on free only", () => {
    expect(exportHasWatermark("free")).toBe(true);
    expect(exportHasWatermark("solo")).toBe(false);
    expect(exportHasWatermark("pro")).toBe(false);
  });

  it("watermarks share links on free only", () => {
    expect(shareLinksHaveWatermark("free")).toBe(true);
    expect(shareLinksHaveWatermark("solo")).toBe(false);
    expect(shareLinksHaveWatermark("pro")).toBe(false);
  });

  it("enables outcome tracking on Pro only", () => {
    expect(hasOutcomeTracking("free")).toBe(false);
    expect(hasOutcomeTracking("solo")).toBe(false);
    expect(hasOutcomeTracking("pro")).toBe(true);
  });
});

describe("token budget", () => {
  it("soft cap is 80% of the monthly budget, truncated", () => {
    expect(tokenBudgetSoftCap("free")).toBe(160_000);
    expect(tokenBudgetSoftCap("solo")).toBe(4_000_000);
    expect(tokenBudgetSoftCap("pro")).toBe(12_000_000);
  });

  it("hard caps monotonically rise with tier", () => {
    expect(PLAN_LIMITS.free.monthlyTokenBudget).toBeLessThan(
      PLAN_LIMITS.solo.monthlyTokenBudget,
    );
    expect(PLAN_LIMITS.solo.monthlyTokenBudget).toBeLessThan(
      PLAN_LIMITS.pro.monthlyTokenBudget,
    );
  });
});
