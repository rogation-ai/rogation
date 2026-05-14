-- Replace the single-issue Linear export with a project + per-US-issue
-- export. See design doc:
-- ~/.gstack/projects/rogation-ai-rogation/hamza-sanxore-linear-project-spec-export-design-20260514-160230.md
--
-- Pre-customer state: no live single-issue pushes to migrate. Dropping
-- the old columns directly is safe per design premise P3. If you read
-- this commit after Rogation has paying customers, this migration was
-- already in production by then.
--
-- linear_issue_map shape: Record<usId, { id, identifier, url }>
--   - id:         Linear's internal issue UUID (used for updateIssue / archiveIssue)
--   - identifier: human key (e.g. "ENG-432") for UI display
--   - url:        deep link, also for UI display
--
-- linear_push_status: in-flight guard for the orchestrator. The
-- procedure-entry rate limit (linear-push preset, 30/hour) gates how
-- often a PM can click "Push" but does NOT prevent a double-click from
-- entering the orchestrator twice. The DB-level guard does: at the start
-- of the write phase, UPDATE ... SET linear_push_status='pushing' WHERE
-- id=? AND linear_push_status='idle' RETURNING id. No row → throw
-- CONFLICT(push-in-flight). Reset to 'idle' on completion (success or
-- failure).

ALTER TABLE "spec"
  ADD COLUMN "linear_project_id" text,
  ADD COLUMN "linear_project_url" text,
  ADD COLUMN "linear_issue_map" jsonb,
  ADD COLUMN "linear_push_status" text NOT NULL DEFAULT 'idle',
  DROP COLUMN "linear_issue_id",
  DROP COLUMN "linear_issue_identifier",
  DROP COLUMN "linear_issue_url";

-- Partial index supports a future "stale pushing" cleanup job (rows
-- stuck in 'pushing' from a crashed serverless invocation). Cheap to
-- create now; ops uses it when the need surfaces.
CREATE INDEX "spec_linear_push_status_idx"
  ON "spec" ("linear_push_status")
  WHERE "linear_push_status" != 'idle';
