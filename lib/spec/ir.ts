/*
  Spec IR — the intermediate representation every spec is stored as.

  Why a typed IR instead of markdown strings: design review eng-review
  decision #6 locked this in. The LLM generates one IR; three thin
  renderers (Markdown, Linear, Notion) produce per-target output. A
  format change is a renderer edit, not an LLM re-run. The readiness
  checklist + the chat refinement both read the IR, not a markdown
  blob.

  Shipped renderers in this commit: Markdown only. Linear + Notion
  renderers land with the export commit.

  This type is the source of truth. Stored in `spec.content_ir`
  (jsonb). Renderers accept SpecIR and never a looser shape.
*/

export type NonFunctionalCategory =
  | "performance"
  | "security"
  | "accessibility"
  | "reliability";

export interface SpecUserStory {
  id: string; // "US1", "US2" — stable within the spec
  persona: string; // "As a PM at a 50-300 person SaaS"
  goal: string; // "I want to filter evidence by segment"
  value: string; // "so I can cluster mobile-only pain points separately"
}

export interface SpecAcceptanceCriterion {
  storyId: string; // references SpecUserStory.id
  given: string;
  when: string;
  then: string;
}

export interface SpecNonFunctional {
  category: NonFunctionalCategory;
  requirement: string;
}

export interface SpecEdgeCase {
  scenario: string;
  expectedBehavior: string;
}

export interface SpecQaCheck {
  check: string;
  /** Default "untested" when omitted by the LLM. */
  status?: "passed" | "failed" | "untested";
}

export interface SpecCitation {
  clusterId: string; // references insight_cluster.id
  note: string;
}

export interface SpecIR {
  title: string;
  summary: string; // 1-paragraph product description
  userStories: SpecUserStory[];
  acceptanceCriteria: SpecAcceptanceCriterion[];
  nonFunctional: SpecNonFunctional[];
  edgeCases: SpecEdgeCase[];
  qaChecklist: SpecQaCheck[];
  citations: SpecCitation[];
}
