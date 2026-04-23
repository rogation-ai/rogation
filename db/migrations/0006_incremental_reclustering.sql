-- Incremental re-clustering (Phase B) schema.
--
-- Two shape changes to insight_cluster + one new insight_run table for
-- the async orchestrator.
--
-- See docs/designs/incremental-reclustering.md §9 + §16 for rationale.

-- 1) insight_cluster.centroid: 1536-dim vector, mean of evidence
--    embeddings attached to this cluster. Recomputed by
--    lib/evidence/clustering/actions.ts on every edge change.
--    Nullable because existing rows get it via backfill script, not
--    inline migration.
ALTER TABLE "insight_cluster"
  ADD COLUMN IF NOT EXISTS "centroid" vector(1536);
--> statement-breakpoint

-- 2) insight_cluster.tombstoned_into: self-FK. When a MERGE action
--    absorbs this cluster into a winner, we set this field instead of
--    DELETE so opportunity_to_cluster FKs stay intact. Readers follow
--    the chain via COALESCE(tombstoned_into, id) in resolve-cluster-id.ts.
ALTER TABLE "insight_cluster"
  ADD COLUMN IF NOT EXISTS "tombstoned_into" uuid
    REFERENCES "insight_cluster"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- 3) Partial HNSW index on centroid, excluding tombstoned rows so KNN
--    never matches a dead cluster. `vector_cosine_ops` matches the
--    similarity function used in knn.ts.
CREATE INDEX IF NOT EXISTS "insight_cluster_centroid_hnsw_idx"
  ON "insight_cluster"
  USING hnsw ("centroid" vector_cosine_ops)
  WHERE "tombstoned_into" IS NULL;
--> statement-breakpoint

-- 4) insight_run: one row per user-triggered clustering run. The
--    Inngest worker writes status transitions; the UI polls
--    trpc.insights.runStatus for the current state.
--
--    mode: "full" | "incremental" — set by the orchestrator based on
--    the cold-start rule (zero clusters + <=50 evidence -> full).
--    status: "pending" -> "running" -> "done" | "failed". A run older
--    than 5 minutes in pending/running is considered stale and a new
--    run may start over it (no reaper — the concurrency predicate in
--    insights.run handles it).
CREATE TABLE IF NOT EXISTS "insight_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "mode" text NOT NULL,
  "clusters_created" integer,
  "evidence_used" integer,
  "duration_ms" integer,
  "error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
--> statement-breakpoint

-- 5) Index for "what's the latest run on this account?" — the UI's
--    status-polling query.
CREATE INDEX IF NOT EXISTS "insight_run_account_started_idx"
  ON "insight_run" ("account_id", "started_at" DESC);
--> statement-breakpoint

-- 6) RLS on insight_run. Policy mirrors every other account-scoped
--    table: FOR ALL with USING + WITH CHECK tied to the session var.
ALTER TABLE "insight_run" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "insight_run_tenant_iso" ON "insight_run"
  FOR ALL
  USING (account_id = app.current_account_id())
  WITH CHECK (account_id = app.current_account_id());
