"use client";

import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";

export default function LearningPage(): React.JSX.Element {
  const exclusions = trpc.learning.exclusions.useQuery();
  const pendingCount = trpc.learning.pendingCount.useQuery();
  const utils = trpc.useUtils();

  const unexclude = trpc.learning.unexclude.useMutation({
    onSuccess: () => {
      void utils.learning.exclusions.invalidate();
      void utils.learning.pendingCount.invalidate();
    },
  });

  const deleteExclusion = trpc.learning.delete.useMutation({
    onSuccess: () => {
      void utils.learning.exclusions.invalidate();
      void utils.learning.pendingCount.invalidate();
    },
  });

  const confirmPending = trpc.learning.confirmPending.useMutation({
    onSuccess: () => {
      void utils.learning.pendingCount.invalidate();
      void utils.learning.exclusions.invalidate();
    },
  });

  const dismissPending = trpc.learning.dismissPending.useMutation({
    onSuccess: () => {
      void utils.learning.pendingCount.invalidate();
    },
  });

  if (exclusions.isLoading) return <SkeletonList count={3} />;

  const items = exclusions.data ?? [];
  const pending = pendingCount.data ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1
          className="text-2xl tracking-tight"
          style={{
            fontFamily: "var(--font-display)",
            color: "var(--color-text-primary)",
          }}
        >
          Learning
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Patterns you&apos;ve dismissed. The system learns from your curation to reduce false
          positives over time.
        </p>
      </header>

      {pending > 0 && (
        <div
          className="rounded-md border p-4"
          style={{
            borderColor: "var(--color-warning)",
            background: "var(--color-surface-sunken)",
          }}
        >
          <p className="text-sm font-medium mb-2" style={{ color: "var(--color-text-primary)" }}>
            {pending} new piece{pending === 1 ? "" : "s"} of evidence match
            {pending === 1 ? "es" : ""} a dismissed pattern
          </p>
          <p className="text-xs mb-3" style={{ color: "var(--color-text-secondary)" }}>
            Review these matches to confirm or dismiss them. Pending evidence is excluded from
            clustering until you decide.
          </p>
          <PendingReview
            onConfirm={(ids) => confirmPending.mutate({ evidenceIds: ids })}
            onDismiss={(ids) => dismissPending.mutate({ evidenceIds: ids })}
          />
        </div>
      )}

      {items.length === 0 && pending === 0 ? (
        <EmptyState
          title="No dismissed patterns yet"
          description="Dismiss a cluster from the Insights page to start training. The system will learn which patterns are irrelevant to you."
          primaryAction={{ label: "Go to Insights", href: "/insights" }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((exc) => (
            <div
              key={exc.id}
              id={`exclusion-${exc.id}`}
              className="rounded-md border p-4"
              style={{
                borderColor: exc.isActive
                  ? "var(--color-border-default)"
                  : "var(--color-border-subtle)",
                background: "var(--color-surface-app)",
                opacity: exc.isActive ? 1 : 0.7,
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h3
                    className="text-sm font-medium truncate"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {exc.label}
                  </h3>
                  {exc.reason && (
                    <p
                      className="text-xs mt-0.5 truncate"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {exc.reason}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    <span>{exc.evidenceCount} evidence excluded</span>
                    {exc.lastUsedAt && (
                      <span>Last active: {new Date(exc.lastUsedAt).toLocaleDateString()}</span>
                    )}
                    <span>Dismissed: {new Date(exc.dismissedAt).toLocaleDateString()}</span>
                    {!exc.isActive && (
                      <span
                        className="rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{
                          background: "var(--color-surface-sunken)",
                          color: "var(--color-text-tertiary)",
                        }}
                      >
                        Inactive
                      </span>
                    )}
                  </div>
                  {exc.isActive && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
                        Strength
                      </span>
                      <div
                        className="h-1.5 rounded-full flex-1 max-w-[120px]"
                        style={{ background: "var(--color-surface-sunken)" }}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.round(exc.strength * 100)}%`,
                            background: "var(--color-brand-accent)",
                          }}
                        />
                      </div>
                      <span className="text-xs tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                        {Math.round(exc.strength * 100)}%
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => unexclude.mutate({ exclusionId: exc.id })}
                    disabled={unexclude.isPending}
                    className="rounded-md border px-3 py-1.5 text-xs font-medium transition hover:brightness-95 disabled:opacity-50"
                    style={{
                      borderColor: "var(--color-border-default)",
                      color: "var(--color-text-primary)",
                      background: "var(--color-surface-app)",
                    }}
                  >
                    Unexclude
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm("Permanently delete this exclusion? Evidence will be restored.")) {
                        deleteExclusion.mutate({ exclusionId: exc.id });
                      }
                    }}
                    disabled={deleteExclusion.isPending}
                    className="rounded-md border px-3 py-1.5 text-xs font-medium transition hover:brightness-95 disabled:opacity-50"
                    style={{
                      borderColor: "var(--color-border-default)",
                      color: "var(--color-danger)",
                      background: "var(--color-surface-app)",
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PendingReview({
  onConfirm,
  onDismiss,
}: {
  onConfirm: (ids: string[]) => void;
  onDismiss: (ids: string[]) => void;
}): React.JSX.Element {
  const exclusions = trpc.learning.exclusions.useQuery();
  const items = (exclusions.data ?? []).filter((e) => e.isActive);

  if (items.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
        No active exclusions to review against.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((exc) => (
        <div
          key={exc.id}
          className="flex items-center justify-between rounded border px-3 py-2"
          style={{
            borderColor: "var(--color-border-subtle)",
            background: "var(--color-surface-raised)",
          }}
        >
          <span className="text-sm" style={{ color: "var(--color-text-primary)" }}>
            &ldquo;{exc.label}&rdquo;
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onConfirm([exc.id])}
              className="rounded px-2 py-1 text-xs font-medium transition hover:brightness-110"
              style={{
                background: "var(--color-brand-accent)",
                color: "white",
              }}
            >
              Confirm exclusion
            </button>
            <button
              type="button"
              onClick={() => onDismiss([exc.id])}
              className="rounded border px-2 py-1 text-xs font-medium transition hover:brightness-95"
              style={{
                borderColor: "var(--color-border-default)",
                color: "var(--color-text-secondary)",
              }}
            >
              Keep evidence
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
