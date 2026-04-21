"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { SeverityPill } from "@/components/ui/SeverityPill";
import { StaleBanner } from "@/components/ui/StaleBanner";
import { EmptyState } from "@/components/ui/EmptyState";
import { FeedbackThumbs } from "@/components/ui/FeedbackThumbs";
import { FrequencyBar } from "@/components/ui/FrequencyBar";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";
import { useFeedbackThumbs } from "@/lib/client/use-feedback-thumbs";

/*
  Insights — approximates approved mockup insights-A-v2:
    Left rail   : cluster list sorted by severity × frequency.
    Center pane : selected cluster + representative quotes.
    Right rail  : "Linked opportunities" placeholder (opportunities
                  commit fills this in).

  Phase A wires:
    - list / detail queries against the synthesis router.
    - "Refresh clusters" button calls insights.run (full re-cluster).
    - Empty state when the corpus is too thin (< 10).
  Phase B adds the real stale banner driven by insight_cluster.stale.
*/

const THIN_CORPUS_THRESHOLD = 10;

export default function InsightsPage(): React.JSX.Element {
  // useSearchParams inside the body requires a Suspense boundary at
  // build-time static-prerender. Wrapping the whole page is the
  // smallest safe change; the inner component hydrates on the
  // client where searchParams actually resolves.
  return (
    <Suspense fallback={<SkeletonList count={5} />}>
      <InsightsPageInner />
    </Suspense>
  );
}

