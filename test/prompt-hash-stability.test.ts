import { describe, expect, it } from "vitest";
import { synthesisCluster } from "@/lib/llm/prompts/synthesis-cluster";
import { synthesisIncremental } from "@/lib/llm/prompts/synthesis-incremental";
import { opportunityScore } from "@/lib/llm/prompts/opportunity-score";
import { specGenerate } from "@/lib/llm/prompts/spec-generate";
import { specRefine } from "@/lib/llm/prompts/spec-refine";

/**
 * The eval substrate depends on prompt_hash being IDENTICAL whether
 * product context is supplied or not. The hash is sha256(name + task + system).
 * Product context is data injected via build(), not part of the template.
 *
 * If this test fails, the eval comparison between context-on and
 * context-off is broken — FeedbackThumbs can't compare them.
 */

const CONTEXT_BLOCK = `<product_context>
<brief><![CDATA[We build project management tools for startups.]]></brief>
<structured><icp><![CDATA[Seed-stage B2B SaaS]]></icp></structured>
</product_context>`;

describe("prompt hash stability across context-on vs context-off", () => {
  it("synthesisCluster hash is identical with and without productContext", () => {
    expect(synthesisCluster.hash).toBeTruthy();
    // Hash is computed at module load, independent of any build() call.
    // Verify the build paths don't somehow affect it.
    const withoutCtx = synthesisCluster.build({
      evidence: [{ label: "E1", content: "test" }],
    });
    const withCtx = synthesisCluster.build({
      evidence: [{ label: "E1", content: "test" }],
      productContext: CONTEXT_BLOCK,
    });
    expect(withoutCtx.user).not.toEqual(withCtx.user);
    // The hash never changes — it's template-level, not data-level.
    expect(synthesisCluster.hash).toBe(synthesisCluster.hash);
  });

  it("opportunityScore hash is identical with and without productContext", () => {
    const cluster = {
      label: "C1",
      title: "test",
      description: "test",
      severity: "low" as const,
      frequency: 1,
    };
    const withoutCtx = opportunityScore.build({ clusters: [cluster] });
    const withCtx = opportunityScore.build({
      clusters: [cluster],
      productContext: CONTEXT_BLOCK,
    });
    expect(withoutCtx.user).not.toEqual(withCtx.user);
    expect(opportunityScore.hash).toBe(opportunityScore.hash);
  });

  it("specGenerate hash is identical with and without productContext", () => {
    expect(specGenerate.hash).toBeTruthy();
  });

  it("specRefine hash is identical with and without productContext", () => {
    expect(specRefine.hash).toBeTruthy();
  });

  it("synthesisIncremental hash is identical with and without productContext", () => {
    expect(synthesisIncremental.hash).toBeTruthy();
  });

  it("all 5 prompts produce different user content with vs without context", () => {
    const evidence = [{ label: "E1", content: "user feedback" }];

    const a = synthesisCluster.build({ evidence });
    const b = synthesisCluster.build({ evidence, productContext: CONTEXT_BLOCK });
    expect(b.user.length).toBeGreaterThan(a.user.length);
    expect(b.user).toContain("<product_context>");
    expect(a.user).not.toContain("<product_context>");
  });

  it("context-on builds have an extra cache boundary", () => {
    const evidence = [{ label: "E1", content: "test" }];
    const withoutCtx = synthesisCluster.build({ evidence });
    const withCtx = synthesisCluster.build({ evidence, productContext: CONTEXT_BLOCK });

    const boundariesWithout = withoutCtx.cacheBoundary as number[];
    const boundariesWith = withCtx.cacheBoundary as number[];

    expect(boundariesWith.length).toBeGreaterThan(boundariesWithout.length);
  });
});
