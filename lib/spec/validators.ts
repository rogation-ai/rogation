import type { SpecIR } from "@/lib/spec/ir";

/*
  Shared SpecIR parsers used by every prompt that emits a SpecIR
  (spec-generate, spec-refine, future: spec-branch, spec-merge).

  One source of truth for the validation shape keeps these in lockstep
  — a refinement can never produce a spec generation wouldn't accept.
*/

export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return JSON.parse(fenceMatch?.[1]?.trim() ?? trimmed);
}

export function asString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${path}: expected non-empty string`);
  }
  return v;
}

export function asUserStories(v: unknown): SpecIR["userStories"] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("spec.userStories: expected non-empty array");
  }
  return v.map((us, i) => {
    if (!us || typeof us !== "object") {
      throw new Error(`spec.userStories[${i}]: not an object`);
    }
    const o = us as Record<string, unknown>;
    return {
      id: asString(o.id, `spec.userStories[${i}].id`),
      persona: asString(o.persona, `spec.userStories[${i}].persona`),
      goal: asString(o.goal, `spec.userStories[${i}].goal`),
      value: asString(o.value, `spec.userStories[${i}].value`),
    };
  });
}

export function asAcceptance(v: unknown): SpecIR["acceptanceCriteria"] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("spec.acceptanceCriteria: expected non-empty array");
  }
  return v.map((ac, i) => {
    if (!ac || typeof ac !== "object") {
      throw new Error(`spec.acceptanceCriteria[${i}]: not an object`);
    }
    const o = ac as Record<string, unknown>;
    return {
      storyId: asString(o.storyId, `spec.acceptanceCriteria[${i}].storyId`),
      given: asString(o.given, `spec.acceptanceCriteria[${i}].given`),
      when: asString(o.when, `spec.acceptanceCriteria[${i}].when`),
      then: asString(o.then, `spec.acceptanceCriteria[${i}].then`),
    };
  });
}

const NF_CATEGORIES = [
  "performance",
  "security",
  "accessibility",
  "reliability",
] as const;

export function asNonFunctional(v: unknown): SpecIR["nonFunctional"] {
  if (!Array.isArray(v)) return [];
  return v.map((nf, i) => {
    if (!nf || typeof nf !== "object") {
      throw new Error(`spec.nonFunctional[${i}]: not an object`);
    }
    const o = nf as Record<string, unknown>;
    const category = o.category;
    if (
      typeof category !== "string" ||
      !(NF_CATEGORIES as readonly string[]).includes(category)
    ) {
      throw new Error(
        `spec.nonFunctional[${i}].category: expected one of ${NF_CATEGORIES.join(
          " / ",
        )}`,
      );
    }
    return {
      category: category as SpecIR["nonFunctional"][number]["category"],
      requirement: asString(
        o.requirement,
        `spec.nonFunctional[${i}].requirement`,
      ),
    };
  });
}

export function asEdgeCases(v: unknown): SpecIR["edgeCases"] {
  if (!Array.isArray(v)) return [];
  return v.map((ec, i) => {
    if (!ec || typeof ec !== "object") {
      throw new Error(`spec.edgeCases[${i}]: not an object`);
    }
    const o = ec as Record<string, unknown>;
    return {
      scenario: asString(o.scenario, `spec.edgeCases[${i}].scenario`),
      expectedBehavior: asString(
        o.expectedBehavior,
        `spec.edgeCases[${i}].expectedBehavior`,
      ),
    };
  });
}

export function asQa(v: unknown): SpecIR["qaChecklist"] {
  if (!Array.isArray(v)) return [];
  return v.map((q, i) => {
    if (!q || typeof q !== "object") {
      throw new Error(`spec.qaChecklist[${i}]: not an object`);
    }
    const o = q as Record<string, unknown>;
    const status = o.status;
    return {
      check: asString(o.check, `spec.qaChecklist[${i}].check`),
      status:
        status === "passed" || status === "failed" || status === "untested"
          ? status
          : "untested",
    };
  });
}

export function asCitations(v: unknown): SpecIR["citations"] {
  if (!Array.isArray(v)) return [];
  return v.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new Error(`spec.citations[${i}]: not an object`);
    }
    const o = c as Record<string, unknown>;
    return {
      clusterId: asString(o.clusterId, `spec.citations[${i}].clusterId`),
      note: asString(o.note, `spec.citations[${i}].note`),
    };
  });
}

/**
 * Validate the entire IR shape + cross-references (every acceptance
 * criterion's storyId maps to a real story; every story has ≥1
 * criterion). Shared between every prompt that emits a SpecIR.
 */
export function validateSpecIR(raw: unknown): SpecIR {
  if (!raw || typeof raw !== "object") {
    throw new Error("spec: expected object");
  }
  const s = raw as Record<string, unknown>;

  const validated: SpecIR = {
    title: asString(s.title, "spec.title"),
    summary: asString(s.summary, "spec.summary"),
    userStories: asUserStories(s.userStories),
    acceptanceCriteria: asAcceptance(s.acceptanceCriteria),
    nonFunctional: asNonFunctional(s.nonFunctional),
    edgeCases: asEdgeCases(s.edgeCases),
    qaChecklist: asQa(s.qaChecklist),
    citations: asCitations(s.citations),
  };

  const storyIds = new Set(validated.userStories.map((us) => us.id));
  for (const ac of validated.acceptanceCriteria) {
    if (!storyIds.has(ac.storyId)) {
      throw new Error(
        `spec: acceptance criterion references unknown storyId ${ac.storyId}`,
      );
    }
  }
  for (const us of validated.userStories) {
    const count = validated.acceptanceCriteria.filter(
      (ac) => ac.storyId === us.id,
    ).length;
    if (count === 0) {
      throw new Error(`spec: story ${us.id} has no acceptance criteria`);
    }
  }

  return validated;
}
