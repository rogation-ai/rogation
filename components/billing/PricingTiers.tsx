"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { trpc } from "@/lib/trpc";

/*
  Shared tier-card grid. Rendered on /pricing (top-of-funnel for
  unauthed visitors + plan compare for signed-in users) and on
  /settings/billing (in-app billing surface for paid users). Both
  surfaces show the same three tiers, the same primary CTA logic,
  and the same direction-aware upgrade/downgrade copy.

  Behavior:
    - Unauthed: each CTA links to /sign-up (with ?upgrade=<tier> for
      paid tiers so the post-signup flow can pick it back up).
    - Signed-in free: paid-tier CTAs kick off Stripe Checkout via
      trpc.billing.createCheckout. Free card shows "Current plan".
    - Signed-in paid: current tier shows "Manage billing" → Stripe
      Customer Portal. Lower-rank tiers show "Downgrade to X" via
      the portal. Higher-rank tiers show "Upgrade to X" via Checkout.
*/

type Tier = {
  id: "free" | "solo" | "pro";
  name: string;
  price: string;
  priceNote: string;
  tagline: string;
  features: string[];
};

export const TIERS: Tier[] = [
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

export function PricingTiers(): React.JSX.Element {
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
    <div className="grid gap-6 md:grid-cols-3">
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
                  <span style={{ color: "var(--color-brand-accent)" }}>✓</span>
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
  // Unauthed visitors must see an actionable CTA the moment the page
  // paints. Gating on Clerk's isLoaded made the pricing page show
  // "Loading…" for ~2s for top-of-funnel traffic — pure conversion drag.
  // Clerk only matters once we know the visitor has a session, so we
  // wait on isLoaded *only* when isSignedIn is true.
  if (isSignedIn && !isLoaded) {
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
