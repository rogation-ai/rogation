-- Per-provider configuration stored alongside sync state. For Linear
-- today: { defaultTeamId, defaultTeamName, defaultTeamKey, workspaceId,
-- workspaceName }. For Notion tomorrow: { databaseId, databaseName }.
--
-- A jsonb column avoids a per-provider migration every time we add a
-- setting. The shape is narrowed in TypeScript per-provider; Postgres
-- treats it as opaque bytes + uses RLS for tenant isolation.

ALTER TABLE "integration_state"
  ADD COLUMN IF NOT EXISTS "config" jsonb;
