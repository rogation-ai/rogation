/*
  ReadinessGrade — the stoplight on every generated spec.

  Design review §6 promoted this from the queue. A PM glances at the
  letter and knows if the spec is shippable. The checklist underneath
  tells them exactly what's missing when it isn't.

  A/B/C/D map to success/info/warning/danger tokens. Each letter has
  a short meaning string + a breakdown of the 4 deterministic checks
  (see lib/spec/readiness.ts). The component is pure presentation —
  it takes the grader's output verbatim and renders.
*/

import type { ReadinessChecklist, ReadinessGrade } from "@/lib/spec/readiness";

export interface ReadinessGradeProps {
  grade: ReadinessGrade;
  checklist: ReadinessChecklist;
  /** Optional compact layout for a sidebar. Omits the meaning line. */
  compact?: boolean;
}

const CHECK_LABELS: Record<keyof ReadinessChecklist, string> = {
  edgesCovered: "3+ edge cases documented",
  validationSpecified: "Every story has acceptance criteria",
  nonFunctionalAddressed: "Non-functional requirements specified",
  acceptanceTestable: "Given/When/Then fully populated",
};

const GRADE_META: Record<
  ReadinessGrade,
  { bg: string; fg: string; border: string; meaning: string }
> = {
  A: {
    bg: "color-mix(in srgb, var(--color-success) 15%, transparent)",
    fg: "var(--color-success)",
    border: "var(--color-success)",
    meaning: "Ready to hand to engineering",
  },
  B: {
    bg: "color-mix(in srgb, var(--color-info) 15%, transparent)",
    fg: "var(--color-info)",
    border: "var(--color-info)",
    meaning: "Solid, tighten one area before kickoff",
  },
  C: {
    bg: "color-mix(in srgb, var(--color-warning) 15%, transparent)",
    fg: "var(--color-warning)",
    border: "var(--color-warning)",
    meaning: "Has gaps — iterate before shipping to eng",
  },
  D: {
    bg: "color-mix(in srgb, var(--color-danger) 15%, transparent)",
    fg: "var(--color-danger)",
    border: "var(--color-danger)",
    meaning: "Not enough to brief a team yet",
  },
};

export function ReadinessGrade({
  grade,
  checklist,
  compact = false,
}: ReadinessGradeProps): React.JSX.Element {
  const meta = GRADE_META[grade];

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border p-4"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 items-center justify-center rounded-full border text-xl font-semibold"
          style={{
            background: meta.bg,
            color: meta.fg,
            borderColor: meta.border,
          }}
          aria-label={`Readiness grade ${grade}`}
        >
          {grade}
        </span>
        <div className="flex flex-col">
          <span
            className="text-sm font-medium"
            style={{ color: "var(--color-text-primary)" }}
          >
            Readiness: {grade}
          </span>
          {!compact && (
            <span
              className="text-xs"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {meta.meaning}
            </span>
          )}
        </div>
      </div>

      <ul className="flex flex-col gap-1.5 text-xs">
        {(Object.keys(CHECK_LABELS) as Array<keyof ReadinessChecklist>).map(
          (key) => {
            const passed = checklist[key];
            return (
              <li
                key={key}
                className="flex items-start gap-2"
                style={{
                  color: passed
                    ? "var(--color-text-primary)"
                    : "var(--color-text-tertiary)",
                }}
              >
                <span
                  aria-hidden
                  className="mt-[1px] inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold"
                  style={{
                    background: passed
                      ? "var(--color-success)"
                      : "var(--color-border-default)",
                    color: passed ? "#fff" : "var(--color-text-tertiary)",
                  }}
                >
                  {passed ? "✓" : "·"}
                </span>
                <span>{CHECK_LABELS[key]}</span>
              </li>
            );
          },
        )}
      </ul>
    </div>
  );
}
