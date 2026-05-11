"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { PricingTiers } from "@/components/billing/PricingTiers";

/*
  Public /pricing page. Renders the shared <PricingTiers> grid (also
  used by /settings/billing) so a paid user looking at "Pricing" in
  the marketing nav and the same user looking at "Billing" in the app
  shell see identical CTAs, identical direction-aware copy, and the
  same current-plan badge.

  Client component because the top-nav swaps "Log in" for "App"
  when there's a session.
*/

export default function PricingPage(): React.JSX.Element {
  const { isSignedIn } = useUser();

  return (
    <main className="mx-auto max-w-6xl px-6 py-20">
      <header className="flex items-center justify-between pb-16">
        <Link
          href="/"
          className="font-semibold tracking-tight"
          style={{ color: "var(--color-brand-accent)" }}
        >
          Rogation
        </Link>
        <nav
          className="flex gap-8 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          <Link href="/pricing">Pricing</Link>
          {isSignedIn ? (
            <Link href="/app">App</Link>
          ) : (
            <Link href="/sign-in">Log in</Link>
          )}
        </nav>
      </header>

      <h1
        className="text-5xl leading-[1.05] tracking-tight"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Pricing
      </h1>
      <p
        className="mt-4 max-w-xl text-lg"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Free to try. Upgrade when you want unlimited synthesis or Linear push.
      </p>

      <div className="mt-12">
        <PricingTiers />
      </div>

      <p
        className="mt-12 text-center text-sm"
        style={{ color: "var(--color-text-secondary)" }}
      >
        No contract. Cancel anytime from the billing portal. Paid plans
        bill monthly through Stripe.
      </p>

      <p
        className="mt-16 text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Test mode. Use card 4242 4242 4242 4242 with any future expiry + CVC.
      </p>
    </main>
  );
}
