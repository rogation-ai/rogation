/*
  Shared types + helpers for every evidence file parser. Each concrete
  parser (text, pdf, vtt, csv) returns the same ParserResult shape so
  the upload Route Handler doesn't branch on format.
*/

export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file.

export type ParserResult =
  | { ok: true; text: string; mimeType: string }
  | {
      ok: false;
      reason: "too_large" | "unsupported" | "parse_failed" | "empty";
      detail: string;
    };

export function tooLargeResult(file: File): ParserResult {
  return {
    ok: false,
    reason: "too_large",
    detail: `${file.name} is ${formatBytes(file.size)}; max ${formatBytes(
      MAX_FILE_BYTES,
    )} per file.`,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
