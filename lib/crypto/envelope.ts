import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/env";

/*
  AES-256-GCM envelope for OAuth access tokens stored in
  integration_credential. One key today (INTEGRATION_ENCRYPTION_KEY,
  base64-encoded 32 bytes). kek_version on the row is wired for future
  rotation without a schema change: add a second key, fall back in
  decrypt(), rewrite rows at leisure.

  Why GCM: authenticated. A flipped ciphertext byte throws instead of
  silently producing a garbage token that then fails auth downstream
  in a confusing way.
*/

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard — 96 bits

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = Buffer.from(env.INTEGRATION_ENCRYPTION_KEY, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${raw.length}). Generate with: openssl rand -base64 32`,
    );
  }
  cachedKey = raw;
  return raw;
}

export interface EncryptedBlob {
  ciphertext: string;
  nonce: string;
}

export function encrypt(plaintext: string): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]).toString("base64"),
    nonce: iv.toString("base64"),
  };
}

export function decrypt(blob: EncryptedBlob): string {
  const iv = Buffer.from(blob.nonce, "base64");
  const buf = Buffer.from(blob.ciphertext, "base64");
  // last 16 bytes are the GCM auth tag
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8",
  );
}
