import { describe, expect, it } from "vitest";
import {
  renderLinearExport,
  sanitizeForLinear,
  type LinearExportPrior,
} from "@/lib/spec/renderers/linear";
import type { SpecIR } from "@/lib/spec/ir";

/*
  Unit coverage for the Linear renderer. Pure function, no mocks
  needed. Tests live in three groups:

    1. Sanitization — markdown-injection vectors via LLM-generated
       spec content (the renderer is the trust boundary).
    2. Plan shape — actions, ordering, edge-case behaviors.
    3. Project / issue payloads — title truncation, description
       sections, citation handling.

  Each case maps to a specific item in the design doc's test plan
  (./hamza-sanxore-linear-project-spec-export-design-20260514-160230.md
  in ~/.gstack/projects/rogation-ai-rogation/).
*/

function baseIR(overrides: Partial<SpecIR> = {}): SpecIR {
  return {
    title: "Test Spec",
    summary: "A short summary.",
    userStories: [
      {
        id: "US1",
        persona: "PM at a SaaS company",
        goal: "filter by segment",
        value: "I can act on mobile pain separately",
      },
    ],
    acceptanceCriteria: [
      {
        storyId: "US1",
        given: "segment filter is set to mobile",
        when: "I open insights",
        then: "only mobile clusters appear",
      },
    ],
    nonFunctional: [],
    edgeCases: [],
    qaChecklist: [],
    citations: [],
    ...overrides,
  };
}

