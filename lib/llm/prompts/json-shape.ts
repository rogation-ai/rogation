/*
  Shape validators shared across every prompt's parse() step.

  Prompts return raw model text. Each parse() needs to:
    1. Strip an errant ```json fence (models sometimes add one despite
       SYSTEM rules).
    2. JSON.parse.
    3. Narrow unknown fields into typed values, throwing on schema drift.

  Extracted here so synthesis-cluster, synthesis-incremental, and any
  future JSON-returning prompt share the same shape of error messages
  and the same fence-stripping behavior.

  Scope boundary: these helpers do JSON-level checks only ("is this a
  string", "is this a severity"). Cross-reference checks that need
  runtime context (label-space resolution, duplicate-assignment guards)
  live in lib/evidence/clustering/validators.ts. Different layer.
*/

export type Severity = "low" | "medium" | "high" | "critical";

/**
 * Pulls the first JSON object out of the raw text. Tolerates a stray
 * markdown fence. Throws on unparseable output.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch?.[1]?.trim() ?? trimmed;
  return JSON.parse(candidate);
}

export function asString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${path}: expected non-empty string`);
  }
  return v;
}

/** String or null — for "optional" fields the LLM may omit by emitting null. */
export function asStringOrNull(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${path}: expected non-empty string or null`);
  }
  return v;
}

export function asSeverity(v: unknown, path: string): Severity {
  if (v === "low" || v === "medium" || v === "high" || v === "critical") {
    return v;
  }
  throw new Error(`${path}: expected severity enum, got ${String(v)}`);
}

export function asStringArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`${path}: expected string[]`);
  }
  return v as string[];
}

export function asObject(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${path}: expected object`);
  }
  return v as Record<string, unknown>;
}

export function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new Error(`${path}: expected array`);
  }
  return v;
}

/**
 * Escape the 4 XML-meaningful characters. Safe for use inside attribute
 * values and for tag names. CDATA'd content does NOT need this — use
 * `cdataEscape` for the CDATA case.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape the ONE string that can break a CDATA section: `]]>`.
 *
 * CDATA has no escape character. The standard trick is to split the
 * literal `]]>` into two CDATA sections by closing after `]]`, then
 * opening a new CDATA section and continuing with `>`. The model sees
 * the concatenated content as if nothing happened.
 *
 * Why this matters: our prompts wrap user-submitted evidence in
 * `<![CDATA[${content}]]>`. Without this escape, a PM pasting a
 * Zendesk ticket that happens to contain `]]>` (easy to trigger in
 * code samples, JSON blobs, regex docs) closes the CDATA early.
 * Everything after the `]]>` becomes plain prompt text — a prompt
 * injection surface that the SYSTEM's "trust boundary" language
 * claims to defend against but can't without this escape.
 */
export function cdataEscape(s: string): string {
  return s.split("]]>").join("]]]]><![CDATA[>");
}
