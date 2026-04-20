import { describe, expect, it } from "vitest";
import { clerkAppearance } from "@/app/(auth)/clerk-appearance";

/*
  Framework-only smoke. Runs without a DB and proves Vitest can resolve
  the @ path alias, import source files, and exercise a pure export.
  Expand this file with light unit tests that don't need a DB (pure
  helpers, JSON schema validation, scoring math, etc.).
*/

describe("smoke", () => {
  it("imports source via @ alias", () => {
    expect(clerkAppearance).toBeDefined();
    expect(clerkAppearance.variables?.colorPrimary).toBe("#D04B3F");
  });
});
