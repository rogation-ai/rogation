import Link from "next/link";

/*
  CitationChip — 11th primitive from DESIGN.md §6.

  Renders a spec citation as a clickable pill: severity dot + truncated
  cluster title + native tooltip with the citation note. Clicks deep-link
  to /insights?cluster=<id> so a PM reading a spec can jump straight to
  the evidence quotes that produced the claim.

  Pure presentation. Parent pre-resolves { id, title, severity } via
  `trpc.insights.byIds` — the chip itself never fetches.

  Variants:
    - Default: inline pill with title.
    - unresolved: we don't know the cluster (deleted / refined away).
      Render as a muted chip with a generic label so the spec doesn't
      look broken.
*/

export type CitationSeverity = "low" | "medium" | "high" | "critical";

export interface CitationChipProps {
  clusterId: string;
  /** Cluster title — if null, we render the "unresolved" fallback. */
  title: string | null;
  severity?: CitationSeverity;
  /** The per-citation note from the spec — tooltip only. */
  note?: string;
  /** Max characters shown before truncation. Default 32. */
  maxChars?: number;
}

const SEVERITY_COLOR: Record<CitationSeverity, string> = {
  low: "var(--color-text-tertiary)",
  medium: "var(--color-info)",
  high: "var(--color-warning)",
  critical: "var(--color-danger)",
};

export function CitationChip({
  clusterId,
  title,
  severity,
  note,
  maxChars = 32,
}: CitationChipProps): React.JSX.Element {
  const unresolved = title === null;
  const dotColor = unresolved
    ? "var(--color-border-default)"
    : SEVERITY_COLOR[severity ?? "low"];

  const label = unresolved
    ? "Cluster unavailable"
    : truncate(title, maxChars);

  const content = (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition hover:brightness-110"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
        color: unresolved
          ? "var(--color-text-tertiary)"
          : "var(--color-text-primary)",
      }}
      title={note}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: dotColor }}
      />
      <span>{label}</span>
    </span>
  );

  if (unresolved) return content;

  return (
    <Link href={`/insights?cluster=${clusterId}`} prefetch={false}>
      {content}
    </Link>
  );
}

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + "…";
}
