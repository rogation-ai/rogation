-- Allow a Clerk user to belong to multiple accounts (personal + orgs).
-- The old unique index on clerk_user_id alone prevents a user from
-- having rows in both their personal account and an org account.

DROP INDEX IF EXISTS "user_clerk_id_idx";
CREATE UNIQUE INDEX "user_clerk_account_idx" ON "user" ("clerk_user_id", "account_id");
CREATE INDEX "user_clerk_id_idx" ON "user" ("clerk_user_id");
