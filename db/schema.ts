import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/*
  Rogation v1 data model. Source of truth for every table, enum, and index.

  Invariants worth knowing:
  - Every row belongs to an account. Tenant isolation happens in the
    tRPC middleware via a scoped(db) helper that bakes account_id into
    every query. Raw db calls outside that helper are linted out.
  - Every LLM-generated entity carries prompt_hash so an eval regression
    can pinpoint the prompt version that produced it (see plan §14.4,
    eng review decision #7).
  - Compound indexes on (account_id, created_at DESC) for every high-
    traffic list surface (eng review Perf #3).
  - Unique (account_id, source_type, source_ref) on evidence makes
    ingestion idempotent (eng review CQ #4).
*/

/* -------------------------------- ENUMS -------------------------------- */

export const planTier = pgEnum("plan_tier", ["free", "solo", "pro"]);
export const subscriptionStatus = pgEnum("subscription_status", [
  "active",
  "past_due",
  "canceled",
  "trialing",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]);

export const evidenceSourceType = pgEnum("evidence_source_type", [
  "upload_transcript",
  "upload_text",
  "upload_pdf",
  "upload_csv",
  "paste_ticket",
  "zendesk",
  "posthog",
  "canny",
]);

export const severity = pgEnum("severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const opportunityStatus = pgEnum("opportunity_status", [
  "open",
  "in_progress",
  "shipped",
  "archived",
]);

export const readinessGrade = pgEnum("readiness_grade", ["A", "B", "C", "D"]);

export const refinementRole = pgEnum("refinement_role", ["user", "assistant"]);

export const feedbackRating = pgEnum("feedback_rating", ["up", "down"]);
export const feedbackEntityType = pgEnum("feedback_entity_type", [
  "insight_cluster",
  "opportunity",
  "spec",
]);

export const integrationProvider = pgEnum("integration_provider", [
  "zendesk",
  "posthog",
  "canny",
  "linear",
  "notion",
]);

export const integrationStatusEnum = pgEnum("integration_status", [
  "active",
  "token_invalid",
  "rate_limited",
  "disabled",
]);

export const metricSource = pgEnum("metric_source", ["manual", "posthog"]);

/* -------------------------------- pgvector ----------------------------- */

