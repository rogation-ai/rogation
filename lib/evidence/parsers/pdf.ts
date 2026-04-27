import {
  MAX_FILE_BYTES,
  tooLargeResult,
  type ParserResult,
} from "./shared";

/*
  PDF parser. User-research reports, interview transcripts, internal
  docs — the #1 thing PMs try to upload. Uses `unpdf`, a serverless-
  native fork of pdfjs-dist that ships pre-bundled without DOM
  globals (DOMMatrix / ImageData / Path2D) or @napi-rs/canvas. Works
  inside Vercel's Node functions where vanilla pdfjs-dist v4+ throws.

  Caveats (documented, not fixed in v1):
    - Scanned PDFs (images, no text layer) return empty. We error
      cleanly so the user knows to OCR first.
    - Multi-column layouts can interleave columns; for clustering
      that's usually fine since the LLM sees the full blob.
    - Encrypted/password-protected PDFs throw inside unpdf. We
      surface a typed parse_failed error.
*/

const PDF_EXT_RE = /\.pdf$/i;
const PDF_MIME_RE = /^application\/pdf$/i;

export function isPdfFile(file: File): boolean {
  return PDF_MIME_RE.test(file.type) || PDF_EXT_RE.test(file.name);
}

export async function parsePdfFile(file: File): Promise<ParserResult> {
  if (file.size > MAX_FILE_BYTES) return tooLargeResult(file);

  try {
    // Deferred import keeps any unpdf load failure scoped to actual
    // PDF uploads instead of crashing the route module for every file.
    const { extractText, getDocumentProxy } = await import("unpdf");
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(data);
    const { text } = await extractText(pdf, { mergePages: true });
    const trimmed = (Array.isArray(text) ? text.join("\n") : text).trim();

    if (!trimmed) {
      return {
        ok: false,
        reason: "empty",
        detail: `${file.name} contains no extractable text. Is it a scanned image? Run it through OCR first.`,
      };
    }

    return { ok: true, text: trimmed, mimeType: "application/pdf" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      reason: "parse_failed",
      detail: `Couldn't parse ${file.name}: ${msg}. Is it password-protected?`,
    };
  }
}
