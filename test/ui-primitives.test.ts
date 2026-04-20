import { describe, expect, it } from "vitest";
import { bandFor, bandPct } from "@/components/ui/PlanMeter";
import { bandForConfidence } from "@/components/ui/ConfidenceBadge";
import { sourceLabel, type SourceType } from "@/components/ui/SourceIcon";
import { truncateSegment } from "@/components/ui/SegmentTag";

/*
  Pure-logic tests for the shared UI primitives. Visual regression
  (screenshot diffing) belongs in Storybook's test-runner, not here —
  but the math that drives color bands + percentage calculations needs
  unit coverage so the "is this calm / warn / danger?" decision tree
  never drifts.
*/

describe("PlanMeter.bandPct", () => {
  it.each([
    [0, 10, 0],
    [5, 10, 50],
    [8, 10, 80],
    [10, 10, 100],
    [12, 10, 120],
  ])("%i / %i -> %i%%", (current, max, expected) => {
    expect(bandPct(current, max)).toBe(expected);
  });

  it("returns 0 when max is 0 (guards div-by-zero)", () => {
    expect(bandPct(0, 0)).toBe(0);
    expect(bandPct(5, 0)).toBe(0);
  });
});

describe("PlanMeter.bandFor", () => {
  it("0-59% = calm (tertiary bar)", () => {
    const b = bandFor(30);
    expect(b.barColor).toBe("var(--color-text-tertiary)");
  });

  it("60-79% = noticed (secondary)", () => {
    const b = bandFor(70);
    expect(b.barColor).toBe("var(--color-text-secondary)");
  });

  it("80-99% = warning (soft cap)", () => {
    const b = bandFor(85);
    expect(b.barColor).toBe("var(--color-warning)");
  });

  it(">=100% = danger", () => {
    const b = bandFor(100);
    expect(b.barColor).toBe("var(--color-danger)");
    const over = bandFor(120);
    expect(over.barColor).toBe("var(--color-danger)");
  });
});

describe("ConfidenceBadge.bandForConfidence", () => {
  it("< 0.45 = Low (tertiary)", () => {
    expect(bandForConfidence(0).label).toBe("Low");
    expect(bandForConfidence(0.44).label).toBe("Low");
  });

  it("0.45 - 0.74 = Medium (warning)", () => {
    expect(bandForConfidence(0.45).label).toBe("Medium");
    expect(bandForConfidence(0.74).label).toBe("Medium");
  });

  it(">= 0.75 = High (success)", () => {
    expect(bandForConfidence(0.75).label).toBe("High");
    expect(bandForConfidence(1).label).toBe("High");
  });

  it("clamps out-of-range scores to [0, 1]", () => {
    expect(bandForConfidence(-0.5).label).toBe("Low");
    expect(bandForConfidence(1.5).label).toBe("High");
  });
});

describe("SourceIcon.sourceLabel", () => {
  it.each<[SourceType, string]>([
    ["upload_transcript", "Transcript"],
    ["upload_text", "Text"],
    ["upload_pdf", "PDF"],
    ["upload_csv", "CSV"],
    ["paste_ticket", "Pasted ticket"],
    ["zendesk", "Zendesk"],
    ["posthog", "PostHog"],
    ["canny", "Canny"],
  ])("%s -> %s", (source, expected) => {
    expect(sourceLabel(source)).toBe(expected);
  });
});

describe("SegmentTag.truncateSegment", () => {
  it("returns short names unchanged", () => {
    expect(truncateSegment("enterprise")).toBe("enterprise");
  });

  it("truncates names longer than max with an ellipsis", () => {
    // Default max = 24; 25 chars should truncate to 23 + "…"
    const long = "enterprise-customers-north-america";
    const out = truncateSegment(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(24);
  });

  it("respects a custom max", () => {
    expect(truncateSegment("mobile-users", 6)).toBe("mobil…");
  });

  it("leaves names exactly at max untouched", () => {
    const exact = "x".repeat(24);
    expect(truncateSegment(exact)).toBe(exact);
  });
});
