/*
  Typed activation-funnel event catalog. Every PostHog capture() call
  references a constant from here — no raw strings inline.

  Why:
  - Typos in event names become silent data gaps in PostHog funnels.
    A single source of truth with literal-string types catches that at
    compile time.
  - Adding a new event means editing this file, which keeps the set
    discoverable in one grep.

  The v1 activation funnel (plan §7):
    signup_completed -> first_upload_started ->
    first_insight_viewed -> first_spec_exported

  Each event is emitted at most once per account for funnel math.
*/

export const EVENTS = {
  /** Clerk webhook fired user.created and we transactionally made the account + user. */
  SIGNUP_COMPLETED: "signup_completed",

  /** User clicked upload on the onboarding wizard. Client-side. */
  FIRST_UPLOAD_STARTED: "first_upload_started",

  /** User viewed the Insights screen with at least one clustered pain point. Client-side. */
  FIRST_INSIGHT_VIEWED: "first_insight_viewed",

  /** User exported a spec to Linear / Notion / Markdown for the first time. Client-side. */
  FIRST_SPEC_EXPORTED: "first_spec_exported",

  /** User clicked "Use sample data" on the onboarding wizard. Client-side. */
  SAMPLE_DATA_USED: "sample_data_used",

  /** Token budget crossed the 80% soft cap. Server-side. */
  TOKEN_BUDGET_WARNING: "token_budget_warning",

  /** Token budget hit the 100% hard cap; a call was rejected. Server-side. */
  TOKEN_BUDGET_EXHAUSTED: "token_budget_exhausted",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/*
  Properties associated with each event. Keep them small + privacy-
  conscious: never send free-form user text, evidence content, or
  credential material.
*/
export interface EventProperties {
  [EVENTS.SIGNUP_COMPLETED]: {
    plan: "free" | "solo" | "pro";
    source?: string;
  };
  [EVENTS.FIRST_UPLOAD_STARTED]: {
    sourceType: string;
    fileCount: number;
  };
  [EVENTS.FIRST_INSIGHT_VIEWED]: {
    clusterCount: number;
  };
  [EVENTS.FIRST_SPEC_EXPORTED]: {
    target: "markdown" | "linear" | "notion";
  };
  [EVENTS.SAMPLE_DATA_USED]: {
    inserted: number;
    deduped: number;
    capReached: boolean;
  };
  [EVENTS.TOKEN_BUDGET_WARNING]: {
    plan: "free" | "solo" | "pro";
    percent: number;
    month: string;
  };
  [EVENTS.TOKEN_BUDGET_EXHAUSTED]: {
    plan: "free" | "solo" | "pro";
    month: string;
  };
}
