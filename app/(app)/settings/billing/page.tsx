"use client";

import { trpc } from "@/lib/trpc";
import { PricingTiers } from "@/components/billing/PricingTiers";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";

/*
  Settings → Billing. In-app home for plan + subscription. Solves the
  dead-end where paid users had no way to reach Stripe's customer
  portal from inside the app — createPortal existed but nothing called
  it. Now everyone (free or paid) lands here from the settings nav and
  sees: current plan, the usage row that's nearest its cap, and the
  full tier compare via the same <PricingTiers> grid the /pricing page
  uses. CTAs route through Stripe Checkout (upgrade) or Customer Portal
  (manage / downgrade) so the user can self-serve every plan change.
*/

const PLAN_LABEL: Record<"free" | "solo" | "pro", string> = {
  free: "Free",
  solo: "Solo",
  pro: "Pro",
};

const SUBSCRIPTION_STATUS_COPY: Record<string, string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Past due — update payment to keep your plan",
  canceled: "Canceled — reverts at the end of the billing period",
  incomplete: "Awaiting payment confirmation",
  incomplete_expired: "Setup expired — re-subscribe to continue",
};

export default function BillingSettingsPage(): React.JSX.Element {
  const me = trpc.account.me.useQuery();

  if (me.isLoading) {
    return <SkeletonList count={3} />;
  }
  if (me.error || !me.data) {
    return (
      <p
        className="text-sm"
        style={{ color: "var(--color-danger)" }}
      >
        Couldn&apos;t load your plan. Refresh and try again.
      </p>
    );
  }

  const { account, usage, budget } = me.data;
  const planLabel = PLAN_LABEL[account.plan];
  const statusCopy = account.subscriptionStatus
    ? SUBSCRIPTION_STATUS_COPY[account.subscriptionStatus] ?? null
    : null;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p
          className="mt-2 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          You&apos;re on the <strong>{planLabel}</strong> plan.
          {statusCopy ? ` ${statusCopy}.` : null}
        </p>
      </header>

      <section>
        <h2
          className="text-xs font-medium uppercase tracking-wider mb-3"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Usage
        </h2>
        <ul
          className="rounded-lg border divide-y"
          style={{
            borderColor: "var(--color-border-subtle)",
            background: "var(--color-surface-raised)",
          }}
        >
          <UsageRow label="Evidence" current={usage.evidence.current} max={usage.evidence.max} />
          <UsageRow label="Insight clusters" current={usage.insights.current} max={usage.insights.max} />
          <UsageRow label="Opportunities" current={usage.opportunities.current} max={usage.opportunities.max} />
          <UsageRow label="Specs" current={usage.specs.current} max={usage.specs.max} />
          <UsageRow label="Integrations" current={usage.integrations.current} max={usage.integrations.max} />
          <li
            className="flex items-center justify-between px-4 py-3 text-sm"
            style={{ borderColor: "var(--color-border-subtle)" }}
          >
            <span>Monthly LLM budget</span>
            <span
              className="tabular-nums"
              style={{
                color: budget.overHardCap
                  ? "var(--color-danger)"
                  : budget.overSoftCap
                    ? "var(--color-warning)"
                    : "var(--color-text-secondary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {formatBudget(budget.totalInputTokens, budget.hardCap)}
            </span>
          </li>
        </ul>
      </section>

      <section>
        <h2
          className="text-xs font-medium uppercase tracking-wider mb-3"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Plans
        </h2>
        <PricingTiers />
        <p
          className="mt-6 text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Cancel anytime from the billing portal. Paid plans bill monthly
          through Stripe.
        </p>
      </section>
    </div>
  );
}

function UsageRow({
  label,
  current,
  max,
}: {
  label: string;
  current: number;
  max: number | "unlimited";
}): React.JSX.Element {
  const displayMax = max === "unlimited" ? "∞" : max;
  const pct = max === "unlimited" || max === 0 ? 0 : Math.min(100, (current / max) * 100);
  const atCap = max !== "unlimited" && current >= max;
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span
          className="tabular-nums"
          style={{
            color: atCap
              ? "var(--color-danger)"
              : "var(--color-text-secondary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {current} / {displayMax}
        </span>
      </div>
      {max !== "unlimited" && (
        <div
          className="mt-2 h-1 rounded-full overflow-hidden"
          style={{ background: "var(--color-surface-app)" }}
          aria-hidden="true"
        >
          <div
            className="h-full"
            style={{
              width: `${pct}%`,
              background: atCap
                ? "var(--color-danger)"
                : "var(--color-brand-accent)",
            }}
          />
        </div>
      )}
    </li>
  );
}

function formatBudget(used: number, max: number): string {
  if (max <= 0) return "—";
  const usedShort = used > 1000 ? `${(used / 1000).toFixed(0)}k` : `${used}`;
  const maxShort = max > 1000 ? `${(max / 1000).toFixed(0)}k` : `${max}`;
  return `${usedShort} / ${maxShort} tokens`;
}