describe("sanitizeForLinear", () => {
  it("escapes leading @-mentions to neutralize phishing", () => {
    expect(sanitizeForLinear("ping @engineer for review")).toBe(
      "ping \\@engineer for review",
    );
  });

  it("preserves @ in the middle of words (e.g. emails)", () => {
    // Word-position is approximated by start-of-string or non-word
    // char preceding @. "x@y" has 'x' before @, which is \w, so it
    // doesn't trip the rule. (Real email sanitization is out of scope.)
    expect(sanitizeForLinear("foo@example.com")).toBe("foo@example.com");
  });

  it("escapes brackets to prevent inline link injection (defense in depth)", () => {
    // All [ and ] in sanitizer inputs are escaped to \[ and \] so a
    // malicious LLM payload cannot construct a [text](url) inline link
    // from user-controlled content. ZWJ on the bare URL inside is
    // belt-and-suspenders for the case where someone strips the
    // escapes downstream.
    const out = sanitizeForLinear("click [here](https://attacker.com/login)");
    expect(out).toContain("\\[here\\]");
    expect(out).toContain("https‍://attacker.com"); // ZWJ-broken
    expect(out).not.toMatch(/\[here\]\(https:/); // no unescaped link
  });

  it("escapes brackets even when the URL is allowlisted", () => {
    // Rendered Linear output preserves intent (the bracketed text is
    // visible) but content cannot construct a markdown link. The
    // renderer's OWN citation/issue templates emit unescaped link
    // syntax with sanitized text inside; those still render correctly.
    const out = sanitizeForLinear(
      "view [cluster](https://app.rogation.com/insights?cluster=abc)",
    );
    expect(out).toContain("\\[cluster\\]");
    expect(out).toContain("https://app.rogation.com/insights?cluster=abc");
  });

  it("blocks startsWith-allowlist bypass via subdomain confusion", () => {
    // A naive prefix check `url.startsWith("https://app.rogation.com")`
    // accepts "https://app.rogation.com.evil.com/x" — the URL-parse
    // allowlist rules this out.
    const out = sanitizeForLinear("see https://app.rogation.com.evil.com/x");
    expect(out).toContain("https‍://app.rogation.com.evil.com");
  });

  it("breaks bare http URLs outside the allowlist", () => {
    const out = sanitizeForLinear("see https://attacker.com/path for more");
    expect(out).toContain("https‍://attacker.com");
    expect(out).not.toMatch(/^see https:\/\/attacker/);
  });

  it("strips reference-style link definitions and uses", () => {
    // After bracket escape, neither [id]: url nor [text][id] can form
    // a valid markdown link. The escaped output is plain text.
    const ref = sanitizeForLinear(
      "see [click here][evil]\n\n[evil]: https://attacker.com",
    );
    expect(ref).toContain("\\[click here\\]\\[evil\\]");
    expect(ref).not.toMatch(/\[click here\]\[evil\]/);
    expect(ref).toContain("https‍://attacker.com"); // ZWJ on the URL too
  });

  it("neutralizes 4+ backtick fences (CommonMark accepts n>=3)", () => {
    // Step 7 splits any run of 3+ backticks with ZWSP so no run
    // of 3 remains.
    const four = sanitizeForLinear("````evil````");
    expect(four).not.toMatch(/`{3,}/);
  });

  it("neutralizes triple-backtick fences", () => {
    const out = sanitizeForLinear("```evil code```");
    expect(out).not.toContain("```");
  });

  it("strips HTML angle brackets defensively", () => {
    expect(sanitizeForLinear("<script>x</script>")).toBe("scriptx/script");
  });

  it("returns empty string on empty input", () => {
    expect(sanitizeForLinear("")).toBe("");
  });
});

describe("renderLinearExport — plan shape", () => {
  it("first push: every user story produces a create-issue action", () => {
    const ir = baseIR({
      userStories: [
        { id: "US1", persona: "PM", goal: "g1", value: "v1" },
        { id: "US2", persona: "PM", goal: "g2", value: "v2" },
      ],
    });
    const plan = renderLinearExport(ir, "Opp Title");
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions.every((a) => a.kind === "create-issue")).toBe(true);
    expect(plan.priorIssueMapEmpty).toBe(false);
  });

  it("preserves IR insertion order for create/update actions", () => {
    const ir = baseIR({
      userStories: [
        { id: "USc", persona: "p", goal: "g", value: "v" },
        { id: "USa", persona: "p", goal: "g", value: "v" },
        { id: "USb", persona: "p", goal: "g", value: "v" },
      ],
    });
    const plan = renderLinearExport(ir, "T");
    const usIds = plan.actions
      .filter((a) => a.kind === "create-issue")
      .map((a) => (a as { payload: { usId: string } }).payload.usId);
    expect(usIds).toEqual(["USc", "USa", "USb"]);
  });

  it("with prior: existing stories produce update-issue, new stories produce create-issue", () => {
    const ir = baseIR({
      userStories: [
        { id: "US1", persona: "p", goal: "g1", value: "v" },
        { id: "US3", persona: "p", goal: "g3", value: "v" }, // new
      ],
    });
    const prior: LinearExportPrior = {
      projectId: "proj-1",
      issueMap: {
        US1: { id: "i-1", identifier: "ENG-1", url: "u1" },
      },
    };
    const plan = renderLinearExport(ir, "T", prior);
    const updates = plan.actions.filter((a) => a.kind === "update-issue");
    const creates = plan.actions.filter((a) => a.kind === "create-issue");
    expect(updates).toHaveLength(1);
    expect(creates).toHaveLength(1);
    if (updates[0]!.kind === "update-issue") {
      expect(updates[0]!.issueId).toBe("i-1");
    }
  });

  it("with prior: stories no longer in IR produce archive-issue", () => {
    const ir = baseIR({
      userStories: [{ id: "US1", persona: "p", goal: "g1", value: "v" }],
    });
    const prior: LinearExportPrior = {
      projectId: "proj-1",
      issueMap: {
        US1: { id: "i-1", identifier: "E-1", url: "u" },
        US2: { id: "i-2", identifier: "E-2", url: "u" }, // archived
      },
    };
    const plan = renderLinearExport(ir, "T", prior);
    const archives = plan.actions.filter((a) => a.kind === "archive-issue");
    expect(archives).toHaveLength(1);
    if (archives[0]!.kind === "archive-issue") {
      expect(archives[0]!.issueId).toBe("i-2");
      expect(archives[0]!.usId).toBe("US2");
    }
  });

  it("renamed US ids (US3 → US2) produce archive + create, not silent rename", () => {
    // This is the explicit behavior the design doc commits to:
    // LLM-generated US ids are not stable across regenerations, and
    // we do NOT silently reconcile. Renaming US3 to US2 archives the
    // old US3 issue and creates a new US2 issue. PMs see the
    // consequence via the D3 confirm modal copy.
    const ir = baseIR({
      userStories: [{ id: "US2", persona: "p", goal: "g", value: "v" }],
    });
    const prior: LinearExportPrior = {
      projectId: "proj-1",
      issueMap: { US3: { id: "i-3", identifier: "E-3", url: "u" } },
    };
    const plan = renderLinearExport(ir, "T", prior);
    expect(plan.actions.find((a) => a.kind === "create-issue")).toBeDefined();
    expect(plan.actions.find((a) => a.kind === "archive-issue")).toBeDefined();
  });

  it("empty prior issueMap with mode=update is flagged via priorIssueMapEmpty", () => {
    const ir = baseIR();
    const prior: LinearExportPrior = {
      projectId: "proj-1",
      issueMap: {},
    };
    const plan = renderLinearExport(ir, "T", prior);
    expect(plan.priorIssueMapEmpty).toBe(true);
    // All actions become create-issue since the map is empty.
    expect(plan.actions.every((a) => a.kind === "create-issue")).toBe(true);
  });

  it("identical inputs render identically (deterministic for downstream diffing)", () => {
    const ir = baseIR();
    const a = renderLinearExport(ir, "T");
    const b = renderLinearExport(ir, "T");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("renderLinearExport — project payload", () => {
  it("uses ir.title when set", () => {
    const ir = baseIR({ title: "  Onboarding redesign  " });
    const plan = renderLinearExport(ir, "Fallback Title");
    expect(plan.project.name).toBe("Onboarding redesign");
  });

  it("falls back to opportunityTitle when ir.title is empty", () => {
    const ir = baseIR({ title: "" });
    const plan = renderLinearExport(ir, "Opp Fallback");
    expect(plan.project.name).toBe("Opp Fallback");
  });

  it("includes Summary section in project description", () => {
    const ir = baseIR({ summary: "We make onboarding less confusing." });
    const plan = renderLinearExport(ir, "T");
    expect(plan.project.description).toContain("## Summary");
    expect(plan.project.description).toContain("We make onboarding less confusing.");
  });

  it("includes Non-functional requirements section when set", () => {
    const ir = baseIR({
      nonFunctional: [{ category: "performance", requirement: "p95 under 200ms" }],
    });
    const plan = renderLinearExport(ir, "T");
    expect(plan.project.description).toContain("## Non-functional requirements");
    expect(plan.project.description).toContain("performance");
    expect(plan.project.description).toContain("p95 under 200ms");
  });

  it("strips < and > from NFR text as defensive HTML strip", () => {
    // The renderer drops angle brackets defensively (Linear strips
    // HTML, but we fail fast). "p95 < 200ms" becomes "p95  200ms".
    // PMs writing NFRs with comparison operators should use words
    // ("less than 200ms") or rephrase ("p95 ≤ 200ms").
    const ir = baseIR({
      nonFunctional: [{ category: "performance", requirement: "p95 < 200ms" }],
    });
    const plan = renderLinearExport(ir, "T");
    expect(plan.project.description).not.toContain("<");
    expect(plan.project.description).toContain("p95  200ms");
  });

  it("omits NFR/edge-case/QA sections when empty", () => {
    const ir = baseIR();
    const plan = renderLinearExport(ir, "T");
    expect(plan.project.description).not.toContain("Non-functional requirements");
    expect(plan.project.description).not.toContain("Edge cases");
    expect(plan.project.description).not.toContain("QA checklist");
  });

  it("renders QA checklist as Linear checkboxes with passed annotation", () => {
    const ir = baseIR({
      qaChecklist: [
        { check: "Login works", status: "passed" },
        { check: "Logout works" },
      ],
    });
    const plan = renderLinearExport(ir, "T");
    expect(plan.project.description).toContain("[x] Login works");
    expect(plan.project.description).toContain("[ ] Logout works");
  });

  it("sanitizes project description content from the summary", () => {
    const ir = baseIR({
      summary: "ping @engineer about [click](https://attacker.com)",
    });
    const plan = renderLinearExport(ir, "T");
    expect(plan.project.description).toContain("\\@engineer");
    // Brackets always escaped + bare URL ZWJ-broken.
    expect(plan.project.description).toContain("\\[click\\]");
    expect(plan.project.description).toContain("https‍://attacker.com");
  });
});

describe("renderLinearExport — issue payload", () => {
  it("title format is [USn] goal, persona prefix dropped", () => {
    const ir = baseIR({
      userStories: [
        {
          id: "US1",
          persona: "PM at a 50-300 person SaaS",
          goal: "filter by segment",
          value: "v",
        },
      ],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    expect(action.payload.title).toBe("[US1] filter by segment");
    expect(action.payload.title).not.toContain("PM at a 50-300");
  });

  it("title truncates at 180 chars on word boundary", () => {
    const longGoal = "a ".repeat(150); // 300 chars
    const ir = baseIR({
      userStories: [{ id: "US1", persona: "p", goal: longGoal, value: "v" }],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    // [US1] prefix is 6 chars; goal portion <= 180
    expect(action.payload.title.length).toBeLessThanOrEqual(186);
  });

  it("title hard-slices when goal is one run-on word (no whitespace)", () => {
    const runOn = "x".repeat(250);
    const ir = baseIR({
      userStories: [{ id: "US1", persona: "p", goal: runOn, value: "v" }],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    // Never produce just "[US1] " (empty title).
    expect(action.payload.title.length).toBeGreaterThan(7);
    expect(action.payload.title).toMatch(/^\[US1\] x/);
  });

  it("omits ## Acceptance criteria when story has zero ACs", () => {
    const ir = baseIR({
      userStories: [{ id: "US1", persona: "p", goal: "g", value: "v" }],
      acceptanceCriteria: [],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    expect(action.payload.description).not.toContain("## Acceptance criteria");
  });

  it("renders AC checkboxes with Given/When/Then format", () => {
    const ir = baseIR({
      acceptanceCriteria: [
        { storyId: "US1", given: "G", when: "W", then: "T" },
      ],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    expect(action.payload.description).toContain("- [ ] **Given** G");
    expect(action.payload.description).toContain("**When** W");
    expect(action.payload.description).toContain("**Then** T");
  });

  it("includes citations linked to APP_URL with refinement footnote", () => {
    const ir = baseIR({
      citations: [{ clusterId: "cluster-abc", note: "PM said X" }],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    expect(action.payload.description).toContain("## Citations");
    expect(action.payload.description).toContain("cluster-abc");
    expect(action.payload.description).toContain("PM said X");
    expect(action.payload.description).toContain("Refinement may invalidate links");
  });

  it("sanitizes user-controlled story strings", () => {
    const ir = baseIR({
      userStories: [
        {
          id: "US1",
          persona: "ping @malicious-user",
          goal: "do [thing](https://attacker.com)",
          value: "v",
        },
      ],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    expect(action.payload.description).toContain("\\@malicious-user");
    // Brackets escaped + bare URL ZWJ-broken — content cannot
    // construct a markdown link.
    expect(action.payload.description).toContain("\\[thing\\]");
    expect(action.payload.description).toContain("https‍://attacker.com");
  });

  it("citation note with `]` cannot escape the citation link", () => {
    // Citation note that tries to close the renderer's [note](url)
    // template prematurely. After bracket-escape, the injected ] is
    // a literal character, so the citation's anchor remains intact.
    const ir = baseIR({
      citations: [
        {
          clusterId: "cluster-abc",
          note: "PM said: ] then [evil](https://attacker.com)",
        },
      ],
    });
    const plan = renderLinearExport(ir, "T");
    const action = plan.actions[0]!;
    if (action.kind !== "create-issue") throw new Error("expected create");
    // The renderer's own [...](...) template still resolves; the
    // injected [evil](...) does NOT become a clickable link.
    expect(action.payload.description).toMatch(
      /\[PM said: \\\] then \\\[evil\\\]\([^)]*attacker.com[^)]*\)\]\(https:\/\/app\.rogation\.com\/insights\?cluster=cluster-abc\)/,
    );
  });
});
