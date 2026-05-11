import type { LimitValue, PlanTier } from "@/lib/plans";

/*
  PlanMeter — the "Evidence 7/10" inline indicator that sits next to
  every gated surface (design review Pass 7). Reads usage + max from
  the account.me payload so the whole app draws from one query.

  Color bands by fill percentage:
    <60%   text-tertiary on sunken surface (calm)
    60-79% text-secondary (noticed)
    80-99% warning (soft cap — paired with the toast banner)
    >=100% danger + "Upgrade" CTA on Free

  Unlimited tiers never show a bar — just the count. Keeps the
  chrome quiet for paid users.
*/

export interface PlanMeterProps {
  /** Display name like "Evidence" / "Insights". */
  label: string;
  /** Current count. */
  current: number;
  /** Max from PLAN_LIMITS — number or "unlimited". */
  max: LimitValue;
  /** Account's current tier; drives the upgrade CTA copy. */
  plan: PlanTier;
  /** Called when the user clicks the inline upgrade link (Free only). */
  onUpgrade?: () => void;
}

export function PlanMeter({
  label,
  current,
  max,
  plan,
  onUpgrade,
}: PlanMeterProps): React.JSX.Element {
  if (max === "unlimited") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
        <span>{current}</span>
      </span>
    );
  }

  const pct = bandPct(current, max);
  const band = bandFor(pct);
  const showUpgrade = plan === "free" && pct >= 100;

  return (
    <span
      className="inline-flex items-center gap-2 text-xs"
      aria-label={`${label} ${current} of ${max}`}
    >
      <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
      <span
        className="font-medium tabular-nums"
        style={{
          color: band.textColor,
          fontFamily: "var(--font-mono)",
        }}
      >
        {current}/{max}
      </span>
      <span
        className="h-1 w-10 overflow-hidden rounded-full"
        style={{ background: "var(--color-surface-sunken)" }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={current}
      >
        <span
          className="block h-full transition-[width]"
          style={{
            width: `${Math.min(pct, 100)}%`,
            background: band.barColor,
          }}
        />
      </span>
      {showUpgrade && onUpgrade && (
        <button
          type="button"
          onClick={onUpgrade}
          className="font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--color-brand-accent)" }}
        >
          Upgrade
        </button>
      )}
    </span>
  );
}

/* ---------------------------- pure helpers ---------------------------- */

/**
 * Percent full, 0-100 when below cap, >100 when over.
 * Pure function — unit tested.
 */
export function bandPct(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((current / max) * 100);
}

type Band = {
  textColor: string;
  barColor: string;
};

/**
 * Maps fill percentage to design tokens. Pure — unit tested.
 */
export function bandFor(pct: number): Band {
  if (pct >= 100) {
    return {
      textColor: "var(--color-danger)",
      barColor: "var(--color-danger)",
    };
  }
  if (pct >= 80) {
    return {
      textColor: "var(--color-warning)",
      barColor: "var(--color-warning)",
    };
  }
  if (pct >= 60) {
    return {
      textColor: "var(--color-text-secondary)",
      barColor: "var(--color-text-secondary)",
    };
  }
  return {
    textColor: "var(--color-text-primary)",
    barColor: "var(--color-text-tertiary)",
  };
}
