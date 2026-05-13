"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, useOrganizationList } from "@clerk/nextjs";
import { trpc } from "@/lib/trpc";
import { bandFor, bandPct } from "@/components/ui/PlanMeter";
import type { LimitValue, PlanTier } from "@/lib/plans";

/*
  Persistent 240px left sidebar — the home for app navigation
  (DESIGN.md §5). Replaces the v0 top-nav AppHeader. Structure:

    Workspace wordmark (top)
    Nav items (Upload, Evidence, Insights, Build, Settings)
    flex-1 spacer
    Plan meter bar (bottom)

  Active state: 3px brand-accent left-border + brand text. No pill,
  no background fill — the discipline is the point.

  Mobile (<md): hidden. AppTopBar owns the hamburger and renders a
  drawer using the same NAV array.
*/

export interface NavItem {
  href: string;
  label: string;
  /** Optional active-state prefix when the link points at one sub-route but should highlight on every sibling. */
  prefix?: string;
}

export const NAV: readonly NavItem[] = [
  { href: "/app", label: "Upload" },
  { href: "/evidence", label: "Evidence" },
  { href: "/insights", label: "Insights" },
  { href: "/build", label: "Build" },
  { href: "/settings/context", label: "Settings", prefix: "/settings" },
];

export function AppSidebar(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <aside
      className="hidden md:flex h-dvh sticky top-0 w-60 shrink-0 flex-col border-r"
      style={{
        background: "var(--color-surface-raised)",
        borderColor: "var(--color-border-subtle)",
      }}
    >
      <div className="px-5 pt-5 pb-4">
        <Link
          href="/app"
          className="text-base font-semibold tracking-tight"
          style={{ color: "var(--color-brand-accent)" }}
        >
          Rogation
        </Link>
      </div>

      <SidebarOrgSwitcher />

      <nav className="flex flex-col gap-px px-2">
        {NAV.map((item) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            label={item.label}
            active={isActive(item, pathname)}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <div className="border-t px-4 py-4" style={{ borderColor: "var(--color-border-subtle)" }}>
        <SidebarPlanMeter />
      </div>
    </aside>
  );
}

function SidebarOrgSwitcher(): React.JSX.Element | null {
  const { isLoaded } = useOrganizationList();

  if (!isLoaded) return null;

  return (
    <div
      className="mx-3 mb-3 rounded border px-2 py-1.5"
      style={{ borderColor: "var(--color-border-subtle)" }}
    >
      <OrganizationSwitcher
        hidePersonal={false}
        appearance={{
          elements: {
            rootBox: "w-full",
            organizationSwitcherTrigger:
              "w-full justify-between text-[13px] px-1 py-0.5 [&_span]:!text-[#FAFAFA] [&_svg]:!text-[#A8A8B0]",
            organizationSwitcherPopoverCard:
              "[&_span]:!text-[#0A0A0B] [&_p]:!text-[#6E6E76]",
          },
        }}
        afterSelectOrganizationUrl="/app"
        afterSelectPersonalUrl="/app"
      />
    </div>
  );
}

function SidebarLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="relative flex h-8 items-center rounded-sm pl-3 pr-2 text-[13px] font-medium transition"
      style={{
        color: active ? "var(--color-brand-accent)" : "var(--color-text-secondary)",
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r"
          style={{ background: "var(--color-brand-accent)" }}
        />
      )}
      <span className="pl-2">{label}</span>
    </Link>
  );
}

/*
  Plan meter pinned to the sidebar bottom. Shows the resource closest
  to its cap as a full-width 4px bar + label in mono. Free users at
  cap get an inline Upgrade link. Unlimited tiers (Solo / Pro) get the
  plan name and no bar.
*/
function SidebarPlanMeter(): React.JSX.Element {
  const me = trpc.account.me.useQuery();
  if (me.isLoading || !me.data) {
    return (
      <div
        className="h-1 w-full rounded-full"
        style={{ background: "var(--color-surface-sunken)" }}
        aria-hidden="true"
      />
    );
  }

  const plan = me.data.account.plan;
  const tightest = pickTightestResource(me.data.usage);

  if (!tightest) {
    // Every resource is unlimited (Solo + Pro)
    return (
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] uppercase tracking-wider"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Plan
        </span>
        <span
          className="text-xs font-medium"
          style={{
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {labelFor(plan)}
        </span>
      </div>
    );
  }

  const pct = bandPct(tightest.current, tightest.max);
  const band = bandFor(pct);
  const showUpgrade = plan === "free" && pct >= 100;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="h-1 w-full overflow-hidden rounded-full"
        style={{ background: "var(--color-surface-sunken)" }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={tightest.max}
        aria-valuenow={tightest.current}
        aria-label={`${tightest.label} ${tightest.current} of ${tightest.max}`}
      >
        <span
          className="block h-full transition-[width]"
          style={{
            width: `${Math.min(pct, 100)}%`,
            background: band.barColor,
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] uppercase tracking-wider"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {tightest.label}
        </span>
        <span className="flex items-center gap-2">
          <span
            className="text-xs tabular-nums"
            style={{
              color: band.textColor,
              fontFamily: "var(--font-mono)",
            }}
          >
            {tightest.current}/{tightest.max}
          </span>
          {showUpgrade && (
            <Link
              href="/settings/billing"
              className="text-xs font-medium underline-offset-2 hover:underline"
              style={{ color: "var(--color-brand-accent)" }}
            >
              Upgrade
            </Link>
          )}
        </span>
      </div>
    </div>
  );
}

function isActive(
  item: { href: string; prefix?: string },
  pathname: string,
): boolean {
  if (item.href === "/app") return pathname === "/app";
  const prefix = item.prefix ?? item.href;
  return pathname === item.href || pathname.startsWith(`${prefix}/`);
}

function labelFor(plan: PlanTier): string {
  switch (plan) {
    case "free":
      return "Free";
    case "solo":
      return "Solo";
    case "pro":
      return "Pro";
  }
}

/*
  Pick the resource closest to its cap. Returns null when every
  resource on the plan is unlimited (paid tiers). Pure helper —
  unit-testable in isolation.
*/
type Usage = {
  evidence: { current: number; max: LimitValue };
  insights: { current: number; max: LimitValue };
  opportunities: { current: number; max: LimitValue };
  specs: { current: number; max: LimitValue };
  integrations: { current: number; max: LimitValue };
};

const RESOURCE_LABELS: Record<keyof Usage, string> = {
  evidence: "Evidence",
  insights: "Insights",
  opportunities: "Opportunities",
  specs: "Specs",
  integrations: "Integrations",
};

export function pickTightestResource(
  usage: Usage,
): { label: string; current: number; max: number } | null {
  let best: { label: string; current: number; max: number } | null = null;
  let bestPct = -1;
  for (const key of Object.keys(usage) as (keyof Usage)[]) {
    const row = usage[key];
    if (row.max === "unlimited") continue;
    const pct = row.max === 0 ? 0 : (row.current / row.max) * 100;
    if (pct > bestPct) {
      bestPct = pct;
      best = {
        label: RESOURCE_LABELS[key],
        current: row.current,
        max: row.max,
      };
    }
  }
  return best;
}
