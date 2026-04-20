import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/analytics/events";

/*
  Guards the event catalog against silent drift. Renaming or typo-ing
  a constant would break PostHog funnels on the server without any
  compile error — the property type checks, but the string value
  doesn't. These assertions lock the wire-format names.

  When adding a new event: append a case here so the constant value is
  explicit in the test file too. If the funnel name changes, this test
  is the flag that tells you downstream PostHog dashboards need an
  update.
*/

describe("activation funnel event names (wire format)", () => {
  it.each([
    ["SIGNUP_COMPLETED", "signup_completed"],
    ["FIRST_UPLOAD_STARTED", "first_upload_started"],
    ["FIRST_INSIGHT_VIEWED", "first_insight_viewed"],
    ["FIRST_SPEC_EXPORTED", "first_spec_exported"],
    ["TOKEN_BUDGET_WARNING", "token_budget_warning"],
    ["TOKEN_BUDGET_EXHAUSTED", "token_budget_exhausted"],
  ])("%s = %s", (key, value) => {
    expect(EVENTS[key as keyof typeof EVENTS]).toBe(value);
  });

  it("every value is snake_case lowercase (PostHog convention)", () => {
    for (const name of Object.values(EVENTS)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("has no duplicate values", () => {
    const values = Object.values(EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });
});
