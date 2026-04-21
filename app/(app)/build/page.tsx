"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { ConfidenceBadge } from "@/components/ui/ConfidenceBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FeedbackThumbs } from "@/components/ui/FeedbackThumbs";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";
import { useFeedbackThumbs } from "@/lib/client/use-feedback-thumbs";

/*
  What to build — ranked opportunities + five weight sliders with
  live client-side re-rank (design review §14.4).

  IA priority (plan §14.1):
    1. Ranked opportunity row with score + ConfidenceBadge + impact.
    2. Cited clusters (reasoning text for now; CitationChip lands
       when that primitive ships).
    3. Effort estimate.
    4. Weight-slider sidebar with Reset.

  Live re-rank model:
    - Drag a slider → we recompute client-side using the SAME formula
      as lib/evidence/opportunities.computeScore. No LLM call.
    - On slider release (300ms debounce), we POST the new weights so
      they persist + the server reruns rescore for future visits.
*/

type WeightKey =
  | "frequencyW"
  | "revenueW"
  | "retentionW"
  | "strategyW"
  | "effortW";

type Weights = Record<WeightKey, number>;

const SLIDERS: Array<{ key: WeightKey; label: string; hint: string }> = [
  {
    key: "frequencyW",
    label: "Frequency",
    hint: "Weight how often users hit this.",
  },
  {
    key: "revenueW",
    label: "Revenue",
    hint: "Weight expected revenue lift.",
  },
  {
    key: "retentionW",
    label: "Retention",
    hint: "Weight expected retention + activation.",
  },
  {
    key: "strategyW",
    label: "Strategy",
    hint: "Weight strategic fit with direction.",
  },
  {
    key: "effortW",
    label: "Effort",
    hint: "Penalty on build cost. Higher = prefer quicker wins.",
  },
];

const EFFORT_WEIGHT: Record<string, number> = {
  XS: 0.1,
  S: 0.25,
  M: 0.5,
  L: 0.75,
  XL: 1,
};

