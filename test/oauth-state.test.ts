import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Unit coverage for the signed OAuth state helper. Locks down:
  - signState → verifyState roundtrip carries the accountId
  - bad signatures fail verify (one byte flipped anywhere)
  - malformed state strings fail verify (wrong segment count,
    garbage base64, non-JSON payload)
  - expired tokens fail verify deterministically via injected clock
  - two calls produce distinct states (nonce prevents replay
    detection ambiguity)

  These tests are the reason we can trust `state.accountId` in the
  OAuth callback — the integrity check is unit-verified here rather
  than implicitly trusted.
*/

const VALID_KEY_B64 = Buffer.alloc(32, 3).toString("base64");

function mockEnv() {
  vi.doMock("@/env", () => ({
    env: { INTEGRATION_ENCRYPTION_KEY: VALID_KEY_B64 },
  }));
}

describe("oauth signed state", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("@/env"));

  it("roundtrips accountId", async () => {
    mockEnv();
    const { signState, verifyState } = await import("@/lib/integrations/state");
    const s = signState("acc-123");
    const v = verifyState(s);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.accountId).toBe("acc-123");
  });

  it("rejects a flipped signature", async () => {
    mockEnv();
    const { signState, verifyState } = await import("@/lib/integrations/state");
    const s = signState("acc-123");
    const [payload, sig] = s.split(".");
    const flipped =
      sig.slice(0, -2) + (sig.slice(-2) === "AA" ? "BB" : "AA");
    const v = verifyState(`${payload}.${flipped}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_signature");
  });

  it("rejects malformed shape (wrong segment count)", async () => {
    mockEnv();
    const { verifyState } = await import("@/lib/integrations/state");
    const v = verifyState("only-one-segment");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("malformed");
  });

  it("rejects expired state via injected clock", async () => {
    mockEnv();
    const { signState, verifyState } = await import("@/lib/integrations/state");
    const now = Date.now();
    const s = signState("acc-x", now);
    // 11 minutes later — TTL is 10
    const v = verifyState(s, now + 11 * 60 * 1000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("rejects garbage JSON payload with valid-looking shape", async () => {
    mockEnv();
    const { verifyState } = await import("@/lib/integrations/state");
    // valid-looking two segments but payload is not JSON
    const v = verifyState("notjson.notsig");
    expect(v.ok).toBe(false);
  });

  it("two calls for same accountId produce distinct states", async () => {
    mockEnv();
    const { signState } = await import("@/lib/integrations/state");
    const a = signState("acc-z");
    const b = signState("acc-z");
    expect(a).not.toBe(b);
  });
});
