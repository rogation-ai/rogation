import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";

/*
  Marketing landing. Light-default cream surface, single column,
  result-first composition (DESIGN.md §5). The hero leads with the
  decision the product produces, then the flow line, then the CTAs.
  No 3-column feature grid, no testimonial carousel, no icon-in-circle
  treatments. The Spec-card stripe under the fold is the product cut.

  Signed-in visitors redirect to /app server-side.
*/
export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/app");

  return (
    <div
      className="min-h-dvh"
      style={{ background: "var(--color-surface-marketing)" }}
    >
      <main className="mx-auto max-w-5xl px-6 pt-10 pb-24">
        <header className="flex items-center justify-between pb-20">
          <Link
            href="/"
            className="font-semibold tracking-tight"
            style={{ color: "var(--color-brand-accent)" }}
          >
            Rogation
          </Link>
          <nav
            className="flex gap-6 text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            <Link
              href="/pricing"
              className="transition hover:text-[var(--color-text-primary)]"
            >
              Pricing
            </Link>
            <Link
              href="/sign-in"
              className="transition hover:text-[var(--color-text-primary)]"
            >
              Log in
            </Link>
          </nav>
        </header>

        <h1
          className="text-5xl md:text-[56px] leading-[1.05] tracking-tight font-semibold max-w-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Turn 20 interviews into Friday&apos;s decision.
        </h1>

        <p
          className="mt-6 max-w-xl text-lg leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Paste transcripts, support tickets, or survey responses. Rogation
          clusters them, ranks opportunities against your weights, and
          drafts the spec. No chat. No second tool. The whole loop happens
          here.
        </p>

        <div className="mt-10 flex items-center gap-4">
          <Link
            href="/sign-up"
            className="inline-flex items-center rounded-md px-5 py-2.5 text-sm font-medium text-white transition hover:brightness-110"
            style={{ background: "var(--color-brand-accent)" }}
          >
            Start free
          </Link>
          <Link
            href="/pricing"
            className="inline-flex items-center text-sm font-medium underline-offset-4 hover:underline"
            style={{ color: "var(--color-text-primary)" }}
          >
            See pricing →
          </Link>
        </div>

        <FlowLine />

        <ProductCut />

        <p
          className="mt-20 text-[11px] uppercase tracking-widest"
          style={{
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Foundations laid. Evidence → Insights → Spec coming wk 1-12.
        </p>
      </main>
    </div>
  );
}

function FlowLine(): React.JSX.Element {
  const steps = ["Paste evidence", "Cluster pain", "Score opportunities", "Stream spec", "Push to Linear"] as const;
  return (
    <ol
      className="mt-20 flex flex-wrap gap-x-6 gap-y-2 text-[13px]"
      style={{ color: "var(--color-text-tertiary)" }}
    >
      {steps.map((step, i) => (
        <li key={step} className="flex items-center gap-2">
          <span
            className="tabular-nums"
            style={{
              color: "var(--color-text-secondary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {String(i + 1).padStart(2, "0")}
          </span>
          <span style={{ color: "var(--color-text-primary)" }}>{step}</span>
          {i < steps.length - 1 && <span aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}

/*
  A static "product cut" panel — a stylized preview of the Insights
  screen rendered with the same tokens the live app uses. Real
  screenshots replace this when the v1 corpus is ready. Lives here so
  marketing visitors get a concrete sense of the artifact before
  signing up.
*/
function ProductCut(): React.JSX.Element {
  const rows = [
    { sev: "critical", title: "Onboarding flow is confusing", freq: "12 mentions" },
    { sev: "high", title: "Mobile checkout fails on iOS Safari", freq: "8 mentions" },
    { sev: "high", title: "Search returns stale results", freq: "6 mentions" },
    { sev: "medium", title: "CSV export is silently truncated at 1k rows", freq: "4 mentions" },
    { sev: "low", title: "Pricing page slow to load on /pricing", freq: "2 mentions" },
  ] as const;

  return (
    <div
      className="mt-20 overflow-hidden rounded-lg border"
      style={{
        background: "var(--color-surface-app)",
        borderColor: "var(--color-border-default)",
      }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{
          background: "var(--color-surface-raised)",
          borderColor: "var(--color-border-subtle)",
        }}
      >
        <span
          className="text-xs uppercase tracking-wider"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Insights · 5 clusters
        </span>
        <span
          className="text-xs tabular-nums"
          style={{
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          updated 12m ago
        </span>
      </div>
      <ul>
        {rows.map((r, i) => (
          <li
            key={r.title}
            className="flex items-center gap-3 px-4 py-3"
            style={{
              borderTop: i === 0 ? "none" : "1px solid var(--color-border-subtle)",
            }}
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: `var(--color-severity-${r.sev})` }}
            />
            <span
              className="flex-1 text-sm"
              style={{ color: "var(--color-text-primary)" }}
            >
              {r.title}
            </span>
            <span
              className="text-xs tabular-nums"
              style={{
                color: "var(--color-text-tertiary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {r.freq}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
