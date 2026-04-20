/*
  LoadingSkeleton — pulsing type-shaped bars that stand in for a
  row/card while the real data loads. Never use a spinner on a list
  surface (DESIGN.md §7 interaction state matrix).

  The variants mirror the most common placeholders we'll need:
  - line:   single text line
  - heading one wider + taller bar
  - card:   cluster / opportunity / evidence card shape

  honors prefers-reduced-motion via the rule in globals.css; the
  pulse animation stops for users who asked.
*/

interface BaseProps {
  /** Extra Tailwind classes if you need to tune width/height. */
  className?: string;
}

export function SkeletonLine({ className }: BaseProps): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={`block h-3 animate-pulse rounded ${className ?? "w-40"}`}
      style={{ background: "var(--color-surface-sunken)" }}
    />
  );
}

export function SkeletonHeading({ className }: BaseProps): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={`block h-5 animate-pulse rounded ${className ?? "w-64"}`}
      style={{ background: "var(--color-surface-sunken)" }}
    />
  );
}

export interface SkeletonCardProps {
  /** Number of line placeholders under the heading. Default 2. */
  lines?: number;
  className?: string;
}

export function SkeletonCard({
  lines = 2,
  className,
}: SkeletonCardProps): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={`flex flex-col gap-3 rounded-xl border p-4 ${className ?? ""}`}
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <SkeletonHeading className="w-1/2" />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine
          key={i}
          className={i === lines - 1 ? "w-3/4" : "w-full"}
        />
      ))}
    </div>
  );
}

export interface SkeletonListProps {
  /** Number of card placeholders. Default 3. */
  count?: number;
}

export function SkeletonList({
  count = 3,
}: SkeletonListProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
