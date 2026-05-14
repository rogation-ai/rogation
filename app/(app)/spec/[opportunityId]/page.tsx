"use client";

import Link from "next/link";
import { use, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { OutcomeCard } from "@/components/ui/OutcomeCard";
import { ReadinessGrade } from "@/components/ui/ReadinessGrade";
import { StaleBanner } from "@/components/ui/StaleBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CitationChip } from "@/components/ui/CitationChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { FeedbackThumbs } from "@/components/ui/FeedbackThumbs";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";
import { StreamingCursor } from "@/components/ui/StreamingCursor";
import { capture } from "@/lib/analytics/posthog-client";
import { canExport } from "@/lib/plans";
import { EVENTS } from "@/lib/analytics/events";
import { sseFetch } from "@/lib/client/sse-fetch";
import {
  extractLinearConflictFromError,
  pickLinearPushState,
} from "@/lib/client/linear-push-state";
import { useFeedbackThumbs } from "@/lib/client/use-feedback-thumbs";
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
  const me = trpc.account.me.useQuery();
  const integrationsList = trpc.integrations.list.useQuery();
  // Only fetch the prior-project lookup when the current spec hasn't
  // been pushed yet. If linearProjectUrl is set, the "Already pushed"
  // state takes precedence and this query result would be unused.
  const priorLinear = trpc.specs.priorLinearProject.useQuery(
    { opportunityId },
    { enabled: latest.data?.linearProjectUrl == null },
  );

  // D3 confirm-modal state. When the server returns
  // CONFLICT(linear-project-exists[-but-empty]), we open the modal
  // with the conflict envelope so the PM picks update vs create-new.
  const [linearConflict, setLinearConflict] = useState<{
    kind: "linear-project-exists" | "linear-project-exists-but-empty";
    projectId: string;
    projectUrl: string;
    issueCount: number;
  } | null>(null);

  // recreatedAfterDelete inline note dismiss state. Keyed by
  // linearProjectId so the PM doesn't re-see it for the same project
  // across page reloads. Persisted in localStorage per design doc §6.6.
  const RECREATED_DISMISS_KEY = "rogation:linear-recreated-dismissed";
  const [recreatedDismissedIds, setRecreatedDismissedIds] = useState<
    Set<string>
  >(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem(RECREATED_DISMISS_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const [recreatedFlag, setRecreatedFlag] = useState<string | null>(null);

  function dismissRecreatedNote(projectId: string): void {
    setRecreatedDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(projectId);
      try {
        window.localStorage.setItem(
          RECREATED_DISMISS_KEY,
          JSON.stringify(Array.from(next)),
        );
      } catch {
        // localStorage quota exceeded or disabled — note re-shows on
        // next reload. Acceptable degradation.
      }
      return next;
    });
  }

  const pushLinear = trpc.specs.pushToLinear.useMutation({
    onSuccess: (result) => {
      utils.specs.getLatest.invalidate({ opportunityId });
      utils.specs.priorLinearProject.invalidate({ opportunityId });
      setLinearConflict(null);
      if (result.recreatedAfterDelete) {
        setRecreatedFlag(result.projectId);
      }
      toast.success("Pushed to Linear", {
        description:
          result.issueCount === 1
            ? "Project created with 1 issue."
            : `Project created with ${result.issueCount} issues.`,
        action: result.projectUrl
          ? {
              label: "View",
              onClick: () =>
                window.open(result.projectUrl, "_blank", "noopener,noreferrer"),
            }
          : undefined,
      });
    },
    onError: (err) => {
      // CONFLICT with the project-exists shape: open the D3 modal
      // instead of showing a generic error toast. The narrowing logic
      // lives in lib/client/linear-push-state for testability.
      const conflict = extractLinearConflictFromError(err);
      if (conflict !== null) {
        setLinearConflict(conflict);
        return;
      }
      toast.error("Couldn't push to Linear", {
        description: err.message,
      });
    },
  });
  const pushNotion = trpc.integrations.pushSpecToNotion.useMutation({
    onSuccess: (result) => {
      utils.specs.getLatest.invalidate({ opportunityId });
      toast.success("Pushed to Notion", {
        description: "Page created in your Rogation Specs database.",
        action: result.url
          ? {
              label: "Open",
              onClick: () =>
                window.open(result.url, "_blank", "noopener,noreferrer"),
            }
          : undefined,
      });
    },
    onError: (err) => {
      toast.error("Couldn't push to Notion", { description: err.message });
    },
  });
  const refinements = trpc.specs.refinements.useQuery(
    { opportunityId },
    { enabled: !!latest.data },
  );
  const opps = trpc.opportunities.list.useQuery();
  const opportunity = opps.data?.find((o) => o.id === opportunityId);

  const specFeedback = useFeedbackThumbs(
    "spec",
    latest.data ? [latest.data.id] : [],
  );

  // Resolve citation cluster UUIDs to titles so CitationChip can
  // render names instead of opaque UUIDs. RLS scopes the lookup;
  // clusters that have been deleted or refined away return nothing,
  // and CitationChip renders the "unresolved" fallback.
  const citationIds = latest.data?.ir.citations.map((c) => c.clusterId) ?? [];
  const resolvedClusters = trpc.insights.byIds.useQuery(
    { clusterIds: citationIds },
    { enabled: citationIds.length > 0 },
  );
  const clusterLookup = new Map(
    (resolvedClusters.data ?? []).map((c) => [
      c.id,
      { title: c.title, severity: c.severity },
    ]),
  );

  const [streamText, setStreamText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Chat state lives alongside the spec stream but drives a separate
  // endpoint + preview.
  const [chatInput, setChatInput] = useState("");
  const [chatStreamText, setChatStreamText] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);

  async function startStream(endpoint: "generate" | "refine", extra: Record<string, unknown> = {}) {
    const isChat = endpoint === "refine";
    const ref = isChat ? chatAbortRef : abortRef;
    ref.current?.abort();
    const ac = new AbortController();
    ref.current = ac;

    if (isChat) {
      setChatStreamText("");
      setChatError(null);
      setIsChatting(true);
    } else {
      setStreamText("");
      setStreamError(null);
      setIsStreaming(true);
    }

    try {
      await sseFetch({
        url: `/api/specs/${endpoint}`,
        body: { opportunityId, ...extra },
        signal: ac.signal,
        onEvent: (ev) => {
          if (ev.type === "delta") {
            if (isChat) setChatStreamText((s) => s + ev.text);
            else setStreamText((s) => s + ev.text);
          } else if (ev.type === "done") {
            utils.specs.getLatest.invalidate({ opportunityId });
            utils.specs.refinements.invalidate({ opportunityId });
            if (isChat) setChatStreamText("");
          } else if (ev.type === "error") {
            if (isChat) setChatError(ev.message);
            else setStreamError(ev.message);
          }
        },
      });
    } catch (err) {
      if (!ac.signal.aborted) {
        const msg = err instanceof Error ? err.message : "Stream failed";
        if (isChat) setChatError(msg);
        else setStreamError(msg);
      }
    } finally {
      if (isChat) setIsChatting(false);
      else setIsStreaming(false);
    }
  }

  async function sendChat() {
    const trimmed = chatInput.trim();
    if (!trimmed || isChatting) return;
    setChatInput("");
    await startStream("refine", { userMessage: trimmed });
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
      {linearConflict !== null && (
        <ConfirmDialog
          open={true}
          title={
            linearConflict.kind === "linear-project-exists-but-empty"
              ? "Continue the first push?"
              : "This spec is already a Linear project"
          }
          body={
            linearConflict.kind === "linear-project-exists-but-empty" ? (
              <>
                A prior push created the project but no issues were created
                yet. Continue and create the issues now?
              </>
            ) : (
              <>
                This project has{" "}
                <strong>
                  {linearConflict.issueCount}{" "}
                  {linearConflict.issueCount === 1 ? "issue" : "issues"}
                </strong>
                . What should we do?
              </>
            )
          }
          primaryAction={
            linearConflict.kind === "linear-project-exists-but-empty"
              ? {
                  label: "Continue first push",
                  onClick: () =>
                    pushLinear.mutate({
                      opportunityId,
                      mode: "update-in-place",
                    }),
                  subtext:
                    "Issues will be created in the existing empty project.",
                  disabled: pushLinear.isPending,
                }
              : {
                  label: "Update existing project",
                  onClick: () =>
                    pushLinear.mutate({
                      opportunityId,
                      mode: "update-in-place",
                    }),
                  subtext:
                    "Removed stories will be archived. Assignees are not notified.",
                  disabled: pushLinear.isPending,
                }
          }
          secondaryAction={
            linearConflict.kind === "linear-project-exists-but-empty"
              ? undefined
              : {
                  label: "Create new project",
                  onClick: () =>
                    pushLinear.mutate({
                      opportunityId,
                      mode: "create-new",
                    }),
                  subtext: "The existing project stays in Linear untouched.",
                  disabled: pushLinear.isPending,
                }
          }
          onCancel={() => setLinearConflict(null)}
          inFlight={
            pushLinear.isPending ? { label: "Updating project" } : undefined
          }
        />
      )}
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

        {spec?.stale && !isStreaming && (
          <StaleBanner
            message="Source clusters changed since this spec was generated. Regenerating creates a new version and starts a new chat thread."
            actionLabel="Regenerate spec"
            isRunning={isStreaming}
            onAction={() => startStream("generate")}
          />
        )}

        {isStreaming || (streamText && !spec) ? (
          <StreamingPreview text={streamText} live={isStreaming} />
        ) : !spec ? (
          <EmptyState
            title="No spec yet"
            description="One call turns this opportunity and its supporting evidence into a structured PRD: user stories, acceptance criteria, edge cases, QA checklist, citations back to the clusters."
            primaryAction={{
              label: "Generate spec",
              onClick: () => startStream("generate"),
            }}
          />
        ) : (
          <SpecView ir={spec.ir} clusterLookup={clusterLookup} />
        )}

        {streamError && (
          <p className="text-sm" style={{ color: "var(--color-danger)" }}>
            {streamError}
          </p>
        )}

        {spec && (
          <ChatPanel
            history={refinements.data ?? []}
            isChatting={isChatting}
            streamText={chatStreamText}
            chatError={chatError}
            input={chatInput}
            onInput={setChatInput}
            onSend={sendChat}
          />
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
            <div
              className="flex items-center justify-between rounded-lg border p-3 text-xs"
              style={{
                borderColor: "var(--color-border-subtle)",
                background: "var(--color-surface-raised)",
                color: "var(--color-text-secondary)",
              }}
            >
              <span>Rate this spec</span>
              <FeedbackThumbs
                value={specFeedback.votes[spec.id] ?? null}
                onChange={(next) => specFeedback.setVote(spec.id, next)}
                label="Rate spec"
              />
            </div>
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
              <LinearPushBlock
                spec={spec}
                plan={me.data?.account.plan ?? "free"}
                integrations={integrationsList.data ?? []}
                isPushing={pushLinear.isPending}
                pushError={pushLinear.error?.message ?? null}
                priorProject={priorLinear.data ?? null}
                showRecreatedNote={
                  recreatedFlag !== null &&
                  !recreatedDismissedIds.has(recreatedFlag)
                }
                onDismissRecreatedNote={() => {
                  if (recreatedFlag !== null)
                    dismissRecreatedNote(recreatedFlag);
                }}
                onPush={() =>
                  pushLinear.mutate({ opportunityId, mode: undefined })
                }
              />
              <NotionPushBlock
                plan={me.data?.account.plan ?? "free"}
                integrations={integrationsList.data ?? []}
                isPushing={pushNotion.isPending}
                pushError={pushNotion.error?.message ?? null}
                pushedUrl={pushNotion.data?.url ?? null}
                onPush={() => pushNotion.mutate({ opportunityId })}
              />
              <button
                type="button"
                onClick={() => startStream("generate")}
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
                className="text-xs tabular-nums"
                style={{
                  color: "var(--color-text-tertiary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                v{spec.version} ·{" "}
                {new Date(spec.updatedAt).toLocaleDateString()}
              </p>
            </div>
            <OutcomeCard
              opportunityId={opportunityId}
              plan={me.data?.account.plan ?? "free"}
            />
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

function ChatPanel({
  history,
  isChatting,
  streamText,
  chatError,
  input,
  onInput,
  onSend,
}: {
  history: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  isChatting: boolean;
  streamText: string;
  chatError: string | null;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
}): React.JSX.Element {
  const showEmpty = history.length === 0 && !isChatting && !streamText;

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-5"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-app)",
      }}
    >
      <header className="flex items-center justify-between">
        <h2
          className="text-xs font-medium uppercase tracking-widest"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Refine
        </h2>
        <span
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Each message rewrites the spec as a new version
        </span>
      </header>

      {showEmpty ? (
        <p
          className="text-sm"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Ask for tightening, rewording, adding edge cases, tighter
          acceptance criteria, … anything the spec is missing.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {history.map((m) => (
            <li
              key={m.id}
              className="flex flex-col gap-1 text-sm"
              style={{ color: "var(--color-text-primary)" }}
            >
              <span
                className="text-xs uppercase tracking-widest"
                style={{
                  color:
                    m.role === "user"
                      ? "var(--color-brand-accent)"
                      : "var(--color-text-tertiary)",
                }}
              >
                {m.role === "user" ? "You" : "Assistant"}
              </span>
              <p
                className="whitespace-pre-wrap"
                style={{
                  color:
                    m.role === "user"
                      ? "var(--color-text-primary)"
                      : "var(--color-text-secondary)",
                }}
              >
                {m.content}
              </p>
            </li>
          ))}
          {(isChatting || streamText) && (
            <li className="flex flex-col gap-1 text-sm">
              <span
                className="text-xs uppercase tracking-widest"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Assistant
              </span>
              <pre
                className="whitespace-pre-wrap break-words text-xs leading-relaxed"
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  color: "var(--color-text-secondary)",
                }}
              >
                {streamText}
                {isChatting && <StreamingCursor />}
              </pre>
            </li>
          )}
        </ol>
      )}

      {chatError && (
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {chatError}
        </p>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={
            isChatting
              ? "Generating…"
              : "Tighten AC for US2… add an edge case for offline mode… (⌘Enter to send)"
          }
          rows={2}
          disabled={isChatting}
          className="flex-1 resize-none rounded-md border p-2 text-sm disabled:opacity-60"
          style={{
            borderColor: "var(--color-border-default)",
            background: "var(--color-surface-raised)",
            color: "var(--color-text-primary)",
          }}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={isChatting || !input.trim()}
          className="rounded-md px-3 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          style={{ background: "var(--color-brand-accent)" }}
        >
          {isChatting ? "…" : "Send"}
        </button>
      </div>
    </section>
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

function SpecView({
  ir,
  clusterLookup,
}: {
  ir: SpecIR;
  clusterLookup: Map<
    string,
    { title: string; severity: "low" | "medium" | "high" | "critical" }
  >;
}): React.JSX.Element {
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
          <ul className="flex flex-col gap-2 text-xs">
            {ir.citations.map((c, i) => {
              const resolved = clusterLookup.get(c.clusterId);
              return (
                <li
                  key={i}
                  className="flex items-start gap-2"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  <CitationChip
                    clusterId={c.clusterId}
                    title={resolved?.title ?? null}
                    severity={resolved?.severity}
                    note={c.note}
                  />
                  <span>{c.note}</span>
                </li>
              );
            })}
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

/* ---------------------------- linear push ---------------------------- */

interface LinearPushBlockProps {
  spec: {
    ir: SpecIR;
    linearProjectUrl: string | null;
    linearProjectId: string | null;
    linearIssueMap: Record<
      string,
      { id: string; identifier: string; url: string }
    > | null;
  };
  plan: "free" | "solo" | "pro";
  integrations: Array<{
    provider: "zendesk" | "posthog" | "canny" | "linear" | "notion" | "slack" | "hotjar";
    connected: boolean;
    status: "active" | "token_invalid" | "rate_limited" | "disabled";
    config: Record<string, unknown> | null;
  }>;
  isPushing: boolean;
  pushError: string | null;
  /**
   * Latest prior version of this spec that did push to Linear. Drives
   * the refinement-gap banner: when a refined spec has no
   * linearProjectId but a prior version did, show a banner linking
   * back to the prior project.
   */
  priorProject: { projectId: string; projectUrl: string } | null;
  /** Whether to show the recreatedAfterDelete inline note. */
  showRecreatedNote: boolean;
  onDismissRecreatedNote: () => void;
  onPush: () => void;
}

/*
  Push-to-Linear CTA block. States, in priority order:

    1. Already pushed                → two-row layout: full-row deep
                                       link to the project + outlined
                                       "Update from latest spec" CTA.
                                       Plus optional partial-success
                                       StaleBanner above if the issue
                                       map is incomplete.
    2. Refinement-gap (prior version
       had a project; this version
       doesn't)                      → StaleBanner tone=info linking
                                       to prior project + push CTA
                                       demoted to outlined neutral.
    3. Plan doesn't allow            → Upgrade CTA to /pricing.
    4. Not connected                 → "Connect Linear first →" link.
    5. No default team               → "Pick a team →" link.
    6. Ready to push (first push)    → solid brand-accent button.

  Error messages surface inline below the CTA so users see precisely
  why it failed (rate limit, token revoked, etc.) without hunting
  through the network tab.

  Accessibility:
    - The recreatedAfterDelete note uses role="status" (informational,
      not interruptive). ConfirmDialog handles its own a11y.
*/
function LinearPushBlock({
  spec,
  plan,
  integrations,
  isPushing,
  pushError,
  priorProject,
  showRecreatedNote,
  onDismissRecreatedNote,
  onPush,
}: LinearPushBlockProps): React.JSX.Element {
  const linear = integrations.find((i) => i.provider === "linear");
  const state = pickLinearPushState({
    spec,
    plan,
    planAllowsLinearExport: canExport(plan, "linear"),
    linearIntegration: linear ?? null,
    priorProject,
  });

  // STATE: Already pushed (this spec version has a Linear project).
  // pickLinearPushState only returns these states when both fields
  // are non-null; coerce with `??` for the type narrowing the compiler
  // can't see across the function boundary.
  if (state === "pushed" || state === "pushed-partial") {
    const projectUrl = spec.linearProjectUrl ?? "";
    const issueMap = spec.linearIssueMap ?? {};
    const issueCount = Object.keys(issueMap).length;
    const expected = spec.ir.userStories.length;
    const isPartial = state === "pushed-partial";

    return (
      <div className="flex flex-col gap-2">
        {showRecreatedNote && (
          <div
            role="status"
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--color-border-subtle)",
              color: "var(--color-text-secondary)",
            }}
          >
            <span>Your previous Linear project was deleted; we created a new one.</span>
            <button
              type="button"
              onClick={onDismissRecreatedNote}
              aria-label="Dismiss"
              className="hover:opacity-80"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              ×
            </button>
          </div>
        )}

        {isPartial && (
          <StaleBanner
            message={`${issueCount} of ${expected} stories pushed — retry to fix.`}
            actionLabel={isPushing ? "Retrying…" : "Retry update"}
            onAction={onPush}
            isRunning={isPushing}
            tone="warn"
          />
        )}

        <a
          href={projectUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="flex items-center justify-between gap-2 rounded-md border px-4 py-2 text-sm font-medium"
          style={{
            borderColor: "var(--color-border-subtle)",
            color: "var(--color-text-primary)",
          }}
        >
          <span className="truncate">
            Linear ·{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {issueCount} {issueCount === 1 ? "issue" : "issues"}
            </span>
          </span>
          <span>→</span>
        </a>

        <button
          type="button"
          onClick={onPush}
          disabled={isPushing}
          className="rounded-md border px-4 py-2 text-sm disabled:opacity-60"
          style={{
            borderColor: "var(--color-border-default)",
            color: "var(--color-text-primary)",
          }}
        >
          {isPushing ? "Pushing…" : "Update from latest spec"}
        </button>

        {pushError ? (
          <p className="text-xs" style={{ color: "var(--color-danger)" }}>
            {pushError}
          </p>
        ) : null}
      </div>
    );
  }

  // STATES: not yet pushed. Each branch is selected by pickLinearPushState.
  if (state === "upgrade-required") {
    return (
      <Link
        href="/pricing"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-secondary)",
        }}
      >
        Push to Linear · Upgrade to Pro →
      </Link>
    );
  }

  if (state === "not-connected") {
    return (
      <Link
        href="/settings/integrations"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-secondary)",
        }}
      >
        Connect Linear first →
      </Link>
    );
  }

  if (state === "no-default-team") {
    return (
      <Link
        href="/settings/integrations"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-secondary)",
        }}
      >
        Pick a Linear team →
      </Link>
    );
  }

  // Refinement-gap: prior version had a project; this version doesn't.
  // Banner + demoted CTA so the PM sees the linkback before clicking.
  const hasRefinementGap = state === "refinement-gap";

  return (
    <div className="flex flex-col gap-2">
      {hasRefinementGap && priorProject && (
        <StaleBanner
          message="This refined spec hasn't been pushed. Your previous Linear project will stay untouched."
          actionLabel="View previous"
          onAction={() =>
            window.open(
              priorProject.projectUrl,
              "_blank",
              "noopener,noreferrer",
            )
          }
          tone="info"
        />
      )}

      <button
        type="button"
        onClick={onPush}
        disabled={isPushing}
        className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
        style={
          hasRefinementGap
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
        {isPushing
          ? "Pushing…"
          : hasRefinementGap
            ? "Push refined spec as new project"
            : "Push project to Linear"}
      </button>
      {pushError ? (
        <p className="text-xs" style={{ color: "var(--color-danger)" }}>
          {pushError}
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------- notion push ---------------------------- */

interface NotionPushBlockProps {
  plan: "free" | "solo" | "pro";
  integrations: Array<{
    provider: "zendesk" | "posthog" | "canny" | "linear" | "notion" | "slack" | "hotjar";
    connected: boolean;
    status: "active" | "token_invalid" | "rate_limited" | "disabled";
    config: Record<string, unknown> | null;
  }>;
  isPushing: boolean;
  pushError: string | null;
  pushedUrl: string | null;
  onPush: () => void;
}

/*
  Push-to-Notion CTA. Mirrors LinearPushBlock — five mutually exclusive
  states, in order:

    1. Just pushed         → "Open in Notion →" link.
    2. Plan doesn't allow  → Upgrade CTA to /pricing.
    3. Not connected       → "Connect Notion first →" link.
    4. No default DB       → "Reconnect with page access →" link.
    5. Ready               → solid "Push to Notion" button.
*/
function NotionPushBlock({
  plan,
  integrations,
  isPushing,
  pushError,
  pushedUrl,
  onPush,
}: NotionPushBlockProps): React.JSX.Element {
  if (pushedUrl) {
    return (
      <a
        href={pushedUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-primary)",
        }}
      >
        Open in Notion →
      </a>
    );
  }

  if (!canExport(plan, "notion")) {
    return (
      <Link
        href="/pricing"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-secondary)",
        }}
      >
        Push to Notion · Upgrade to Pro →
      </Link>
    );
  }

  const notion = integrations.find((i) => i.provider === "notion");
  if (!notion?.connected) {
    return (
      <Link
        href="/settings/integrations"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-secondary)",
        }}
      >
        Connect Notion first →
      </Link>
    );
  }

  const defaultDatabaseId =
    typeof notion.config?.defaultDatabaseId === "string"
      ? notion.config.defaultDatabaseId
      : null;

  if (!defaultDatabaseId) {
    return (
      <Link
        href="/settings/integrations"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-secondary)",
        }}
      >
        Reconnect Notion with page access →
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={onPush}
        disabled={isPushing}
        className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60"
        style={{
          borderColor: "var(--color-brand-accent)",
          color: "var(--color-brand-accent)",
        }}
      >
        {isPushing ? "Pushing…" : "Push to Notion"}
      </button>
      {pushError ? (
        <p className="text-xs" style={{ color: "var(--color-danger)" }}>
          {pushError}
        </p>
      ) : null}
    </>
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
