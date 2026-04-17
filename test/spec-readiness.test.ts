import { describe, expect, it } from "vitest";
import { gradeSpec } from "@/lib/spec/readiness";
import type { SpecIR } from "@/lib/spec/ir";

/*
  Coverage for the deterministic readiness grader.

  The rule set from design review Pass 7:
    4/4 checks → A
    3/4 → B
    2/4 → C
    ≤1 → D
  Checks:
    edgesCovered:           edgeCases.length >= 3
    validationSpecified:    every userStory has >= 1 acceptanceCriterion
    nonFunctionalAddressed: nonFunctional.length >= 1
    acceptanceTestable:     every criterion has non-empty g/w/t

  A regression here changes a PM-visible grade. That's worse than a
  failed build — it silently degrades trust in the stoplight.
*/

function base(overrides: Partial<SpecIR> = {}): SpecIR {
  return {
    title: "t",
    summary: "s",
    userStories: [
      { id: "US1", persona: "PM", goal: "X", value: "Y" },
    ],
    acceptanceCriteria: [
      { storyId: "US1", given: "g", when: "w", then: "t" },
    ],
    nonFunctional: [
      { category: "performance", requirement: "p95 < 1s" },
    ],
    edgeCases: [
      { scenario: "empty", expectedBehavior: "empty state" },
      { scenario: "offline", expectedBehavior: "retry" },
      { scenario: "concurrent", expectedBehavior: "last write wins" },
    ],
    qaChecklist: [{ check: "x" }],
    citations: [],
    ...overrides,
  };
}

describe("gradeSpec", () => {
  it("grades A when all four checks pass", () => {
    const result = gradeSpec(base());
    expect(result.grade).toBe("A");
    expect(result.passed).toBe(4);
    expect(result.checklist).toEqual({
      edgesCovered: true,
      validationSpecified: true,
      nonFunctionalAddressed: true,
      acceptanceTestable: true,
    });
  });

  it("grades B when exactly one check fails", () => {
    // nonFunctional removed → 3/4.
    const result = gradeSpec(base({ nonFunctional: [] }));
    expect(result.grade).toBe("B");
    expect(result.passed).toBe(3);
    expect(result.checklist.nonFunctionalAddressed).toBe(false);
  });

  it("grades C when two checks fail", () => {
    const result = gradeSpec(
      base({
        nonFunctional: [],
        edgeCases: [
          { scenario: "only one", expectedBehavior: "shrug" },
        ],
      }),
    );
    expect(result.grade).toBe("C");
    expect(result.passed).toBe(2);
  });

  it("grades D when three or four checks fail", () => {
    const three = gradeSpec(
      base({
        nonFunctional: [],
        edgeCases: [],
        acceptanceCriteria: [
          // Still testable for the one story.
          { storyId: "US1", given: "g", when: "w", then: "t" },
        ],
        userStories: [
          { id: "US1", persona: "PM", goal: "X", value: "Y" },
          { id: "US2", persona: "PM", goal: "A", value: "B" }, // no criterion
        ],
      }),
    );
    expect(three.grade).toBe("D");
    expect(three.passed).toBeLessThanOrEqual(1);
  });

  it("fails acceptanceTestable when a criterion has a blank field", () => {
    const result = gradeSpec(
      base({
        acceptanceCriteria: [
          { storyId: "US1", given: "g", when: "", then: "t" },
        ],
      }),
    );
    expect(result.checklist.acceptanceTestable).toBe(false);
  });

  it("fails validationSpecified when any story has no criterion", () => {
    const result = gradeSpec(
      base({
        userStories: [
          { id: "US1", persona: "PM", goal: "X", value: "Y" },
          { id: "US2", persona: "PM", goal: "A", value: "B" },
        ],
        acceptanceCriteria: [
          { storyId: "US1", given: "g", when: "w", then: "t" },
        ],
      }),
    );
    expect(result.checklist.validationSpecified).toBe(false);
  });

  it("fails edgesCovered on exactly two edge cases (threshold is 3)", () => {
    const result = gradeSpec(
      base({
        edgeCases: [
          { scenario: "a", expectedBehavior: "x" },
          { scenario: "b", expectedBehavior: "y" },
        ],
      }),
    );
    expect(result.checklist.edgesCovered).toBe(false);
  });
});
