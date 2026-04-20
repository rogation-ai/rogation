import { describe, expect, it } from "vitest";
import { splitIntoBlocks, MAX_BLOCKS } from "@/lib/evidence/split-blocks";

describe("splitIntoBlocks", () => {
  it("returns empty for empty or whitespace-only input", () => {
    expect(splitIntoBlocks("")).toEqual([]);
    expect(splitIntoBlocks("   \n\n\t\n   ")).toEqual([]);
  });

  it("returns one block when the input has no blank-line separator", () => {
    const out = splitIntoBlocks("line 1\nline 2\nline 3");
    expect(out).toEqual([{ index: 1, text: "line 1\nline 2\nline 3" }]);
  });

  it("splits on a single blank line", () => {
    const input = "ticket one\n\nticket two\n\nticket three";
    const out = splitIntoBlocks(input);
    expect(out).toEqual([
      { index: 1, text: "ticket one" },
      { index: 2, text: "ticket two" },
      { index: 3, text: "ticket three" },
    ]);
  });

  it("splits on multiple blank lines and whitespace-only lines", () => {
    const input = "alpha\n\n\nbeta\n \t\n\ngamma";
    const out = splitIntoBlocks(input);
    expect(out.map((b) => b.text)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps single newlines inside a block intact (speaker turns)", () => {
    const input =
      "Alice: I couldn't find the export button.\nBob: Yeah, same here.\n\nCharlie: I gave up.";
    const out = splitIntoBlocks(input);
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toContain("Alice:");
    expect(out[0]?.text).toContain("Bob:");
    expect(out[1]?.text).toContain("Charlie:");
  });

  it("trims whitespace off each block", () => {
    const out = splitIntoBlocks("   leading spaces   \n\n\ttabbed\t");
    expect(out.map((b) => b.text)).toEqual(["leading spaces", "tabbed"]);
  });

  it("drops empty blocks", () => {
    const out = splitIntoBlocks("one\n\n\n\ntwo");
    expect(out).toHaveLength(2);
  });

  it("indexes blocks 1-indexed", () => {
    const out = splitIntoBlocks("a\n\nb\n\nc");
    expect(out.map((b) => b.index)).toEqual([1, 2, 3]);
  });

  it("caps at MAX_BLOCKS", () => {
    const parts = Array.from({ length: MAX_BLOCKS + 50 }, (_, i) => `p${i}`);
    const out = splitIntoBlocks(parts.join("\n\n"));
    expect(out).toHaveLength(MAX_BLOCKS);
    expect(out[MAX_BLOCKS - 1]?.index).toBe(MAX_BLOCKS);
  });
});
