-- Enable pgvector. Drizzle-kit doesn't emit CREATE EXTENSION so we manage it here.
-- pgcrypto provides gen_random_uuid() on older Postgres. Postgres 13+ has it built in; noop if already present.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."evidence_source_type" AS ENUM('upload_transcript', 'upload_text', 'upload_pdf', 'upload_csv', 'paste_ticket', 'zendesk', 'posthog', 'canny');--> statement-breakpoint
CREATE TYPE "public"."feedback_entity_type" AS ENUM('insight_cluster', 'opportunity', 'spec');--> statement-breakpoint
CREATE TYPE "public"."feedback_rating" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('zendesk', 'posthog', 'canny', 'linear', 'notion');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('active', 'token_invalid', 'rate_limited', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."metric_source" AS ENUM('manual', 'posthog');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('open', 'in_progress', 'shipped', 'archived');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('free', 'solo', 'pro');--> statement-breakpoint
CREATE TYPE "public"."readiness_grade" AS ENUM('A', 'B', 'C', 'D');--> statement-breakpoint
CREATE TYPE "public"."refinement_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'past_due', 'canceled', 'trialing', 'incomplete', 'incomplete_expired', 'unpaid', 'paused');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"plan" "plan_tier" DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" "subscription_status",
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(64) NOT NULL,
	"entity_type" varchar(32),
	"entity_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid,
	"entity_type" "feedback_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"rating" "feedback_rating" NOT NULL,
	"note" text,
	"prompt_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source_type" "evidence_source_type" NOT NULL,
	"source_ref" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"segment" varchar(128),
	"date" timestamp with time zone,
	"parse_status" varchar(32) DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_embedding" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"model" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_to_cluster" (
	"evidence_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"relevance_score" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_to_cluster_evidence_id_cluster_id_pk" PRIMARY KEY("evidence_id","cluster_id")
);
--> statement-breakpoint
CREATE TABLE "insight_cluster" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"severity" "severity" NOT NULL,
	"frequency" integer DEFAULT 0 NOT NULL,
	"contradictions" jsonb,
	"prompt_hash" varchar(64) NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"kek_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_state" (
	"account_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"status" "integration_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_state_account_id_provider_pk" PRIMARY KEY("account_id","provider")
);
--> statement-breakpoint
CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"reasoning" text NOT NULL,
	"impact_estimate" jsonb,
	"effort_estimate" varchar(16) NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" "opportunity_status" DEFAULT 'open' NOT NULL,
	"prompt_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_score_weights" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"frequency_w" real DEFAULT 1 NOT NULL,
	"revenue_w" real DEFAULT 1 NOT NULL,
	"retention_w" real DEFAULT 1 NOT NULL,
	"strategy_w" real DEFAULT 1 NOT NULL,
	"effort_w" real DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_to_cluster" (
	"opportunity_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	CONSTRAINT "opportunity_to_cluster_opportunity_id_cluster_id_pk" PRIMARY KEY("opportunity_id","cluster_id")
);
--> statement-breakpoint
CREATE TABLE "outcome" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"metric_name" varchar(128) NOT NULL,
	"metric_source" "metric_source" NOT NULL,
	"posthog_metric_id" text,
	"predicted" real,
	"actual" real,
	"measured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec_refinement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"role" "refinement_role" NOT NULL,
	"content" text NOT NULL,
	"prompt_hash" varchar(64),
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_ir" jsonb NOT NULL,
	"content_md" text,
	"readiness_grade" "readiness_grade",
	"readiness_checklist" jsonb,
	"prompt_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" varchar(320) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_feedback" ADD CONSTRAINT "entity_feedback_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_feedback" ADD CONSTRAINT "entity_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_embedding" ADD CONSTRAINT "evidence_embedding_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_to_cluster" ADD CONSTRAINT "evidence_to_cluster_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_to_cluster" ADD CONSTRAINT "evidence_to_cluster_cluster_id_insight_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."insight_cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_cluster" ADD CONSTRAINT "insight_cluster_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credential" ADD CONSTRAINT "integration_credential_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_state" ADD CONSTRAINT "integration_state_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_score_weights" ADD CONSTRAINT "opportunity_score_weights_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_to_cluster" ADD CONSTRAINT "opportunity_to_cluster_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_to_cluster" ADD CONSTRAINT "opportunity_to_cluster_cluster_id_insight_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."insight_cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome" ADD CONSTRAINT "outcome_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome" ADD CONSTRAINT "outcome_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_refinement" ADD CONSTRAINT "spec_refinement_spec_id_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec" ADD CONSTRAINT "spec_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec" ADD CONSTRAINT "spec_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_stripe_customer_idx" ON "account" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_stripe_subscription_idx" ON "account" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "activity_account_created_idx" ON "activity_log" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feedback_entity_idx" ON "entity_feedback" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "feedback_prompt_hash_idx" ON "entity_feedback" USING btree ("prompt_hash");--> statement-breakpoint
CREATE INDEX "feedback_account_created_idx" ON "entity_feedback" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_source_unique" ON "evidence" USING btree ("account_id","source_type","source_ref");--> statement-breakpoint
CREATE INDEX "evidence_account_created_idx" ON "evidence" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evidence_account_hash_idx" ON "evidence" USING btree ("account_id","content_hash");--> statement-breakpoint
CREATE INDEX "evidence_embedding_hnsw_idx" ON "evidence_embedding" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "etc_cluster_idx" ON "evidence_to_cluster" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "insight_cluster_account_updated_idx" ON "insight_cluster" USING btree ("account_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "integration_credential_unique" ON "integration_credential" USING btree ("account_id","provider");--> statement-breakpoint
CREATE INDEX "opportunity_account_score_idx" ON "opportunity" USING btree ("account_id","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "opportunity_account_updated_idx" ON "opportunity" USING btree ("account_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "otc_cluster_idx" ON "opportunity_to_cluster" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "outcome_opportunity_idx" ON "outcome" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "outcome_account_measured_idx" ON "outcome" USING btree ("account_id","measured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "spec_refinement_spec_created_idx" ON "spec_refinement" USING btree ("spec_id","created_at");--> statement-breakpoint
CREATE INDEX "spec_opportunity_version_idx" ON "spec" USING btree ("opportunity_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "spec_account_updated_idx" ON "spec" USING btree ("account_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "user_clerk_id_idx" ON "user" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "user_account_idx" ON "user" USING btree ("account_id");