function InsightsPageInner(): React.JSX.Element {
  const evCount = trpc.evidence.count.useQuery();
  const list = trpc.insights.list.useQuery();
  const utils = trpc.useUtils();
  const run = trpc.insights.run.useMutation({
    onSuccess: () => {
      utils.insights.list.invalidate();
      setSelectedId(null);
    },
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // Deep-link: /insights?cluster=<id> pre-selects that cluster on
  // first render. CitationChip on the spec editor links here so a
  // PM reading a spec can jump straight to the evidence quotes.
  //
  // Fallback: if there's no deep-link and the user hasn't picked a
  // cluster yet, auto-select the first (highest-severity) one. An
  // unselected state left both the middle and right panes empty —
  // two placeholders side by side is dead space.
  useEffect(() => {
    if (selectedId !== null) return;
    const deep = searchParams.get("cluster");
    if (deep) {
      setSelectedId(deep);
      return;
    }
    const first = list.data?.[0]?.id;
    if (first) setSelectedId(first);
  }, [searchParams, selectedId, list.data]);

  const detail = trpc.insights.detail.useQuery(
    { clusterId: selectedId ?? "" },
    { enabled: Boolean(selectedId) },
  );

  const clusterIds = (list.data ?? []).map((c) => c.id);
  const feedback = useFeedbackThumbs("insight_cluster", clusterIds);

  const maxFrequency = Math.max(
    1,
    ...(list.data ?? []).map((c) => c.frequency),
  );

  const count = evCount.data?.count ?? 0;
  const clusters = list.data ?? [];
  const hasThinCorpus = count < THIN_CORPUS_THRESHOLD;

  if (evCount.isLoading || list.isLoading) {
    return <SkeletonList count={4} />;
  }

  // No evidence yet → redirect messaging + CTA.
  if (count === 0) {
    return (
      <EmptyState
        title="Upload evidence to see clusters"
        description="Insights are clustered pain points across your evidence. Drop a few interviews or support tickets first."
        primaryAction={{ label: "Go to onboarding", href: "/app" }}
      />
    );
  }

  // Thin corpus + no clusters yet → invite to refresh or add more.
  if (clusters.length === 0) {
    return (
      <section className="flex flex-col gap-6">
        {hasThinCorpus && (
          <StaleBanner
            message={`Clusters get sharper around ${THIN_CORPUS_THRESHOLD}+ pieces. You have ${count}. ${run.error?.message ?? ""}`}
            actionLabel={count >= 1 ? "Run anyway" : "Upload more"}
            onAction={() => (count >= 1 ? run.mutate() : undefined)}
            isRunning={run.isPending}
          />
        )}
        {!hasThinCorpus && (
          <div className="flex items-center justify-between">
            <p style={{ color: "var(--color-text-secondary)" }}>
              {count} pieces of evidence, no clusters yet.
            </p>
            <button
              type="button"
              onClick={() => run.mutate()}
              disabled={run.isPending}
              className="rounded-md px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              style={{ background: "var(--color-brand-accent)" }}
            >
              {run.isPending ? "Clustering…" : "Generate clusters"}
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="grid grid-cols-[240px_1fr_260px] gap-6">
      {/* Left rail — cluster list */}
      <aside className="flex flex-col gap-2">
        <p
          className="mb-1 text-xs uppercase tracking-widest"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Clustered pain points
        </p>
        {clusters.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedId(c.id)}
            className="flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left text-sm transition"
            style={{
              borderColor:
                selectedId === c.id
                  ? "var(--color-brand-accent)"
                  : "var(--color-border-subtle)",
              background:
                selectedId === c.id
                  ? "var(--color-surface-sunken)"
                  : "var(--color-surface-app)",
              color: "var(--color-text-primary)",
            }}
          >
            <span className="font-medium">{c.title}</span>
            <span className="flex items-center gap-2 text-xs">
              <SeverityPill severity={c.severity} count={c.frequency} />
            </span>
            <FrequencyBar
              value={c.frequency}
              max={maxFrequency}
              ariaLabel={`${c.frequency} of ${maxFrequency} pieces of evidence`}
            />
          </button>
        ))}

        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="mt-4 text-xs underline-offset-2 hover:underline disabled:opacity-60"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {run.isPending ? "Refreshing…" : "Refresh clusters"}
        </button>
      </aside>

      {/* Center — selected cluster detail */}
      <section className="flex flex-col gap-4">
        {selectedId && detail.data ? (
          <>
            <header className="flex items-center gap-3">
              <h1
                className="text-3xl tracking-tight"
                style={{
                  fontFamily: "var(--font-display)",
                  color: "var(--color-text-primary)",
                }}
              >
                {detail.data.title}
              </h1>
              <SeverityPill
                severity={detail.data.severity}
                count={detail.data.frequency}
              />
              <FeedbackThumbs
                value={feedback.votes[detail.data.id] ?? null}
                onChange={(next) => feedback.setVote(detail.data.id, next)}
                label={`Rate cluster: ${detail.data.title}`}
              />
            </header>

            <p
              className="max-w-xl text-base"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {detail.data.description}
            </p>

            <p
              className="mt-2 text-xs uppercase tracking-widest"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Representative quotes
            </p>
            <ul className="flex flex-col gap-3">
              {detail.data.quotes.slice(0, 5).map((q) => (
                <li
                  key={q.evidenceId}
                  className="rounded-md border p-3 text-sm"
                  style={{
                    borderColor: "var(--color-border-subtle)",
                    background: "var(--color-surface-raised)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  {q.content.slice(0, 280)}
                  {q.content.length > 280 && "…"}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p style={{ color: "var(--color-text-tertiary)" }}>
            Pick a cluster on the left to see its quotes.
          </p>
        )}
      </section>

      {/* Right rail — real linked opportunities for the selected cluster */}
      <aside>
        <LinkedOpportunities clusterId={selectedId} />
      </aside>
    </div>
  );
}

function LinkedOpportunities({
  clusterId,
}: {
  clusterId: string | null;
}): React.JSX.Element {
  const q = trpc.opportunities.forCluster.useQuery(
    { clusterId: clusterId ?? "" },
    { enabled: Boolean(clusterId) },
  );

  const items = q.data ?? [];

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <p
        className="mb-3 text-xs uppercase tracking-widest"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Linked opportunities
      </p>
      {!clusterId ? (
        <p
          className="text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Select a cluster to see the opportunities that address it.
        </p>
      ) : q.isLoading ? (
        <p style={{ color: "var(--color-text-tertiary)" }}>Loading…</p>
      ) : items.length === 0 ? (
        <p
          className="text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          No opportunities linked yet.{" "}
          <a
            href="/build"
            className="underline underline-offset-2"
            style={{ color: "var(--color-brand-accent)" }}
          >
            Generate on What to build.
          </a>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((o) => (
            <li key={o.id} className="flex flex-col gap-1">
              <a
                href={`/build#opp-${o.id}`}
                className="text-sm font-medium hover:underline"
                style={{ color: "var(--color-text-primary)" }}
              >
                {o.title}
              </a>
              <span
                className="text-xs"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                score {o.score.toFixed(2)}
              </span>
            </li>
          ))}
          <a
            href="/build"
            className="mt-2 inline-block rounded-md px-3 py-1.5 text-center text-sm font-medium text-white transition hover:brightness-110"
            style={{ background: "var(--color-brand-accent)" }}
          >
            Turn into spec →
          </a>
        </ul>
      )}
    </div>
  );
}
