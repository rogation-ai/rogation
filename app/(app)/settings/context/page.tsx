"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

const MAX_BRIEF_BYTES = 8_192;
const DEBOUNCE_MS = 1_500;

const STAGES = ["Pre-seed", "Seed", "Series A", "Series B", "Growth", "Public"] as const;
const METRIC_OPTIONS: { value: MetricOption; description: string }[] = [
  { value: "Retention", description: "Users coming back over time" },
  { value: "Revenue", description: "MRR, ARR, or transaction volume" },
  { value: "Activation", description: "New users reaching their aha moment" },
  { value: "NPS", description: "Net Promoter Score from user surveys" },
  { value: "Custom", description: "A metric specific to your product" },
];
type MetricOption = "Retention" | "Revenue" | "Activation" | "NPS" | "Custom";

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function SavedIndicator({ visible }: { visible: boolean }) {
  return (
    <span
      className={`text-xs text-[var(--color-success)] transition-opacity duration-[240ms] ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      Saved
    </span>
  );
}

export default function ProductContextPage(): React.JSX.Element {
  const { data, isLoading } = trpc.account.productContext.useQuery();
  const mutation = trpc.account.updateProductContext.useMutation();

  const [brief, setBrief] = useState("");
  const [icp, setIcp] = useState("");
  const [stage, setStage] = useState("");
  const [selectedMetrics, setSelectedMetrics] = useState<MetricOption[]>([]);
  const [customMetric, setCustomMetric] = useState("");

  const [savedFields, setSavedFields] = useState<Record<string, boolean>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const latestState = useRef({ brief, icp, stage, selectedMetrics, customMetric });
  latestState.current = { brief, icp, stage, selectedMetrics, customMetric };

  useEffect(() => {
    if (!data) return;
    setBrief(data.productBrief ?? "");
    setIcp(data.productBriefStructured?.icp ?? "");
    setStage(data.productBriefStructured?.stage ?? "");
    setSelectedMetrics((data.productBriefStructured?.primaryMetrics as MetricOption[]) ?? []);
    setCustomMetric(data.productBriefStructured?.customMetric ?? "");
  }, [data]);

  const showSaved = useCallback((field: string) => {
    setSavedFields((prev) => ({ ...prev, [field]: true }));
    clearTimeout(timers.current[field]);
    timers.current[field] = setTimeout(() => {
      setSavedFields((prev) => ({ ...prev, [field]: false }));
    }, 2000);
  }, []);

  const save = useCallback(
    (field: string) => {
      const s = latestState.current;
      const bytes = byteLength(s.brief);
      if (field === "brief" && bytes > MAX_BRIEF_BYTES) return;

      mutation.mutate(
        {
          productBrief: s.brief,
          productBriefStructured: {
            icp: s.icp || undefined,
            stage: (s.stage as (typeof STAGES)[number]) || undefined,
            primaryMetrics: s.selectedMetrics.length > 0 ? s.selectedMetrics : undefined,
            customMetric: s.customMetric || undefined,
          },
        },
        { onSuccess: () => showSaved(field) },
      );
    },
    [mutation, showSaved],
  );

  const debouncedSave = useCallback(
    (field: string) => {
      clearTimeout(timers.current[`debounce-${field}`]);
      timers.current[`debounce-${field}`] = setTimeout(() => save(field), DEBOUNCE_MS);
    },
    [save],
  );

  const toggleMetric = useCallback(
    (metric: MetricOption) => {
      setSelectedMetrics((prev) => {
        const next = prev.includes(metric)
          ? prev.filter((m) => m !== metric)
          : [...prev, metric];
        setTimeout(() => {
          latestState.current.selectedMetrics = next;
          save("metrics");
        }, 0);
        return next;
      });
    },
    [save],
  );

  const briefBytes = byteLength(brief);
  const counterClass =
    briefBytes >= MAX_BRIEF_BYTES
      ? "text-[var(--color-danger)]"
      : briefBytes >= MAX_BRIEF_BYTES * 0.8
        ? "text-[var(--color-warning)]"
        : "text-[var(--color-text-tertiary)]";

  const showCustomInput = selectedMetrics.includes("Custom");

  if (isLoading) {
    return (
      <div>
        <div className="h-8 w-48 bg-[var(--color-surface-raised)] rounded animate-pulse mb-2" />
        <div className="h-4 w-96 bg-[var(--color-surface-raised)] rounded animate-pulse mb-8" />
        <div className="h-40 bg-[var(--color-surface-raised)] rounded animate-pulse mb-6" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-10 bg-[var(--color-surface-raised)] rounded animate-pulse" />
          <div className="h-10 bg-[var(--color-surface-raised)] rounded animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-8">
      <div className="flex-[3] max-w-[720px]">
        <h1 className="font-[var(--font-display)] text-[32px] font-semibold tracking-[-0.015em] leading-[1.15] mb-2">
          Product context
        </h1>
        <p className="text-[var(--color-text-secondary)] mb-8">
          Help the AI understand your product for sharper insights and specs.
        </p>

        {/* Brief */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="brief" className="text-sm font-medium">
              Product brief
            </label>
            <SavedIndicator visible={!!savedFields.brief} />
          </div>
          <textarea
            id="brief"
            value={brief}
            onChange={(e) => {
              setBrief(e.target.value);
              debouncedSave("brief");
            }}
            onBlur={() => save("brief")}
            placeholder="Describe your product, its purpose, and what sets it apart. Include key features and context relevant for the analysis."
            className="w-full min-h-[180px] p-3 border border-[var(--color-border-default)] rounded-[var(--radius-sm)] text-base leading-relaxed resize-y focus:outline-none focus:border-[var(--color-brand-accent)] focus:ring-2 focus:ring-[var(--color-brand-accent)]/15"
          />
          <div className={`text-right text-xs mt-1 ${counterClass}`}>
            {briefBytes.toLocaleString()} / {MAX_BRIEF_BYTES.toLocaleString()} bytes
          </div>
        </div>

        <hr className="border-[var(--color-border-subtle)] my-8" />

        {/* ICP */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="icp" className="text-sm font-medium">
              ICP
            </label>
            <SavedIndicator visible={!!savedFields.icp} />
          </div>
          <input
            id="icp"
            type="text"
            value={icp}
            onChange={(e) => {
              setIcp(e.target.value);
              debouncedSave("icp");
            }}
            onBlur={() => save("icp")}
            maxLength={120}
            placeholder="e.g. Startup companies, Series A B2B SaaS"
            className="w-full p-2.5 border border-[var(--color-border-default)] rounded-[var(--radius-sm)] text-base focus:outline-none focus:border-[var(--color-brand-accent)] focus:ring-2 focus:ring-[var(--color-brand-accent)]/15"
          />
        </div>

        {/* Stage */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="stage" className="text-sm font-medium">
              Stage
            </label>
            <SavedIndicator visible={!!savedFields.stage} />
          </div>
          <select
            id="stage"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              save("stage");
            }}
            className="w-full p-2.5 border border-[var(--color-border-default)] rounded-[var(--radius-sm)] text-base bg-transparent focus:outline-none focus:border-[var(--color-brand-accent)] focus:ring-2 focus:ring-[var(--color-brand-accent)]/15"
          >
            <option value="" disabled>
              Select stage
            </option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {/* Primary Metrics (multi-select checkboxes) */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium">Primary metrics</span>
            <SavedIndicator visible={!!savedFields.metrics} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {METRIC_OPTIONS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => toggleMetric(m.value)}
                className={`flex flex-col items-start px-3 py-2.5 text-left rounded-[var(--radius-sm)] border transition-colors ${
                  selectedMetrics.includes(m.value)
                    ? "border-[var(--color-brand-accent)] bg-[var(--color-brand-accent)]/10"
                    : "border-[var(--color-border-default)] hover:border-[var(--color-border-strong)]"
                }`}
              >
                <span
                  className={`text-sm font-medium ${
                    selectedMetrics.includes(m.value)
                      ? "text-[var(--color-brand-accent)]"
                      : "text-[var(--color-text-primary)]"
                  }`}
                >
                  {m.value}
                </span>
                <span className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                  {m.description}
                </span>
              </button>
            ))}
          </div>

          {/* Custom metric text input */}
          {showCustomInput && (
            <div className="mt-3">
              <input
                type="text"
                value={customMetric}
                onChange={(e) => {
                  setCustomMetric(e.target.value);
                  debouncedSave("customMetric");
                }}
                onBlur={() => save("customMetric")}
                maxLength={120}
                placeholder="Describe your custom metric"
                className="w-full p-2.5 border border-[var(--color-border-default)] rounded-[var(--radius-sm)] text-base focus:outline-none focus:border-[var(--color-brand-accent)] focus:ring-2 focus:ring-[var(--color-brand-accent)]/15"
              />
            </div>
          )}
        </div>
      </div>

      {/* Preview pane */}
      <aside className="flex-[2] bg-[var(--color-surface-sunken)] border-l border-[var(--color-border-subtle)] p-8 sticky top-0 h-screen overflow-y-auto hidden lg:block">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)] mb-4">
          What the AI sees
        </h2>
        <ContextPreview
          brief={brief}
          icp={icp}
          stage={stage}
          selectedMetrics={selectedMetrics}
          customMetric={customMetric}
        />
      </aside>
    </div>
  );
}

function ContextPreview({
  brief,
  icp,
  stage,
  selectedMetrics,
  customMetric,
}: {
  brief: string;
  icp: string;
  stage: string;
  selectedMetrics: string[];
  customMetric: string;
}) {
  const hasAny =
    brief.trim() || icp.trim() || stage || selectedMetrics.length > 0 || customMetric.trim();

  if (!hasAny) {
    return (
      <p className="text-sm text-[var(--color-text-tertiary)] italic">
        Fill in the form to see the assembled context block the AI will use.
      </p>
    );
  }

  const lines: string[] = [];
  if (brief.trim()) lines.push(`Product brief:\n  ${brief.trim()}`);
  if (icp.trim()) lines.push(`ICP: ${icp.trim()}`);
  if (stage) lines.push(`Stage: ${stage}`);
  if (selectedMetrics.length > 0) {
    const display = selectedMetrics
      .map((m) => (m === "Custom" && customMetric.trim() ? `Custom (${customMetric.trim()})` : m))
      .join(", ");
    lines.push(`Primary metrics: ${display}`);
  }

  return (
    <pre className="font-mono text-[13px] leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap break-words">
      {lines.join("\n")}
    </pre>
  );
}
