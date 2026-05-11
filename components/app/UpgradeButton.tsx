"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc";

/*
  In-app billing CTA. Two shapes:

    - Free plan → red "Upgrade" pill → /settings/billing. We used to
      route to /pricing, but /settings/billing now hosts the same tier
      grid plus current-usage meters, so the click lands on a richer
      context-aware page.
    - Paid plan → muted "Billing" text link → /settings/billing so
      subscribers can reach the Stripe portal without hunting through
      the marketing site.

  Pulls plan off the same `account.me` query the rest of the signed-in
  shell uses, so it piggybacks the cache.

  `variant="drawer"` is used inside the mobile hamburger drawer so the
  link sizes itself like the other nav rows (44px tap target, full
  width) instead of like the desktop pill.
*/
type Variant = "header" | "drawer";

export function UpgradeButton({
  variant = "header",
  onNavigate,
}: {
  variant?: Variant;
  onNavigate?: () => void;
} = {}): React.JSX.Element | null {
  const meQ = trpc.account.me.useQuery();
  const plan = meQ.data?.account.plan;

  if (!plan) return null;

  const isFree = plan === "free";

  if (variant === "drawer") {
    return (
      <Link
        href="/settings/billing"
        onClick={onNavigate}
        className="flex min-h-[44px] items-center border-b border-l-4 px-6 text-sm font-medium"
        style={{
          color: isFree
            ? "var(--color-brand-accent)"
            : "var(--color-text-primary)",
          borderLeftColor: "transparent",
          borderBottomColor: "var(--color-border-subtle)",
        }}
      >
        {isFree ? "Upgrade" : "Billing"}
      </Link>
    );
  }

  if (isFree) {
    return (
      <Link
        href="/settings/billing"
        className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
        style={{ background: "var(--color-brand-accent)" }}
      >
        Upgrade
      </Link>
    );
  }

  return (
    <Link
      href="/settings/billing"
      className="text-sm transition hover:opacity-80"
      style={{ color: "var(--color-text-secondary)" }}
    >
      Billing
    </Link>
  );
}
