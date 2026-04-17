import { Langfuse } from "langfuse";
import { env } from "@/env";
import type { TraceEvent } from "@/lib/llm/router";

/*
  Langfuse wrapper for the LLM router's onTrace hook.

  Every LLM call becomes a Langfuse trace with:
  - Prompt name + hash (so eval regressions pinpoint the version).
  - Input + output payloads (for debugging).
  - Usage + latency.
  - Account + user attribution when the caller provides it.

  Gracefully no-ops when both keys aren't set, so dev works without a
  Langfuse project. The module-level singleton is lazy — never
  instantiated if the env config isn't complete.

  Why module-level singleton rather than per-request:
  - Langfuse client batches events in memory and flushes periodically.
    Creating a new client per request leaves events un-flushed when
    the process dies.
  - One client is safe to share — its queue is thread-local to the
    Node runtime and we're not multi-tenant at the client level.
*/

let client: Langfuse | null = null;

function getClient(): Langfuse | null {
  if (!env.LANGFUSE_SECRET_KEY || !env.LANGFUSE_PUBLIC_KEY) {
    return null;
  }
  if (client) return client;
  client = new Langfuse({
    secretKey: env.LANGFUSE_SECRET_KEY,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    baseUrl: env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
    // Short batching so traces show up quickly during dev. Production
    // can tune higher if volume spikes.
    flushAt: 5,
    flushInterval: 5_000,
  });
  return client;
}

export interface TraceContext {
  accountId: string;
  userId: string;
}

/**
 * Capture one LLM call as a Langfuse trace. Safe to call when the
 * client isn't configured — no-ops. Errors inside this function never
 * propagate: tracing is a best-effort side-channel, not part of the
 * caller's contract.
 */
export function traceLLM<Input, Output>(
  event: TraceEvent<Input, Output>,
  ctx: TraceContext,
): void {
  const c = getClient();
  if (!c) return;

  try {
    const trace = c.trace({
      name: event.promptName,
      userId: ctx.userId,
      metadata: {
        accountId: ctx.accountId,
        promptHash: event.promptHash,
      },
      tags: [event.promptName, event.model],
    });

    const generation = trace.generation({
      name: event.promptName,
      model: event.model,
      input: event.input,
      output: event.output,
      startTime: new Date(Date.now() - event.latencyMs),
      endTime: new Date(),
    });

    if (event.error) {
      generation.end({
        level: "ERROR",
        statusMessage:
          event.error instanceof Error
            ? event.error.message
            : String(event.error),
      });
    }
  } catch (err) {
    // Tracing is best-effort. A dropped trace never breaks the caller.
    // eslint-disable-next-line no-console
    console.error("[langfuse trace]", err);
  }
}

/**
 * Flush pending traces to Langfuse. Call at request-teardown in
 * webhook / serverless handlers so the container doesn't die with
 * events in the queue.
 */
export async function flushLangfuse(): Promise<void> {
  if (!client) return;
  await client.shutdownAsync();
}
