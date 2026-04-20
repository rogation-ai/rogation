/*
  SourceIcon — monochrome 16px glyph rendered next to evidence rows
  so PMs scanning a long list can tell at a glance which items came
  from transcripts, pasted tickets, PDFs, or integration pulls.

  Maps every `evidence_source_type` enum value to a small inline SVG.
  Monochrome by design (DESIGN.md §6): `currentColor` so the caller
  controls tone via `color` or `--color-text-secondary`, never brand
  logos (those live in IntegrationLogoButton).

  If we add a new source type to the DB enum, TypeScript will force
  us to add a glyph here — the Record<SourceType, ...> shape is the
  exhaustiveness check.
*/

export type SourceType =
  | "upload_transcript"
  | "upload_text"
  | "upload_pdf"
  | "upload_csv"
  | "paste_ticket"
  | "zendesk"
  | "posthog"
  | "canny";

export interface SourceIconProps {
  source: SourceType;
  /** Accessible label. Defaults to a human-readable source name. */
  label?: string;
  /** Size in px. Defaults to 16 per DESIGN.md §6. */
  size?: number;
}

const LABELS: Record<SourceType, string> = {
  upload_transcript: "Transcript",
  upload_text: "Text",
  upload_pdf: "PDF",
  upload_csv: "CSV",
  paste_ticket: "Pasted ticket",
  zendesk: "Zendesk",
  posthog: "PostHog",
  canny: "Canny",
};

// 16x16 viewBox, stroke width 1.5, currentColor. Kept shape-simple
// so rendering at 12-20px stays crisp without hinting hacks.
const GLYPHS: Record<SourceType, React.JSX.Element> = {
  upload_transcript: (
    <>
      <path d="M4 3h6l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M10 3v3h3" />
      <path d="M6 9h5M6 11.5h5M6 14h3" />
    </>
  ),
  upload_text: (
    <>
      <path d="M4 3h6l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M10 3v3h3" />
      <path d="M5.5 9h6M5.5 11.5h6M5.5 14h4" />
    </>
  ),
  upload_pdf: (
    <>
      <path d="M4 3h6l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M10 3v3h3" />
      <path d="M5.5 10.5h1.5a1 1 0 1 1 0 2H5.5v-2Zm0 0v3M9 10.5v3M9 12h1.5M11.5 10.5v3M11.5 10.5h1.2" />
    </>
  ),
  upload_csv: (
    <>
      <path d="M3 4h10v8H3z" />
      <path d="M3 7h10M3 10h10M6.5 4v8M9.5 4v8" />
    </>
  ),
  paste_ticket: (
    <>
      <path d="M2 6l6-3 6 3v4l-6 3-6-3V6Z" />
      <path d="M8 3v10M2 6l6 3 6-3" />
    </>
  ),
  // Zendesk = upper-right sector arc + lower-left sector arc, stylized
  zendesk: (
    <>
      <path d="M3 13 13 3v10H3Z" />
      <path d="M3 3h10L3 11V3Z" />
    </>
  ),
  // PostHog = hedgehog-ish stacked bars nod
  posthog: (
    <>
      <path d="M3 11V5l4 4V5l4 4V5l2 2v6H3Z" />
    </>
  ),
  // Canny = speech bubble with an arrow (feedback)
  canny: (
    <>
      <path d="M3 4h10v7H8l-3 2v-2H3V4Z" />
      <path d="M6 7h4M6 9h3" />
    </>
  ),
};

export function SourceIcon({
  source,
  label,
  size = 16,
}: SourceIconProps): React.JSX.Element {
  const title = label ?? LABELS[source];
  return (
    <svg
      role="img"
      aria-label={title}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block shrink-0"
    >
      <title>{title}</title>
      {GLYPHS[source]}
    </svg>
  );
}

export function sourceLabel(source: SourceType): string {
  return LABELS[source];
}
