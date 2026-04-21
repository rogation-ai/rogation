import {
  MAX_FILE_BYTES,
  tooLargeResult,
  type ParserResult,
} from "./shared";

/*
  Plain-text parser: .txt, .md, .log, .json, .yaml, .xml. The most
  common uploads for PMs are raw transcripts and notes. Just read the
  file as UTF-8 and return. Hashing + normalization happen downstream
  in ingestEvidence().

  CSV used to be here too but moved to its own parser — structured
  row-by-row formatting is cleaner for LLM consumption than a raw CSV
  blob.
*/

const TEXT_MIME_RE = /^text\/|^application\/(json|xml|x-yaml|yaml)$/i;
const TEXT_EXT_RE = /\.(txt|md|markdown|log|json|xml|yaml|yml|tsv)$/i;

export function isTextFile(file: File): boolean {
  return TEXT_MIME_RE.test(file.type) || TEXT_EXT_RE.test(file.name);
}

export async function parseTextFile(file: File): Promise<ParserResult> {
  if (file.size > MAX_FILE_BYTES) return tooLargeResult(file);

  if (!isTextFile(file)) {
    return {
      ok: false,
      reason: "unsupported",
      detail: `${file.name} (${file.type || "unknown"}) isn't a plain text file.`,
    };
  }

  const text = await file.text();
  if (!text.trim()) {
    return {
      ok: false,
      reason: "empty",
      detail: `${file.name} is empty.`,
    };
  }
  return { ok: true, text, mimeType: file.type || "text/plain" };
}
