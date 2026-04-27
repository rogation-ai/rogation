-- Stale flags on opportunity + spec.
--
-- When the cluster set is reshaped by re-clustering (MERGE / SPLIT /
-- tombstone), opportunities derived from those clusters and specs
-- derived from those opportunities become stale relative to the
-- current evidence corpus. Marking stale lets the UI surface a
-- "regenerate to refresh" CTA instead of silently displaying outputs
-- whose source data has shifted.
--
-- Why a flag instead of timestamp comparison: a flag is authoritative
-- (set by apply.ts after the cluster mutation completes) and survives
-- non-content updates. Comparing updated_at columns produces false
-- positives whenever a row is touched for any reason.
--
-- Partial index on (account_id) WHERE stale = true keeps the
-- /build banner queries fast — only stale rows are indexed.

ALTER TABLE "opportunity"
  ADD COLUMN IF NOT EXISTS "stale" boolean NOT NULL DEFAULT false;

ALTER TABLE "spec"
  ADD COLUMN IF NOT EXISTS "stale" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "opportunity_account_stale_idx"
  ON "opportunity" ("account_id")
  WHERE "stale" = true;

CREATE INDEX IF NOT EXISTS "spec_account_stale_idx"
  ON "spec" ("account_id")
  WHERE "stale" = true;
