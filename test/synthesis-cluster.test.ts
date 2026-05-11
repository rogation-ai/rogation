import { describe, expect, it } from "vitest";
import { synthesisCluster } from "@/lib/llm/prompts/synthesis-cluster";

/*
  Coverage for the clustering prompt's build() + parse(). No live LLM.

  These are the invariants that matter regardless of what the model
  returns on any given day:

  - build() produces ONE string with every evidence item wrapped in
    its own <evidence id="..."><![CDATA[...]]></evidence> tag.
  - build() escapes XML metacharacters in the label. (Content is
    inside CDATA, so it doesn't need escaping.)
  - build() sets cacheBoundary to the end of the user message so
    Anthropic's cache can re-hit across runs.
  - parse() accepts a valid JSON envelope.
  - parse() strips markdown fences the model sometimes ignores the
    "no fences" rule and wraps the JSON in ```json ... ```.
  - parse() rejects responses missing required fields / with bad
    severity / with empty evidenceLabels.
  - parse() rejects an empty clusters[] array (zero-cluster output
    is never useful and masks prompt failure).
*/

describe("synthesisCluster.build", () => {
  it("wraps every evidence item in its own tag", () => {
    const { user } = synthesisCluster.build({
      evidence: [
        { label: "E1", content: "first" },
        { label: "E2", content: "second" },
      ],
    });
    expect(user).toContain('<evidence id="E1">');
    expect(user).toContain('<evidence id="E2">');
    expect(user.match(/<evidence /g)?.length).toBe(2);
  });

  it("uses CDATA so evidence content can contain XML metacharacters", () => {
    const { user } = synthesisCluster.build({
      evidence: [
        { label: "E1", content: "contains <script>alert(1)</script>" },
      ],
    });
    expect(user).toContain("<![CDATA[");
    expect(user).toContain("</script>");
  });

  it("escapes XML metacharacters in labels", () => {
    const { user } = synthesisCluster.build({
      evidence: [{ label: `E"&<>`, content: "x" }],
    });
    expect(user).toContain('id="E&quot;&amp;&lt;&gt;"');
  });

  it("sets cacheBoundary to the end of the user message", () => {
    const { user, cacheBoundary } = synthesisCluster.build({
      evidence: [{ label: "E1", content: "x" }],
    });
    expect(cacheBoundary).toEqual([user.length]);
  });
});

describe("synthesisCluster.parse", () => {
  const valid = JSON.stringify({
    clusters: [
      {
        title: "Onboarding is confusing",
        description: "Multiple users struggle with first-run setup.",
        severity: "high",
        evidenceLabels: ["E1", "E2"],
      },
      {
        title: "Search is slow",
        description: "Mid-size accounts report p95 > 2s on dashboards.",
        severity: "medium",
        evidenceLabels: ["E3"],
      },
    ],
  });

  it("accepts a well-formed response", () => {
    const out = synthesisCluster.parse(valid);
    expect(out.clusters).toHaveLength(2);
    expect(out.clusters[0]?.severity).toBe("high");
    expect(out.clusters[1]?.evidenceLabels).toEqual(["E3"]);
  });

  it("tolerates a markdown fence the model sometimes adds", () => {
    const fenced = "```json\n" + valid + "\n```";
    const out = synthesisCluster.parse(fenced);
    expect(out.clusters).toHaveLength(2);
  });

  it("rejects missing clusters array", () => {
    expect(() => synthesisCluster.parse("{}")).toThrowError(/clusters/);
  });

  it("rejects an empty clusters array (signal of prompt failure)", () => {
    expect(() =>
      synthesisCluster.parse(JSON.stringify({ clusters: [] })),
    ).toThrowError(/zero clusters/i);
  });

  it("rejects bad severity", () => {
    const bad = JSON.stringify({
      clusters: [
        {
          title: "x",
          description: "y",
          severity: "URGENT",
          evidenceLabels: ["E1"],
        },
      ],
    });
    expect(() => synthesisCluster.parse(bad)).toThrowError(/severity/i);
  });

  it("rejects a cluster with no evidence labels", () => {
    const bad = JSON.stringify({
      clusters: [
        {
          title: "x",
          description: "y",
          severity: "low",
          evidenceLabels: [],
        },
      ],
    });
    expect(() => synthesisCluster.parse(bad)).toThrowError(
      /at least one evidence label/i,
    );
  });
});
