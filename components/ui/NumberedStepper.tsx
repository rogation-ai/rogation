/*
  NumberedStepper — the "1 Upload → 2 Cluster → 3 First insight" header
  across the onboarding wizard (approved mockup: onboarding-upload-A-v2).

  Current + completed steps use the brand accent; upcoming steps are
  muted. Completed steps show a check; current shows the number; future
  shows the number in tertiary text.

  Purely visual — no routing hooks. The parent owns the "which step is
  active" state. Keeps the component reusable across flows (onboarding,
  billing, etc.).
*/

export type StepState = "completed" | "current" | "upcoming";

export interface NumberedStepperStep {
  label: string;
  state: StepState;
}

export interface NumberedStepperProps {
  steps: NumberedStepperStep[];
}

export function NumberedStepper({
  steps,
}: NumberedStepperProps): React.JSX.Element {
  return (
    <ol
      className="flex items-center gap-4 text-sm"
      style={{ color: "var(--color-text-secondary)" }}
    >
      {steps.map((step, idx) => (
        <li key={step.label} className="flex items-center gap-4">
          <span className="flex items-center gap-2">
            <StepBadge state={step.state} index={idx + 1} />
            <span
              className={step.state === "current" ? "font-medium" : ""}
              style={{
                color:
                  step.state === "upcoming"
                    ? "var(--color-text-tertiary)"
                    : "var(--color-text-primary)",
              }}
            >
              {step.label}
            </span>
          </span>
          {idx < steps.length - 1 && (
            <span
              aria-hidden
              className="h-px w-6"
              style={{ background: "var(--color-border-default)" }}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function StepBadge({
  state,
  index,
}: {
  state: StepState;
  index: number;
}): React.JSX.Element {
  if (state === "completed") {
    return (
      <span
        aria-label="completed"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ background: "var(--color-brand-accent)" }}
      >
        <svg
          viewBox="0 0 12 12"
          width="10"
          height="10"
          fill="none"
          aria-hidden
        >
          <path
            d="M2.5 6.5L5 9L9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (state === "current") {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{ background: "var(--color-brand-accent)" }}
      >
        {index}
      </span>
    );
  }

  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold"
      style={{
        borderColor: "var(--color-border-default)",
        color: "var(--color-text-tertiary)",
      }}
    >
      {index}
    </span>
  );
}
