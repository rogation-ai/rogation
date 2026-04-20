/*
  ConfidenceBadge — paired with every ranked opportunity + spec
  readiness. Three buckets (Low / Medium / High) map from a 0-1 float
  to the closest band so downstream callers don't repeat threshold math.
*/

export interface ConfidenceBadgeProps {
  /** 0.0 - 1.0 confidence score from the LLM router. */
  score: number;
  /** Optional short explanation rendered as a title tooltip. */
  explanation?: string;
}

export function ConfidenceBadge({
  score,
  explanation,
}: ConfidenceBadgeProps): React.JSX.Element {
  const band = bandForConfidence(score);

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
        color: "var(--color-text-primary)",
      }}
      title={explanation}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: band.dot }}
      />
      <span>Confidence</span>
      <span style={{ color: band.labelColor }}>{band.label}</span>
    </span>
  );
}

/* ---------------------------- pure helpers ---------------------------- */

export type ConfidenceLabel = "Low" | "Medium" | "High";

/**
 * Maps a 0..1 score to a human-readable band + matching design tokens.
 * Pure, unit tested.
 */
export function bandForConfidence(score: number): {
  label: ConfidenceLabel;
  dot: string;
  labelColor: string;
} {
  const clamped = Math.max(0, Math.min(1, score));
  if (clamped >= 0.75) {
    return {
      label: "High",
      dot: "var(--color-success)",
      labelColor: "var(--color-success)",
    };
  }
  if (clamped >= 0.45) {
    return {
      label: "Medium",
      dot: "var(--color-warning)",
      labelColor: "var(--color-warning)",
    };
  }
  return {
    label: "Low",
    dot: "var(--color-text-tertiary)",
    labelColor: "var(--color-text-tertiary)",
  };
}
