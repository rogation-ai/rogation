import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { complete } from "@/lib/llm/router";
import {
  synthesisIncremental,
  type SynthesisIncrementalInput,
} from "@/lib/llm/prompts/synthesis-incremental";

/*
  Baseline eval for synthesis.incremental.v1.

  Gated on RUN_EVALS=1 because every invocation:
    - costs roughly $0.05 at Sonnet 4.6 pricing
    - requires a real ANTHROPIC_API_KEY
    - takes 10-30 seconds

  CI never runs it. Developers run it manually when:
    - editing the SYSTEM prompt (check the new hash's behavior)
    - bumping the model tier
    - investigating a real-user cluster quality regression

  Output: full prompt_hash + usage snapshot + pass/fail per assertion.
  Feed the output into a baseline diff when bumping the prompt:
    diff <(git show main:...baseline.txt) <(RUN_EVALS=1 bun test ...)

  What this test protects:
    - The prompt produces parseable JSON.
    - Every candidate evidence appears in exactly one action (no drops,
      no duplicates).
    - At least one KEEP: model uses existing clusters rather than
      starting fresh every run.
    - At least one NEW: model surfaces genuinely-new pain points from
      the extra 4 ground-truth groups we DON'T pre-seed.
    - No hallucinated cluster labels.
    - Total clusters after apply stays bounded (model doesn't fragment).

  This does NOT check cluster quality per se — that's a human-in-the-loop
  review + feedback-thumbs aggregate. We're just proving the prompt
  doesn't produce structurally broken output.
*/

interface Fixture {
  description: string;
  groups: Record<string, string[]>;
}

const FIXTURE_PATH = join(
  process.cwd(),
  "test",
  "evals",
  "fixtures",
  "incremental-100-rows.json",
);

function loadFixture(): Fixture {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as Fixture;
}

/**
 * Pre-seed 5 existing clusters (first 5 ground-truth groups × 4
 * evidence each → 20 evidence, labels E1-E20, clusters C1-C5). The
 * remaining rows are candidates E21-Exxx. The LLM should ideally:
 *   - KEEP 4-5 candidates onto C1-C5 (same-group evidence)
 *   - NEW up to 4 clusters for the 4 ground-truth groups we didn't pre-seed
 */
function buildInput(
  fx: Fixture,
): { input: SynthesisIncrementalInput; candidateLabels: Set<string> } {
  const groupNames = Object.keys(fx.groups);
  const seeded = groupNames.slice(0, 5);
  const remaining = groupNames.slice(5);

  const existing: SynthesisIncrementalInput["existing"] = [];
  let evidenceCounter = 0;
  seeded.forEach((groupName, groupIdx) => {
    const rows = fx.groups[groupName]!;
    const evidence = rows.slice(0, 4).map((content) => {
      evidenceCounter += 1;
      return { label: `E${evidenceCounter}`, content };
    });
    existing.push({
      label: `C${groupIdx + 1}`,
      title: prettyTitle(groupName),
      description: `Pre-existing cluster for ${groupName}.`,
      severity: "medium",
      evidence,
    });
  });

  const candidates: SynthesisIncrementalInput["candidates"] = [];
  const candidateLabels = new Set<string>();

  // Candidates = leftover rows from seeded groups (4 kept, rest are
  // candidates) + all rows from non-seeded groups.
  seeded.forEach((groupName) => {
    const rows = fx.groups[groupName]!;
    for (const content of rows.slice(4)) {
      evidenceCounter += 1;
      const label = `E${evidenceCounter}`;
      candidateLabels.add(label);
      candidates.push({ label, content });
    }
  });
  remaining.forEach((groupName) => {
    const rows = fx.groups[groupName]!;
    for (const content of rows) {
      evidenceCounter += 1;
      const label = `E${evidenceCounter}`;
      candidateLabels.add(label);
      candidates.push({ label, content });
    }
  });

  return { input: { existing, candidates }, candidateLabels };
}

