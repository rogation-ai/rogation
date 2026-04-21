"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import type { PlanTier } from "@/lib/plans";

/*
  OutcomeCard — sidebar panel on /spec/[id] for recording shipped
  outcomes. Pro-only. Free + Solo see an upsell pointing at /pricing.

  Scope: manual entry only. Metric name + predicted + actual + optional
  measured-at date. Multiple rows per opportunity (each metric is its
  own row). Editing and deleting happen in-place.

  Input shape matches the existing outcomes table, so a future PostHog
  sync can insert rows with metricSource='posthog' without schema churn.
*/

type OutcomeRow = {
  id: string;
  metricName: string;
  predicted: number | null;
  actual: number | null;
  measuredAt: Date | null;
  metricSource: "manual" | "posthog";
};

export function OutcomeCard({
  opportunityId,
  plan,
}: {
  opportunityId: string;
  plan: PlanTier;
}): React.JSX.Element {
  if (plan !== "pro") {
    return <OutcomeUpsell plan={plan} />;
  }
  return <OutcomePanel opportunityId={opportunityId} />;
}

function OutcomeUpsell({ plan }: { plan: PlanTier }): React.JSX.Element {
  // Solo gets a shorter copy — they're already paying. Free gets the
  // full "here's what you'd unlock" pitch.
  const isSolo = plan === "solo";
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border p-4 text-xs"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
        color: "var(--color-text-secondary)",
      }}
    >
      <h2
        className="text-xs font-medium uppercase tracking-widest"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Outcome tracking
      </h2>
      <p>
        {isSolo
          ? "Record what this shipped feature moved (retention, activation, revenue) and feed the results back into future rank decisions."
          : "After this spec ships, record the metrics it moved. Rogation remembers predicted vs. actual and shows the verdict the next time you rank opportunities — so taste compounds into data."}
      </p>
      <a
        href="/pricing"
        className="self-start rounded-md px-3 py-1 text-xs font-medium text-white transition hover:brightness-110"
        style={{ background: "var(--color-brand-accent)" }}
      >
        Upgrade to Pro
      </a>
    </section>
  );
}

function OutcomePanel({
  opportunityId,
}: {
  opportunityId: string;
}): React.JSX.Element {
  const utils = trpc.useUtils();
  const list = trpc.outcomes.list.useQuery({ opportunityId });

  const invalidate = () => {
    utils.outcomes.list.invalidate({ opportunityId });
    utils.outcomes.summary.invalidate();
  };

  const create = trpc.outcomes.create.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Outcome recorded");
    },
    onError: (err) => toast.error("Couldn't save", { description: err.message }),
  });
  const update = trpc.outcomes.update.useMutation({
    onSuccess: invalidate,
    onError: (err) => toast.error("Couldn't save", { description: err.message }),
  });
  const del = trpc.outcomes.delete.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Outcome removed");
    },
  });

  const [adding, setAdding] = useState(false);

  const rows = (list.data ?? []) as OutcomeRow[];

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-4"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <header className="flex items-center justify-between">
        <h2
          className="text-xs font-medium uppercase tracking-widest"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Outcomes
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs underline-offset-2 hover:underline"
            style={{ color: "var(--color-brand-accent)" }}
          >
            + Add metric
          </button>
        )}
      </header>

      {rows.length === 0 && !adding && (
        <p
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          After this ships, add the metrics it moved (e.g. &ldquo;Retention
          7d&rdquo;, predicted 40, actual 43). Feeds future opportunity rank.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <OutcomeRowItem
            key={r.id}
            row={r}
            onSave={(patch) => update.mutate({ id: r.id, ...patch })}
            onDelete={() => del.mutate({ id: r.id })}
            saving={update.isPending || del.isPending}
          />
        ))}
      </ul>

      {adding && (
        <OutcomeForm
          onCancel={() => setAdding(false)}
          onSubmit={(input) => {
            create.mutate(
              { opportunityId, ...input },
              { onSuccess: () => setAdding(false) },
            );
          }}
          submitting={create.isPending}
        />
      )}
    </section>
  );
}

