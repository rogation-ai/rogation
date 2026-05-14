import { describe, expect, it } from "vitest";
import { withScopeFilter } from "@/lib/evidence/scope-filter";
import { evidence } from "@/db/schema";

describe("withScopeFilter", () => {
  it("returns undefined when scopeId is undefined", () => {
    expect(withScopeFilter(undefined, evidence.scopeId)).toBeUndefined();
  });

  it("returns undefined when scopeId is null", () => {
    expect(withScopeFilter(null, evidence.scopeId)).toBeUndefined();
  });

  it("returns an IS NULL condition for 'unscoped'", () => {
    const result = withScopeFilter("unscoped", evidence.scopeId);
    expect(result).toBeDefined();
  });

  it("returns an eq condition for a UUID", () => {
    const result = withScopeFilter(
      "550e8400-e29b-41d4-a716-446655440000",
      evidence.scopeId,
    );
    expect(result).toBeDefined();
  });
});
