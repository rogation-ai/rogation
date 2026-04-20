/*
  Pure helper: split a plain-text evidence payload into per-block
  chunks. Used when a PM uploads a .txt or .md dump where each
  paragraph-separated block is its own piece of evidence (e.g. a
  hand-curated list of 20 support tickets).

  Rules:
    - Split on one or more fully blank lines (two consecutive newlines
      with only whitespace between). Single newlines stay intact so
      transcripts with speaker turns aren't mangled when the checkbox
      is accidentally left on.
    - Trim each block; drop empties.
    - Hard cap at MAX_BLOCKS so a pathological file can't blow up the
      plan meter + Inngest queue.
    - If the input has no blank-line separators, return a single
      block (the whole text). The upload path treats this the same as
      "split off", so the checkbox being on doesn't silently break a
      single-block file.
*/

const BLANK_LINE_RE = /\n\s*\n+/;

/** Max evidence rows producible from one file when splitting. */
export const MAX_BLOCKS = 100;

export interface SplitBlock {
  /** 1-indexed position in the source file (for sourceRef + UI). */
  index: number;
  text: string;
}

export function splitIntoBlocks(text: string): SplitBlock[] {
  if (!text || !text.trim()) return [];

  const raw = text.split(BLANK_LINE_RE);
  const blocks: SplitBlock[] = [];
  for (const chunk of raw) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    blocks.push({ index: blocks.length + 1, text: trimmed });
    if (blocks.length >= MAX_BLOCKS) break;
  }

  return blocks;
}
