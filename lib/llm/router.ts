import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { env } from "@/env";
import type { LLMTask, Prompt } from "@/lib/llm/prompts";

/*
  LLM router.

  The one place every LLM call flows through. Adds:
  - Task -> model mapping. Swap a model by editing TASK_MODELS; nothing
    else changes. Eng review decision #4.
  - Retry with exponential backoff on 429/5xx from providers.
  - Anthropic cache_control injected on the prompt's `system` and the
    pre-boundary chunk of the user message, so re-reads of the same
    evidence corpus cost 10% of a cold call. Perf decision #4.
  - onUsage hook: called with token counts so plan-limits middleware can
    charge the per-account budget (eng review issue #2). Empty stub
    here; wired when the plan-limits commit lands.
  - onTrace hook: called with {promptHash, input, output, latencyMs} so
    the eval infra + Sentry can record every call. Empty stub here;
    wired when the Sentry/Braintrust commit lands.

  Embeddings use OpenAI (text-embedding-3-small, 1536-d matches the
  evidence_embedding column). Completions and streaming use Anthropic.
*/

const TASK_MODELS: Record<Exclude<LLMTask, "embedding">, string> = {
  synthesis: "claude-sonnet-4-6",
  generation: "claude-haiku-4-5-20251001",
  refinement: "claude-haiku-4-5-20251001",
  scoring: "claude-haiku-4-5-20251001",
};

// Providers are lazily constructed so tests can mock them without the
// env validation erroring at module load.
let anthropicClient: Anthropic | undefined;
let openaiClient: OpenAI | undefined;

