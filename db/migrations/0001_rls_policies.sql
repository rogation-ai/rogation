-- Tenant guard, layer 3: Postgres Row-Level Security.
--
-- Every account-scoped table gets RLS enabled + a FOR ALL policy that
-- filters rows by `current_setting('app.current_account_id')`.
--
-- The `authedProcedure` middleware in server/trpc.ts wraps each
-- request in a transaction that calls `set_config('app.current_account_id',
-- $1, true)`. The `true` scopes it to the transaction, so connection
-- pooling (pgbouncer transaction mode) is safe.
--
-- Background jobs, webhooks, and migrations bypass RLS by connecting
-- as the table OWNER (not a RESTRICTED role). For v1 we run everything
-- as the owner. When v2 introduces a limited app role, RLS becomes
-- active for the app role and bypassed for the owner/admin.
--
-- Adding a new account-scoped table? Copy the `ENABLE ROW LEVEL
-- SECURITY` + `CREATE POLICY` block for it. There is no shortcut —
-- Postgres does not inherit RLS.

BEGIN;

-- The schema `app` hosts our helper function. It has to exist before the
-- function definition references `app.current_account_id()`.
CREATE SCHEMA IF NOT EXISTS app;

-- Helper that reads the session var and casts it to uuid. Missing or
-- empty returns NULL, so every policy below fails closed (no rows
-- visible) when the session variable isn't bound.
CREATE OR REPLACE FUNCTION app.current_account_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid
$$;

-- account: self-scoped (the row's own id == current_account_id).
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_tenant_iso ON "account"
  FOR ALL
  USING (id = app.current_account_id())
  WITH CHECK (id = app.current_account_id());

-- user: scoped by account_id.
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_tenant_iso ON "user"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- evidence
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_tenant_iso ON "evidence"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- evidence_embedding: scoped via its evidence parent.
ALTER TABLE "evidence_embedding" ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_embedding_tenant_iso ON "evidence_embedding"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "evidence" e
      WHERE e.id = evidence_embedding.evidence_id
        AND e.account_id = app.current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "evidence" e
      WHERE e.id = evidence_embedding.evidence_id
        AND e.account_id = app.current_account_id()
    )
  );

-- insight_cluster
ALTER TABLE "insight_cluster" ENABLE ROW LEVEL SECURITY;
CREATE POLICY insight_cluster_tenant_iso ON "insight_cluster"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- evidence_to_cluster: scoped via cluster parent.
ALTER TABLE "evidence_to_cluster" ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_to_cluster_tenant_iso ON "evidence_to_cluster"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "insight_cluster" c
      WHERE c.id = evidence_to_cluster.cluster_id
        AND c.account_id = app.current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "insight_cluster" c
      WHERE c.id = evidence_to_cluster.cluster_id
        AND c.account_id = app.current_account_id()
    )
  );

-- opportunity
ALTER TABLE "opportunity" ENABLE ROW LEVEL SECURITY;
CREATE POLICY opportunity_tenant_iso ON "opportunity"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- opportunity_to_cluster: scoped via opportunity parent.
ALTER TABLE "opportunity_to_cluster" ENABLE ROW LEVEL SECURITY;
CREATE POLICY opportunity_to_cluster_tenant_iso ON "opportunity_to_cluster"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "opportunity" o
      WHERE o.id = opportunity_to_cluster.opportunity_id
        AND o.account_id = app.current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "opportunity" o
      WHERE o.id = opportunity_to_cluster.opportunity_id
        AND o.account_id = app.current_account_id()
    )
  );

-- opportunity_score_weights: PK is account_id itself.
ALTER TABLE "opportunity_score_weights" ENABLE ROW LEVEL SECURITY;
CREATE POLICY opportunity_score_weights_tenant_iso ON "opportunity_score_weights"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- spec
ALTER TABLE "spec" ENABLE ROW LEVEL SECURITY;
CREATE POLICY spec_tenant_iso ON "spec"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- spec_refinement: scoped via spec parent.
ALTER TABLE "spec_refinement" ENABLE ROW LEVEL SECURITY;
CREATE POLICY spec_refinement_tenant_iso ON "spec_refinement"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "spec" s
      WHERE s.id = spec_refinement.spec_id
        AND s.account_id = app.current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "spec" s
      WHERE s.id = spec_refinement.spec_id
        AND s.account_id = app.current_account_id()
    )
  );

-- outcome
ALTER TABLE "outcome" ENABLE ROW LEVEL SECURITY;
CREATE POLICY outcome_tenant_iso ON "outcome"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- activity_log
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY activity_log_tenant_iso ON "activity_log"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- entity_feedback
ALTER TABLE "entity_feedback" ENABLE ROW LEVEL SECURITY;
CREATE POLICY entity_feedback_tenant_iso ON "entity_feedback"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- integration_credential
ALTER TABLE "integration_credential" ENABLE ROW LEVEL SECURITY;
CREATE POLICY integration_credential_tenant_iso ON "integration_credential"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

-- integration_state
ALTER TABLE "integration_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY integration_state_tenant_iso ON "integration_state"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());

COMMIT;
