import type { SpecIR } from "@/lib/spec/ir";

/*
  Readiness grade — deterministic, pure, unit-tested.

  Design review Pass 7 locked in this checklist-of-four formula. The
  grade is a stoplight the PM trusts: if the LLM says "A" the PM can
  hand this spec to eng without the "where are the edge cases?" ping.

  The LLM is never asked to grade itself. The prompt produces the IR;
  the IR runs through this function. Same input → same grade, forever.
  That property is what lets us eval prompt regressions meaningfully.

  Scale:
    4/4 checks pass → A
    3/4           → B
    2/4           → C
    0-1/4         → D

  Checks:
    edgesCovered:           >= 3 edge cases
    validationSpecified:    every userStory has >= 1 acceptance criterion
    nonFunctionalAddressed: >= 1 non-functional requirement
    acceptanceTestable:     every acceptance criterion has non-empty
                            given / when / then
*/

export type ReadinessGrade = "A" | "B" | "C" | "D";

export interface ReadinessChecklist {
  edgesCovered: boolean;
  validationSpecified: boolean;
  nonFunctionalAddressed: boolean;
  acceptanceTestable: boolean;
}

export interface ReadinessResult {
  grade: ReadinessGrade;
  checklist: ReadinessChecklist;
  /** Passing checks, 0-4. */
  passed: number;
}

const MIN_EDGE_CASES = 3;

export function gradeSpec(spec: SpecIR): ReadinessResult {
  const checklist: ReadinessChecklist = {
    edgesCovered: spec.edgeCases.length >= MIN_EDGE_CASES,
    validationSpecified: everyStoryHasCriterion(spec),
    nonFunctionalAddressed: spec.nonFunctional.length >= 1,
    acceptanceTestable: everyCriterionTestable(spec),
  };

  const passed = Object.values(checklist).filter(Boolean).length;
  const grade: ReadinessGrade =
    passed === 4 ? "A" : passed === 3 ? "B" : passed === 2 ? "C" : "D";

  return { grade, checklist, passed };
}

function everyStoryHasCriterion(spec: SpecIR): boolean {
  if (spec.userStories.length === 0) return false;
  const criteriaStoryIds = new Set(
    spec.acceptanceCriteria.map((ac) => ac.storyId),
  );
  return spec.userStories.every((us) => criteriaStoryIds.has(us.id));
}

function everyCriterionTestable(spec: SpecIR): boolean {
  if (spec.acceptanceCriteria.length === 0) return false;
  return spec.acceptanceCriteria.every(
    (ac) =>
      ac.given.trim().length > 0 &&
      ac.when.trim().length > 0 &&
      ac.then.trim().length > 0,
  );
}
