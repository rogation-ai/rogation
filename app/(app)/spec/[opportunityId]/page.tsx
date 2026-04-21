"use client";

import Link from "next/link";
import { use, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { OutcomeCard } from "@/components/ui/OutcomeCard";
import { ReadinessGrade } from "@/components/ui/ReadinessGrade";
import { CitationChip } from "@/components/ui/CitationChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { FeedbackThumbs } from "@/components/ui/FeedbackThumbs";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";
import { StreamingCursor } from "@/components/ui/StreamingCursor";
import { capture } from "@/lib/analytics/posthog-client";
import { canExport } from "@/lib/plans";
import { EVENTS } from "@/lib/analytics/events";
import { sseFetch } from "@/lib/client/sse-fetch";
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
  const pushLinear = trpc.specs.pushToLinear.useMutation({
    onSuccess: (result) => {
      utils.specs.getLatest.invalidate({ opportunityId });
      // Tell the user the push landed. Without this, the UI used to
      // silently succeed/fail — the 500 path surfaced nothing at all.
      toast.success("Pushed to Linear", {
        description: result.identifier
          ? `Created ${result.identifier}. Opens in Linear.`
          : "Issue created in your Linear workspace.",
        action: result.url
          ? { label: "View", onClick: () => window.open(result.url, "_blank") }
          : undefined,
      });
    },
    onError: (err) => {
      // The silent-500 path. Surface the real server message so users
      // know whether to retry, reconnect, or contact support.
      toast.error("Couldn't push to Linear", {
        description: err.message,
      });
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
                onPush={() => pushLinear.mutate({ opportunityId })}
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
                className="text-xs"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Version {spec.version} ·{" "}
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
    linearIssueUrl: string | null;
    linearIssueIdentifier: string | null;
  };
  plan: "free" | "solo" | "pro";
  integrations: Array<{
    provider: "zendesk" | "posthog" | "canny" | "linear" | "notion";
    connected: boolean;
    status: "active" | "token_invalid" | "rate_limited" | "disabled";
    config: Record<string, unknown> | null;
  }>;
  isPushing: boolean;
  pushError: string | null;
  onPush: () => void;
}

/*
  Push-to-Linear CTA block. Picks one of five mutually exclusive
  states, in order:

    1. Already pushed      → "View in Linear →" link (keep URL + id).
    2. Plan doesn't allow  → Upgrade CTA to /pricing.
    3. Not connected       → "Connect Linear first →" link.
    4. No default team     → "Pick a team →" link.
    5. Ready to push       → solid "Push to Linear" button.

  Error messages from the mutation surface inline below the button
  so the user sees precisely why it failed (rate limit, token
  revoked, etc.) without hunting through the network tab.
*/
function LinearPushBlock({
  spec,
  plan,
  integrations,
  isPushing,
  pushError,
  onPush,
}: LinearPushBlockProps): React.JSX.Element {
  if (spec.linearIssueUrl) {
    return (
      <a
        href={spec.linearIssueUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium"
        style={{
          borderColor: "var(--color-border-subtle)",
          color: "var(--color-text-primary)",
        }}
      >
        View in Linear{spec.linearIssueIdentifier ? ` · ${spec.linearIssueIdentifier}` : ""} →
      </a>
    );
  }

  if (!canExport(plan, "linear")) {
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

  const linear = integrations.find((i) => i.provider === "linear");
  if (!linear?.connected) {
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

  const defaultTeamId =
    typeof linear.config?.defaultTeamId === "string"
      ? linear.config.defaultTeamId
      : null;
  const defaultTeamName =
    typeof linear.config?.defaultTeamName === "string"
      ? linear.config.defaultTeamName
      : null;

  if (!defaultTeamId) {
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
        {isPushing ? "Pushing…" : `Push to Linear (${defaultTeamName ?? "team"})`}
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
