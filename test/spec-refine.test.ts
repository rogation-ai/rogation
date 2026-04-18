import { describe, expect, it } from "vitest";
import { specRefine } from "@/lib/llm/prompts/spec-refine";

/*
  Coverage for the spec-refine prompt's build() + parse().

  build() invariants:
    - currentSpec is wrapped in a single <currentSpec> CDATA block.
    - history is wrapped in <history> with one <message role> per turn.
    - userMessage is the post-boundary tail (the fresh chunk).
    - cacheBoundary is set so prior turns cache-hit across refine calls.

  parse() invariants:
    - Rejects missing assistantMessage / missing spec.
    - Accepts a valid spec + string message.
    - Uses the shared validator so story/criterion cross-refs are
      enforced identically to spec-generate.
*/

const BASE_SPEC = {
  title: "Filter by segment",
  summary: "PMs narrow a run to one segment.",
  userStories: [
    { id: "US1", persona: "PM", goal: "filter", value: "mobile clarity" },
  ],
  acceptanceCriteria: [
    {
      storyId: "US1",
      given: "tagged evidence",
      when: "I pick Mobile",
      then: "I see mobile clusters only",
    },
  ],
  nonFunctional: [
    { category: "performance" as const, requirement: "< 300ms" },
  ],
  edgeCases: [
    { scenario: "no matches", expectedBehavior: "empty state" },
    { scenario: "untagged", expectedBehavior: "Unspecified bucket" },
    { scenario: "mid-run change", expectedBehavior: "queue one re-run" },
  ],
  qaChecklist: [{ check: "persists reload" }],
  citations: [
    {
      clusterId: "00000000-0000-0000-0000-000000000001",
      note: "top hit",
    },
  ],
};

describe("specRefine.build", () => {
  it("wraps currentSpec + history + userMessage in their own tags", () => {
    const { user } = specRefine.build({
      currentSpec: BASE_SPEC,
      history: [
        { role: "user", content: "first turn" },
        { role: "assistant", content: "first reply" },
      ],
      userMessage: "tighten US1's AC",
    });
    expect(user).toContain("<currentSpec>");
    expect(user).toContain("<history>");
    expect(user).toContain('role="user"');
    expect(user).toContain('role="assistant"');
    expect(user).toContain("<userMessage>");
    expect(user).toContain("tighten US1's AC");
  });

  it("escapes XML metacharacters inside CDATA content", () => {
    // CDATA should not need escaping — verify metacharacters pass
    // through intact so the model sees them as data.
    const { user } = specRefine.build({
      currentSpec: BASE_SPEC,
      history: [],
      userMessage: "change <foo> to <bar> with & sign",
    });
    expect(user).toContain("<foo>");
    expect(user).toContain("& sign");
  });

  it("cacheBoundary points at the end of the stable section", () => {
    const { user, cacheBoundary } = specRefine.build({
      currentSpec: BASE_SPEC,
      history: [{ role: "user", content: "prior" }],
      userMessage: "NEW",
    });
    expect(cacheBoundary).toBeLessThan(user.length);
    // Everything after the boundary should include the fresh user
    // message; everything before should not.
    const post = user.slice(cacheBoundary!);
    const pre = user.slice(0, cacheBoundary!);
    expect(post).toContain("NEW");
    expect(pre).not.toContain("NEW");
  });
});

describe("specRefine.parse", () => {
  const validResponse = {
    assistantMessage: "Tightened US1's acceptance criterion.",
    spec: {
      ...BASE_SPEC,
      acceptanceCriteria: [
        {
          storyId: "US1",
          given: "I have at least one mobile-tagged piece of evidence",
          when: "I select Mobile from the segment filter",
          then: "only mobile-derived clusters render",
        },
      ],
    },
  };

  it("accepts a valid refinement response", () => {
    const out = specRefine.parse(JSON.stringify(validResponse));
    expect(out.assistantMessage).toContain("Tightened");
    expect(out.spec.acceptanceCriteria[0]?.given).toContain("mobile-tagged");
  });

  it("tolerates a markdown fence", () => {
    const fenced = "```json\n" + JSON.stringify(validResponse) + "\n```";
    const out = specRefine.parse(fenced);
    expect(out.spec.title).toBe("Filter by segment");
  });

  it("rejects missing assistantMessage", () => {
    const bad = structuredClone(validResponse) as Record<string, unknown>;
    delete bad.assistantMessage;
    expect(() => specRefine.parse(JSON.stringify(bad))).toThrowError(
      /assistantMessage/,
    );
  });

  it("rejects missing spec", () => {
    const bad = structuredClone(validResponse) as Record<string, unknown>;
    delete bad.spec;
    expect(() => specRefine.parse(JSON.stringify(bad))).toThrowError(
      /spec object/,
    );
  });

  it("rejects criterion referencing unknown storyId (shared validator)", () => {
    const bad = structuredClone(validResponse);
    bad.spec.acceptanceCriteria[0]!.storyId = "US_GHOST";
    expect(() => specRefine.parse(JSON.stringify(bad))).toThrowError(
      /unknown storyId/,
    );
  });

  it("rejects a story with no acceptance criteria (shared validator)", () => {
    const bad = structuredClone(validResponse);
    bad.spec.userStories.push({
      id: "US2",
      persona: "PM",
      goal: "g",
      value: "v",
    });
    // No criterion for US2.
    expect(() => specRefine.parse(JSON.stringify(bad))).toThrowError(
      /no acceptance criteria/,
    );
  });
});
