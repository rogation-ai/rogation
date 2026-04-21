import {
  MAX_FILE_BYTES,
  tooLargeResult,
  type ParserResult,
} from "./shared";

/*
  WebVTT parser. The format meeting platforms export (Zoom, Google
  Meet, Teams). Each cue is:

    00:00:01.000 --> 00:00:03.500
    <v Alice>Hello, how are you?

  We don't care about timestamps for clustering — just the spoken
  text. Speaker tags (`<v Alice>`) convert to "Alice: " prefix so
  speaker attribution survives into the evidence.

  Minimal by design. No cue IDs, no styling, no karaoke timestamps.
  Robust to CRLF line endings and missing trailing newlines.
*/

const VTT_EXT_RE = /\.vtt$/i;
const VTT_MIME_RE = /^text\/vtt$/i;

export function isVttFile(file: File): boolean {
  return VTT_MIME_RE.test(file.type) || VTT_EXT_RE.test(file.name);
}

/** Pure helper: VTT source → cleaned transcript text. Exported for tests. */
export function parseVttContent(raw: string): string {
  // Normalize line endings. Strip BOM + WEBVTT header.
  const normalized = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = normalized.split("\n");
  const out: string[] = [];
  let inCue = false;

  for (const line of lines) {
    // WEBVTT header, NOTE blocks, STYLE blocks, cue timing lines → skip
    if (/^WEBVTT\b/i.test(line)) continue;
    if (/^NOTE\b/i.test(line)) continue;
    if (/^STYLE\b/i.test(line)) continue;
    if (/-->/.test(line)) {
      // Timing line: the next non-blank lines are the cue text.
      inCue = true;
      continue;
    }

    if (line.trim() === "") {
      inCue = false;
      continue;
    }

    // A line before a timing block is a cue identifier; skip it.
    if (!inCue) continue;

    // Extract speaker from `<v Speaker Name>` tags, strip other tags.
    let text = line;
    const speakerMatch = text.match(/^<v(?:\.\w+)?\s+([^>]+)>/);
    if (speakerMatch) {
      const speaker = speakerMatch[1].trim();
      text = text.replace(/^<v(?:\.\w+)?\s+[^>]+>/, "").trim();
      text = stripTags(text);
      out.push(`${speaker}: ${text}`);
    } else {
      out.push(stripTags(text));
    }
  }

  return out.join("\n").trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

export async function parseVttFile(file: File): Promise<ParserResult> {
  if (file.size > MAX_FILE_BYTES) return tooLargeResult(file);

  const raw = await file.text();
  const text = parseVttContent(raw);

  if (!text) {
    return {
      ok: false,
      reason: "empty",
      detail: `${file.name} has no readable cue text.`,
    };
  }

  return { ok: true, text, mimeType: "text/vtt" };
}
