-- L1: Add Slack + Hotjar connector support via Nango
-- Adds new enum values for evidence source types and integration providers.
-- Nango handles OAuth/tokens externally; connection state lives in
-- integration_state.config JSONB (no changes to integration_credential).

ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'slack';
ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'hotjar';

ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'slack';
ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'hotjar';

-- Optional source_channel for display (e.g. "#product-feedback")
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS source_channel text;
