import { describe, expect, it } from "vitest";
import { renderSpecMarkdown } from "@/lib/spec/renderers/markdown";
import type { SpecIR } from "@/lib/spec/ir";

/*
  The markdown renderer is the only format that ships today (Linear +
  Notion land with the export commit). Tests lock down the shape so
  future edits don't silently reflow the download file PMs paste into
  Linear/Notion/Google Docs.
*/

const FULL: SpecIR = {
  title: "Filter evidence by segment",
  summary:
    "Let PMs narrow a synthesis run to a specific customer segment so mobile-only pain points cluster separately from desktop ones.",
  userStories: [
    {
      id: "US1",
      persona: "PM",
      goal: "filter evidence by segment",
      value: "I can tell mobile and desktop pain apart",
    },
    {
      id: "US2",
      persona: "owner at a 50-person SaaS",
      goal: "export a filtered cluster set",
      value: "I can share one segment's pain with a single team",
    },
  ],
  acceptanceCriteria: [
    {
      storyId: "US1",
      given: "I have evidence tagged `mobile` and `desktop`",
      when: "I select Mobile from the segment filter",
      then: "clusters derive only from Mobile-tagged evidence",
    },
    {
      storyId: "US2",
      given: "a filter is active",
      when: "I click Export",
      then: "the exported file matches the current filter",
    },
  ],
  nonFunctional: [
    { category: "performance", requirement: "Filter applies in < 300ms." },
    { category: "reliability", requirement: "Filter survives reload." },
  ],
  edgeCases: [
    {
      scenario: "No evidence matches the filter.",
      expectedBehavior: "Show an empty-state and preserve prior filter state.",
    },
    {
      scenario: "Evidence is untagged.",
      expectedBehavior: "Treat as its own 'Unspecified' segment.",
    },
    {
      scenario: "Filter changes mid-run.",
      expectedBehavior: "Queue a single re-cluster; drop intermediates.",
    },
  ],
  qaChecklist: [
    { check: "Confirm filter persists across reloads." },
    { check: "Confirm empty-state copy renders correctly.", status: "passed" },
  ],
  citations: [
    {
      clusterId: "c-7f1c3b0e",
      note: "Mobile users repeatedly report slow search on 5-rowed dashboards.",
    },
  ],
};

describe("renderSpecMarkdown", () => {
  it("renders a stable document with all sections in order", () => {
    const md = renderSpecMarkdown(FULL);

    // Title + summary quote.
    expect(md.startsWith("# Filter evidence by segment")).toBe(true);
    expect(md).toContain("> Let PMs narrow");

    // Story list uses the "As a ..." article rule.
    expect(md).toContain("**US1** — As a PM, I want filter evidence by segment");
    // US2 persona already starts with "owner", picks article "an".
    expect(md).toContain("**US2** — As an owner at a 50-person SaaS");

    // Criteria are grouped per storyId, in story order.
    const us1Idx = md.indexOf("### US1");
    const us2Idx = md.indexOf("### US2");
    expect(us1Idx).toBeGreaterThan(0);
    expect(us2Idx).toBeGreaterThan(us1Idx);

    // Given/When/Then are all present with bold labels.
    expect(md).toContain("**Given** I have evidence tagged");
    expect(md).toContain("**When** I select Mobile");
    expect(md).toContain("**Then** clusters derive only from Mobile-tagged");

    // Non-functional title-cases the category.
    expect(md).toContain("- **Performance:** Filter applies");
    expect(md).toContain("- **Reliability:** Filter survives");

    // QA: untested stays empty box, passed gets [x].
    expect(md).toContain("- [ ] Confirm filter persists");
    expect(md).toContain("- [x] Confirm empty-state copy");

    // Citations render the cluster id verbatim in backticks.
    expect(md).toContain("`c-7f1c3b0e`: Mobile users repeatedly report");
  });

  it("is deterministic — same IR -> identical output", () => {
    const a = renderSpecMarkdown(FULL);
    const b = renderSpecMarkdown(FULL);
    expect(a).toBe(b);
  });

  it("skips optional sections when empty but keeps required ones", () => {
    const minimal: SpecIR = {
      title: "Minimal",
      summary: "s",
      userStories: [{ id: "US1", persona: "PM", goal: "g", value: "v" }],
      acceptanceCriteria: [
        { storyId: "US1", given: "g", when: "w", then: "t" },
      ],
      nonFunctional: [],
      edgeCases: [],
      qaChecklist: [],
      citations: [],
    };
    const md = renderSpecMarkdown(minimal);
    expect(md).toContain("# Minimal");
    expect(md).toContain("## User Stories");
    expect(md).toContain("## Acceptance Criteria");
    expect(md).not.toContain("## Non-Functional Requirements");
    expect(md).not.toContain("## Edge Cases");
    expect(md).not.toContain("## QA Checklist");
    expect(md).not.toContain("## Citations");
  });

  it("leaves already-articled personas alone", () => {
    const md = renderSpecMarkdown({
      ...FULL,
      userStories: [
        { id: "US1", persona: "a senior PM", goal: "g", value: "v" },
      ],
      acceptanceCriteria: [
        { storyId: "US1", given: "g", when: "w", then: "t" },
      ],
    });
    // Should read "As a senior PM", not "As a a senior PM".
    expect(md).toContain("As a senior PM");
    expect(md).not.toContain("As a a senior PM");
  });
});
