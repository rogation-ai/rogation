"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { useScopeFilter } from "@/lib/client/use-scope-filter";
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

const TERMINAL_STATUSES = new Set(["done", "failed"]);
const POLL_INTERVAL_MS = 1500;
const STUCK_TIMEOUT_MS = 5 * 60 * 1000;

function InsightsPageInner(): React.JSX.Element {
  const scopeId = useScopeFilter();
  const evCount = trpc.evidence.count.useQuery();
  const list = trpc.insights.list.useQuery({ scopeId });
  const utils = trpc.useUtils();

  // Tracks the in-flight re-cluster id. Seeded from `latestRun` on
  // mount so reloading mid-run keeps the progress indicator; cleared
  // when the poll sees a terminal status.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [stuckRun, setStuckRun] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // Switching scopes can leave selectedId pointing at a cluster that
  // isn't in the new scope's list. Reset so the auto-select effect
  // below picks the new top cluster instead of 404ing the detail query.
  useEffect(() => {
    setSelectedId(null);
  }, [scopeId]);

  // Resume polling after a page reload if the latest run is still in flight.
  // One-shot: only seeds when we have no activeRunId yet.
  const latest = trpc.insights.latestRun.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (activeRunId || !latest.data) return;
    if (!TERMINAL_STATUSES.has(latest.data.status)) {
      setActiveRunId(latest.data.id);
    }
  }, [latest.data, activeRunId]);

  const runStatus = trpc.insights.runStatus.useQuery(
    { runId: activeRunId ?? "" },
    {
      enabled: Boolean(activeRunId),
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data) return POLL_INTERVAL_MS;
        return TERMINAL_STATUSES.has(data.status) ? false : POLL_INTERVAL_MS;
      },
      refetchOnWindowFocus: false,
    },
  );

  const run = trpc.insights.run.useMutation({
    onSuccess: ({ runId }) => {
      setActiveRunId(runId);
      setStuckRun(false);
    },
  });

  // The router accepts a uuid only — see server/routers/insights.ts:95.
  // When the global filter is "unscoped" we collapse to undefined,
  // which means the worker re-clusters every scope. The dispatch row
  // also dedups against `scope_id IS NULL`, so an "All" run and an
  // "Unscoped" run share a bucket. Both are pre-existing surprises;
  // proper fix is to extend the run input + orchestrator to accept
  // the "unscoped" literal as a first-class re-cluster target.
  const runScopeId =
    scopeId && scopeId !== "unscoped" ? scopeId : undefined;

  const cancelStuck = trpc.insights.cancelStuckRun.useMutation({
    onSuccess: ({ cancelled }) => {
      if (cancelled > 0) {
        setStuckRun(false);
        setActiveRunId(null);
        void utils.insights.latestRun.invalidate();
      }
    },
  });

  // Terminal-status handler: success → invalidate + reselect; failure →
  // just clear activeRunId so the button re-enables + surfaces the
  // server error below.
  useEffect(() => {
    const data = runStatus.data;
    if (!data) return;
    if (data.status === "done") {
      void utils.insights.list.invalidate();
      void utils.insights.latestRun.invalidate();
      setSelectedId(null);
      setActiveRunId(null);
      setStuckRun(false);
    } else if (data.status === "failed") {
      setActiveRunId(null);
      setStuckRun(false);
    }
  }, [runStatus.data, utils]);

  // Client-side stuck-run cutoff. When a run has been pending/running
  // for longer than STUCK_TIMEOUT_MS: stop polling, cancel the DB row
  // server-side (so the dedup check doesn't block the next dispatch),
  // and re-enable the Generate button.
  useEffect(() => {
    if (!activeRunId || !runStatus.data) return;
    const elapsed = Date.now() - new Date(runStatus.data.startedAt).getTime();
    if (elapsed > STUCK_TIMEOUT_MS && !TERMINAL_STATUSES.has(runStatus.data.status)) {
      setStuckRun(true);
      setActiveRunId(null);
      cancelStuck.mutate();
    }
  }, [runStatus.data, activeRunId, cancelStuck]);

  const isRunning = Boolean(activeRunId);
  const runError = run.error?.message ?? (runStatus.data?.status === "failed"
    ? runStatus.data.error ?? "Re-cluster failed."
    : null) ?? (stuckRun ? "Taking too long — retry." : null);

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

  const pendingCount = trpc.learning.pendingCount.useQuery();
  const dismiss = trpc.learning.dismiss.useMutation({
    onSuccess: () => {
      setSelectedId(null);
      void utils.insights.list.invalidate();
      void utils.insights.latestRun.invalidate();
      void pendingCount.refetch();
    },
  });
  const [dismissReason, setDismissReason] = useState("");
  const [showDismissDialog, setShowDismissDialog] = useState(false);

  const handleDismiss = useCallback(() => {
    if (!selectedId) return;
    dismiss.mutate({ clusterId: selectedId, reason: dismissReason || undefined });
    setShowDismissDialog(false);
    setDismissReason("");
  }, [selectedId, dismissReason, dismiss]);

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
            message={`Clusters get sharper around ${THIN_CORPUS_THRESHOLD}+ pieces. You have ${count}. ${runError ?? ""}`}
            actionLabel={count >= 1 ? "Run anyway" : "Upload more"}
            onAction={() =>
              count >= 1 ? run.mutate({ scopeId: runScopeId }) : undefined
            }
            isRunning={isRunning}
          />
        )}
        {!hasThinCorpus && (
          <div className="flex items-center justify-between">
            <p style={{ color: "var(--color-text-secondary)" }}>
              {count} pieces of evidence, no clusters yet.
            </p>
            <button
              type="button"
              onClick={() => run.mutate({ scopeId: runScopeId })}
              disabled={isRunning || run.isPending}
              className="rounded-md px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              style={{ background: "var(--color-brand-accent)" }}
            >
              {isRunning ? "Clustering…" : "Generate clusters"}
            </button>
          </div>
        )}
      </section>
    );
  }

  const pendingN = pendingCount.data ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {pendingN > 0 && (
        <StaleBanner
          message={`${pendingN} new piece${pendingN === 1 ? "" : "s"} of evidence match${pendingN === 1 ? "es" : ""} a dismissed pattern. Review matches.`}
          actionLabel="Review in Settings"
          onAction={() => { window.location.href = "/settings/learning"; }}
        />
      )}
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
          onClick={() => run.mutate({ scopeId: runScopeId })}
          disabled={isRunning || run.isPending}
          className="mt-4 text-xs underline-offset-2 hover:underline disabled:opacity-60"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {isRunning ? "Refreshing…" : "Refresh clusters"}
        </button>
        {runError && !isRunning && (
          <p className="mt-2 text-xs" style={{ color: "var(--color-danger)" }}>
            {runError}
          </p>
        )}
      </aside>

      {/* Center — selected cluster detail */}
      <section className="flex flex-col gap-4">
        {selectedId && detail.isLoading ? (
          // Cluster selected + quotes in flight (can take up to 3s).
          // Without this, the empty-state "Pick a cluster on the left"
          // showed DURING the fetch — misleading, looks unresponsive.
          <SkeletonList count={3} />
        ) : selectedId && detail.data ? (
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
              <button
                type="button"
                onClick={() => setShowDismissDialog(true)}
                disabled={dismiss.isPending}
                className="ml-2 rounded-md border px-3 py-1.5 text-xs font-medium transition hover:brightness-95 disabled:opacity-50"
                style={{
                  borderColor: "var(--color-border-default)",
                  color: "var(--color-danger)",
                  background: "var(--color-surface-app)",
                }}
                title="Dismiss this pattern from future clustering"
              >
                {dismiss.isPending ? "Dismissing..." : "Dismiss"}
              </button>
            </header>

            {showDismissDialog && (
              <div
                className="rounded-md border p-4 mb-2"
                style={{
                  borderColor: "var(--color-border-default)",
                  background: "var(--color-surface-sunken)",
                }}
              >
                <p className="text-sm mb-2" style={{ color: "var(--color-text-primary)" }}>
                  Dismiss &ldquo;{detail.data.title}&rdquo;? Evidence in this cluster will be
                  excluded from future clustering.
                </p>
                <input
                  type="text"
                  placeholder="Reason (optional)"
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  maxLength={500}
                  className="w-full rounded-md border px-3 py-2 text-sm mb-3"
                  style={{
                    borderColor: "var(--color-border-subtle)",
                    background: "var(--color-surface-app)",
                    color: "var(--color-text-primary)",
                  }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDismiss}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
                    style={{ background: "var(--color-danger)" }}
                  >
                    Dismiss pattern
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowDismissDialog(false); setDismissReason(""); }}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium transition hover:brightness-95"
                    style={{
                      borderColor: "var(--color-border-default)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

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
