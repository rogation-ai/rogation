import { describe, expect, it } from "vitest";
import { normalizeScopeParam } from "@/lib/client/use-scope-filter";

describe("normalizeScopeParam", () => {
  it("returns undefined when the param is missing", () => {
    expect(normalizeScopeParam(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeScopeParam("")).toBeUndefined();
  });

  it('returns "unscoped" literal when the param is the literal "unscoped"', () => {
    expect(normalizeScopeParam("unscoped")).toBe("unscoped");
  });

  it("returns the uuid when the param is a valid v4 uuid", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(normalizeScopeParam(uuid)).toBe(uuid);
  });

  it("accepts uppercase uuids (case insensitive)", () => {
    const uuid = "550E8400-E29B-41D4-A716-446655440000";
    expect(normalizeScopeParam(uuid)).toBe(uuid);
  });

  it("returns undefined for garbage input — never sends to the server", () => {
    expect(normalizeScopeParam("not-a-uuid")).toBeUndefined();
    expect(normalizeScopeParam("' OR 1=1 --")).toBeUndefined();
    expect(normalizeScopeParam("../etc/passwd")).toBeUndefined();
  });

  it("returns undefined for nearly-valid uuids (one char off)", () => {
    expect(
      normalizeScopeParam("550e8400-e29b-41d4-a716-44665544000"),
    ).toBeUndefined();
    expect(
      normalizeScopeParam("550e8400-e29b-41d4-a716-446655440000z"),
    ).toBeUndefined();
  });
});
