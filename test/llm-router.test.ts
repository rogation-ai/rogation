import { beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { complete, __setProvidersForTest } from "@/lib/llm/router";
import { synthesisHello } from "@/lib/llm/prompts/synthesis-hello";
import type { Usage } from "@/lib/llm/router";

/*
  Router unit tests. Mocks the Anthropic provider so tests run fast +
  deterministic, no API key needed. Covers:
  - Happy path: typed output + usage payload.
  - Task -> model mapping: synthesis routes to Sonnet 4.6.
  - Prompt hash stability: same template -> same hash.
  - Budget hook: called with usage; throwing aborts.
  - cache_control injection when cache=true.
  - Retry on 429 with eventual success.
*/

type MessageCreate = Anthropic["messages"]["create"];

function mockAnthropic(create: MessageCreate): Anthropic {
  // We only use `messages.create`, so a minimal stub satisfies the
  // parts of the SDK the router touches. Cast through unknown because
  // Anthropic's class has ~30 other methods we don't exercise.
  return {
    messages: { create },
  } as unknown as Anthropic;
}

function fakeResponse(text: string, overrides: Partial<Anthropic.Messages.Message> = {}) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    content: [{ type: "text" as const, text, citations: null }],
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 42,
      output_tokens: 8,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
    ...overrides,
  } as unknown as Anthropic.Messages.Message;
}

describe("llm router", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prompt hash is stable across calls (content-addressed)", () => {
    expect(synthesisHello.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(synthesisHello.hash).toBe(synthesisHello.hash);
  });

  it("routes synthesis tasks to Sonnet 4.6", async () => {
    const create = vi.fn(async () =>
      fakeResponse(JSON.stringify({ greeting: "hello, world" })),
    ) as unknown as MessageCreate;
    __setProvidersForTest({ anthropic: mockAnthropic(create) });

    const { output } = await complete(synthesisHello, { subject: "world" });
    expect(output).toEqual({ greeting: "hello, world" });

    const call = (create as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.model).toBe("claude-sonnet-4-6");
  });

  it("invokes the budget hook with token counts + prompt hash", async () => {
    const create = vi.fn(async () =>
      fakeResponse(JSON.stringify({ greeting: "hi" })),
    ) as unknown as MessageCreate;
    __setProvidersForTest({ anthropic: mockAnthropic(create) });

    const onUsage = vi.fn<(u: Usage) => void>();
    await complete(synthesisHello, { subject: "x" }, { onUsage });

    expect(onUsage).toHaveBeenCalledOnce();
    const usage = onUsage.mock.calls[0]?.[0];
    expect(usage?.promptHash).toBe(synthesisHello.hash);
    expect(usage?.task).toBe("synthesis");
    expect(usage?.tokensIn).toBe(42);
    expect(usage?.tokensOut).toBe(8);
  });

  it("a thrown budget hook aborts the call (caller never sees output)", async () => {
    const create = vi.fn(async () =>
      fakeResponse(JSON.stringify({ greeting: "hi" })),
    ) as unknown as MessageCreate;
    __setProvidersForTest({ anthropic: mockAnthropic(create) });

    const onUsage = vi.fn(() => {
      throw new Error("over budget");
    });

    await expect(
      complete(synthesisHello, { subject: "x" }, { onUsage }),
    ).rejects.toThrow("over budget");
  });

  it("injects cache_control on system when cache=true", async () => {
    const create = vi.fn(async () =>
      fakeResponse(JSON.stringify({ greeting: "hi" })),
    ) as unknown as MessageCreate;
    __setProvidersForTest({ anthropic: mockAnthropic(create) });

    await complete(synthesisHello, { subject: "x" }, { cache: true });

    const arg = (create as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(Array.isArray(arg?.system)).toBe(true);
    expect(arg?.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("retries on 429 and succeeds on the second attempt", async () => {
    let attempts = 0;
    const create = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Anthropic.APIError(429, { error: "rate_limited" }, "rate limited", new Headers());
      }
      return fakeResponse(JSON.stringify({ greeting: "after-retry" }));
    }) as unknown as MessageCreate;
    __setProvidersForTest({ anthropic: mockAnthropic(create) });

    const { output } = await complete(
      synthesisHello,
      { subject: "retry" },
      { maxAttempts: 2 },
    );

    expect(output).toEqual({ greeting: "after-retry" });
    expect(attempts).toBe(2);
  }, 10_000);

  it("does not retry on 4xx other than 429 (bad request is caller's problem)", async () => {
    let attempts = 0;
    const create = vi.fn(async () => {
      attempts++;
      throw new Anthropic.APIError(400, { error: "bad_request" }, "bad request", new Headers());
    }) as unknown as MessageCreate;
    __setProvidersForTest({ anthropic: mockAnthropic(create) });

    await expect(
      complete(synthesisHello, { subject: "x" }, { maxAttempts: 3 }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
