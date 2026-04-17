"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { NumberedStepper } from "@/components/ui/NumberedStepper";
import { EVENTS } from "@/lib/analytics/events";
import { capture } from "@/lib/analytics/posthog-client";

/*
  Onboarding — matches approved mockup
  ~/.gstack/projects/rogation-ai-rogation/designs/onboarding-upload-20260417/
  variant-A-v2.png. The one job: drop files / paste tickets / connect
  a source, get to first insight in ~90 seconds.

  This commit wires the paste path end-to-end. File drop is rendered
  but disabled with a "File upload lands next" note — keeps the mockup
  intact while the upload Route Handler ships separately.

  Stepper state is driven by live evidence count from the server so a
  returning user who already has data doesn't see "Upload" as current.
  At 10+ pieces we advance to Cluster automatically (clustering ships
  later; for now it shows as current-but-waiting).
*/

const THIN_CORPUS_THRESHOLD = 10; // Plan §11 default; Insights feels meaningful here.

export default function AppHome(): React.JSX.Element {
  const me = trpc.account.me.useQuery();
  const evCount = trpc.evidence.count.useQuery();
  const utils = trpc.useUtils();
  const paste = trpc.evidence.paste.useMutation({
    onSuccess: () => {
      utils.evidence.count.invalidate();
      utils.account.me.invalidate();
    },
  });

  const [pasteText, setPasteText] = useState("");
  const [firstUploadFired, setFirstUploadFired] = useState(false);

  const count = evCount.data?.count ?? 0;
  // `insight` advancement lands with the clustering commit — for now we
  // only walk between upload and cluster based on corpus size.
  const onboardingStep: "upload" | "cluster" =
    count < THIN_CORPUS_THRESHOLD ? "upload" : "cluster";
  const remaining = Math.max(THIN_CORPUS_THRESHOLD - count, 0);

  // Fire first_upload_started once per session when the user successfully
  // creates their first piece of evidence. Funnel step 2 (plan §7).
  useEffect(() => {
    if (count > 0 && !firstUploadFired) {
      capture(EVENTS.FIRST_UPLOAD_STARTED, {
        sourceType: "paste",
        fileCount: count,
      });
      setFirstUploadFired(true);
    }
  }, [count, firstUploadFired]);

  if (me.isLoading || evCount.isLoading) {
    return (
      <p style={{ color: "var(--color-text-tertiary)" }}>Loading…</p>
    );
  }

  async function submitPaste() {
    const trimmed = pasteText.trim();
    if (!trimmed) return;
    try {
      await paste.mutateAsync({ content: trimmed });
      setPasteText("");
    } catch {
      // tRPC shows errors via paste.error below; no toast yet.
    }
  }

  return (
    <div className="flex flex-col items-center gap-12">
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

      <section className="w-full max-w-xl">
        <div
          aria-disabled="true"
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center"
          style={{
            borderColor: "var(--color-border-default)",
            background: "var(--color-surface-raised)",
          }}
        >
          <p
            className="text-xl tracking-tight"
            style={{
              fontFamily: "var(--font-display)",
              color: "var(--color-text-primary)",
            }}
          >
            Drop files → 3 insights in ~90 seconds
          </p>
          <p
            className="text-xs uppercase tracking-widest"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            File upload lands in the next commit. Paste below for now.
          </p>
        </div>

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
            className="rounded-md px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
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
            disabled
            className="underline underline-offset-2 disabled:cursor-not-allowed"
            title="Sample data ships in the next commit"
          >
            Use sample data
          </button>
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
