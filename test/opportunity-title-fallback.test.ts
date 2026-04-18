import { describe, expect, it } from "vitest";
import { resolveByTitle } from "@/lib/evidence/opportunities";

/*
  Regression: Sonnet 4.6 occasionally returns cluster TITLES in
  `clusterLabels` instead of the "C1"/"C2" labels the prompt asked
  for. Before the fix, any such run crashed with
  `opportunity-score returned unknown cluster label "..."` and no
  opportunities got persisted — wasting the full Sonnet call.

  The orchestrator now uses resolveByTitle() as a secondary match +
  rewrites titles back to canonical C-labels.

  Found by /qa on 2026-04-18.
  Report: .gstack/qa-reports/qa-report-rogation-2026-04-18.md
*/

const labeled = [
  { label: "C1", title: "Onboarding fails to guide new users to first value", id: "uuid-1" },
  { label: "C2", title: "Share links expire silently, breaking embedded content", id: "uuid-2" },
  { label: "C3", title: "Mobile and tablet performance is unusably slow", id: "uuid-3" },
];

const titleToClusterId = new Map(
  labeled.map((c) => [c.title.toLowerCase().trim(), c.id]),
);

describe("resolveByTitle", () => {
  it("exact title → canonical label", () => {
    expect(
      resolveByTitle(
        "Onboarding fails to guide new users to first value",
        labeled,
        titleToClusterId,
      ),
    ).toBe("C1");
  });

  it("case-insensitive match", () => {
    expect(
      resolveByTitle(
        "SHARE LINKS EXPIRE SILENTLY, BREAKING EMBEDDED CONTENT",
        labeled,
        titleToClusterId,
      ),
    ).toBe("C2");
  });

  it("trims whitespace", () => {
    expect(
      resolveByTitle(
        "  Mobile and tablet performance is unusably slow  ",
        labeled,
        titleToClusterId,
      ),
    ).toBe("C3");
  });

  it("no match → null", () => {
    expect(
      resolveByTitle("a completely unrelated title", labeled, titleToClusterId),
    ).toBeNull();
  });

  it("empty string → null", () => {
    expect(resolveByTitle("", labeled, titleToClusterId)).toBeNull();
  });
});
