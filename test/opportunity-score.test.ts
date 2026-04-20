import { describe, expect, it } from "vitest";
import {
  computeScore,
  defaultWeights,
  effortToNumber,
} from "@/lib/evidence/opportunities";
import { opportunityScore } from "@/lib/llm/prompts/opportunity-score";

/*
  Pure tests over the opportunity-score pipeline. Two halves:

  - The mechanical re-rank (computeScore) — called on every slider
    tick in the UI. Drift here silently changes ranked output.
  - The prompt parser — rejects malformed LLM output before any DB
    write.
*/

describe("computeScore", () => {
  const freqs = new Map([
    ["c1", 10],
    ["c2", 2],
  ]);

  const base = {
    impact: { retention: 0.4, revenue: 0.6 },
    strategy: 0.5,
    effort: "M" as const,
    confidence: 1,
  };

  it("is >=0", () => {
    expect(
      computeScore(base, ["c1"], freqs, defaultWeights()),
    ).toBeGreaterThanOrEqual(0);
  });

  it("clusters with higher frequency score higher when frequency weight is up", () => {
    const high = { ...defaultWeights(), frequencyW: 3 };
    const low = { ...defaultWeights(), frequencyW: 0 };
    const hi = computeScore(base, ["c1"], freqs, high);
    const lo = computeScore(base, ["c1"], freqs, low);
    expect(hi).toBeGreaterThan(lo);
  });

  it("penalises higher effort when effort weight is up", () => {
    const w = { ...defaultWeights(), effortW: 2 };
    const xs = computeScore({ ...base, effort: "XS" }, ["c1"], freqs, w);
    const xl = computeScore({ ...base, effort: "XL" }, ["c1"], freqs, w);
    expect(xs).toBeGreaterThan(xl);
  });

  it("confidence scales the whole score", () => {
    const full = computeScore(base, ["c1"], freqs, defaultWeights());
    const half = computeScore(
      { ...base, confidence: 0.5 },
      ["c1"],
      freqs,
      defaultWeights(),
    );
    expect(Math.abs(half - full / 2)).toBeLessThan(1e-9);
  });

  it("never goes negative even with extreme effort penalty", () => {
    const w = { ...defaultWeights(), effortW: 10 };
    expect(
      computeScore({ ...base, effort: "XL" }, ["c1"], freqs, w),
    ).toBe(0);
  });

  it("handles empty cluster list gracefully", () => {
    expect(computeScore(base, [], freqs, defaultWeights())).toBeGreaterThanOrEqual(0);
  });

  it("effortToNumber maps XS..XL to 0.1..1.0 ascending", () => {
    expect(effortToNumber("XS")).toBeLessThan(effortToNumber("S"));
    expect(effortToNumber("S")).toBeLessThan(effortToNumber("M"));
    expect(effortToNumber("M")).toBeLessThan(effortToNumber("L"));
    expect(effortToNumber("L")).toBeLessThan(effortToNumber("XL"));
  });
});

describe("opportunityScore.parse", () => {
  const valid = JSON.stringify({
    opportunities: [
      {
        title: "Ship a setup wizard",
        description: "First-run onboarding is confusing.",
        reasoning: "C1 and C2 both point at onboarding friction.",
        clusterLabels: ["C1", "C2"],
        impact: { retention: 0.4, revenue: 0.2 },
        strategy: 0.6,
        effort: "S",
        confidence: 0.85,
      },
    ],
  });

  it("accepts a well-formed envelope", () => {
    const out = opportunityScore.parse(valid);
    expect(out.opportunities).toHaveLength(1);
    expect(out.opportunities[0]?.effort).toBe("S");
  });

  it("rejects missing opportunities[]", () => {
    expect(() => opportunityScore.parse("{}")).toThrowError(/opportunities/);
  });

  it("rejects zero-length array (signal of prompt failure)", () => {
    expect(() =>
      opportunityScore.parse(JSON.stringify({ opportunities: [] })),
    ).toThrowError(/zero opportunities/i);
  });

  it("rejects bad effort values", () => {
    const bad = JSON.stringify({
      opportunities: [
        {
          title: "x",
          description: "y",
          reasoning: "z",
          clusterLabels: ["C1"],
          impact: {},
          strategy: 0.5,
          effort: "HUGE",
          confidence: 0.5,
        },
      ],
    });
    expect(() => opportunityScore.parse(bad)).toThrowError(/XS/);
  });

  it("rejects out-of-range confidence / strategy", () => {
    for (const value of [-0.1, 1.1, "high"]) {
      const bad = JSON.stringify({
        opportunities: [
          {
            title: "x",
            description: "y",
            reasoning: "z",
            clusterLabels: ["C1"],
            impact: {},
            strategy: value,
            effort: "S",
            confidence: 0.5,
          },
        ],
      });
      expect(() => opportunityScore.parse(bad)).toThrow();
    }
  });

  it("rejects opportunities without cluster labels", () => {
    const bad = JSON.stringify({
      opportunities: [
        {
          title: "x",
          description: "y",
          reasoning: "z",
          clusterLabels: [],
          impact: {},
          strategy: 0.5,
          effort: "S",
          confidence: 0.5,
        },
      ],
    });
    expect(() => opportunityScore.parse(bad)).toThrowError(/cluster/i);
  });
});
