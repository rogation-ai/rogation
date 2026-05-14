/*
  StaleBanner — the "new evidence added, refresh to include" toast
  that sits above the Insights center pane when the corpus has moved
  ahead of the last cluster run. Design review Pass 7 locked this in
  as the cluster-ID stability UX (user controls when the view updates;
  no auto-reshuffle).

  Dismissible so returning users can scroll past it until they're
  ready to re-cluster. The refresh button is the primary action.

  Tones (added by /autoplan design review):
    - "warn" (default): the original warning posture for cluster
      staleness and partial-failure surfaces.
    - "info": neutral informational banner. Used by the spec page's
      "refinement gap" surface — telling the PM that their refined
      spec hasn't been pushed yet and links to the prior project.
      Same shape, softer visual weight.
*/

export interface StaleBannerProps {
  message: string;
  /** Label for the primary action. Default "Refresh clusters". */
  actionLabel?: string;
  onAction: () => void;
  /** Called when the user dismisses the banner. */
  onDismiss?: () => void;
  /** Whether the action is running — disables the button + shows a spinner label. */
  isRunning?: boolean;
  /**
   * Visual tone. Defaults to "warn" for backward compatibility.
   * "info" softens the action color to text-secondary so the banner
   * reads as informational, not interruptive.
   */
  tone?: "warn" | "info";
}

export function StaleBanner({
  message,
  actionLabel = "Refresh clusters",
  onAction,
  onDismiss,
  isRunning,
  tone = "warn",
}: StaleBannerProps): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-lg border px-4 py-2 text-sm"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-sunken)",
        color: "var(--color-text-primary)",
      }}
    >
      <span>{message}</span>

      <span className="flex items-center gap-3">
        <button
          type="button"
          onClick={onAction}
          disabled={isRunning}
          className="font-medium underline-offset-2 hover:underline disabled:opacity-60"
          style={{
            color:
              tone === "info"
                ? "var(--color-text-secondary)"
                : "var(--color-brand-accent)",
          }}
        >
          {isRunning ? "Refreshing…" : actionLabel}
        </button>

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="hover:opacity-80"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <svg
              viewBox="0 0 14 14"
              width="14"
              height="14"
              fill="none"
              aria-hidden
            >
              <path
                d="M3 3L11 11M11 3L3 11"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </span>
    </div>
  );
}
