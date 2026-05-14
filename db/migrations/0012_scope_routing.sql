-- L2b: Scope routing. PMs create scopes with text briefs; evidence
-- gets routed to scopes by embedding cosine similarity. Clustering,
-- opportunities, and specs then run per-scope in isolation.

BEGIN;

-- pm_scope: one per named domain ("Onboarding", "Mobile perf", …).
-- brief is the human-readable description that gets embedded for
-- similarity routing. brief_embedding stores the 1536-d vector
-- (same dim as evidence_embedding).
CREATE TABLE IF NOT EXISTS "pm_scope" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
  "name" varchar(128) NOT NULL,
  "brief" text NOT NULL,
  "brief_embedding" vector(1536),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pm_scope_account_idx ON "pm_scope" ("account_id", "created_at" DESC);

-- scope_id FK on evidence. ON DELETE SET NULL returns evidence to
-- unscoped when a scope is removed.
ALTER TABLE "evidence"
  ADD COLUMN "scope_id" uuid REFERENCES "pm_scope"("id") ON DELETE SET NULL;

CREATE INDEX evidence_account_scope_created_idx
  ON "evidence" ("account_id", "scope_id", "created_at" DESC);

-- scope_id FK on insight_cluster.
ALTER TABLE "insight_cluster"
  ADD COLUMN "scope_id" uuid REFERENCES "pm_scope"("id") ON DELETE SET NULL;

CREATE INDEX insight_cluster_account_scope_idx
  ON "insight_cluster" ("account_id", "scope_id", "updated_at" DESC);

-- scope_id FK on opportunity.
ALTER TABLE "opportunity"
  ADD COLUMN "scope_id" uuid REFERENCES "pm_scope"("id") ON DELETE SET NULL;

CREATE INDEX opportunity_account_scope_idx
  ON "opportunity" ("account_id", "scope_id", "score" DESC);

-- scope_id FK on spec.
ALTER TABLE "spec"
  ADD COLUMN "scope_id" uuid REFERENCES "pm_scope"("id") ON DELETE SET NULL;

CREATE INDEX spec_account_scope_idx
  ON "spec" ("account_id", "scope_id", "updated_at" DESC);

-- scope_id on insight_run so the UI can poll per-scope.
ALTER TABLE "insight_run"
  ADD COLUMN "scope_id" uuid REFERENCES "pm_scope"("id") ON DELETE SET NULL;

-- RLS for pm_scope.
ALTER TABLE "pm_scope" ENABLE ROW LEVEL SECURITY;
CREATE POLICY pm_scope_tenant_iso ON "pm_scope"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

COMMIT;