export default function BuildPage(): React.JSX.Element {
  const list = trpc.opportunities.list.useQuery();
  const weightsQ = trpc.opportunities.weights.useQuery();
  const utils = trpc.useUtils();
  const run = trpc.opportunities.run.useMutation({
    onSuccess: () => utils.opportunities.list.invalidate(),
  });
  const updateWeights = trpc.opportunities.updateWeights.useMutation({
    onSuccess: () => {
      utils.opportunities.list.invalidate();
      utils.opportunities.weights.invalidate();
    },
  });

  const [weights, setWeights] = useState<Weights | null>(null);
  useEffect(() => {
    if (weightsQ.data?.weights && weights === null) {
      setWeights(weightsQ.data.weights);
    }
  }, [weightsQ.data, weights]);

  // Debounced persist. setTimeout ref so consecutive drags collapse.
  const persistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleWeightsPersist(next: Weights) {
    if (persistRef.current) clearTimeout(persistRef.current);
    persistRef.current = setTimeout(() => {
      updateWeights.mutate({ weights: next });
    }, 300);
  }

  function setWeight(key: WeightKey, value: number) {
    if (!weights) return;
    const next = { ...weights, [key]: value };
    setWeights(next);
    scheduleWeightsPersist(next);
  }

  function resetToRecommended() {
    if (!weightsQ.data?.defaults) return;
    setWeights(weightsQ.data.defaults);
    scheduleWeightsPersist(weightsQ.data.defaults);
  }

  // Compute client-side scores with the current (unpersisted) weights
  // so dragging feels instant. Mirrors lib/evidence/opportunities.computeScore
  // but kept intentionally simple — the server's mechanical re-rank
  // is the persistent truth; this is just for drag feedback.
  const ranked = useMemo(() => {
    const rows = list.data ?? [];
    if (!weights || rows.length === 0) return rows.map((r) => ({ ...r }));
    const frequencies = buildFrequencyMap(rows);
    const maxFreq = Math.max(1, ...frequencies.values());

    return [...rows]
      .map((r) => {
        const freqComp =
          r.linkedClusterIds.length === 0
            ? 0
            : r.linkedClusterIds.reduce(
                (s, id) => s + (frequencies.get(id) ?? 0) / maxFreq,
                0,
              ) / r.linkedClusterIds.length;
        const imp = r.impactEstimate;
        const impComp =
          (weights.revenueW * (imp?.revenue ?? 0) +
            weights.retentionW *
              ((imp?.retention ?? 0) + (imp?.activation ?? 0))) /
          (weights.revenueW + weights.retentionW * 2 || 1);
        const raw =
          weights.frequencyW * freqComp +
          impComp +
          weights.strategyW * 0.5 -
          weights.effortW * (EFFORT_WEIGHT[r.effortEstimate] ?? 0.5);
        const liveScore = Math.max(0, raw) * r.confidence;
        return { ...r, score: liveScore };
      })
      .sort((a, b) => b.score - a.score);
  }, [list.data, weights]);

  const opportunityIds = (list.data ?? []).map((o) => o.id);
  const feedback = useFeedbackThumbs("opportunity", opportunityIds);

  if (list.isLoading || weightsQ.isLoading) {
    return <SkeletonList count={5} />;
  }

  if (ranked.length === 0) {
    return (
      <EmptyState
        title="No opportunities yet"
        description="Opportunities come from clusters. Generate clusters on the Insights tab first, then come back and click Generate opportunities."
        primaryAction={{ label: "Back to Insights", href: "/insights" }}
        secondaryAction={{
          label: run.isPending ? "Generating…" : "Generate opportunities",
          onClick: () => run.mutate(),
        }}
      />
    );
  }

  return (
    <div className="grid grid-cols-[1fr_280px] gap-8">
      <section className="flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1
            className="text-3xl tracking-tight"
            style={{
              fontFamily: "var(--font-display)",
              color: "var(--color-text-primary)",
            }}
          >
            What to build
          </h1>
          <button
            type="button"
            onClick={() => run.mutate()}
            disabled={run.isPending}
            title="Re-rank opportunities from your current clusters. ~30s, uses your LLM budget."
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-60"
            style={{
              borderColor: "var(--color-border-subtle)",
              color: "var(--color-text-secondary)",
            }}
          >
            {run.isPending ? "Refreshing…" : "Refresh opportunities"}
          </button>
        </header>

        <ol className="flex flex-col gap-3">
          {ranked.map((o, i) => (
            <li
              key={o.id}
              className="flex flex-col gap-2 rounded-xl border p-4"
              style={{
                borderColor: "var(--color-border-subtle)",
                background: "var(--color-surface-raised)",
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex items-center gap-3">
                  <span
                    className="text-xs tabular-nums"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    #{i + 1}
                  </span>
                  <span
                    className="text-base font-medium"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {o.title}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <ConfidenceBadge score={o.confidence} />
                  <span
                    className="rounded-full border px-2 py-0.5 text-xs"
                    style={{
                      borderColor: "var(--color-border-subtle)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {o.effortEstimate}
                  </span>
                  <span
                    className="tabular-nums text-xs"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    score {o.score.toFixed(2)}
                  </span>
                </span>
              </div>
              <p
                className="text-sm"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {o.description}
              </p>
              <p
                className="text-xs italic"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {o.reasoning}
              </p>
              <div className="mt-1 flex items-center justify-between">
                <FeedbackThumbs
                  value={feedback.votes[o.id] ?? null}
                  onChange={(next) => feedback.setVote(o.id, next)}
                  label={`Rate opportunity: ${o.title}`}
                />
                <Link
                  href={`/spec/${o.id}`}
                  className="rounded-md border px-3 py-1 text-xs font-medium transition hover:brightness-110"
                  style={{
                    borderColor: "var(--color-brand-accent)",
                    color: "var(--color-brand-accent)",
                  }}
                >
                  Create spec →
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <aside className="flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h2
            className="text-sm font-medium uppercase tracking-widest"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Weights
          </h2>
          <button
            type="button"
            onClick={resetToRecommended}
            className="text-xs underline-offset-2 hover:underline"
            style={{ color: "var(--color-brand-accent)" }}
          >
            Reset
          </button>
        </header>

        {SLIDERS.map((s) => (
          <label key={s.key} className="flex flex-col gap-1 text-sm">
            <span className="flex items-center justify-between">
              <span style={{ color: "var(--color-text-primary)" }}>
                {s.label}
              </span>
              <span
                className="tabular-nums text-xs"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {(weights?.[s.key] ?? 1).toFixed(2)}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={weights?.[s.key] ?? 1}
              onChange={(e) => setWeight(s.key, Number(e.target.value))}
              className="w-full"
              style={{ accentColor: "var(--color-brand-accent)" }}
            />
            <span
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {s.hint}
            </span>
          </label>
        ))}
      </aside>
    </div>
  );
}

function buildFrequencyMap(
  rows: ReadonlyArray<{ linkedClusterIds: string[] }>,
): Map<string, number> {
  // We don't have cluster frequency shipped in the list() payload —
  // for drag-feedback purposes, treat each linked cluster as count 1
  // so the frequency component collapses to "how many clusters this
  // opportunity covers." Server-side re-rank uses real frequencies
  // so the persisted score stays accurate.
  const m = new Map<string, number>();
  for (const r of rows) {
    for (const id of r.linkedClusterIds) {
      m.set(id, (m.get(id) ?? 0) + 1);
    }
  }
  return m;
}
