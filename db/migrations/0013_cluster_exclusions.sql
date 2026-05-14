-- L3: AI Learning Loop — cluster exclusion for PM curation feedback
-- Extends feedback_rating enum, adds excluded tracking to evidence,
-- adds tombstone_reason to insight_cluster, creates cluster_exclusion table.

-- Step 1: Extend feedback_rating enum (non-transactional, must be separate)
ALTER TYPE feedback_rating ADD VALUE IF NOT EXISTS 'dismiss';

-- Step 2: Add excluded tracking columns to evidence
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS exclusion_pending boolean NOT NULL DEFAULT false;

-- Step 3: Create cluster_exclusion table first (evidence FK references it)
CREATE TABLE IF NOT EXISTS cluster_exclusion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  scope_id uuid REFERENCES pm_scope(id) ON DELETE SET NULL,
  source_cluster_id uuid REFERENCES insight_cluster(id) ON DELETE SET NULL,
  centroid vector(1536),
  label text NOT NULL,
  reason text,
  strength real NOT NULL DEFAULT 1.0,
  is_active boolean NOT NULL DEFAULT true,
  dismissed_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Step 4: Add FK from evidence to cluster_exclusion (after table exists)
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS flagged_by_exclusion_id uuid REFERENCES cluster_exclusion(id) ON DELETE SET NULL;

-- Step 5: Add tombstone_reason to insight_cluster
DO $$ BEGIN
  CREATE TYPE tombstone_reason AS ENUM ('merge', 'dismiss');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE insight_cluster ADD COLUMN IF NOT EXISTS tombstone_reason tombstone_reason;

-- Step 5b: Prevent duplicate exclusions for the same cluster
CREATE UNIQUE INDEX IF NOT EXISTS exclusion_source_cluster_unique
  ON cluster_exclusion(account_id, source_cluster_id)
  WHERE source_cluster_id IS NOT NULL;

-- Step 6: Indexes
CREATE INDEX IF NOT EXISTS evidence_excluded_idx ON evidence(account_id, excluded) WHERE excluded = true;
CREATE INDEX IF NOT EXISTS evidence_pending_idx ON evidence(account_id, exclusion_pending) WHERE exclusion_pending = true;
CREATE INDEX IF NOT EXISTS exclusion_account_active_idx ON cluster_exclusion(account_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS exclusion_scope_idx ON cluster_exclusion(account_id, scope_id) WHERE is_active = true;

-- Step 7: RLS
ALTER TABLE cluster_exclusion ENABLE ROW LEVEL SECURITY;
CREATE POLICY cluster_exclusion_tenant ON cluster_exclusion
  FOR ALL USING (account_id = current_setting('app.current_account_id')::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id')::uuid);
