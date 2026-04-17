import { describe, expect, it } from "vitest";
import {
  hashEvidenceContent,
  normalizeEvidenceText,
} from "@/lib/evidence/hash";

/*
  Pure tests over the evidence content normalizer + hasher. These are
  the dedup invariants — if normalization silently changes the bytes
  of a valid paste, we'd stop deduping real duplicates.
*/

describe("normalizeEvidenceText", () => {
  it("strips the UTF-8 BOM", () => {
    expect(normalizeEvidenceText("\uFEFFhello")).toBe("hello\n");
  });

  it("normalizes CRLF + CR to LF", () => {
    expect(normalizeEvidenceText("line1\r\nline2\rline3")).toBe(
      "line1\nline2\nline3\n",
    );
  });

  it("trims trailing whitespace on every line", () => {
    expect(normalizeEvidenceText("a   \nb\t\n")).toBe("a\nb\n");
  });

  it("collapses repeated trailing newlines to exactly one", () => {
    expect(normalizeEvidenceText("hello\n\n\n\n")).toBe("hello\n");
  });
});

describe("hashEvidenceContent", () => {
  it("returns a 64-char hex SHA-256", () => {
    const h = hashEvidenceContent("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for cosmetically different inputs (the point of normalize)", () => {
    const a = "Alice: onboarding is confusing\n";
    const b = "\uFEFFAlice: onboarding is confusing\r\n   \n\n";
    expect(hashEvidenceContent(a)).toBe(hashEvidenceContent(b));
  });

  it("returns different hashes for semantically different content", () => {
    expect(hashEvidenceContent("a")).not.toBe(hashEvidenceContent("b"));
  });
});
