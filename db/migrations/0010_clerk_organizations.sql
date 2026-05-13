-- L2a: Clerk Organizations support.
-- Adds clerkOrgId to accounts so org-context requests resolve to the right account.
-- Existing personal accounts keep clerkOrgId NULL and use the userId path.

ALTER TABLE "account" ADD COLUMN "clerk_org_id" text;

CREATE UNIQUE INDEX "account_clerk_org_idx" ON "account" ("clerk_org_id") WHERE "clerk_org_id" IS NOT NULL;
