import { describe, expect, it } from "vitest";
import {
  EXCLUSION_THRESHOLD,
  DECAY_RATE,
} from "@/lib/evidence/exclusions";
import { withExcludedFilter } from "@/lib/evidence/excluded-filter";
import { evidence } from "@/db/schema";

describe("exclusion constants", () => {
  it("EXCLUSION_THRESHOLD is 0.75", () => {
    expect(EXCLUSION_THRESHOLD).toBe(0.75);
  });

  it("DECAY_RATE is 0.02", () => {
    expect(DECAY_RATE).toBe(0.02);
  });

  it("threshold is strictly between 0 and 1", () => {
    expect(EXCLUSION_THRESHOLD).toBeGreaterThan(0);
    expect(EXCLUSION_THRESHOLD).toBeLessThan(1);
  });

  it("decay rate is positive and much smaller than threshold", () => {
    expect(DECAY_RATE).toBeGreaterThan(0);
    expect(DECAY_RATE).toBeLessThan(EXCLUSION_THRESHOLD);
  });
});

describe("withExcludedFilter", () => {
  it("returns a condition when only excludedCol is provided", () => {
    const result = withExcludedFilter(evidence.excluded);
    expect(result).toBeDefined();
  });

  it("returns a combined AND condition when both columns are provided", () => {
    const result = withExcludedFilter(
      evidence.excluded,
      evidence.exclusionPending,
    );
    expect(result).toBeDefined();
  });

  it("returns undefined-free result for single column", () => {
    const result = withExcludedFilter(evidence.excluded);
    // The result should be a drizzle SQL condition, not undefined
    expect(result).not.toBeUndefined();
  });

  it("returns undefined-free result for both columns", () => {
    const result = withExcludedFilter(
      evidence.excluded,
      evidence.exclusionPending,
    );
    expect(result).not.toBeUndefined();
  });
});
