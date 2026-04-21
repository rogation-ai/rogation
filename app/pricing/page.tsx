"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { trpc } from "@/lib/trpc";

/*
  Public /pricing page. Three tiers (Free / Solo / Pro) with feature
  comparison and upgrade CTAs. Signed-out visitors land in sign-up;
  signed-in free users kick off a Stripe Checkout session; existing
  paid subscribers get the Customer Portal.

  Client component because the CTA state (current plan, buttons) is
  account-specific — the same URL renders a different primary action
  for each viewer.
*/

type Tier = {
  id: "free" | "solo" | "pro";
  name: string;
  price: string;
  priceNote: string;
  tagline: string;
  features: string[];
};

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    priceNote: "forever",
    tagline: "Paste 10 pieces of evidence. See one clustered opportunity.",
    features: [
      "10 evidence pieces",
      "3 insight clusters",
      "1 opportunity",
      "1 spec",
      "Markdown export (watermarked)",
    ],
  },
  {
    id: "solo",
    name: "Solo",
    price: "$49",
    priceNote: "per month",
    tagline: "Unlimited synthesis for one PM. No integrations.",
    features: [
      "Unlimited evidence",
      "Unlimited clusters + opportunities",
      "Unlimited specs",
      "1 integration",
      "Markdown export, no watermark",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$99",
    priceNote: "per month",
    tagline: "Everything. Linear + Notion push. Outcome tracking.",
    features: [
      "Everything in Solo",
      "Unlimited integrations",
      "Linear + Notion export",
      "Outcome tracking",
      "Share links without watermark",
    ],
  },
];

export default function PricingPage(): React.JSX.Element {
  const { isSignedIn, isLoaded } = useUser();
  const meQ = trpc.account.me.useQuery(undefined, { enabled: !!isSignedIn });

  const currentPlan = meQ.data?.account.plan ?? null;

  const checkout = trpc.billing.createCheckout.useMutation({
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) => {
      alert(err.message);
    },
  });
  const portal = trpc.billing.createPortal.useMutation({
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) => {
      alert(err.message);
    },
  });

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

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {TIERS.map((tier) => {
          const isCurrent = currentPlan === tier.id;
          const highlight = tier.id === "pro";
          return (
            <div
              key={tier.id}
              className="rounded-lg border p-6 flex flex-col"
              style={{
                borderColor: highlight
                  ? "var(--color-brand-accent)"
                  : "var(--color-border-subtle)",
                background: "var(--color-surface-raised)",
              }}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-xl font-semibold">{tier.name}</h2>
                {isCurrent ? (
                  <span
                    className="text-xs uppercase tracking-widest"
                    style={{ color: "var(--color-brand-accent)" }}
                  >
                    Current
                  </span>
                ) : null}
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-4xl font-semibold">{tier.price}</span>
                <span
                  className="text-sm"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {tier.priceNote}
                </span>
              </div>
              <p
                className="mt-3 text-sm"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {tier.tagline}
              </p>
              <ul className="mt-6 space-y-2 text-sm flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span style={{ color: "var(--color-brand-accent)" }}>
                      ✓
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-6">
                <PrimaryCta
                  tier={tier}
                  isLoaded={isLoaded}
                  isSignedIn={!!isSignedIn}
                  currentPlan={currentPlan}
                  onCheckout={() => {
                    if (tier.id === "free") return;
                    checkout.mutate({ tier: tier.id });
                  }}
                  onPortal={() => portal.mutate()}
                  isPending={checkout.isPending || portal.isPending}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p
        className="mt-12 text-center text-sm"
        style={{ color: "var(--color-text-secondary)" }}
      >
        No contract. Cancel anytime from the billing portal. Paid plans
        bill monthly through Stripe.
      </p>

      <p
        className="mt-16 text-xs uppercase tracking-widest"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Test mode. Use card 4242 4242 4242 4242 with any future expiry + CVC.
      </p>
    </main>
  );
}

interface CtaProps {
  tier: Tier;
  isLoaded: boolean;
  isSignedIn: boolean;
  currentPlan: "free" | "solo" | "pro" | null;
  onCheckout: () => void;
  onPortal: () => void;
  isPending: boolean;
}

function PrimaryCta({
  tier,
  isLoaded,
  isSignedIn,
  currentPlan,
  onCheckout,
  onPortal,
  isPending,
}: CtaProps): React.JSX.Element {
  if (!isLoaded) {
    return <CtaButton disabled>Loading…</CtaButton>;
  }

  if (!isSignedIn) {
    return (
      <Link
        href={tier.id === "free" ? "/sign-up" : `/sign-up?upgrade=${tier.id}`}
        className="block w-full rounded-md px-4 py-2 text-center text-sm font-medium text-white transition hover:brightness-110"
        style={{ background: "var(--color-brand-accent)" }}
      >
        {tier.id === "free" ? "Start free" : `Sign up for ${tier.name}`}
      </Link>
    );
  }

  // Signed in
  if (tier.id === currentPlan) {
    if (tier.id === "free") {
      return <CtaButton disabled>Current plan</CtaButton>;
    }
    return (
      <CtaButton onClick={onPortal} disabled={isPending}>
        {isPending ? "Opening…" : "Manage billing"}
      </CtaButton>
    );
  }

  if (tier.id === "free") {
    // Paid user, free card: portal handles downgrade.
    return (
      <CtaButton variant="secondary" onClick={onPortal} disabled={isPending}>
        {isPending ? "Opening…" : "Downgrade"}
      </CtaButton>
    );
  }

  // Direction-aware copy: a Pro user looking at the Solo card is
  // downgrading, not upgrading. Silent "Upgrade to Solo" when you're
  // on Pro is the kind of bug that breaks trust.
  const rank = { free: 0, solo: 1, pro: 2 } as const;
  const isDowngrade =
    currentPlan !== null && rank[tier.id] < rank[currentPlan];

  if (isDowngrade) {
    return (
      <CtaButton variant="secondary" onClick={onPortal} disabled={isPending}>
        {isPending ? "Opening…" : `Downgrade to ${tier.name}`}
      </CtaButton>
    );
  }

  return (
    <CtaButton onClick={onCheckout} disabled={isPending}>
      {isPending ? "Redirecting…" : `Upgrade to ${tier.name}`}
    </CtaButton>
  );
}

function CtaButton({
  children,
  onClick,
  disabled,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}): React.JSX.Element {
  const isPrimary = variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block w-full rounded-md px-4 py-2 text-sm font-medium transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        background: isPrimary ? "var(--color-brand-accent)" : "transparent",
        color: isPrimary ? "#fff" : "var(--color-text-primary)",
        border: isPrimary ? "none" : "1px solid var(--color-border-subtle)",
      }}
    >
      {children}
    </button>
  );
}
