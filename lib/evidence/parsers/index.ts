import { isCsvFile, parseCsvFile } from "./csv";
import { isPdfFile, parsePdfFile } from "./pdf";
import { isTextFile, parseTextFile } from "./text";
import { isVttFile, parseVttFile } from "./vtt";
import type { ParserResult } from "./shared";

/*
  Parser dispatcher. Given a File, pick the right parser by extension
  or mime type and return a uniform ParserResult. The upload Route
  Handler calls this once per file — every format goes through one
  shared ingest pipeline downstream.

  Order matters: check the most specific parsers first (PDF, VTT, CSV
  all have dedicated handling) and fall back to plain-text reading
  last. An unknown extension that looks like text still parses.
*/

export type { ParserResult } from "./shared";
export { MAX_FILE_BYTES } from "./shared";

export async function parseEvidenceFile(file: File): Promise<ParserResult> {
  if (isPdfFile(file)) return parsePdfFile(file);
  if (isVttFile(file)) return parseVttFile(file);
  if (isCsvFile(file)) return parseCsvFile(file);
  if (isTextFile(file)) return parseTextFile(file);

  return {
    ok: false,
    reason: "unsupported",
    detail: `${file.name} (${file.type || "unknown"}) isn't a supported format. Try .txt, .md, .pdf, .vtt, or .csv.`,
  };
}

/** Convenience export for the upload UI accept= attribute. */
export const SUPPORTED_EXTENSIONS =
  ".txt,.md,.markdown,.log,.pdf,.vtt,.csv,.tsv,.json,.xml,.yaml,.yml";
