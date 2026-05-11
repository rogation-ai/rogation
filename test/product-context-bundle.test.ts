import { describe, expect, it } from "vitest";
import {
  assembleContextBundle,
  buildProductContextBlock,
  hasNonEmptyContext,
} from "@/lib/evidence/product-context-bundle";

describe("hasNonEmptyContext", () => {
  it("returns false for null/undefined brief and structured", () => {
    expect(hasNonEmptyContext(null, null)).toBe(false);
    expect(hasNonEmptyContext(undefined, undefined)).toBe(false);
    expect(hasNonEmptyContext("", null)).toBe(false);
    expect(hasNonEmptyContext("   ", null)).toBe(false);
  });

  it("returns true when brief has content", () => {
    expect(hasNonEmptyContext("My product does X", null)).toBe(true);
  });

  it("returns true when structured has any non-empty field", () => {
    expect(hasNonEmptyContext(null, { icp: "Startups" })).toBe(true);
    expect(hasNonEmptyContext(null, { stage: "Seed" })).toBe(true);
    expect(hasNonEmptyContext(null, { primaryMetrics: ["Retention"] })).toBe(true);
  });

  it("returns false when all structured fields are empty strings", () => {
    expect(
      hasNonEmptyContext(null, {
        icp: "",
        stage: "",
        primaryMetrics: [],
        customMetric: "",
      }),
    ).toBe(false);
  });
});

describe("assembleContextBundle", () => {
  it("returns empty block when no context present", () => {
    const result = assembleContextBundle(null, null);
    expect(result.block).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("assembles brief-only block", () => {
    const result = assembleContextBundle("We build project management tools", null);
    expect(result.block).toContain("<product_context>");
    expect(result.block).toContain("<brief>");
    expect(result.block).toContain("project management tools");
    expect(result.truncated).toBe(false);
  });

  it("assembles brief + structured block", () => {
    const result = assembleContextBundle("Our tool helps PMs", {
      icp: "Startup companies",
      stage: "Seed",
      primaryMetrics: ["Retention", "Revenue"],
      customMetric: "Weekly active teams",
    });
    expect(result.block).toContain("<brief>");
    expect(result.block).toContain("<icp>");
    expect(result.block).toContain("<stage>");
    expect(result.block).toContain("<primary_metrics>");
    expect(result.block).toContain("<custom_metric>");
    expect(result.block).not.toContain("<features_shipped>");
    expect(result.block).not.toContain("<roadmap>");
    expect(result.truncated).toBe(false);
  });

  it("escapes CDATA in custom metric", () => {
    const result = assembleContextBundle(null, {
      customMetric: "Metric ]]> injection",
    });
    expect(result.block).toContain("]]]]><![CDATA[>");
    expect(result.truncated).toBe(false);
  });

  it("escapes CDATA in brief", () => {
    const result = assembleContextBundle("Brief with ]]> inside", null);
    expect(result.block).toContain("]]]]><![CDATA[>");
  });

  it("truncates brief over 8KB", () => {
    const longBrief = "A".repeat(10_000);
    const result = assembleContextBundle(longBrief, null);
    const briefMatch = result.block.match(/<brief><!\[CDATA\[(.*?)\]\]><\/brief>/s);
    expect(briefMatch).toBeTruthy();
    const content = briefMatch![1]!;
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(8_192);
  });

  it("renders multiple primary metrics as items", () => {
    const result = assembleContextBundle(null, {
      primaryMetrics: ["Retention", "Revenue", "NPS"],
    });
    const items = result.block.match(/<item>/g);
    expect(items).toHaveLength(3);
  });
});

describe("buildProductContextBlock", () => {
  it("returns empty string for undefined", () => {
    expect(buildProductContextBlock(undefined)).toBe("");
  });

  it("appends double newline to context", () => {
    const result = buildProductContextBlock("<product_context>...</product_context>");
    expect(result).toBe("<product_context>...</product_context>\n\n");
  });
});
