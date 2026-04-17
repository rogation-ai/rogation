"use client";

import { trpc } from "@/lib/trpc";

/*
  Signed-in landing. Right now, it's the end-to-end auth probe: if
  account.me returns, the whole chain works (Clerk session -> middleware ->
  tRPC context -> DB user lookup -> account row -> typed payload).

  Once evidence ingestion lands, this page becomes the onboarding upload
  wizard that was approved during /plan-design-review (variant-A-v2).
*/
export default function AppHome() {
  const me = trpc.account.me.useQuery();

  if (me.isLoading) {
    return (
      <p style={{ color: "var(--color-text-tertiary)" }}>Loading account…</p>
    );
  }

  if (me.error || !me.data) {
    return (
      <div className="max-w-md">
        <h1
          className="text-2xl tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          We couldn&apos;t load your account
        </h1>
        <p
          className="mt-3 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {me.error?.message ?? "Account is still provisioning."}
        </p>
        <p
          className="mt-6 text-xs uppercase tracking-widest"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          If this persists, refresh. Your account may still be provisioning.
        </p>
      </div>
    );
  }

  const { user, account } = me.data;

  return (
    <section>
      <h1
        className="text-4xl leading-tight tracking-tight"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Welcome.
      </h1>
      <p
        className="mt-4 max-w-xl text-base"
        style={{ color: "var(--color-text-secondary)" }}
      >
        You&apos;re signed in as{" "}
        <span style={{ color: "var(--color-text-primary)" }}>{user.email}</span>
        . Your account is on the{" "}
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide"
          style={{
            background: "var(--color-surface-sunken)",
            color: "var(--color-text-primary)",
          }}
        >
          {account.plan}
        </span>{" "}
        plan.
      </p>

      <div
        className="mt-10 rounded-xl border p-6"
        style={{
          borderColor: "var(--color-border-subtle)",
          background: "var(--color-surface-raised)",
        }}
      >
        <h2
          className="text-lg font-semibold tracking-tight"
          style={{ color: "var(--color-text-primary)" }}
        >
          Next up: the upload wizard
        </h2>
        <p
          className="mt-2 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Drop files → 3 insights in ~90 seconds. Approved design lives at{" "}
          <code className="text-xs">
            ~/.gstack/projects/rogation-ai-rogation/designs/
            onboarding-upload-20260417/variant-A-v2.png
          </code>
          . Shipping in the next batch of commits.
        </p>
      </div>
    </section>
  );
}