function anthropic(): Anthropic {
  anthropicClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

function openai(): OpenAI {
  openaiClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return openaiClient;
}

// Test seam: lets the unit test substitute a mock provider without
// poking the module's private state via a new import.
export function __setProvidersForTest(mocks: {
  anthropic?: Anthropic;
  openai?: OpenAI;
}): void {
  if (mocks.anthropic) anthropicClient = mocks.anthropic;
  if (mocks.openai) openaiClient = mocks.openai;
}

export interface Usage {
  promptHash: string;
  task: LLMTask;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  latencyMs: number;
}

export interface TraceEvent<Input, Output> {
  promptName: string;
  promptHash: string;
  model: string;
  input: Input;
  output: Output | null;
  error?: unknown;
  latencyMs: number;
}

export interface CompleteOpts {
  /** Enable Anthropic prompt caching on the system message + pre-boundary content. */
  cache?: boolean;
  /** Account-scoped budget hook. Throw inside to abort before the provider call. */
  onUsage?: (u: Usage) => Promise<void> | void;
  /** Observability hook. Never throws; errors are swallowed and logged. */
  onTrace?: <I, O>(t: TraceEvent<I, O>) => Promise<void> | void;
  /** Max attempts on transient errors (429, 5xx). Default 3. */
  maxAttempts?: number;
  /** Temperature override. Most prompts get sensible defaults per task. */
  temperature?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

const DEFAULT_TEMPERATURE: Record<Exclude<LLMTask, "embedding">, number> = {
  synthesis: 0.2, // deterministic clustering
  generation: 0.4, // spec body tolerates some variation
  refinement: 0.4,
  scoring: 0.1, // scoring math + structure, low temp
};

/**
 * Run a typed prompt to completion. Output is parsed by the prompt's
 * own parse() so the caller gets a typed result.
 */
export async function complete<Input, Output>(
  prompt: Prompt<Input, Output>,
  input: Input,
  opts: CompleteOpts = {},
): Promise<{ output: Output; usage: Usage }> {
  if (prompt.task === "embedding") {
    throw new Error(
      `Prompt ${prompt.name} has task=embedding; call embed() instead.`,
    );
  }

  const model = TASK_MODELS[prompt.task];
  const built = prompt.build(input);
  const started = Date.now();
  const maxAttempts = opts.maxAttempts ?? 3;

  // System message uses cache_control when cache=true so subsequent
  // calls re-hit the cached system blob.
  const systemBlocks = opts.cache
    ? [
        {
          type: "text" as const,
          text: prompt.system,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : prompt.system;

  // User content is split at cacheBoundary when provided + cache=true.
  // Everything before the boundary gets cache_control; the tail after
  // is the fresh part of the request.
  const userContent =
    opts.cache && typeof built.cacheBoundary === "number"
      ? [
          {
            type: "text" as const,
            text: built.user.slice(0, built.cacheBoundary),
            cache_control: { type: "ephemeral" as const },
          },
          {
            type: "text" as const,
            text: built.user.slice(built.cacheBoundary),
          },
        ]
      : built.user;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await anthropic().messages.create(
        {
          model,
          system: systemBlocks,
          messages: [{ role: "user", content: userContent }],
          max_tokens: 4096,
          temperature: opts.temperature ?? DEFAULT_TEMPERATURE[prompt.task],
        },
        { signal: opts.signal },
      );

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const usage: Usage = {
        promptHash: prompt.hash,
        task: prompt.task,
        model,
        tokensIn: res.usage.input_tokens,
        tokensOut: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? undefined,
        cacheCreateTokens: res.usage.cache_creation_input_tokens ?? undefined,
        latencyMs: Date.now() - started,
      };

      // Budget hook runs BEFORE parse — if the caller wants to reject
      // based on cost, they can throw here and we don't charge for a
      // potentially bad parse.
      if (opts.onUsage) await opts.onUsage(usage);

      const output = prompt.parse(text);

      // Trace hook is fire-and-forget. Errors from the hook must not
      // break the caller's request.
      if (opts.onTrace) {
        Promise.resolve(
          opts.onTrace({
            promptName: prompt.name,
            promptHash: prompt.hash,
            model,
            input,
            output,
            latencyMs: usage.latencyMs,
          }),
        ).catch((err) => console.error("[llm trace hook]", err));
      }

      return { output, usage };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxAttempts) {
        if (opts.onTrace) {
          Promise.resolve(
            opts.onTrace({
              promptName: prompt.name,
              promptHash: prompt.hash,
              model,
              input,
              output: null,
              error: err,
              latencyMs: Date.now() - started,
            }),
          ).catch(() => {
            /* swallow */
          });
        }
        throw err;
      }
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError;
}

/**
 * Streaming completion. Yields text deltas as they arrive. On completion,
 * emits a final { type: "done", text, usage, output } where text is the
 * full accumulated body, usage is the same shape as complete(), and
 * output is the prompt's parsed result.
 *
 * Streaming intentionally skips retries — a mid-stream failure is easier
 * for the caller to handle (abort, restart) than for us to resume from
 * a provider that doesn't expose resumable streams. If you need retries,
 * fall back to complete().
 */
export async function* completeStream<Input, Output>(
  prompt: Prompt<Input, Output>,
  input: Input,
  opts: CompleteOpts = {},
): AsyncGenerator<
  | { type: "delta"; text: string }
  | {
      type: "done";
      text: string;
      output: Output;
      usage: Usage;
    },
  void,
  unknown
> {
  if (prompt.task === "embedding") {
    throw new Error(
      `Prompt ${prompt.name} has task=embedding; call embed() instead.`,
    );
  }

  const model = TASK_MODELS[prompt.task];
  const built = prompt.build(input);
  const started = Date.now();

  const systemBlocks = opts.cache
    ? [
        {
          type: "text" as const,
          text: prompt.system,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : prompt.system;

  const userContent =
    opts.cache && typeof built.cacheBoundary === "number"
      ? [
          {
            type: "text" as const,
            text: built.user.slice(0, built.cacheBoundary),
            cache_control: { type: "ephemeral" as const },
          },
          {
            type: "text" as const,
            text: built.user.slice(built.cacheBoundary),
          },
        ]
      : built.user;

  const stream = anthropic().messages.stream(
    {
      model,
      system: systemBlocks,
      messages: [{ role: "user", content: userContent }],
      max_tokens: 4096,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE[prompt.task],
    },
    { signal: opts.signal },
  );

  let full = "";
  try {
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        full += event.delta.text;
        yield { type: "delta", text: event.delta.text };
      }
    }
  } catch (err) {
    if (opts.onTrace) {
      Promise.resolve(
        opts.onTrace({
          promptName: prompt.name,
          promptHash: prompt.hash,
          model,
          input,
          output: null,
          error: err,
          latencyMs: Date.now() - started,
        }),
      ).catch(() => {
        /* swallow */
      });
    }
    throw err;
  }

  const finalMessage = await stream.finalMessage();
  const usage: Usage = {
    promptHash: prompt.hash,
    task: prompt.task,
    model,
    tokensIn: finalMessage.usage.input_tokens,
    tokensOut: finalMessage.usage.output_tokens,
    cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? undefined,
    cacheCreateTokens:
      finalMessage.usage.cache_creation_input_tokens ?? undefined,
    latencyMs: Date.now() - started,
  };

  if (opts.onUsage) await opts.onUsage(usage);

  const output = prompt.parse(full);

  if (opts.onTrace) {
    Promise.resolve(
      opts.onTrace({
        promptName: prompt.name,
        promptHash: prompt.hash,
        model,
        input,
        output,
        latencyMs: usage.latencyMs,
      }),
    ).catch((err) => console.error("[llm trace hook]", err));
  }

  yield { type: "done", text: full, output, usage };
}

/**
 * Embed one or more strings. Uses OpenAI text-embedding-3-small (1536-d,
 * matches the evidence_embedding.vector column).
 */
export async function embed(
  input: string | string[],
): Promise<number[][]> {
  const items = Array.isArray(input) ? input : [input];
  const res = await openai().embeddings.create({
    model: "text-embedding-3-small",
    input: items,
  });
  return res.data.map((d) => d.embedding);
}

/* ----------------------------- retry helpers ------------------------------ */

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // 429 rate limit + 5xx server errors are transient.
    return err.status === 429 || (err.status ?? 0) >= 500;
  }
  // Network-level errors (fetch aborts, ECONNRESET) are transient too.
  if (err instanceof Error && /fetch|network|ECONNRESET|ETIMEDOUT/i.test(err.message)) {
    return true;
  }
  return false;
}

function backoffMs(attempt: number): number {
  // 500ms, 1500ms, 4500ms
  const base = 500 * Math.pow(3, attempt - 1);
  const jitter = Math.random() * 250;
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
