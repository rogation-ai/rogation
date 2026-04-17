/*
  SeverityPill — the small indicator next to every clustered pain
  point (Insights screen left rail, center-pane metadata strip).
  Maps the severity enum to the DESIGN.md severity color scale so
  the palette has one source of truth.
*/

export type Severity = "low" | "medium" | "high" | "critical";

export interface SeverityPillProps {
  severity: Severity;
  /** Optional count beside the label (e.g. "High · 34"). */
  count?: number;
}

const LABELS: Record<Severity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const DOT_COLORS: Record<Severity, string> = {
  low: "var(--color-severity-low)",
  medium: "var(--color-severity-medium)",
  high: "var(--color-severity-high)",
  critical: "var(--color-severity-critical)",
};

export function SeverityPill({
  severity,
  count,
}: SeverityPillProps): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
        color: "var(--color-text-primary)",
      }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: DOT_COLORS[severity] }}
      />
      {LABELS[severity]}
      {typeof count === "number" && (
        <span style={{ color: "var(--color-text-tertiary)" }}>
          · {count}
        </span>
      )}
    </span>
  );
}
