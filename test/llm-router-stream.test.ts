import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { completeStream, __setProvidersForTest } from "@/lib/llm/router";
import { synthesisHello } from "@/lib/llm/prompts/synthesis-hello";

/*
  Streaming coverage for the LLM router.

  The real Anthropic stream emits `content_block_delta` events with
  `text_delta` payloads + closes with a final message. We mimic that
  minimal contract so completeStream()'s invariants are exercised:
    - Yields a {type:"delta", text} per provider delta in order.
    - Yields a single {type:"done"} at end with accumulated text +
      parsed output + usage totals.
    - Runs the prompt's parse() against the full accumulated body
      (not per-chunk) so partial JSON never throws mid-stream.
    - onUsage fires once on completion with the correct totals.
*/

type AsyncIterableStream<T> = AsyncIterable<T> & {
  finalMessage: () => Promise<Anthropic.Messages.Message>;
};

function fakeStream(
  deltas: string[],
  usage: Anthropic.Messages.Message["usage"] = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  } as Anthropic.Messages.Message["usage"],
): AsyncIterableStream<unknown> {
  const events = deltas.map((text) => ({
    type: "content_block_delta" as const,
    index: 0,
    delta: { type: "text_delta" as const, text },
  }));

  const full = deltas.join("");

  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) {
            return { done: false, value: events[i++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
    async finalMessage(): Promise<Anthropic.Messages.Message> {
      return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: full, citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      } as unknown as Anthropic.Messages.Message;
    },
  };
}

function mockAnthropicStream(stream: AsyncIterableStream<unknown>): Anthropic {
  return {
    messages: {
      stream: () => stream,
    },
  } as unknown as Anthropic;
}

describe("completeStream", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("yields each delta in order and a final done event", async () => {
    const stream = fakeStream([
      '{"greeting":',
      '"hello, ',
      'world"}',
    ]);
    __setProvidersForTest({ anthropic: mockAnthropicStream(stream) });

    const out: Array<{ type: string; text?: string }> = [];
    let done: {
      type: "done";
      text: string;
      output: { greeting: string };
      usage: { tokensIn: number; tokensOut: number };
    } | null = null;

    for await (const ev of completeStream(synthesisHello, { subject: "x" })) {
      if (ev.type === "delta") {
        out.push({ type: "delta", text: ev.text });
      } else {
        done = ev;
      }
    }

    expect(out).toEqual([
      { type: "delta", text: '{"greeting":' },
      { type: "delta", text: '"hello, ' },
      { type: "delta", text: 'world"}' },
    ]);

    expect(done).not.toBeNull();
    expect(done?.text).toBe('{"greeting":"hello, world"}');
    expect(done?.output).toEqual({ greeting: "hello, world" });
    expect(done?.usage.tokensIn).toBe(100);
    expect(done?.usage.tokensOut).toBe(20);
  });

  it("runs parse() against the full body, not each chunk", async () => {
    // Deliberately split JSON across chunks so per-chunk parsing would
    // throw. The full accumulated body is valid; completeStream must
    // only parse at the end.
    const stream = fakeStream(['{"gree', 'ting":"hi"}']);
    __setProvidersForTest({ anthropic: mockAnthropicStream(stream) });

    const it = completeStream(synthesisHello, { subject: "x" });
    const chunks: string[] = [];
    for await (const ev of it) {
      if (ev.type === "delta") chunks.push(ev.text);
    }
    expect(chunks.join("")).toBe('{"greeting":"hi"}');
  });

  it("calls onUsage once with the final totals", async () => {
    const stream = fakeStream(['{"greeting":"x"}']);
    __setProvidersForTest({ anthropic: mockAnthropicStream(stream) });

    const onUsage = vi.fn(async () => {});
    for await (const _ev of completeStream(
      synthesisHello,
      { subject: "x" },
      { onUsage },
    )) {
      /* drain */
    }
    expect(onUsage).toHaveBeenCalledOnce();
  });
});
