import Papa from "papaparse";
import {
  MAX_FILE_BYTES,
  tooLargeResult,
  type ParserResult,
} from "./shared";

/*
  CSV parser. Zendesk, Airtable, Google Sheets exports all land here.

  A raw CSV blob is bad LLM input: `foo,"bar, baz",1\n...` is hard for
  the model to reason about. Reformat to one "Key: value" row per
  record so each data point reads like a natural sentence.

    Header row: [Ticket, Subject, Priority]
    Row 1:      [T-123, "Export fails", High]
    →
    Ticket: T-123
    Subject: Export fails
    Priority: High

  Rows with no header (headerless CSV) get column indexes as keys.
  Trailing empty cells are dropped. Papa handles quote escapes + CRLF.

  Cap at 500 rows per file. Anything larger is a data dump, not
  evidence — users should pre-filter in their spreadsheet tool.
*/

const CSV_EXT_RE = /\.(csv|tsv)$/i;
const CSV_MIME_RE = /^text\/csv$|^application\/csv$|^text\/tab-separated-values$/i;
const MAX_ROWS = 500;

export function isCsvFile(file: File): boolean {
  return CSV_MIME_RE.test(file.type) || CSV_EXT_RE.test(file.name);
}

/** Pure helper: CSV source → "Key: value" formatted text. Exported for tests. */
export function parseCsvContent(raw: string, filename = "csv"): string {
  const isTsv = /\.tsv$/i.test(filename);
  const parsed = Papa.parse<string[]>(raw.trim(), {
    skipEmptyLines: true,
    delimiter: isTsv ? "\t" : undefined,
  });

  const rows = parsed.data.filter(
    (r): r is string[] => Array.isArray(r) && r.length > 0,
  );
  if (rows.length === 0) return "";

  const [maybeHeader, ...dataRows] = rows;
  const hasHeader = looksLikeHeader(maybeHeader);
  const headers = hasHeader
    ? maybeHeader.map((h) => h.trim() || "column")
    : maybeHeader.map((_, i) => `Column ${i + 1}`);
  const records = hasHeader ? dataRows : rows;

  const out: string[] = [];
  for (const row of records.slice(0, MAX_ROWS)) {
    const lines: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const val = (row[i] ?? "").trim();
      if (!val) continue;
      const key = headers[i] ?? `Column ${i + 1}`;
      lines.push(`${key}: ${val}`);
    }
    if (lines.length > 0) out.push(lines.join("\n"));
  }

  return out.join("\n\n");
}

function looksLikeHeader(row: string[]): boolean {
  // Heuristic: if every cell is short and non-numeric, treat as header.
  return row.every(
    (cell) => cell.length > 0 && cell.length < 80 && !isNumeric(cell),
  );
}

function isNumeric(s: string): boolean {
  if (!s) return false;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n);
}

export async function parseCsvFile(file: File): Promise<ParserResult> {
  if (file.size > MAX_FILE_BYTES) return tooLargeResult(file);

  const raw = await file.text();
  const text = parseCsvContent(raw, file.name);

  if (!text) {
    return {
      ok: false,
      reason: "empty",
      detail: `${file.name} has no readable rows.`,
    };
  }

  return { ok: true, text, mimeType: file.type || "text/csv" };
}
