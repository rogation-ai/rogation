import { describe, expect, it } from "vitest";
import { specGenerate } from "@/lib/llm/prompts/spec-generate";

/*
  Coverage for the spec-generate prompt's build() + parse(). No live LLM.

  build() invariants:
  - opportunity + every cluster is wrapped in its own tag.
  - cluster id + label get attribute-escaped (CDATA handles content).
  - cacheBoundary points at the end of the user message.

  parse() invariants:
  - Accepts a valid JSON envelope (fenced or raw).
  - Validates story/criterion cross-references. This runs before we
    write to the DB, so it's the last line of defense against a spec
    whose acceptanceCriteria reference a storyId that doesn't exist.
  - Rejects empty userStories + empty acceptanceCriteria.
  - Fills qaChecklist.status with "untested" when the LLM omits it.
*/

const VALID_SPEC = {
  spec: {
    title: "Filter by segment",
    summary: "Let PMs narrow a run to one segment.",
    userStories: [
      { id: "US1", persona: "PM", goal: "filter by segment", value: "clear signal" },
      { id: "US2", persona: "PM", goal: "share results", value: "team alignment" },
    ],
    acceptanceCriteria: [
      { storyId: "US1", given: "tagged evidence", when: "I pick Mobile", then: "I see mobile clusters only" },
      { storyId: "US2", given: "a filter is active", when: "I export", then: "file matches the filter" },
    ],
    nonFunctional: [
      { category: "performance", requirement: "< 300ms" },
      { category: "reliability", requirement: "survives reload" },
    ],
    edgeCases: [
      { scenario: "no matches", expectedBehavior: "empty state" },
      { scenario: "untagged", expectedBehavior: "Unspecified bucket" },
      { scenario: "mid-run change", expectedBehavior: "queue one re-run" },
    ],
    qaChecklist: [{ check: "persists reload" }, { check: "empty-state copy" }],
    citations: [
      { clusterId: "00000000-0000-0000-0000-000000000001", note: "top hit" },
    ],
  },
};

describe("specGenerate.build", () => {
  it("wraps opportunity + every cluster in its own tag", () => {
    const { user } = specGenerate.build({
      opportunity: {
        title: "opp",
        description: "d",
        reasoning: "r",
        effort: "M",
        impact: { retention: 0.5 },
      },
      clusters: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          label: "C1",
          title: "t1",
          description: "d1",
          severity: "high",
          frequency: 3,
          quotes: ["q1", "q2"],
        },
        {
          id: "00000000-0000-0000-0000-000000000002",
          label: "C2",
          title: "t2",
          description: "d2",
          severity: "low",
          frequency: 1,
          quotes: [],
        },
      ],
    });
    expect(user).toContain("<opportunity>");
    expect(user.match(/<cluster /g)?.length).toBe(2);
    expect(user).toContain('label="C1"');
    expect(user).toContain('label="C2"');
    expect(user).toContain('severity="high"');
  });

  it("escapes XML metacharacters in cluster attributes", () => {
    const { user } = specGenerate.build({
      opportunity: {
        title: "t",
        description: "d",
        reasoning: "r",
        effort: "S",
        impact: {},
      },
      clusters: [
        {
          id: `has"&<>`,
          label: `C"&<>`,
          title: "t",
          description: "d",
          severity: "low",
          frequency: 0,
          quotes: [],
        },
      ],
    });
    expect(user).toContain('id="has&quot;&amp;&lt;&gt;"');
    expect(user).toContain('label="C&quot;&amp;&lt;&gt;"');
  });

  it("sets cacheBoundary to end of user message", () => {
    const { user, cacheBoundary } = specGenerate.build({
      opportunity: {
        title: "t",
        description: "d",
        reasoning: "r",
        effort: "M",
        impact: {},
      },
      clusters: [
        {
          id: "x",
          label: "C1",
          title: "t",
          description: "d",
          severity: "low",
          frequency: 0,
          quotes: [],
        },
      ],
    });
    expect(cacheBoundary).toEqual([user.length]);
  });
});

describe("specGenerate.parse", () => {
  it("accepts a well-formed response", () => {
    const out = specGenerate.parse(JSON.stringify(VALID_SPEC));
    expect(out.spec.userStories).toHaveLength(2);
    expect(out.spec.acceptanceCriteria).toHaveLength(2);
    expect(out.spec.qaChecklist[0]?.status).toBe("untested");
  });

  it("tolerates a markdown fence", () => {
    const fenced = "```json\n" + JSON.stringify(VALID_SPEC) + "\n```";
    const out = specGenerate.parse(fenced);
    expect(out.spec.title).toBe("Filter by segment");
  });

  it("rejects criterion referencing unknown storyId", () => {
    const bad = structuredClone(VALID_SPEC);
    bad.spec.acceptanceCriteria[0]!.storyId = "US_GHOST";
    expect(() => specGenerate.parse(JSON.stringify(bad))).toThrowError(
      /unknown storyId/,
    );
  });

  it("rejects a story with no acceptance criteria", () => {
    const bad = structuredClone(VALID_SPEC);
    // Remove the US1 criterion so US1 is orphaned.
    bad.spec.acceptanceCriteria = bad.spec.acceptanceCriteria.filter(
      (ac) => ac.storyId !== "US1",
    );
    expect(() => specGenerate.parse(JSON.stringify(bad))).toThrowError(
      /no acceptance criteria/,
    );
  });

  it("rejects empty userStories", () => {
    const bad = structuredClone(VALID_SPEC);
    bad.spec.userStories = [];
    expect(() => specGenerate.parse(JSON.stringify(bad))).toThrowError(
      /userStories/,
    );
  });

  it("rejects a bad nonFunctional.category", () => {
    const bad = structuredClone(VALID_SPEC);
    bad.spec.nonFunctional[0]!.category = "vibes" as typeof bad.spec.nonFunctional[0]["category"];
    expect(() => specGenerate.parse(JSON.stringify(bad))).toThrowError(
      /category/i,
    );
  });
});
