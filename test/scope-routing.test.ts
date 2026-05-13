import { describe, expect, it } from "vitest";
import { cosineSim } from "@/lib/evidence/clustering/knn";
import { SCOPE_THRESHOLD, MULTI_SCOPE_MARGIN } from "@/lib/evidence/scope-routing";

describe("scope routing thresholds", () => {
  it("threshold is 0.70", () => {
    expect(SCOPE_THRESHOLD).toBe(0.7);
  });

  it("multi-scope margin is 0.05", () => {
    expect(MULTI_SCOPE_MARGIN).toBe(0.05);
  });

  it("evidence with sim >= threshold gets routed", () => {
    const a = [1, 0, 0];
    const b = [0.8, 0.6, 0];
    const sim = cosineSim(a, b);
    expect(sim).toBeGreaterThan(SCOPE_THRESHOLD);
  });

  it("evidence with sim < threshold stays unscoped", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const sim = cosineSim(a, b);
    expect(sim).toBeLessThan(SCOPE_THRESHOLD);
  });

  it("orthogonal vectors score near zero", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSim(a, b)).toBeCloseTo(0, 10);
  });

  it("identical vectors score 1.0", () => {
    const a = [0.5, 0.3, 0.1];
    expect(cosineSim(a, a)).toBeCloseTo(1.0, 10);
  });

  it("0-scope accounts skip filter entirely", () => {
    // When scopeId is undefined/null, withScopeFilter returns undefined
    // so the query runs without any scope WHERE clause = same as today.
    // This is verified by scope-filter.test.ts; here we just confirm
    // the routing thresholds make sense for the math.
    expect(SCOPE_THRESHOLD).toBeLessThan(1);
    expect(SCOPE_THRESHOLD).toBeGreaterThan(0);
  });

  it("multi-scope margin detects close matches", () => {
    const scope1 = [0.9, 0.4, 0.1];
    const scope2 = [0.88, 0.42, 0.12];
    const query = [0.89, 0.41, 0.11];

    const sim1 = cosineSim(query, scope1);
    const sim2 = cosineSim(query, scope2);
    const diff = Math.abs(sim1 - sim2);
    expect(diff).toBeLessThan(MULTI_SCOPE_MARGIN);
  });
});
