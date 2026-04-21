"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { NumberedStepper } from "@/components/ui/NumberedStepper";
import { EVENTS } from "@/lib/analytics/events";
import { capture } from "@/lib/analytics/posthog-client";

/*
  Onboarding — matches approved mockup
  ~/.gstack/projects/rogation-ai-rogation/designs/onboarding-upload-20260417/
  variant-A-v2.png. Drop files OR paste text OR connect a source, get
  to first insight in ~90 seconds.

  This commit wires the dropzone to /api/evidence/upload for .txt
  files. Paste was wired in the previous commit. PDF / VTT / CSV are
  still disabled — the Route Handler rejects them with a clear
  "unsupported" message that the UI surfaces inline.

  Stepper advances from "Upload" to "Cluster" once the account has
  hit the thin-corpus threshold (10 pieces). Clustering itself lands
  with the synthesis commit.
*/

const THIN_CORPUS_THRESHOLD = 10;

interface UploadResult {
  filename: string;
  id?: string;
  deduped?: boolean;
  error?: string;
}

interface UploadResponse {
  results: UploadResult[];
  capHit: { code: string; message: string } | null;
}

export default function AppHome(): React.JSX.Element {
  const me = trpc.account.me.useQuery();
  const evCount = trpc.evidence.count.useQuery();
  // Cluster existence drives the stepper's "First insight" state. A
  // returning user with clusters shouldn't see the stepper claim they
  // still need to run their first clustering pass.
  const clusters = trpc.insights.list.useQuery();
  const utils = trpc.useUtils();
  const paste = trpc.evidence.paste.useMutation({
    onSuccess: () => {
      utils.evidence.count.invalidate();
      utils.account.me.invalidate();
    },
  });
  const seedSample = trpc.evidence.seedSample.useMutation({
    onSuccess: (result) => {
      utils.evidence.count.invalidate();
      utils.account.me.invalidate();
      capture(EVENTS.SAMPLE_DATA_USED, {
        inserted: result.inserted,
        deduped: result.deduped,
        capReached: result.capReached,
      });
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pasteText, setPasteText] = useState("");
  const [firstUploadFired, setFirstUploadFired] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [splitOnBlankLines, setSplitOnBlankLines] = useState(false);
  const [uploadResults, setUploadResults] = useState<UploadResult[] | null>(
    null,
  );

  const count = evCount.data?.count ?? 0;
  const clusterCount = clusters.data?.length ?? 0;
  const onboardingStep: "upload" | "cluster" | "done" =
    clusterCount > 0
      ? "done"
      : count < THIN_CORPUS_THRESHOLD
        ? "upload"
        : "cluster";
  const remaining = Math.max(THIN_CORPUS_THRESHOLD - count, 0);

  useEffect(() => {
    if (count > 0 && !firstUploadFired) {
      capture(EVENTS.FIRST_UPLOAD_STARTED, {
        sourceType: "paste_or_upload",
        fileCount: count,
      });
      setFirstUploadFired(true);
    }
  }, [count, firstUploadFired]);

  async function submitPaste() {
    const trimmed = pasteText.trim();
    if (!trimmed) return;
    try {
      await paste.mutateAsync({ content: trimmed });
      setPasteText("");
    } catch {
      // tRPC exposes the error via paste.error below.
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    setIsUploading(true);
    setUploadResults(null);

    const form = new FormData();
    for (const file of list) form.append("files", file);
    if (splitOnBlankLines) form.append("splitOnBlankLines", "true");

    try {
      const res = await fetch("/api/evidence/upload", {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as UploadResponse | { error: string };
      if (!res.ok) {
        setUploadResults([
          { filename: "", error: "error" in body ? body.error : "Upload failed" },
        ]);
      } else if ("results" in body) {
        setUploadResults(body.results);
        utils.evidence.count.invalidate();
        utils.account.me.invalidate();
      }
    } catch (err) {
      setUploadResults([
        { filename: "", error: err instanceof Error ? err.message : "Network error" },
      ]);
    } finally {
      setIsUploading(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
  }

  if (me.isLoading || evCount.isLoading) {
    return (
      <p style={{ color: "var(--color-text-tertiary)" }}>Loading…</p>
    );
  }

  // Hide the onboarding stepper entirely for returning users. Once
  // they've produced a cluster, the stepper is pure noise — and a
  // stepper that says "First insight: upcoming" when the user has
  // 7 clusters is worse than no stepper at all.
  const showStepper = onboardingStep !== "done";

  return (
    <div className="flex flex-col items-center gap-12">
      {showStepper && (
        <NumberedStepper
          steps={[
            {
              label: "Upload",
              state: onboardingStep === "upload" ? "current" : "completed",
            },
            {
              label: "Cluster",
              state: onboardingStep === "cluster" ? "current" : "upcoming",
            },
            { label: "First insight", state: "upcoming" },
          ]}
        />
      )}

      <section className="w-full max-w-xl">
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={onDrop}
          className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center transition"
          style={{
            borderColor: isDragOver
              ? "var(--color-brand-accent)"
              : "var(--color-border-default)",
            background: isDragOver
              ? "var(--color-surface-marketing)"
              : "var(--color-surface-raised)",
            opacity: isUploading ? 0.6 : 1,
          }}
        >
          <h1
            className="text-xl tracking-tight"
            style={{
              fontFamily: "var(--font-display)",
              color: "var(--color-text-primary)",
            }}
          >
            {isUploading
              ? "Uploading…"
              : "Drop files → 3 insights in ~90 seconds"}
          </h1>
          <p
            className="text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            .txt / .md today · PDF / VTT / CSV next commit
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.log,text/*"
            className="hidden"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
        </div>

        <label
          className="mt-3 flex items-center gap-2 text-xs"
          style={{ color: "var(--color-text-secondary)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={splitOnBlankLines}
            onChange={(e) => setSplitOnBlankLines(e.target.checked)}
            disabled={isUploading}
          />
          <span>
            Split each file into one entry per paragraph
            <span
              className="ml-1"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              · good for ticket dumps, skip for transcripts
            </span>
          </span>
        </label>

        {uploadResults && (
          <ul
            className="mt-3 divide-y rounded-md border text-sm"
            style={{ borderColor: "var(--color-border-subtle)" }}
          >
            {uploadResults.map((r, i) => (
              <li
                key={`${r.filename}-${i}`}
                className="flex items-center justify-between gap-3 px-3 py-2"
                style={{ borderColor: "var(--color-border-subtle)" }}
              >
                <span
                  className="truncate"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  {r.filename || "(batch)"}
                </span>
                {r.error ? (
                  <span style={{ color: "var(--color-danger)" }}>
                    {r.error}
                  </span>
                ) : r.deduped ? (
                  <span style={{ color: "var(--color-text-tertiary)" }}>
                    deduped
                  </span>
                ) : (
                  <span style={{ color: "var(--color-success)" }}>added</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="Or paste raw support ticket text…"
          rows={4}
          className="mt-3 w-full rounded-md border p-3 text-sm"
          style={{
            borderColor: "var(--color-border-default)",
            background: "var(--color-surface-app)",
            color: "var(--color-text-primary)",
          }}
          disabled={paste.isPending}
        />

        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            onClick={submitPaste}
            disabled={paste.isPending || !pasteText.trim()}
            // Disabled state is ~30% opacity + grayscale so there's no
            // ambiguity between "button off" and "brand color is just
            // muted." Idle/enabled stays full-saturation brand accent.
            className="rounded-md px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30 disabled:grayscale"
            style={{ background: "var(--color-brand-accent)" }}
          >
            {paste.isPending ? "Adding…" : "Add evidence"}
          </button>

          {paste.error && (
            <span
              className="text-xs"
              style={{ color: "var(--color-danger)" }}
            >
              {paste.error.message}
            </span>
          )}

          {remaining > 0 && count > 0 && (
            <span
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {remaining} more for meaningful clusters
            </span>
          )}
        </div>

        <div className="mt-10">
          <p
            className="mb-3 text-xs uppercase tracking-widest"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Or connect a source
          </p>
          <div className="flex flex-wrap gap-3">
            {["Zendesk", "PostHog", "Canny"].map((provider) => (
              <button
                key={provider}
                type="button"
                disabled
                title="Integrations ship in the next batch of commits"
                className="rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  borderColor: "var(--color-border-subtle)",
                  color: "var(--color-text-secondary)",
                  background: "var(--color-surface-app)",
                }}
              >
                {provider}
              </button>
            ))}
          </div>
        </div>

        <p
          className="mt-10 text-center text-sm"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          No data handy?{" "}
          <button
            type="button"
            onClick={() => seedSample.mutate()}
            disabled={seedSample.isPending}
            className="underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            style={{ color: "var(--color-brand-accent)" }}
          >
            {seedSample.isPending ? "Seeding…" : "Use sample data"}
          </button>
          {seedSample.data && !seedSample.isPending && (
            <span
              className="ml-2 text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {seedSample.data.inserted > 0
                ? `Added ${seedSample.data.inserted}${seedSample.data.deduped > 0 ? ` (${seedSample.data.deduped} already present)` : ""}.`
                : `${seedSample.data.deduped} samples already present.`}
              {seedSample.data.capReached && " Plan cap reached — upgrade to seed the rest."}
            </span>
          )}
          {seedSample.error && (
            <span
              className="ml-2 text-xs"
              style={{ color: "var(--color-danger)" }}
            >
              {seedSample.error.message}
            </span>
          )}
        </p>
      </section>

      {count > 0 && me.data && (
        <p
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {count} / {me.data.usage.evidence.max === "unlimited"
            ? "∞"
            : me.data.usage.evidence.max}{" "}
          evidence added on the{" "}
          <span style={{ color: "var(--color-text-secondary)" }}>
            {me.data.account.plan}
          </span>{" "}
          plan.
        </p>
      )}
    </div>
  );
}
