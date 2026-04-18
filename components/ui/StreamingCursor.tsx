/*
  StreamingCursor — the little blinking block that follows streamed
  text as it arrives from the LLM. Ninth primitive from the DESIGN.md
  §6 queue, shipped alongside the spec streaming commit.

  It's pure presentation — no state. Parents control visibility by
  rendering/not-rendering it based on whether a stream is active.

  Variants:
    - inline (default): sits at the end of a text line.
    - block: a taller bar, suitable next to large headings.

  Motion: respects prefers-reduced-motion via the global CSS variable
  set in app/globals.css (§Design-review pass 5). When reduced motion
  is on, the cursor is solid (no blink).
*/

export interface StreamingCursorProps {
  variant?: "inline" | "block";
  /** Optional aria-label so screen readers announce "generating…". */
  label?: string;
}

export function StreamingCursor({
  variant = "inline",
  label = "Generating",
}: StreamingCursorProps): React.JSX.Element {
  const size =
    variant === "block"
      ? { width: "0.5rem", height: "1.2rem" }
      : { width: "0.45rem", height: "0.95rem" };

  return (
    <span
      role="status"
      aria-label={label}
      className="rogation-streaming-cursor inline-block align-[-2px]"
      style={{
        ...size,
        marginLeft: "2px",
        background: "var(--color-brand-accent)",
        borderRadius: "1px",
      }}
    />
  );
}
