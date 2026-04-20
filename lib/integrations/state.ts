import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/*
  Signed OAuth `state` param for CSRF protection. We don't need a
  second secret — the integration key is already available and never
  leaves the server. HMAC-SHA256 over {accountId, nonce, expiresAt}
  means an attacker can't mint a state that binds the callback to a
  different account.

  Format: base64url(JSON{accountId, nonce, exp}) . base64url(hmac)
  Expiry defaults to 10 minutes — OAuth flows that take longer than
  that are almost certainly abandoned or attacked.
*/

const TTL_MS = 10 * 60 * 1000;

function keyBytes(): Buffer {
  return Buffer.from(env.INTEGRATION_ENCRYPTION_KEY, "base64");
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface StatePayload {
  accountId: string;
  nonce: string;
  exp: number;
}

export function signState(
  accountId: string,
  now: number = Date.now(),
): string {
  const payload: StatePayload = {
    accountId,
    nonce: randomBytes(16).toString("hex"),
    exp: now + TTL_MS,
  };
  const encoded = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", keyBytes()).update(encoded).digest();
  return `${encoded}.${b64url(mac)}`;
}

export type VerifyResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyState(
  state: string,
  now: number = Date.now(),
): VerifyResult {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encoded, sig] = parts;

  const expected = createHmac("sha256", keyBytes()).update(encoded).digest();
  const got = b64urlDecode(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp < now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.accountId !== "string" || !payload.accountId) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, accountId: payload.accountId };
}
