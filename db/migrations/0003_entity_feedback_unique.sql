-- One vote per (account, user, entity) so the app-layer UPSERT on
-- feedback.vote has a stable conflict target. Nulls in user_id (from
-- deleted users) don't dedupe in Postgres, which is correct — we
-- keep historical votes tied to the row even after the voter is gone.

CREATE UNIQUE INDEX "feedback_user_entity_unique"
  ON "entity_feedback" ("account_id", "user_id", "entity_type", "entity_id")
  WHERE "user_id" IS NOT NULL;
