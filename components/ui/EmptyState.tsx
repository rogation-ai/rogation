/*
  EmptyState — the shared "you haven't done this yet" component.
  Lives on every list surface (Evidence library, Insights, What to
  build, Outcomes).

  Design review decision: empty states are features, not fallbacks.
  Every empty state needs warmth, a primary action, and context.
  This component enforces that shape via required props.
*/

export interface EmptyStateProps {
  /** One-line headline in display type. */
  title: string;
  /** 1-2 sentence context explaining why it's empty + what to do. */
  description: string;
  /** Primary CTA — what the user should do next. */
  primaryAction: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  /** Secondary action — commonly "Use sample data" on onboarding surfaces. */
  secondaryAction?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
}

export function EmptyState({
  title,
  description,
  primaryAction,
  secondaryAction,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className="mx-auto flex max-w-md flex-col items-start gap-3 rounded-xl border px-6 py-10"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <h2
        className="text-2xl tracking-tight"
        style={{
          fontFamily: "var(--font-display)",
          color: "var(--color-text-primary)",
        }}
      >
        {title}
      </h2>
      <p
        className="text-sm leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {description}
      </p>
      <div className="mt-3 flex items-center gap-4">
        <ActionButton {...primaryAction} kind="primary" />
        {secondaryAction && <ActionButton {...secondaryAction} kind="link" />}
      </div>
    </div>
  );
}

interface ActionProps {
  label: string;
  onClick?: () => void;
  href?: string;
  kind: "primary" | "link";
}

function ActionButton({ label, onClick, href, kind }: ActionProps) {
  const baseClasses =
    kind === "primary"
      ? "rounded-md px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
      : "text-sm underline-offset-2 hover:underline";
  const style =
    kind === "primary"
      ? { background: "var(--color-brand-accent)" }
      : { color: "var(--color-text-secondary)" };

  if (href) {
    return (
      <a href={href} className={baseClasses} style={style}>
        {label}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={baseClasses} style={style}>
      {label}
    </button>
  );
}
