import { describe, expect, it } from "vitest";
import {
  extractLinearConflictFromError,
  isPartialPush,
  pickLinearPushState,
  type LinearPushStateInput,
} from "@/lib/client/linear-push-state";
import type { SpecIR } from "@/lib/spec/ir";

/*
  Pure-logic tests for the spec-page Linear push surface. The React
  component reads pickLinearPushState() and routes JSX accordingly;
  these tests verify every branch of the cascade and the supporting
  helpers without needing a renderer.
*/

function baseIR(overrides: Partial<SpecIR> = {}): SpecIR {
  return {
    title: "t",
    summary: "s",
    userStories: [{ id: "US1", persona: "p", goal: "g", value: "v" }],
    acceptanceCriteria: [],
    nonFunctional: [],
    edgeCases: [],
    qaChecklist: [],
    citations: [],
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<LinearPushStateInput> = {},
): LinearPushStateInput {
  return {
    spec: {
      ir: baseIR(),
      linearProjectUrl: null,
      linearProjectId: null,
      linearIssueMap: null,
    },
    plan: "pro",
    planAllowsLinearExport: true,
    linearIntegration: { connected: true, config: { defaultTeamId: "t1" } },
    priorProject: null,
    ...overrides,
  };
}

describe("pickLinearPushState", () => {
  it("returns 'pushed' when current spec has a project URL and complete issue map", () => {
    const out = pickLinearPushState(
      baseInput({
        spec: {
          ir: baseIR(),
          linearProjectUrl: "https://linear.app/acme/project/p1",
          linearProjectId: "p1",
          linearIssueMap: { US1: { id: "i", identifier: "E-1", url: "u" } },
        },
      }),
    );
    expect(out).toBe("pushed");
  });

  it("returns 'pushed-partial' when issue map is smaller than user stories", () => {
    const out = pickLinearPushState(
      baseInput({
        spec: {
          ir: baseIR({
            userStories: [
              { id: "US1", persona: "p", goal: "g", value: "v" },
              { id: "US2", persona: "p", goal: "g", value: "v" },
            ],
          }),
          linearProjectUrl: "u",
          linearProjectId: "p1",
          linearIssueMap: { US1: { id: "i", identifier: "E-1", url: "u" } },
        },
      }),
    );
    expect(out).toBe("pushed-partial");
  });

  it("'pushed' takes precedence over 'not-connected' so the link stays usable after disconnect", () => {
    const out = pickLinearPushState(
      baseInput({
        spec: {
          ir: baseIR(),
          linearProjectUrl: "u",
          linearProjectId: "p1",
          linearIssueMap: { US1: { id: "i", identifier: "E-1", url: "u" } },
        },
        linearIntegration: { connected: false, config: null },
      }),
    );
    expect(out).toBe("pushed");
  });

  it("returns 'upgrade-required' when plan does not allow Linear export", () => {
    expect(
      pickLinearPushState(baseInput({ planAllowsLinearExport: false })),
    ).toBe("upgrade-required");
  });

  it("returns 'not-connected' when integration is missing or disconnected", () => {
    expect(
      pickLinearPushState(baseInput({ linearIntegration: null })),
    ).toBe("not-connected");
    expect(
      pickLinearPushState(
        baseInput({ linearIntegration: { connected: false, config: null } }),
      ),
    ).toBe("not-connected");
  });

  it("returns 'no-default-team' when the integration has no defaultTeamId", () => {
    expect(
      pickLinearPushState(
        baseInput({
          linearIntegration: { connected: true, config: {} },
        }),
      ),
    ).toBe("no-default-team");
    expect(
      pickLinearPushState(
        baseInput({
          linearIntegration: {
            connected: true,
            config: { defaultTeamId: 42 }, // wrong type
          },
        }),
      ),
    ).toBe("no-default-team");
  });

  it("returns 'refinement-gap' when prior version had a project but current doesn't", () => {
    expect(
      pickLinearPushState(
        baseInput({
          priorProject: { projectId: "p-old", projectUrl: "u-old" },
        }),
      ),
    ).toBe("refinement-gap");
  });

  it("returns 'ready' when integration is configured and no prior project exists", () => {
    expect(pickLinearPushState(baseInput())).toBe("ready");
  });
});

describe("isPartialPush", () => {
  it("returns true on empty issue map with non-empty stories", () => {
    expect(isPartialPush({}, [{ id: "US1" }])).toBe(true);
    expect(isPartialPush(null, [{ id: "US1" }])).toBe(true);
    expect(isPartialPush(undefined, [{ id: "US1" }])).toBe(true);
  });

  it("returns false when map size equals story count", () => {
    expect(
      isPartialPush({ US1: 1, US2: 2 }, [{ id: "US1" }, { id: "US2" }]),
    ).toBe(false);
  });

  it("returns false when map is larger than stories (refinement dropped some)", () => {
    expect(
      isPartialPush({ US1: 1, US2: 2, US3: 3 }, [{ id: "US1" }]),
    ).toBe(false);
  });

  it("returns true when map is smaller than stories (new stories added)", () => {
    expect(isPartialPush({ US1: 1 }, [{ id: "US1" }, { id: "US2" }])).toBe(
      true,
    );
  });

  it("returns false when both are empty", () => {
    expect(isPartialPush({}, [])).toBe(false);
    expect(isPartialPush(null, [])).toBe(false);
  });
});

describe("extractLinearConflictFromError", () => {
  it("returns the conflict envelope when cause.type matches", () => {
    const err = {
      data: {
        cause: {
          type: "linear-project-exists",
          projectId: "p1",
          projectUrl: "https://linear.app/acme/p1",
          issueCount: 4,
        },
      },
    };
    const out = extractLinearConflictFromError(err);
    expect(out).toEqual({
      kind: "linear-project-exists",
      projectId: "p1",
      projectUrl: "https://linear.app/acme/p1",
      issueCount: 4,
    });
  });

  it("recognizes the empty-but-existing variant", () => {
    const err = {
      data: {
        cause: {
          type: "linear-project-exists-but-empty",
          projectId: "p1",
          projectUrl: "u",
          issueCount: 0,
        },
      },
    };
    expect(extractLinearConflictFromError(err)?.kind).toBe(
      "linear-project-exists-but-empty",
    );
  });

  it("returns null for unrelated error causes", () => {
    expect(
      extractLinearConflictFromError({
        data: { cause: { type: "linear-push-failed", reason: "token-invalid" } },
      }),
    ).toBe(null);
  });

  it("returns null for malformed payload shapes", () => {
    // Missing fields
    expect(
      extractLinearConflictFromError({
        data: { cause: { type: "linear-project-exists" } },
      }),
    ).toBe(null);
    // Wrong types
    expect(
      extractLinearConflictFromError({
        data: {
          cause: {
            type: "linear-project-exists",
            projectId: 123,
            projectUrl: "u",
            issueCount: 1,
          },
        },
      }),
    ).toBe(null);
  });

  it("returns null when err.data is missing or non-object", () => {
    expect(extractLinearConflictFromError(null)).toBe(null);
    expect(extractLinearConflictFromError(undefined)).toBe(null);
    expect(extractLinearConflictFromError({})).toBe(null);
    expect(extractLinearConflictFromError({ data: "string" })).toBe(null);
  });
});
