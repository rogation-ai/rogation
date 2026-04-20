import { describe, expect, it } from "vitest";
import { percentFor } from "@/components/ui/FrequencyBar";
import { truncate } from "@/components/ui/CitationChip";

/*
  Pure helpers for CitationChip + FrequencyBar. The components
  themselves render in Storybook (visual regression + accessibility
  checks via addon-a11y); this file covers the math + string cases
  that regressions would silently break.
*/

describe("FrequencyBar.percentFor", () => {
  it("value/max -> rounded 0..100", () => {
    expect(percentFor(5, 10)).toBe(50);
    expect(percentFor(1, 3)).toBe(33);
    expect(percentFor(2, 3)).toBe(67);
  });

  it("zero or negative max -> 0 (no div-by-zero)", () => {
    expect(percentFor(5, 0)).toBe(0);
    expect(percentFor(5, -1)).toBe(0);
  });

  it("zero or negative value -> 0", () => {
    expect(percentFor(0, 10)).toBe(0);
    expect(percentFor(-3, 10)).toBe(0);
  });

  it("value >= max -> 100 (clamped)", () => {
    expect(percentFor(10, 10)).toBe(100);
    expect(percentFor(15, 10)).toBe(100);
  });

  it("handles non-finite inputs as 0", () => {
    expect(percentFor(Number.NaN, 10)).toBe(0);
    expect(percentFor(5, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("CitationChip.truncate", () => {
  it("leaves short strings alone", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("exactly10", 9)).toBe("exactly10");
  });

  it("cuts to maxChars-1 + ellipsis when too long", () => {
    // "one-two-three" is 13 chars; maxChars=10 → 9 char slice + "…"
    expect(truncate("one-two-three", 10)).toBe("one-two-t…");
    expect(truncate("Onboarding is confusing", 12)).toBe("Onboarding …");
  });

  it("maxChars <= 0 returns just the ellipsis", () => {
    expect(truncate("anything", 0)).toBe("…");
  });
});
