import { describe, expect, it } from "vitest";
import { buildUserContent } from "@/lib/llm/router";

/*
  Regression: Anthropic rejects empty text blocks with
  `400 invalid_request_error — messages: text content blocks must be
  non-empty`. The original router always emitted TWO blocks when cache
  + cacheBoundary were set, so a prompt whose entire user message is
  stable (boundary === user.length) crashed at the provider.

  Three of four v1 prompts hit this case:
    - synthesis-cluster  (cacheBoundary: user.length)
    - opportunity-score  (cacheBoundary: user.length)
    - spec-generate      (cacheBoundary: user.length)

  Found by /qa on 2026-04-18 when clicking "Generate clusters" after
  the sample-data seed. Report: .gstack/qa-reports/qa-report-rogation-2026-04-18.md
*/

describe("buildUserContent", () => {
  const msg = "abcdefghij"; // len 10

  it("no cache → plain string", () => {
    expect(buildUserContent(msg, 5, false)).toBe(msg);
    expect(buildUserContent(msg, undefined, true)).toBe(msg);
  });

  it("boundary strictly inside → two text blocks, prefix cached", () => {
    const blocks = buildUserContent(msg, 6, true);
    expect(blocks).toEqual([
      {
        type: "text",
        text: "abcdef",
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "ghij" },
    ]);
  });

  it("boundary === user.length → ONE block (the bug)", () => {
    // The fix: don't emit a trailing empty text block.
    const blocks = buildUserContent(msg, msg.length, true);
    expect(blocks).toEqual([
      {
        type: "text",
        text: msg,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("boundary past user.length → clamped, one block", () => {
    const blocks = buildUserContent(msg, 9999, true);
    expect(blocks).toEqual([
      {
        type: "text",
        text: msg,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("boundary 0 → no empty cache prefix; plain string", () => {
    // Caching an empty prefix is not useful; fall back to plain string.
    expect(buildUserContent(msg, 0, true)).toBe(msg);
  });

  it("negative boundary → clamped to 0, plain string", () => {
    expect(buildUserContent(msg, -5, true)).toBe(msg);
  });
});