/*
  Custom type wrapper for pgvector. Dimension 1536 matches OpenAI
  text-embedding-3-small / Anthropic claude embeddings of that size.
  Change this only alongside a full re-embedding pass.
*/
const EMBED_DIM = 1536;
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${EMBED_DIM})`;
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .map((n) => Number(n));
  },
});

/* -------------------------------- TABLES ------------------------------- */

export const accounts = pgTable(
  "account",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerUserId: uuid("owner_user_id"),
    plan: planTier("plan").notNull().default("free"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: subscriptionStatus("subscription_status"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("account_stripe_customer_idx").on(t.stripeCustomerId),
    uniqueIndex("account_stripe_subscription_idx").on(t.stripeSubscriptionId),
  ],
);

export const users = pgTable(
  "user",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("user_clerk_id_idx").on(t.clerkUserId),
    index("user_account_idx").on(t.accountId),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sourceType: evidenceSourceType("source_type").notNull(),
    sourceRef: text("source_ref").notNull(),
    content: text("content").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    segment: varchar("segment", { length: 128 }),
    date: timestamp("date", { withTimezone: true }),
    parseStatus: varchar("parse_status", { length: 32 })
      .notNull()
      .default("ready"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("evidence_source_unique").on(
      t.accountId,
      t.sourceType,
      t.sourceRef,
    ),
    index("evidence_account_created_idx").on(
      t.accountId,
      t.createdAt.desc(),
    ),
    index("evidence_account_hash_idx").on(t.accountId, t.contentHash),
  ],
);

export const evidenceEmbeddings = pgTable(
  "evidence_embedding",
  {
    evidenceId: uuid("evidence_id")
      .primaryKey()
      .references(() => evidence.id, { onDelete: "cascade" }),
    embedding: vector("embedding").notNull(),
    model: varchar("model", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("evidence_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const insightClusters = pgTable(
  "insight_cluster",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    severity: severity("severity").notNull(),
    frequency: integer("frequency").notNull().default(0),
    contradictions: jsonb("contradictions").$type<
      Array<{ summary: string; evidenceIds: string[] }>
    >(),
    promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
    stale: boolean("stale").notNull().default(false),
    // Mean of the attached evidence embeddings. Recomputed by
    // applyClusterActions on every edge mutation; used by KNN to
    // decide whether a new piece of evidence attaches here or needs
    // a new cluster. Nullable so existing rows can be backfilled.
    centroid: vector("centroid", { dimensions: 1536 }),
    // Self-FK set on MERGE action. Readers resolve via
    // COALESCE(tombstoned_into, id) through resolveClusterIds().
    // Never DELETE a merged cluster — opportunity_to_cluster FKs
    // depend on this row staying resolvable.
    tombstonedInto: uuid("tombstoned_into"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("insight_cluster_account_updated_idx").on(
      t.accountId,
      t.updatedAt.desc(),
    ),
  ],
);

export const evidenceToCluster = pgTable(
  "evidence_to_cluster",
  {
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => insightClusters.id, { onDelete: "cascade" }),
    relevanceScore: real("relevance_score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.evidenceId, t.clusterId] }),
    index("etc_cluster_idx").on(t.clusterId),
  ],
);

/*
  insight_run: one row per user-triggered clustering run. Written by
  trpc.insights.run (status=pending) and transitioned by the Inngest
  worker through running -> done | failed. The UI polls
  trpc.insights.runStatus for the current state so it can swap the
  "Generate" button for a live progress banner.

  Concurrency: `trpc.insights.run` rejects with CONFLICT when a row
  in `pending` | `running` exists for this account younger than 5
  minutes. Older rows are considered stale (worker crashed) and the
  new run supersedes them — no reaper job needed.
*/
export const insightRuns = pgTable(
  "insight_run",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    mode: text("mode").notNull(),
    clustersCreated: integer("clusters_created"),
    evidenceUsed: integer("evidence_used"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("insight_run_account_started_idx").on(t.accountId, t.startedAt.desc())],
);

export type InsightRunStatus = "pending" | "running" | "done" | "failed";
export type InsightRunMode = "full" | "incremental";
export type InsightRun = typeof insightRuns.$inferSelect;

export const opportunities = pgTable(
  "opportunity",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    reasoning: text("reasoning").notNull(),
    impactEstimate: jsonb("impact_estimate").$type<{
      retention?: number;
      revenue?: number;
      activation?: number;
    }>(),
    effortEstimate: varchar("effort_estimate", { length: 16 }).notNull(),
    score: real("score").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    status: opportunityStatus("status").notNull().default("open"),
    promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("opportunity_account_score_idx").on(
      t.accountId,
      t.score.desc(),
    ),
    index("opportunity_account_updated_idx").on(
      t.accountId,
      t.updatedAt.desc(),
    ),
  ],
);

export const opportunityToCluster = pgTable(
  "opportunity_to_cluster",
  {
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => insightClusters.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.opportunityId, t.clusterId] }),
    index("otc_cluster_idx").on(t.clusterId),
  ],
);

export const opportunityScoreWeights = pgTable("opportunity_score_weights", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  frequencyW: real("frequency_w").notNull().default(1),
  revenueW: real("revenue_w").notNull().default(1),
  retentionW: real("retention_w").notNull().default(1),
  strategyW: real("strategy_w").notNull().default(1),
  effortW: real("effort_w").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const specs = pgTable(
  "spec",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    contentIr: jsonb("content_ir").notNull(),
    contentMd: text("content_md"),
    readinessGrade: readinessGrade("readiness_grade"),
    readinessChecklist: jsonb("readiness_checklist").$type<{
      edgesCovered: boolean;
      validationSpecified: boolean;
      nonFunctionalAddressed: boolean;
      acceptanceTestable: boolean;
      llmNotes?: string;
    }>(),
    // Linear push metadata. Populated when pushSpecToLinear succeeds.
    // Cleared implicitly on regenerate (new version = new row with
    // NULLs). Old versions retain their URL as audit.
    linearIssueId: text("linear_issue_id"),
    linearIssueIdentifier: text("linear_issue_identifier"),
    linearIssueUrl: text("linear_issue_url"),
    linearPushedAt: timestamp("linear_pushed_at", { withTimezone: true }),
    promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("spec_opportunity_version_idx").on(t.opportunityId, t.version.desc()),
    index("spec_account_updated_idx").on(t.accountId, t.updatedAt.desc()),
  ],
);

export const specRefinements = pgTable(
  "spec_refinement",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    specId: uuid("spec_id")
      .notNull()
      .references(() => specs.id, { onDelete: "cascade" }),
    role: refinementRole("role").notNull(),
    content: text("content").notNull(),
    promptHash: varchar("prompt_hash", { length: 64 }),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("spec_refinement_spec_created_idx").on(t.specId, t.createdAt)],
);

export const outcomes = pgTable(
  "outcome",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    metricName: varchar("metric_name", { length: 128 }).notNull(),
    metricSource: metricSource("metric_source").notNull(),
    posthogMetricId: text("posthog_metric_id"),
    predicted: real("predicted"),
    actual: real("actual"),
    measuredAt: timestamp("measured_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("outcome_opportunity_idx").on(t.opportunityId),
    index("outcome_account_measured_idx").on(t.accountId, t.measuredAt.desc()),
  ],
);

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("activity_account_created_idx").on(
      t.accountId,
      t.createdAt.desc(),
    ),
  ],
);

export const entityFeedback = pgTable(
  "entity_feedback",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    entityType: feedbackEntityType("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    rating: feedbackRating("rating").notNull(),
    note: text("note"),
    promptHash: varchar("prompt_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("feedback_entity_idx").on(t.entityType, t.entityId),
    index("feedback_prompt_hash_idx").on(t.promptHash),
    index("feedback_account_created_idx").on(
      t.accountId,
      t.createdAt.desc(),
    ),
    // One vote per (account, user, entity). Partial — null user_id
    // (deleted voter) doesn't participate, so historical votes stay.
    uniqueIndex("feedback_user_entity_unique")
      .on(t.accountId, t.userId, t.entityType, t.entityId)
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);

export const integrationCredentials = pgTable(
  "integration_credential",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: integrationProvider("provider").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    kekVersion: integer("kek_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("integration_credential_unique").on(t.accountId, t.provider),
  ],
);

/*
  Monthly LLM usage accumulation. One row per (account, month). Every
  call through lib/llm/router.ts charges this table via the onUsage hook
  in the tRPC authed middleware.

  Month is stored as `YYYY-MM` text for portable indexing (no timezone
  games at the DB level; callers compute the UTC month key once).

  Why a rolling monthly bucket rather than per-call rows:
  - The "current month spend" query must be a single row read, not an
    aggregate scan, since it runs on every LLM call inside the tRPC
    request path. O(1) PK read beats SUM(tokens_in) every time.
  - Per-call audit trail lives in the eval-infra (Langfuse/Braintrust)
    and in Sentry traces — not here.
*/
export const llmUsage = pgTable(
  "llm_usage",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    month: varchar("month", { length: 7 }).notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreateTokens: integer("cache_create_tokens").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.month] })],
);

export const integrationState = pgTable(
  "integration_state",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: integrationProvider("provider").notNull(),
    cursor: text("cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    status: integrationStatusEnum("status").notNull().default("active"),
    lastError: text("last_error"),
    // Per-provider knobs (Linear: default team; Notion: target DB;
    // etc.). Narrowed in TS with provider-specific shapes at read time.
    config: jsonb("config").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.provider] })],
);

export interface LinearIntegrationConfig {
  workspaceId?: string;
  workspaceName?: string;
  defaultTeamId?: string;
  defaultTeamName?: string;
  defaultTeamKey?: string;
  // Index signature makes this assignable to the column's jsonb
  // Record<string, unknown> type without widening to plain records
  // at every call site.
  [k: string]: unknown;
}

/*
  Notion integration config. Auto-created on first connect:

  - workspaceId / workspaceName / workspaceIcon: displayed on the
    settings page and used to warn the user on reconnect if they
    connect a different workspace.
  - botId: the Notion bot user created when the OAuth app was granted
    access. Stored so we can correlate Notion-side audit with our
    integration row without another round-trip.
  - defaultDatabaseId / defaultDatabaseName: the "Rogation Specs"
    database we auto-create at callback time. Every spec push creates
    a page in this database. If null, we were unable to find a
    writable parent page during consent — the UI flips to a
    "Reconnect with page access" state.
  - setupReason: non-null when defaultDatabaseId is null, so the UI
    can show a specific message ("No writable page found" vs
    "Provisioning failed — retry").
*/
export interface NotionIntegrationConfig {
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string | null;
  botId?: string;
  defaultDatabaseId?: string;
  defaultDatabaseName?: string;
  setupReason?: "no_writable_page" | "provision_failed";
  [k: string]: unknown;
}

/* --------------------------- TYPE INFERENCE ---------------------------- */

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
export type InsightCluster = typeof insightClusters.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
export type Spec = typeof specs.$inferSelect;
export type Outcome = typeof outcomes.$inferSelect;
export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type LlmUsage = typeof llmUsage.$inferSelect;
export type NewLlmUsage = typeof llmUsage.$inferInsert;
