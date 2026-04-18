import { TRPCError } from "@trpc/server";
import { ingestEvidence, type IngestContext } from "@/lib/evidence/ingest";

/*
  Sample-data seeder.

  The onboarding page's "Use sample data" button calls this. Seeds a
  curated 15-piece corpus that clusters into 5 distinct pain points
  so a PM evaluating Rogation lands directly on the Insights screen
  with something real to click.

  Design constraints:
  - Each piece reads like authentic user voice — real verbs, real
    frustrations, no filler. A PM opening the Insights screen
    needs to feel "yeah, I've gotten tickets like this."
  - Spread across 5 themes with enough overlap that the clustering
    prompt has signal for severity + frequency ranking.
  - Every piece has a stable sourceRef like `sample:ticket-01` so
    the UNIQUE(account_id, source_type, source_ref) dedup index
    guarantees idempotency — re-clicking the button never duplicates.
  - Respects the Free-plan 10-row cap: if we'd go over, we stop and
    return what we managed (the UI still renders the wow moment with
    10 pieces; the user upgrades for the last 5).

  If you add a new sample piece, keep the slug stable — content can
  change (we'll re-embed on next seed thanks to the content-hash
  dedup check) but the sourceRef must stay.
*/

export interface SampleEvidence {
  slug: string;
  segment?: string;
  content: string;
}

export const SAMPLE_EVIDENCE: ReadonlyArray<SampleEvidence> = [
  // Theme 1: Onboarding confusion (4 pieces, HIGH severity).
  {
    slug: "onboarding-01",
    segment: "new-signup",
    content:
      "I signed up yesterday and just stared at the empty dashboard for five minutes. Is there a tutorial? I couldn't find one. Eventually I gave up and watched a YouTube video.",
  },
  {
    slug: "onboarding-02",
    segment: "new-signup",
    content:
      "First-run experience is confusing. The empty state says 'Get started' but doesn't tell me what the first action should be. I ended up clicking every menu item trying to find it.",
  },
  {
    slug: "onboarding-03",
    segment: "new-signup",
    content:
      "Support ticket: Please add a guided tour. I've shown this to three teammates and every single one asked me how to find the upload button. The icon isn't obvious.",
  },
  {
    slug: "onboarding-04",
    segment: "enterprise-trial",
    content:
      "I'm evaluating this for a 40-person team. I churned through the trial in 20 minutes because I couldn't figure out how to get the AI to actually read my data. Onboarding needs a 'try with sample data' path.",
  },

  // Theme 2: Mobile performance (3 pieces, HIGH severity).
  {
    slug: "mobile-perf-01",
    segment: "mobile",
    content:
      "Search is painfully slow on my iPhone 14. Desktop takes 200ms, mobile takes 3 seconds consistently. Same wifi. Might be a JS bundle size issue?",
  },
  {
    slug: "mobile-perf-02",
    segment: "mobile",
    content:
      "Dashboards on iPad are molasses. I run a support team and half of us work from tablets — we stopped using the mobile web view entirely.",
  },
  {
    slug: "mobile-perf-03",
    segment: "mobile",
    content:
      "Please fix mobile. The lag on search + dashboard switching makes the whole thing feel broken. It's fast on desktop so I know the backend is fine.",
  },

  // Theme 3: Share links expire / break (3 pieces, CRITICAL severity).
  {
    slug: "share-links-01",
    segment: "team-collab",
    content:
      "URGENT: all our share links from last quarter are dead. We link them in Notion for the exec update. I need someone to tell me if there's a way to re-generate them in bulk, otherwise our entire Q2 retro is a dead link.",
  },
  {
    slug: "share-links-02",
    segment: "team-collab",
    content:
      "Share links silently expire. I sent one to my CEO on Monday, he clicked it on Friday, dead page. No warning, no email, nothing. We stopped using them.",
  },
  {
    slug: "share-links-03",
    segment: "team-collab",
    content:
      "Is there a setting for permanent share links? Rotating every 30 days means we can't embed them in shared docs. Our customer success team would pay extra for a permanent-link option.",
  },

  // Theme 4: Pricing unclear / too expensive (3 pieces, MEDIUM severity).
  {
    slug: "pricing-01",
    segment: "small-team",
    content:
      "Pro is $50/month per seat and we're a 3-person founding team. We just want to add one more editor seat. Any way to buy a la carte? The Solo plan would work but we need multi-user.",
  },
  {
    slug: "pricing-02",
    segment: "small-team",
    content:
      "The pricing page doesn't explain what 'Pro' includes vs 'Solo'. I clicked Upgrade and got a 500. Gave up after two tries.",
  },
  {
    slug: "pricing-03",
    segment: "enterprise-trial",
    content:
      "For enterprise we need SSO + audit log + custom retention. Your Pro tier says 'SSO on request' but there's no way to request it from the billing screen. How do I start that conversation?",
  },

  // Theme 5: CSV export bugs (2 pieces, MEDIUM severity).
  {
    slug: "export-01",
    segment: "reporting",
    content:
      "CSV export dropped the 'Owner' column for the third week running. I've been patching it by hand before sending to finance. Please tell me this is on the roadmap.",
  },
  {
    slug: "export-02",
    segment: "reporting",
    content:
      "Export is buggy. Columns come out in a different order each time. My downstream Google Sheet script breaks every Monday. Can we pin the column order?",
  },
];

export interface SeedResult {
  inserted: number;
  deduped: number;
  capReached: boolean;
}

/**
 * Ingest the sample corpus into the current account. Idempotent —
 * re-running returns `deduped` counts for everything already present.
 * Stops early at plan cap and reports `capReached: true` so the UI
 * can surface the upgrade CTA instead of a generic error.
 */
export async function seedSampleEvidence(
  ctx: IngestContext,
): Promise<SeedResult> {
  let inserted = 0;
  let deduped = 0;
  let capReached = false;

  for (const s of SAMPLE_EVIDENCE) {
    try {
      const result = await ingestEvidence(ctx, {
        content: s.content,
        sourceType: "paste_ticket",
        sourceRef: `sample:${s.slug}`,
        segment: s.segment,
      });
      if (result.deduped) deduped++;
      else inserted++;
    } catch (err) {
      if (
        err instanceof TRPCError &&
        err.code === "FORBIDDEN" &&
        err.cause &&
        typeof err.cause === "object" &&
        "type" in err.cause &&
        err.cause.type === "plan_limit_reached"
      ) {
        capReached = true;
        break;
      }
      throw err;
    }
  }

  return { inserted, deduped, capReached };
}
