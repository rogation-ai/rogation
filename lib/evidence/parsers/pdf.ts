import type { PDFParse as PDFParseType } from "pdf-parse";
import {
  MAX_FILE_BYTES,
  tooLargeResult,
  type ParserResult,
} from "./shared";

/*
  PDF parser. User-research reports, interview transcripts, internal
  docs — the #1 thing PMs try to upload. Uses pdf-parse (v2.x, which
  wraps pdfjs-dist) to extract text from the document.

  Caveats (documented, not fixed in v1):
    - Scanned PDFs (images, no text layer) return empty. We error
      cleanly so the user knows to OCR first.
    - Multi-column layouts can interleave columns; for clustering
      that's usually fine since the LLM sees the full blob.
    - Encrypted/password-protected PDFs throw inside pdf-parse.
      We surface a typed parse_failed error.
*/

const PDF_EXT_RE = /\.pdf$/i;
const PDF_MIME_RE = /^application\/pdf$/i;

export function isPdfFile(file: File): boolean {
  return PDF_MIME_RE.test(file.type) || PDF_EXT_RE.test(file.name);
}

export async function parsePdfFile(file: File): Promise<ParserResult> {
  if (file.size > MAX_FILE_BYTES) return tooLargeResult(file);

  let parser: PDFParseType | null = null;
  try {
    // Deferred import: pdf-parse pulls in pdfjs-dist, which can fail to
    // initialize in the route's runtime. Loading it lazily keeps that
    // failure scoped to actual PDF uploads instead of crashing the
    // route module for every file (including .txt).
    const { PDFParse } = await import("pdf-parse");
    const data = new Uint8Array(await file.arrayBuffer());
    parser = new PDFParse({ data });
    const result = await parser.getText();
    const text = result.text.trim();

    if (!text) {
      return {
        ok: false,
        reason: "empty",
        detail: `${file.name} contains no extractable text. Is it a scanned image? Run it through OCR first.`,
      };
    }

    return { ok: true, text, mimeType: "application/pdf" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      reason: "parse_failed",
      detail: `Couldn't parse ${file.name}: ${msg}. Is it password-protected?`,
    };
  } finally {
    // Release pdfjs worker + document handles so serverless invocations
    // don't leak memory across requests.
    await parser?.destroy().catch(() => {});
  }
}
