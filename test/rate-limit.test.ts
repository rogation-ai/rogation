import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Unit tests for the rate-limit module. Covers the fail-open path
  (dev / CI with no Upstash config) and the preset table shape.

  Full integration with a live Upstash instance isn't tested here —
  that requires real credentials + a throwaway Redis. When we wire up
  a staging Upstash project we can add a hasUpstash-gated integration
  test mirroring the tenant-iso pattern.
*/

function mockEnv(redis?: { url?: string; token?: string }) {
  vi.doMock("@/env", () => ({
    env: {
      UPSTASH_REDIS_REST_URL: redis?.url,
      UPSTASH_REDIS_REST_TOKEN: redis?.token,
      NODE_ENV: "test",
    },
  }));
}

describe("rate-limit module (no Upstash configured)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("fails OPEN when both Upstash env vars are missing", async () => {
    mockEnv();
    const mod = await import("@/lib/rate-limit");
    const result = await mod.checkLimit("checkout-create", "acc_1");

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(Number.POSITIVE_INFINITY);
    expect(result.limit).toBe(10);
  });

  it("fails OPEN when only URL is set (partial config is unsafe)", async () => {
    mockEnv({ url: "https://x.upstash.io" });
    const mod = await import("@/lib/rate-limit");
    const result = await mod.checkLimit("spec-chat", "acc_2");

    expect(result.success).toBe(true);
  });

  it("warns once per preset in dev but not on repeat calls", async () => {
    mockEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("@/lib/rate-limit");

    await mod.checkLimit("checkout-create", "acc_1");
    await mod.checkLimit("checkout-create", "acc_1");
    await mod.checkLimit("checkout-create", "acc_2");

    // One warning for this preset (first call), none for subsequent.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("checkout-create")))
      .toHaveLength(1);
    warn.mockRestore();
  });

  it("PRESETS table: every preset has requests + window", async () => {
    mockEnv();
    const { RATE_LIMIT_PRESETS } = await import("@/lib/rate-limit");
    for (const [name, cfg] of Object.entries(RATE_LIMIT_PRESETS)) {
      expect(cfg.requests, `${name} requests`).toBeGreaterThan(0);
      expect(cfg.window, `${name} window`).toMatch(/^\d+\s+(s|m|h|d)$/);
    }
  });

  it("PRESETS table: covers every rate-limited surface in the app", async () => {
    const { RATE_LIMIT_PRESETS } = await import("@/lib/rate-limit");
    expect(Object.keys(RATE_LIMIT_PRESETS).sort()).toEqual([
      "checkout-create",
      "linear-push",
      "share-link",
      "spec-chat",
      "webhook",
    ]);
  });
});
