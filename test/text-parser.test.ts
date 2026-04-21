import { describe, expect, it } from "vitest";
import { parseTextFile } from "@/lib/evidence/parsers/text";

/*
  Pure tests over the text file parser. The parser is the gate
  between "browser gave me a File" and "ingest pipeline has a
  string" — if it's loose, binary files leak into the embed step
  and waste tokens on garbage.
*/

function makeFile(
  name: string,
  contents: string,
  type?: string,
  size?: number,
): File {
  const blob = new Blob([contents], { type: type ?? "" });
  // Jsdom + node don't always respect Blob size against synthetic
  // content; the File constructor lets us override.
  const file = new File([blob], name, { type });
  if (typeof size === "number") {
    Object.defineProperty(file, "size", { value: size });
  }
  return file;
}

describe("parseTextFile", () => {
  it("accepts a .txt file with text/plain mime", async () => {
    const file = makeFile("alice.txt", "interview content", "text/plain");
    const r = await parseTextFile(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("interview content");
  });

  it("accepts by extension even when mime is missing", async () => {
    const file = makeFile("notes.md", "# heading", "");
    const r = await parseTextFile(file);
    expect(r.ok).toBe(true);
  });

  it("rejects binary types (application/pdf, image/*, etc.)", async () => {
    const file = makeFile("deck.pdf", "%PDF...", "application/pdf");
    const r = await parseTextFile(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported");
  });

  it("rejects files larger than 2 MB", async () => {
    const file = makeFile(
      "huge.txt",
      "x",
      "text/plain",
      3 * 1024 * 1024, // 3 MB reported size
    );
    const r = await parseTextFile(file);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("too_large");
      expect(r.detail).toContain("MB");
    }
  });

  it("handles UTF-8 content with multi-byte characters", async () => {
    const file = makeFile("emoji.txt", "👋 héllo", "text/plain");
    const r = await parseTextFile(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("👋 héllo");
  });

  it("accepts JSON / YAML by extension", async () => {
    // CSV moved to its own parser (lib/evidence/parsers/csv.ts) so
    // rows can be reformatted Key: value style. parseTextFile now
    // handles only genuine plain-text formats.
    for (const name of ["events.json", "config.yaml"]) {
      const r = await parseTextFile(makeFile(name, "x", ""));
      expect(r.ok, `${name} should parse`).toBe(true);
    }
  });

  it("rejects .csv — that's the CSV parser's job now", async () => {
    const r = await parseTextFile(makeFile("data.csv", "a,b", ""));
    expect(r.ok).toBe(false);
  });
});
