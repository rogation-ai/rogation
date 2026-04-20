"use client";

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { SourceIcon, sourceLabel, type SourceType } from "@/components/ui/SourceIcon";
import { SegmentTag } from "@/components/ui/SegmentTag";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";

/*
  Evidence library. Lists every piece of evidence on the account
  newest-first with a delete affordance. "I pasted a transcript ten
  minutes ago, can I see it again?" belongs here.

  Cascade behaviour: deleting an evidence row deletes every
  evidence_to_cluster + evidence_to_opportunity edge via FK ON DELETE
  CASCADE. The cluster row itself stays; it'll look thinner on the
  next insights.run. PMs are shown the consequence before they
  confirm so nothing silently weakens an insight.
*/

const PREVIEW_CHARS = 240;

export default function EvidenceLibraryPage(): React.JSX.Element {
  const listQ = trpc.evidence.list.useQuery({ limit: 100 });
  const utils = trpc.useUtils();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const del = trpc.evidence.delete.useMutation({
    onSuccess: () => {
      setPendingDeleteId(null);
      utils.evidence.list.invalidate();
      utils.evidence.count.invalidate();
      utils.account.me.invalidate();
    },
    onError: (err) => {
      alert(err.message);
      setPendingDeleteId(null);
    },
  });

  if (listQ.isPending) {
    return (
      <div className="space-y-6">
        <Header count={null} />
        <SkeletonList count={5} />
      </div>
    );
  }

  if (listQ.isError) {
    return (
      <div className="space-y-6">
        <Header count={null} />
        <p style={{ color: "var(--color-danger)" }}>
          Couldn&apos;t load evidence: {listQ.error.message}
        </p>
      </div>
    );
  }

  const rows = listQ.data.rows;

  if (rows.length === 0) {
    return (
      <div className="space-y-6">
        <Header count={0} />
        <EmptyState
          title="No evidence yet"
          description="Paste a transcript, a support ticket, or a pasted doc on the Upload screen and it'll show up here."
          primaryAction={{ label: "Go to Upload", href: "/app" }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header count={rows.length} />

      <ul
        className="divide-y rounded-lg border"
        style={{ borderColor: "var(--color-border-subtle)" }}
      >
        {rows.map((row) => {
          const isDeleting =
            del.isPending && pendingDeleteId === row.id;
          return (
            <li key={row.id} className="px-4 py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  <SourceIcon source={row.sourceType as SourceType} size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className="font-medium"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {sourceLabel(row.sourceType as SourceType)}
                    </span>
                    <span style={{ color: "var(--color-text-tertiary)" }}>
                      · {formatDate(row.createdAt)}
                    </span>
                    {row.segment ? (
                      <SegmentTag name={row.segment} />
                    ) : null}
                    {row.sourceRef ? (
                      <span
                        className="truncate"
                        style={{ color: "var(--color-text-tertiary)" }}
                        title={row.sourceRef}
                      >
                        · {row.sourceRef}
                      </span>
                    ) : null}
                  </div>
                  <p
                    className="mt-1.5 text-sm whitespace-pre-wrap break-words"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {truncate(row.content, PREVIEW_CHARS)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !confirm(
                        "Delete this piece of evidence? Any clusters that cited it will no longer be supported by this quote on the next re-cluster.",
                      )
                    ) {
                      return;
                    }
                    setPendingDeleteId(row.id);
                    del.mutate({ id: row.id });
                  }}
                  disabled={del.isPending}
                  className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium transition hover:bg-[var(--color-surface-raised)] disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor: "var(--color-border-subtle)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {isDeleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {listQ.data.nextCursor ? (
        <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
          Showing the 100 most recent. Older items are still stored but not yet paginated here.
        </p>
      ) : null}
    </div>
  );
}

function Header({ count }: { count: number | null }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <div>
        <h1
          className="text-3xl tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Evidence
        </h1>
        <p
          className="mt-1 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Everything you&apos;ve pasted or uploaded, newest first.
          {count !== null ? ` ${count} row${count === 1 ? "" : "s"}.` : null}
        </p>
      </div>
      <Link
        href="/app"
        className="text-sm"
        style={{ color: "var(--color-brand-accent)" }}
      >
        + Add more →
      </Link>
    </div>
  );
}

/** Truncate to N chars on a word boundary; append ellipsis if we cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

/** Human-friendly date label. Same day → time only; else → short date. */
export function formatDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
