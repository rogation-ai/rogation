import { describe, expect, it } from "vitest";
import { truncate, formatDate } from "@/app/(app)/evidence/page";

describe("truncate", () => {
  it("returns the original string when under the cap", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("returns the original string when exactly at the cap", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
  });

  it("cuts on the last word boundary past 60% of max and appends ellipsis", () => {
    const input = "the quick brown fox jumps over the lazy dog";
    const out = truncate(input, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toMatch(/\s…$/);
  });

  it("cuts mid-word when no space exists past 60%", () => {
    const input = "aaaaaaaaaaaaaaaaaaaaaaaa bbb";
    const out = truncate(input, 10);
    expect(out).toBe("aaaaaaaaaa…");
  });
});

describe("formatDate", () => {
  it("renders time-only for same-day dates", () => {
    const d = new Date();
    d.setHours(14, 5, 0, 0);
    const out = formatDate(d);
    expect(out).not.toMatch(/\d{4}/);
    expect(out).toMatch(/\d/);
  });

  it("renders a date for non-same-day inputs", () => {
    const past = new Date();
    past.setDate(past.getDate() - 10);
    const out = formatDate(past);
    expect(out.length).toBeGreaterThan(3);
  });

  it("accepts ISO strings", () => {
    expect(() => formatDate(new Date().toISOString())).not.toThrow();
  });
});
