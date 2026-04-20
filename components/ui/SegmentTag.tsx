/*
  SegmentTag — small outlined pill that labels a piece of evidence
  or a cluster by its user segment (e.g. "enterprise", "mobile",
  "free-tier"). Clicking it filters the current view by that segment.

  DESIGN.md §6: "Small outlined pill with segment name. Tap = filter
  by segment." No background fill. Color comes from the border + text
  so light and dark surfaces read the same.

  Pure presentation: if `onSelect` is omitted the tag renders as a
  static `<span>`. Parents own the filter state — this primitive
  doesn't reach into routing.
*/

export interface SegmentTagProps {
  /** Segment identifier, rendered verbatim. Truncated at 24 chars. */
  name: string;
  /** Called with `name` when the tag is tapped. Omit for read-only. */
  onSelect?: (name: string) => void;
  /** Visually mark this segment as the active filter. */
  active?: boolean;
}

const MAX_LEN = 24;

export function truncateSegment(name: string, max: number = MAX_LEN): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1).trimEnd() + "…";
}

export function SegmentTag({
  name,
  onSelect,
  active = false,
}: SegmentTagProps): React.JSX.Element {
  const display = truncateSegment(name);
  const baseStyle = {
    borderColor: active
      ? "var(--color-brand-accent)"
      : "var(--color-border-subtle)",
    color: active
      ? "var(--color-brand-accent)"
      : "var(--color-text-secondary)",
  } as const;
  const className =
    "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-4";

  if (!onSelect) {
    return (
      <span
        className={className}
        style={baseStyle}
        title={name !== display ? name : undefined}
      >
        {display}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(name)}
      aria-pressed={active}
      title={name !== display ? name : undefined}
      className={`${className} cursor-pointer transition-colors hover:bg-[var(--color-surface-raised)]`}
      style={baseStyle}
    >
      {display}
    </button>
  );
}
