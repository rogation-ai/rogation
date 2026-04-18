"use client";

import Link from "next/link";
import { use, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { ReadinessGrade } from "@/components/ui/ReadinessGrade";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";
import { StreamingCursor } from "@/components/ui/StreamingCursor";
import { capture } from "@/lib/analytics/posthog-client";
import { EVENTS } from "@/lib/analytics/events";
import { sseFetch } from "@/lib/client/sse-fetch";
import type { SpecIR } from "@/lib/spec/ir";

/*
  Spec editor — streaming generate + readiness grade + Markdown export.

  Three phases:
    1. Before generation: opportunity header + big "Generate spec" CTA.
    2. During generation: live text stream from /api/specs/generate
       with a blinking StreamingCursor. The server persists on its
       own transaction; we just paint bytes.
    3. After generation: grade panel + rendered spec + "Download .md"
       + "Regenerate" + version badge.

  Refinement chat ships in the next commit (Commit C).

  Why SSE instead of the tRPC mutation: spec generation runs 10-30s.
  Staring at a spinner for 20s is a bad UX; streaming tokens makes
  the wait feel like progress instead of a crash. The blocking tRPC
  path still exists (trpc.specs.generate) — we use it as a fallback
  when SSE fails. Both paths share the same orchestrator, readiness
  grade, and persistence so the server-side contract is identical.

  FIRST_SPEC_EXPORTED fires on the first successful markdown
  download (localStorage-guarded so re-downloads don't double-count).
*/

const FIRST_EXPORT_FLAG = "rogation:first-spec-exported";

export default function SpecEditorPage({
  params,
}: {
  params: Promise<{ opportunityId: string }>;
}): React.JSX.Element {
  const { opportunityId } = use(params);

  const utils = trpc.useUtils();
  const latest = trpc.specs.getLatest.useQuery({ opportunityId });
  const opps = trpc.opportunities.list.useQuery();
  const opportunity = opps.data?.find((o) => o.id === opportunityId);

  const [streamText, setStreamText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function startStream() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStreamText("");
    setStreamError(null);
    setIsStreaming(true);

    try {
      await sseFetch({
        url: "/api/specs/generate",
        body: { opportunityId },
        signal: ac.signal,
        onEvent: (ev) => {
          if (ev.type === "delta") {
            setStreamText((s) => s + ev.text);
          } else if (ev.type === "done") {
            // Server persisted — reload the rendered spec view.
            utils.specs.getLatest.invalidate({ opportunityId });
          } else if (ev.type === "error") {
            setStreamError(ev.message);
          }
        },
      });
    } catch (err) {
      if (!ac.signal.aborted) {
        setStreamError(err instanceof Error ? err.message : "Stream failed");
      }
    } finally {
      setIsStreaming(false);
    }
  }

  const [downloading, setDownloading] = useState(false);

  async function downloadMarkdown() {
    setDownloading(true);
    try {
      const file = await utils.client.specs.exportMarkdown.query({
        opportunityId,
      });
      downloadFile(file.filename, file.content);
      maybeFireFirstExport();
    } finally {
      setDownloading(false);
    }
  }

  if (opps.isLoading || latest.isLoading) {
    return <SkeletonList count={4} />;
  }

  if (!opportunity) {
    return (
      <EmptyState
        title="Opportunity not found"
        description="This opportunity no longer exists. The list may have been regenerated."
        primaryAction={{ label: "Back to What to build", href: "/build" }}
      />
    );
  }

  const spec = latest.data;

  return (
    <div className="grid grid-cols-[1fr_320px] gap-8">
      <section className="flex flex-col gap-4">
        <Link
          href="/build"
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          ← What to build
        </Link>
        <h1
          className="text-3xl tracking-tight"
          style={{
            fontFamily: "var(--font-display)",
            color: "var(--color-text-primary)",
          }}
        >
          {opportunity.title}
        </h1>
        <p
          className="text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {opportunity.description}
        </p>
        <p
          className="text-xs italic"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {opportunity.reasoning}
        </p>

        {isStreaming || (streamText && !spec) ? (
          <StreamingPreview text={streamText} live={isStreaming} />
        ) : !spec ? (
          <EmptyState
            title="No spec yet"
            description="One call turns this opportunity and its supporting evidence into a structured PRD: user stories, acceptance criteria, edge cases, QA checklist, citations back to the clusters."
            primaryAction={{
              label: "Generate spec",
              onClick: startStream,
            }}
          />
        ) : (
          <SpecView ir={spec.ir} />
        )}

        {streamError && (
          <p className="text-sm" style={{ color: "var(--color-danger)" }}>
            {streamError}
          </p>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        {spec ? (
          <>
            <ReadinessGrade
              grade={spec.grade ?? "D"}
              checklist={
                spec.checklist ?? {
                  edgesCovered: false,
                  validationSpecified: false,
                  nonFunctionalAddressed: false,
                  acceptanceTestable: false,
                }
              }
            />
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={downloadMarkdown}
                disabled={downloading}
                className="rounded-md px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                style={{ background: "var(--color-brand-accent)" }}
              >
                {downloading ? "Preparing…" : "Download .md"}
              </button>
              <button
                type="button"
                onClick={startStream}
                disabled={isStreaming}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-60"
                style={{
                  borderColor: "var(--color-border-subtle)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {isStreaming ? "Generating…" : "Regenerate"}
              </button>
              <p
                className="text-xs"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Version {spec.version} ·{" "}
                {new Date(spec.updatedAt).toLocaleDateString()}
              </p>
            </div>
          </>
        ) : (
          <div
            className="rounded-lg border p-4 text-xs"
            style={{
              borderColor: "var(--color-border-subtle)",
              background: "var(--color-surface-raised)",
              color: "var(--color-text-tertiary)",
            }}
          >
            Generate once. Regenerate whenever the underlying clusters
            change. Each generation creates a new version; earlier
            versions are retained.
          </div>
        )}
      </aside>
    </div>
  );
}

function StreamingPreview({
  text,
  live,
}: {
  text: string;
  live: boolean;
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border p-6"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <p
        className="text-xs uppercase tracking-widest"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Generating{live ? "…" : ""}
      </p>
      <pre
        className="whitespace-pre-wrap break-words text-xs leading-relaxed"
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          color: "var(--color-text-secondary)",
        }}
      >
        {text}
        {live && <StreamingCursor />}
      </pre>
    </div>
  );
}

function SpecView({ ir }: { ir: SpecIR }): React.JSX.Element {
  // Group criteria by story so the render matches the markdown layout.
  const criteriaByStory = new Map<string, typeof ir.acceptanceCriteria>();
  for (const ac of ir.acceptanceCriteria) {
    const list = criteriaByStory.get(ac.storyId) ?? [];
    list.push(ac);
    criteriaByStory.set(ac.storyId, list);
  }

  return (
    <div
      className="flex flex-col gap-5 rounded-xl border p-6"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <div>
        <h2
          className="text-xl tracking-tight"
          style={{
            fontFamily: "var(--font-display)",
            color: "var(--color-text-primary)",
          }}
        >
          {ir.title}
        </h2>
        <p
          className="mt-2 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {ir.summary}
        </p>
      </div>

      <Section title="User stories">
        <ul className="flex flex-col gap-2 text-sm">
          {ir.userStories.map((us) => (
            <li key={us.id}>
              <span
                className="font-medium"
                style={{ color: "var(--color-text-primary)" }}
              >
                {us.id}
              </span>{" "}
              <span style={{ color: "var(--color-text-secondary)" }}>
                As {us.persona}, I want {us.goal} so that {us.value}.
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Acceptance criteria">
        <div className="flex flex-col gap-3">
          {ir.userStories.map((us) => {
            const criteria = criteriaByStory.get(us.id) ?? [];
            if (criteria.length === 0) return null;
            return (
              <div key={us.id}>
                <p
                  className="text-xs font-medium uppercase tracking-widest"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {us.id}
                </p>
                <ul className="mt-1 flex flex-col gap-1.5 text-sm">
                  {criteria.map((ac, i) => (
                    <li
                      key={`${us.id}-${i}`}
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      <b style={{ color: "var(--color-text-primary)" }}>
                        Given
                      </b>{" "}
                      {ac.given}{" "}
                      <b style={{ color: "var(--color-text-primary)" }}>
                        When
                      </b>{" "}
                      {ac.when}{" "}
                      <b style={{ color: "var(--color-text-primary)" }}>
                        Then
                      </b>{" "}
                      {ac.then}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Section>

      {ir.nonFunctional.length > 0 && (
        <Section title="Non-functional">
          <ul className="flex flex-col gap-1.5 text-sm">
            {ir.nonFunctional.map((nf, i) => (
              <li
                key={i}
                style={{ color: "var(--color-text-secondary)" }}
              >
                <b style={{ color: "var(--color-text-primary)" }}>
                  {nf.category}:
                </b>{" "}
                {nf.requirement}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {ir.edgeCases.length > 0 && (
        <Section title="Edge cases">
          <ul className="flex flex-col gap-2 text-sm">
            {ir.edgeCases.map((ec, i) => (
              <li key={i}>
                <p style={{ color: "var(--color-text-primary)" }}>
                  {ec.scenario}
                </p>
                <p style={{ color: "var(--color-text-secondary)" }}>
                  → {ec.expectedBehavior}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {ir.qaChecklist.length > 0 && (
        <Section title="QA checklist">
          <ul className="flex flex-col gap-1.5 text-sm">
            {ir.qaChecklist.map((q, i) => (
              <li
                key={i}
                className="flex items-start gap-2"
                style={{ color: "var(--color-text-secondary)" }}
              >
                <span
                  className="mt-[3px] inline-block h-3 w-3 rounded-sm border"
                  style={{
                    borderColor: "var(--color-border-default)",
                    background:
                      q.status === "passed"
                        ? "var(--color-success)"
                        : "transparent",
                  }}
                />
                {q.check}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {ir.citations.length > 0 && (
        <Section title="Citations">
          <ul className="flex flex-col gap-1 text-xs">
            {ir.citations.map((c, i) => (
              <li
                key={i}
                style={{ color: "var(--color-text-tertiary)" }}
              >
                <code
                  className="rounded px-1"
                  style={{ background: "var(--color-surface-app)" }}
                >
                  {c.clusterId.slice(0, 8)}
                </code>{" "}
                {c.note}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3
        className="text-xs font-medium uppercase tracking-widest"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/* ---------------------------- side-effects ---------------------------- */

function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function maybeFireFirstExport(): void {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(FIRST_EXPORT_FLAG) === "1") return;
  localStorage.setItem(FIRST_EXPORT_FLAG, "1");
  capture(EVENTS.FIRST_SPEC_EXPORTED, { target: "markdown" });
}
