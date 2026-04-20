-- Track spec → Linear issue pushes. One Linear issue per spec version:
-- regenerating a spec bumps version and wipes these columns on the new
-- row, so the PM can push the updated version as a fresh issue. Old
-- versions keep their Linear URL as an audit trail.
--
-- Why on the spec row instead of a separate push_log table: the UI
-- only cares about the latest-version state ("show button vs show View
-- in Linear"). A per-version column read is O(1) with the existing
-- spec_opportunity_version_idx. A log table would need a filter +
-- max-version subquery on every render. Revisit if we add Notion +
-- Jira + GitHub + multi-push tracking.

ALTER TABLE "spec"
  ADD COLUMN IF NOT EXISTS "linear_issue_id" text,
  ADD COLUMN IF NOT EXISTS "linear_issue_identifier" text,
  ADD COLUMN IF NOT EXISTS "linear_issue_url" text,
  ADD COLUMN IF NOT EXISTS "linear_pushed_at" timestamptz;
