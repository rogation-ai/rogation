/*
  FeedbackThumbs — 10th shared primitive from the DESIGN.md §6 queue.

  Thumbs up / thumbs down toggle for LLM-generated entities (cluster,
  opportunity, spec). The parent owns the "current vote" state and the
  vote handler; this component is pure presentation + accessible keys.

  Design:
    - Two buttons, toggled state painted via background + border color.
    - Clicking the already-selected rating clears it (undo).
    - Keyboard: thumbs are focusable, Enter/Space toggles. No custom
      key handling — native button behavior is sufficient.
    - Compact by default; a `size="lg"` variant for feature surfaces.

  Accessibility:
    - Each button carries aria-pressed reflecting its toggled state.
    - Parents should pass a label like "Rate cluster: Onboarding is
      confusing" so screen readers have context for the generic
      thumbs icons.
*/

export type ThumbsRating = "up" | "down" | null;

export interface FeedbackThumbsProps {
  value: ThumbsRating;
  onChange: (next: ThumbsRating) => void;
  /** Screen-reader label describing what's being rated. */
  label?: string;
  size?: "sm" | "lg";
  disabled?: boolean;
}

export function FeedbackThumbs({
  value,
  onChange,
  label = "Feedback",
  size = "sm",
  disabled = false,
}: FeedbackThumbsProps): React.JSX.Element {
  const dim = size === "lg" ? "h-8 w-8 text-base" : "h-6 w-6 text-xs";

  function toggle(next: "up" | "down") {
    if (disabled) return;
    onChange(value === next ? null : next);
  }

  return (
    <div
      className="inline-flex items-center gap-1"
      role="group"
      aria-label={label}
    >
      <ThumbButton
        icon="up"
        dim={dim}
        active={value === "up"}
        disabled={disabled}
        onClick={() => toggle("up")}
        label={`${label}: thumbs up`}
      />
      <ThumbButton
        icon="down"
        dim={dim}
        active={value === "down"}
        disabled={disabled}
        onClick={() => toggle("down")}
        label={`${label}: thumbs down`}
      />
    </div>
  );
}

function ThumbButton({
  icon,
  active,
  disabled,
  onClick,
  dim,
  label,
}: {
  icon: "up" | "down";
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  dim: string;
  label: string;
}): React.JSX.Element {
  const activeFg =
    icon === "up" ? "var(--color-success)" : "var(--color-danger)";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      className={`${dim} inline-flex items-center justify-center rounded-md border transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40`}
      style={{
        borderColor: active ? activeFg : "var(--color-border-subtle)",
        background: active
          ? `color-mix(in srgb, ${activeFg} 12%, transparent)`
          : "var(--color-surface-raised)",
        color: active ? activeFg : "var(--color-text-tertiary)",
      }}
    >
      {icon === "up" ? "▲" : "▼"}
    </button>
  );
}
