/*
  FrequencyBar — 12th primitive from DESIGN.md §6.

  Horizontal bar showing a cluster's evidence frequency relative to the
  max frequency in the current view. Not a progress bar (no "until
  complete" semantics) and not a histogram (single-row only) — just a
  visual signal of "this cluster represents the most pain."

  Pure presentation. Callers compute the max across their list once and
  pass it in, so bars are comparable across rows rendered in the same
  set.

  Variants:
    - Default: compact for dense cluster lists.
    - size="lg": taller, for detail headers.
*/

export interface FrequencyBarProps {
  /** This row's frequency count. Clamped to >= 0. */
  value: number;
  /** Max across the visible set. Bars scale value/max. */
  max: number;
  size?: "sm" | "lg";
  /** Optional label — rendered below the bar in muted text. */
  label?: string;
  /** aria-label override; defaults to "Frequency: N of M". */
  ariaLabel?: string;
}

export function FrequencyBar({
  value,
  max,
  size = "sm",
  label,
  ariaLabel,
}: FrequencyBarProps): React.JSX.Element {
  const pct = percentFor(value, max);
  const height = size === "lg" ? "h-2" : "h-1";

  return (
    <div
      role="meter"
      aria-valuenow={Math.max(0, value)}
      aria-valuemin={0}
      aria-valuemax={Math.max(value, max, 1)}
      aria-label={ariaLabel ?? `Frequency: ${value} of ${max}`}
      className="flex flex-col gap-1"
    >
      <div
        className={`${height} w-full overflow-hidden rounded-full`}
        style={{ background: "var(--color-border-subtle)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{
            width: `${pct}%`,
            background: "var(--color-brand-accent)",
          }}
        />
      </div>
      {label && (
        <span
          className="text-[10px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

/**
 * Pure: value/max as a 0-100 percent, clamped. Used by the component;
 * exported for the unit test so callers can't drift from the rule.
 *
 * Special cases:
 *   - max <= 0 → 0% (avoid div-by-zero; nothing to show).
 *   - value < 0 → 0% (guard bad input).
 *   - value > max → 100% (should not happen if callers passed the real max,
 *     but we clamp so a buggy caller doesn't overflow the bar).
 */
export function percentFor(value: number, max: number): number {
  if (max <= 0 || !Number.isFinite(max)) return 0;
  if (value <= 0 || !Number.isFinite(value)) return 0;
  if (value >= max) return 100;
  return Math.round((value / max) * 100);
}
