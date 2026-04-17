import type { SpecIR } from "@/lib/spec/ir";

/*
  Markdown renderer for a Spec IR.

  One of three planned renderers (Markdown + Linear + Notion). Linear +
  Notion ship with the export commit. This one ships today because the
  editor needs a "Download .md" button on day 1 — eng always wants the
  file, PMs paste the file into their tool of choice.

  Deterministic: same IR → same string. That property lets us diff two
  generations to see "what changed" in a future iteration (or pipe
  into a version history UI).

  Shape:
    # Title
    > Summary paragraph

    ## User Stories
    - **US1** — As a <persona>, I want <goal> so that <value>.

    ## Acceptance Criteria
    ### US1
    - **Given** ... **When** ... **Then** ...

    ## Non-Functional Requirements
    - **Performance:** ...

    ## Edge Cases
    - **Scenario:** ...
      **Expected:** ...

    ## QA Checklist
    - [ ] Check 1
    - [x] Check 2  (when status === "passed")

    ## Citations
    - `clusterId`: note
*/

export function renderSpecMarkdown(spec: SpecIR): string {
  const parts: string[] = [];

  parts.push(`# ${spec.title}`);
  parts.push("");
  parts.push(`> ${spec.summary}`);

  parts.push("");
  parts.push("## User Stories");
  parts.push("");
  for (const us of spec.userStories) {
    parts.push(
      `- **${us.id}** — As ${withArticle(us.persona)}, I want ${us.goal} so that ${us.value}.`,
    );
  }

  parts.push("");
  parts.push("## Acceptance Criteria");
  // Group criteria by storyId so the rendered doc mirrors the story
  // structure instead of a flat list.
  const byStory = new Map<string, typeof spec.acceptanceCriteria>();
  for (const ac of spec.acceptanceCriteria) {
    const list = byStory.get(ac.storyId) ?? [];
    list.push(ac);
    byStory.set(ac.storyId, list);
  }
  for (const us of spec.userStories) {
    const criteria = byStory.get(us.id);
    if (!criteria || criteria.length === 0) continue;
    parts.push("");
    parts.push(`### ${us.id}`);
    for (const ac of criteria) {
      parts.push(`- **Given** ${ac.given} **When** ${ac.when} **Then** ${ac.then}`);
    }
  }

  if (spec.nonFunctional.length > 0) {
    parts.push("");
    parts.push("## Non-Functional Requirements");
    parts.push("");
    for (const nf of spec.nonFunctional) {
      parts.push(`- **${titleCase(nf.category)}:** ${nf.requirement}`);
    }
  }

  if (spec.edgeCases.length > 0) {
    parts.push("");
    parts.push("## Edge Cases");
    parts.push("");
    for (const ec of spec.edgeCases) {
      parts.push(`- **Scenario:** ${ec.scenario}`);
      parts.push(`  **Expected:** ${ec.expectedBehavior}`);
    }
  }

  if (spec.qaChecklist.length > 0) {
    parts.push("");
    parts.push("## QA Checklist");
    parts.push("");
    for (const q of spec.qaChecklist) {
      const box = q.status === "passed" ? "[x]" : "[ ]";
      parts.push(`- ${box} ${q.check}`);
    }
  }

  if (spec.citations.length > 0) {
    parts.push("");
    parts.push("## Citations");
    parts.push("");
    for (const c of spec.citations) {
      parts.push(`- \`${c.clusterId}\`: ${c.note}`);
    }
  }

  parts.push("");
  return parts.join("\n");
}

function withArticle(persona: string): string {
  const first = persona.trim().charAt(0).toLowerCase();
  // Already starts with an article? Leave it alone.
  const lower = persona.trim().toLowerCase();
  if (lower.startsWith("a ") || lower.startsWith("an ") || lower.startsWith("the ")) {
    return persona.trim();
  }
  return /[aeiou]/.test(first) ? `an ${persona.trim()}` : `a ${persona.trim()}`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
