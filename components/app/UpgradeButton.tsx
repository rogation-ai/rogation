"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc";

/*
  In-app Upgrade CTA. Renders only for free-plan accounts — paid users
  see nothing (their "Manage billing" surface is on /pricing and, later,
  under /settings/billing). Pulls plan off the same `account.me` query
  the rest of the signed-in shell uses, so it piggybacks the cache.
*/
export function UpgradeButton(): React.JSX.Element | null {
  const meQ = trpc.account.me.useQuery();
  const plan = meQ.data?.account.plan;

  if (!plan || plan !== "free") return null;

  return (
    <Link
      href="/pricing"
      className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
      style={{ background: "var(--color-brand-accent)" }}
    >
      Upgrade
    </Link>
  );
}