function OutcomeRowItem({
  row,
  onSave,
  onDelete,
  saving,
}: {
  row: OutcomeRow;
  onSave: (patch: {
    metricName: string;
    predicted: number | null;
    actual: number | null;
  }) => void;
  onDelete: () => void;
  saving: boolean;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li>
        <OutcomeForm
          initial={row}
          onCancel={() => setEditing(false)}
          onSubmit={(patch) => {
            onSave(patch);
            setEditing(false);
          }}
          submitting={saving}
        />
      </li>
    );
  }

  const verdict = verdictFor(row.predicted, row.actual);
  return (
    <li
      className="flex items-start justify-between gap-2 rounded-lg border p-2 text-xs"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-app)",
      }}
    >
      <div className="flex flex-col gap-1">
        <span style={{ color: "var(--color-text-primary)" }}>
          {row.metricName}
        </span>
        <span style={{ color: "var(--color-text-tertiary)" }}>
          {row.predicted === null ? "—" : `predicted ${row.predicted}`} ·{" "}
          {row.actual === null ? "—" : `actual ${row.actual}`}
          {verdict && (
            <>
              {" "}
              <span style={{ color: verdictColor(verdict) }}>
                {verdict === "win" ? "✓ win" : verdict === "loss" ? "✗ miss" : "~ mixed"}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs underline-offset-2 hover:underline"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={saving}
          className="text-xs underline-offset-2 hover:underline disabled:opacity-50"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function OutcomeForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
}: {
  initial?: Pick<OutcomeRow, "metricName" | "predicted" | "actual">;
  onSubmit: (input: {
    metricName: string;
    predicted: number | null;
    actual: number | null;
    measuredAt: Date | null;
  }) => void;
  onCancel: () => void;
  submitting: boolean;
}): React.JSX.Element {
  const [metricName, setMetricName] = useState(initial?.metricName ?? "");
  const [predicted, setPredicted] = useState(
    initial?.predicted !== undefined && initial?.predicted !== null
      ? String(initial.predicted)
      : "",
  );
  const [actual, setActual] = useState(
    initial?.actual !== undefined && initial?.actual !== null
      ? String(initial.actual)
      : "",
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = metricName.trim();
    if (!name) {
      toast.error("Metric name is required");
      return;
    }
    onSubmit({
      metricName: name,
      predicted: parseOptionalNumber(predicted),
      actual: parseOptionalNumber(actual),
      measuredAt: actual.trim() === "" ? null : new Date(),
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded-lg border p-2 text-xs"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-app)",
      }}
    >
      <label className="flex flex-col gap-1">
        <span style={{ color: "var(--color-text-tertiary)" }}>
          Metric name
        </span>
        <input
          type="text"
          value={metricName}
          onChange={(e) => setMetricName(e.target.value)}
          placeholder="Retention 7d"
          maxLength={128}
          className="rounded border bg-transparent px-2 py-1"
          style={{
            borderColor: "var(--color-border-subtle)",
            color: "var(--color-text-primary)",
          }}
          autoFocus
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span style={{ color: "var(--color-text-tertiary)" }}>Predicted</span>
          <input
            type="number"
            step="any"
            inputMode="decimal"
            value={predicted}
            onChange={(e) => setPredicted(e.target.value)}
            placeholder="40"
            className="rounded border bg-transparent px-2 py-1"
            style={{
              borderColor: "var(--color-border-subtle)",
              color: "var(--color-text-primary)",
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "var(--color-text-tertiary)" }}>Actual</span>
          <input
            type="number"
            step="any"
            inputMode="decimal"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            placeholder="43"
            className="rounded border bg-transparent px-2 py-1"
            style={{
              borderColor: "var(--color-border-subtle)",
              color: "var(--color-text-primary)",
            }}
          />
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border px-2 py-1 text-xs"
          style={{
            borderColor: "var(--color-border-subtle)",
            color: "var(--color-text-secondary)",
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
          style={{ background: "var(--color-brand-accent)" }}
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/* -------------------------- pure display helpers -------------------------- */

export function verdictFor(
  predicted: number | null,
  actual: number | null,
): "win" | "loss" | null {
  if (predicted === null || actual === null) return null;
  return actual >= predicted ? "win" : "loss";
}

function verdictColor(v: "win" | "loss" | "mixed"): string {
  if (v === "win") return "var(--color-success, #16a34a)";
  if (v === "loss") return "var(--color-danger, #dc2626)";
  return "var(--color-text-tertiary)";
}

function parseOptionalNumber(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
