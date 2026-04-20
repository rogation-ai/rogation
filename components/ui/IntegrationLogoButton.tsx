/*
  IntegrationLogoButton — the "Connect Zendesk", "Connect Linear",
  "Connect PostHog" tile that shows up on onboarding + the settings
  integrations screen.

  DESIGN.md §6 + §11: "Outlined button (no shadow) with monochrome
  logo + one-word label. Not a card." Deliberately flat so a row of
  six providers reads as a picker, not a cluttered marketing grid.

  Monochrome: every provider glyph here uses `currentColor` so the
  button can darken on hover without swapping icon assets. If design
  decides later to go multi-color, this is the one place to change.

  States:
    - default: outlined, clickable
    - connected: filled check dot replaces the "Connect" affordance
    - disabled: reduced opacity, not clickable (used for "coming soon"
      providers in onboarding)
*/

export type IntegrationProvider =
  | "linear"
  | "notion"
  | "zendesk"
  | "posthog"
  | "canny";

export interface IntegrationLogoButtonProps {
  provider: IntegrationProvider;
  /** Override the default label. Keep it one word. */
  label?: string;
  /** Render as connected (checkmark, no Connect affordance). */
  connected?: boolean;
  /** Disable the button (e.g. "coming soon"). */
  disabled?: boolean;
  onClick?: () => void;
}

const LABELS: Record<IntegrationProvider, string> = {
  linear: "Linear",
  notion: "Notion",
  zendesk: "Zendesk",
  posthog: "PostHog",
  canny: "Canny",
};

// Monochrome mini-glyphs. Each is 20x20, currentColor.
// Shape evokes the brand without infringing on full logos.
const GLYPHS: Record<IntegrationProvider, React.JSX.Element> = {
  // Linear — diagonal stripe
  linear: (
    <path
      d="M3 12 12 3M6 15 15 6M10 17 17 10"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      fill="none"
    />
  ),
  // Notion — rectangle with angled corner
  notion: (
    <path
      d="M4 4h9l3 3v9H4z M4 4l3 3h9"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      fill="none"
    />
  ),
  // Zendesk — two right-angle triangles
  zendesk: (
    <path
      d="M3 4h7L3 14V4Zm14 12h-7l7-10v10Z"
      fill="currentColor"
    />
  ),
  // PostHog — three stepped bars
  posthog: (
    <path
      d="M3 14V7l4 4V7l4 4V7l4 4v3H3Z"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      fill="none"
    />
  ),
  // Canny — upvote arrow in a bubble
  canny: (
    <g stroke="currentColor" strokeWidth={1.5} fill="none" strokeLinejoin="round">
      <path d="M4 5h12v9H9l-3 2v-2H4z" />
      <path d="M10 11V8M8.5 9.5 10 8l1.5 1.5" strokeLinecap="round" />
    </g>
  ),
};

export function IntegrationLogoButton({
  provider,
  label,
  connected = false,
  disabled = false,
  onClick,
}: IntegrationLogoButtonProps): React.JSX.Element {
  const displayLabel = label ?? LABELS[provider];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={connected ? `${displayLabel}, connected` : displayLabel}
      className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-raised)] disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: connected
          ? "var(--color-brand-accent)"
          : "var(--color-border-subtle)",
        color: "var(--color-text-primary)",
        background: "transparent",
      }}
    >
      <svg
        aria-hidden
        width={20}
        height={20}
        viewBox="0 0 20 20"
        className="shrink-0"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {GLYPHS[provider]}
      </svg>
      <span>{displayLabel}</span>
      {connected ? (
        <span
          aria-hidden
          className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
          style={{
            background: "var(--color-brand-accent)",
            color: "var(--color-text-inverse)",
          }}
        >
          ✓
        </span>
      ) : null}
    </button>
  );
}
