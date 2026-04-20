import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Unit coverage for the AES-256-GCM envelope helper. Locks down:
  - roundtrip correctness on ASCII + UTF-8 + long plaintext
  - every encrypt() produces a fresh nonce (IVs never repeat)
  - decrypt() throws on a flipped ciphertext byte (GCM auth tag)
  - decrypt() throws on a flipped nonce (tag binds to the IV)
  - the key-length guard rejects malformed keys clearly

  Keeps the spec for "a swapped KEK never silently yields garbage"
  enforced — if someone drops in a broken rotation we hear about it.
*/

const VALID_KEY_B64 = Buffer.alloc(32, 7).toString("base64"); // 32 bytes of 0x07

function mockEnv(keyB64: string) {
  vi.doMock("@/env", () => ({
    env: { INTEGRATION_ENCRYPTION_KEY: keyB64 },
  }));
}

describe("envelope encrypt/decrypt", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("@/env"));

  it("roundtrips ASCII", async () => {
    mockEnv(VALID_KEY_B64);
    const { encrypt, decrypt } = await import("@/lib/crypto/envelope");
    const blob = encrypt("hello world");
    expect(decrypt(blob)).toBe("hello world");
  });

  it("roundtrips UTF-8 emoji + non-ASCII", async () => {
    mockEnv(VALID_KEY_B64);
    const { encrypt, decrypt } = await import("@/lib/crypto/envelope");
    const input = "café → 🔒 token_abc123";
    const blob = encrypt(input);
    expect(decrypt(blob)).toBe(input);
  });

  it("roundtrips a long token (~2KB)", async () => {
    mockEnv(VALID_KEY_B64);
    const { encrypt, decrypt } = await import("@/lib/crypto/envelope");
    const input = "x".repeat(2048);
    expect(decrypt(encrypt(input))).toBe(input);
  });

  it("each call produces a fresh nonce", async () => {
    mockEnv(VALID_KEY_B64);
    const { encrypt } = await import("@/lib/crypto/envelope");
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("decrypt throws on flipped ciphertext byte", async () => {
    mockEnv(VALID_KEY_B64);
    const { encrypt, decrypt } = await import("@/lib/crypto/envelope");
    const blob = encrypt("secret");
    const buf = Buffer.from(blob.ciphertext, "base64");
    buf[0] = buf[0] ^ 0xff;
    expect(() =>
      decrypt({ ciphertext: buf.toString("base64"), nonce: blob.nonce }),
    ).toThrow();
  });

  it("decrypt throws on flipped nonce", async () => {
    mockEnv(VALID_KEY_B64);
    const { encrypt, decrypt } = await import("@/lib/crypto/envelope");
    const blob = encrypt("secret");
    const nonceBuf = Buffer.from(blob.nonce, "base64");
    nonceBuf[0] = nonceBuf[0] ^ 0xff;
    expect(() =>
      decrypt({ ciphertext: blob.ciphertext, nonce: nonceBuf.toString("base64") }),
    ).toThrow();
  });

  it("rejects a wrong-length key with a clear error", async () => {
    mockEnv(Buffer.alloc(16).toString("base64")); // 16 bytes, not 32
    const { encrypt } = await import("@/lib/crypto/envelope");
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });
});
