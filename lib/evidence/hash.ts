import { createHash } from "node:crypto";

/*
  SHA-256 content hash for evidence deduplication.

  Paste the same interview transcript twice → second paste no-ops.
  File upload with identical contents → same deal. Dedup is scoped to
  `(account_id, content_hash)` so one tenant's evidence never masks
  another's (evidence_account_hash_idx on the schema).

  Normalization before hashing: strip BOM, normalize line endings to
  \n, trim trailing whitespace per line + one trailing newline. This
  keeps "same content saved from different editors" from duplicating.
*/

export function normalizeEvidenceText(raw: string): string {
  const body = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
  // Exactly one trailing newline on non-empty input. Keeps the hash
  // stable whether the paste source trimmed its final newline or not.
  return body.length > 0 ? `${body}\n` : "";
}

export function hashEvidenceContent(raw: string): string {
  return createHash("sha256")
    .update(normalizeEvidenceText(raw))
    .digest("hex");
}
