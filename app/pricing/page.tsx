"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { PricingTiers } from "@/components/billing/PricingTiers";

/*
  Public /pricing page. Light marketing surface to stay continuous
  with the homepage. Renders the shared <PricingTiers> grid (also
  used by /settings/billing) so the unauthed compare table and the
  authed plan picker share one component, one set of CTAs, one
  direction-aware copy path.

  Client component because the top-nav swaps "Log in" for "App" when
  there's a session.
*/
export default function PricingPage(): React.JSX.Element {
  const { isSignedIn } = useUser();

  return (
    <div
      className="min-h-dvh"
      style={{ background: "var(--color-surface-marketing)" }}
    >
      <main className="mx-auto max-w-6xl px-6 pt-10 pb-24">
        <header className="flex items-center justify-between pb-16">
          <Link
            href="/"
            className="inline-flex h-11 items-center font-semibold tracking-tight"
            style={{ color: "var(--color-brand-accent)" }}
          >
            Rogation
          </Link>
          <nav
            className="flex items-center text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            <Link
              href="/pricing"
              className="inline-flex h-11 items-center px-3 transition hover:text-[var(--color-text-primary)]"
            >
              Pricing
            </Link>
            {isSignedIn ? (
              <Link
                href="/app"
                className="inline-flex h-11 items-center px-3 transition hover:text-[var(--color-text-primary)]"
              >
                App
              </Link>
            ) : (
              <Link
                href="/sign-in"
                className="inline-flex h-11 items-center px-3 transition hover:text-[var(--color-text-primary)]"
              >
                Log in
              </Link>
            )}
          </nav>
        </header>

        <h1
          className="text-4xl md:text-5xl leading-[1.05] tracking-tight font-semibold"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Pricing
        </h1>
        <p
          className="mt-4 max-w-xl text-base"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Free to try. Upgrade when you want unlimited synthesis or
          Linear push.
        </p>

        <div className="mt-12">
          <PricingTiers />
        </div>

        <p
          className="mt-10 text-center text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          No contract. Cancel anytime from the billing portal. Paid plans
          bill monthly through Stripe.
        </p>

        <p
          className="mt-16 text-[11px] uppercase tracking-widest"
          style={{
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Test mode. Use card 4242 4242 4242 4242 with any future expiry + CVC.
        </p>
      </main>
    </div>
  );
}
