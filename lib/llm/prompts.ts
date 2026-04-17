import { createHash } from "node:crypto";

/*
  Prompt registry with content-addressed hashing.

  Pattern: every LLM call goes through a typed Prompt<Input, Output>. The
  prompt's template is hashed at module-load time, and that hash is
  stored on every row the prompt produces (insight_cluster.prompt_hash,
  opportunity.prompt_hash, spec.prompt_hash, spec_refinement.prompt_hash,
  entity_feedback.prompt_hash).

  Why:
  - Eval regressions pinpoint which prompt version caused a quality drop.
  - `/plan-eng-review` decision #7 locked this in as the replacement for
    the deferred prompt_versions table — git + hash = version chain.
  - Any edit to a template's `system` or `user` content produces a new
    hash automatically. No "forgot to bump the version" bugs.

  Adding a new prompt? Create a file under lib/llm/prompts/ and call
  definePrompt(). Keep the template strings inline so the hash changes
  when you edit them.
*/

export type LLMTask =
  | "synthesis" // clustering + contradictions over long evidence corpus
  | "generation" // spec body, opportunity narratives (streaming, fast)
  | "refinement" // spec-editor chat refinement (streaming, fast)
  | "scoring" // opportunity rescoring on weight change (cheap)
  | "embedding"; // text -> vector (not via this router; see embed())

export interface Prompt<Input, Output> {
  /** Stable identifier used in logs + traces. `<domain>.<what>.<version>`. */
  name: string;
  /** Which model tier the router should dispatch to. */
  task: LLMTask;
  /** Static system instructions. Hashed as part of the prompt identity. */
  system: string;
  /**
   * Build the user-side messages for a given input. The input is NOT
   * part of the hash — only the template itself is. Runtime input is
   * traced separately via onTrace().
   */
  build(input: Input): { user: string; cacheBoundary?: number };
  /**
   * Parse the model's text output into the typed Output. Throws on
   * schema mismatch so the router can catch + retry or fail cleanly.
   */
  parse(raw: string): Output;
  /** Content-addressed hash of {name, task, system}. Computed once at load. */
  readonly hash: string;
}

export interface PromptDefinition<Input, Output> {
  name: string;
  task: LLMTask;
  system: string;
  build: Prompt<Input, Output>["build"];
  parse: Prompt<Input, Output>["parse"];
}

export function definePrompt<Input, Output>(
  def: PromptDefinition<Input, Output>,
): Prompt<Input, Output> {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        name: def.name,
        task: def.task,
        system: def.system,
      }),
    )
    .digest("hex")
    // 16 chars is enough for collision-free prompt identity across a few
    // thousand prompts, and matches our `prompt_hash varchar(64)` column.
    .slice(0, 16);

  return {
    name: def.name,
    task: def.task,
    system: def.system,
    build: def.build,
    parse: def.parse,
    hash,
  };
}
