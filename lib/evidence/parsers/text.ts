/*
  File parsers for evidence ingestion. Each parser takes a File or
  Blob (browser/Node 22 native) and returns plain UTF-8 text ready for
  normalization + hashing.

  Today: txt only. PDF / VTT / CSV land in follow-up commits with
  their respective parse libraries (pdf-parse, custom VTT, papaparse).

  Rejection up front is cheaper than pushing the file bytes through
  the ingest pipeline only to fail on an unsupported format. The
  Route Handler calls selectParser(file) to get a typed result OR a
  structured rejection the UI can render as "couldn't read this one."
*/

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB per file.

export type ParserResult =
  | { ok: true; text: string; mimeType: string }
  | { ok: false; reason: "too_large" | "unsupported"; detail: string };

/** Human-readable label for the File.type we accept as plain text. */
const TEXT_MIME_RE = /^text\/|^application\/(json|xml|x-yaml|yaml)$/i;
const TEXT_EXT_RE = /\.(txt|md|markdown|log|csv|tsv|json|xml|yaml|yml)$/i;

export async function parseTextFile(file: File): Promise<ParserResult> {
  if (file.size > MAX_TEXT_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      detail: `${file.name} is ${formatBytes(file.size)}; max ${formatBytes(
        MAX_TEXT_BYTES,
      )} per file.`,
    };
  }

  const looksLikeText =
    TEXT_MIME_RE.test(file.type) || TEXT_EXT_RE.test(file.name);

  if (!looksLikeText) {
    return {
      ok: false,
      reason: "unsupported",
      detail:
        `${file.name} (${file.type || "unknown"}) isn't supported yet. ` +
        "Text (.txt, .md) works today; PDF, VTT, CSV land in the next commit.",
    };
  }

  const text = await file.text();
  return { ok: true, text, mimeType: file.type || "text/plain" };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
