"use client";

import { useEffect, useId, useRef } from "react";

/*
  ConfirmDialog — modal confirmation primitive.

  Used by the Linear push flow when a spec already has a Linear
  project: "Update existing project?" / "Create new project?" The PM
  needs to see the consequence before committing.

  Why not extend EmptyState: EmptyState renders an empty list state
  (icon + headline + secondary actions). ConfirmDialog renders a
  destructive-aware confirmation (title + body + primary action with
  destructive consequence subtext). Different shapes, different
  responsibilities — keeping them as siblings is cleaner than
  overloading EmptyState.

  Accessibility:
    - role="dialog" + aria-modal="true"
    - aria-labelledby points to the title
    - Initial focus on the primary action button
    - Focus trap inside the modal (tab cycles within)
    - Focus returns to the trigger element on close
    - Esc closes the modal — UNLESS inFlight is set, since closing
      during an async action would orphan state
    - Primary action subtext is aria-describedby for the button, so
      screen readers hear the consequence before activating

  Visual:
    - The one DESIGN.md exception to "no shadows on default cards":
      modal panels carry a shadow because the overlay must clearly
      lift above the rest of the UI.
*/

export interface ConfirmDialogAction {
  label: string;
  onClick: () => void;
  /** Subtext shown below the button. Used as aria-describedby. */
  subtext?: string;
  /** "destructive" gives a warn-tone affordance (border, no fill). */
  tone?: "default" | "destructive";
  disabled?: boolean;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  primaryAction: ConfirmDialogAction;
  secondaryAction?: ConfirmDialogAction;
  cancelLabel?: string;
  onCancel: () => void;
  /**
   * When set, both buttons are replaced with an in-flight indicator.
   * Esc is ignored (closing mid-flight would orphan state).
   *
   * progress: optional {completed, total} for a counter affordance;
   * omit for an indeterminate spinner label.
   */
  inFlight?: { label: string; progress?: { completed: number; total: number } };
}

export function ConfirmDialog({
  open,
  title,
  body,
  primaryAction,
  secondaryAction,
  cancelLabel = "Cancel",
  onCancel,
  inFlight,
}: ConfirmDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const primarySubtextId = useId();
  const secondarySubtextId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Capture the trigger and move focus to the primary button on open.
  // Return focus on close.
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    primaryBtnRef.current?.focus();
    return () => {
      previousFocus.current?.focus();
    };
  }, [open]);

  // Esc to cancel — unless an async action is in flight.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !inFlight) {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Tab") {
        // Trap focus inside the dialog. Selectors cover the elements
        // we render; if a consumer adds more interactive content via
        // body, those nodes are included automatically.
        const container = dialogRef.current;
        if (!container) return;
        const focusables = container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onCancel, inFlight]);

  if (!open) return null;

  return (
    <div
      // Overlay + panel container. Click-on-overlay closes (unless
      // in-flight) to match standard modal expectations.
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(0, 0, 0, 0.4)", backdropFilter: "blur(2px)" }}
      onClick={() => {
        if (!inFlight) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-lg border bg-white p-6"
        style={{
          borderColor: "var(--color-border-subtle)",
          boxShadow:
            "0 12px 32px -8px rgba(0, 0, 0, 0.15), 0 4px 8px -4px rgba(0, 0, 0, 0.08)",
          color: "var(--color-text-primary)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-medium">
            {title}
          </h2>
          {!inFlight && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close dialog"
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
        </div>

        <div
          className="mt-3 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {body}
        </div>

        {inFlight ? (
          <div
            className="mt-5 flex items-center justify-center rounded-md border px-4 py-3 text-sm"
            style={{
              borderColor: "var(--color-border-subtle)",
              color: "var(--color-text-secondary)",
            }}
            role="status"
          >
            {inFlight.label}
            {inFlight.progress
              ? ` (${inFlight.progress.completed}/${inFlight.progress.total})`
              : "…"}
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            <div>
              <button
                ref={primaryBtnRef}
                type="button"
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled}
                aria-describedby={
                  primaryAction.subtext ? primarySubtextId : undefined
                }
                className="w-full rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
                style={
                  primaryAction.tone === "destructive"
                    ? {
                        borderColor: "var(--color-border-default)",
                        color: "var(--color-text-primary)",
                      }
                    : {
                        borderColor: "var(--color-brand-accent)",
                        background: "var(--color-brand-accent)",
                        color: "var(--color-text-on-accent)",
                      }
                }
              >
                {primaryAction.label}
              </button>
              {primaryAction.subtext && (
                <p
                  id={primarySubtextId}
                  className="mt-1.5 text-xs"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {primaryAction.subtext}
                </p>
              )}
            </div>

            {secondaryAction && (
              <div>
                <button
                  type="button"
                  onClick={secondaryAction.onClick}
                  disabled={secondaryAction.disabled}
                  aria-describedby={
                    secondaryAction.subtext ? secondarySubtextId : undefined
                  }
                  className="w-full rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
                  style={{
                    borderColor: "var(--color-border-default)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  {secondaryAction.label}
                </button>
                {secondaryAction.subtext && (
                  <p
                    id={secondarySubtextId}
                    className="mt-1.5 text-xs"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {secondaryAction.subtext}
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={onCancel}
              className="mt-1 text-sm underline-offset-2 hover:underline"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {cancelLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