function prettyTitle(slug: string): string {
  return slug
    .split("_")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function collectReferencedEvidenceLabels(
  actions: ReturnType<typeof synthesisIncremental.parse>["actions"],
): string[] {
  const labels: string[] = [];
  for (const a of actions) {
    if (a.type === "KEEP") labels.push(...a.attachEvidence);
    else if (a.type === "SPLIT") {
      for (const c of a.children) labels.push(...c.evidenceLabels);
    } else if (a.type === "NEW") labels.push(...a.evidenceLabels);
    // MERGE doesn't reference evidence labels — only cluster labels.
  }
  return labels;
}

function computeFinalClusterCount(
  startCount: number,
  actions: ReturnType<typeof synthesisIncremental.parse>["actions"],
): number {
  let count = startCount;
  for (const a of actions) {
    if (a.type === "MERGE") count -= a.clusterLabels.length - 1;
    else if (a.type === "SPLIT") count += a.children.length - 1;
    else if (a.type === "NEW") count += 1;
  }
  return count;
}

describe.skipIf(!process.env.RUN_EVALS)(
  "synthesis.incremental.v1 eval (RUN_EVALS gated)",
  () => {
    it("produces a valid ClusterPlan from the 100-row fixture", async () => {
      const fx = loadFixture();
      const { input, candidateLabels } = buildInput(fx);
      const existingLabels = new Set(input.existing.map((c) => c.label));

      console.log(`\n[eval] prompt hash: ${synthesisIncremental.hash}`);
      console.log(
        `[eval] input: ${input.existing.length} existing clusters, ${input.candidates.length} candidates`,
      );

      const usages: Array<{ tokensIn: number; tokensOut: number }> = [];
      const start = Date.now();
      const { output } = await complete(synthesisIncremental, input, {
        onUsage: (u) => {
          usages.push({ tokensIn: u.tokensIn, tokensOut: u.tokensOut });
        },
      });
      const latencyMs = Date.now() - start;

      const totalIn = usages.reduce((s, u) => s + u.tokensIn, 0);
      const totalOut = usages.reduce((s, u) => s + u.tokensOut, 0);
      console.log(
        `[eval] latency: ${latencyMs}ms | tokens in/out: ${totalIn}/${totalOut}`,
      );
      console.log(
        `[eval] actions: ${output.actions.length} total (${output.actions
          .map((a) => a.type)
          .join(", ")})`,
      );

      // --- Structural assertions ---
      // (1) Every candidate evidence label is referenced exactly once.
      const referenced = collectReferencedEvidenceLabels(output.actions);
      const referencedSet = new Set(referenced);
      expect(referenced.length).toBe(referencedSet.size); // no duplicates
      for (const label of candidateLabels) {
        expect(referencedSet.has(label)).toBe(true);
      }

      // (2) No referenced evidence label is outside our candidate set.
      for (const label of referencedSet) {
        expect(candidateLabels.has(label)).toBe(true);
      }

      // (3) No referenced cluster label is outside the existing set.
      const clusterRefs = new Set<string>();
      for (const a of output.actions) {
        if (a.type === "KEEP") clusterRefs.add(a.clusterLabel);
        else if (a.type === "MERGE") {
          for (const l of a.clusterLabels) clusterRefs.add(l);
        } else if (a.type === "SPLIT") clusterRefs.add(a.originLabel);
      }
      for (const l of clusterRefs) {
        expect(existingLabels.has(l)).toBe(true);
      }

      // (4) At least one KEEP — LLM uses the seeded clusters.
      const keepCount = output.actions.filter((a) => a.type === "KEEP").length;
      expect(keepCount).toBeGreaterThanOrEqual(1);

      // (5) At least one NEW — LLM surfaces the 4 non-seeded pain points.
      const newCount = output.actions.filter((a) => a.type === "NEW").length;
      expect(newCount).toBeGreaterThanOrEqual(1);

      // (6) Total cluster count stays bounded — 5 seeded + up to 4
      //     genuinely new + a little slack for SPLITs. Fragmentation
      //     budget is 12.
      const finalCount = computeFinalClusterCount(
        input.existing.length,
        output.actions,
      );
      expect(finalCount).toBeLessThanOrEqual(12);
      expect(finalCount).toBeGreaterThanOrEqual(5);
    }, 60_000);
  },
);
