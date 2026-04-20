import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, users } from "@/db/schema";
import type { PlanTier } from "@/lib/plans";

/*
  Account provisioning — the single source of truth for "Clerk user
  exists but has no DB row yet; create one."

  Called by BOTH paths:

  1. Clerk webhook (`app/api/webhooks/clerk/route.ts`) on user.created.
     Runs as soon as Clerk delivers the signed event.

  2. Lazy fallback in `server/trpc.ts > createContext` when a request
     arrives with a valid Clerk session but no DB row. In dev this
     happens every time because Clerk webhooks can't reach localhost
     without a tunnel. In prod it's the brief race between the
     redirect-after-signup and the webhook delivery.

  Idempotent. Re-running for an already-provisioned Clerk user is a
  single SELECT (no writes, no retries, no duplicates).

  Runs as the DB owner (migration 0001 comment: "Background jobs,
  webhooks, and migrations bypass RLS by connecting as the table
  OWNER"). Uses `db` directly, not an account-scoped tx — the whole
  point is to create the first account for a user who doesn't have
  one yet, so there's no account_id to bind to.
*/

export interface ProvisionInput {
  clerkUserId: string;
  email: string;
}

export interface ProvisionedAccount {
  userId: string;
  accountId: string;
  plan: PlanTier;
  /** True if this call created a new row; false if it was already there. */
  created: boolean;
}

export async function provisionAccountForClerkUser(
  input: ProvisionInput,
): Promise<ProvisionedAccount> {
  // Dedup: if the Clerk user already has a row, return it.
  const [existing] = await db
    .select({
      userId: users.id,
      accountId: users.accountId,
      plan: accounts.plan,
    })
    .from(users)
    .innerJoin(accounts, eq(users.accountId, accounts.id))
    .where(eq(users.clerkUserId, input.clerkUserId))
    .limit(1);

  if (existing) {
    return {
      userId: existing.userId,
      accountId: existing.accountId,
      plan: existing.plan,
      created: false,
    };
  }

  // Transactional create: account first, then user, then set owner.
  // If any step fails the whole thing rolls back, so we never leave
  // an orphan account with no owner (or a user with no account).
  //
  // Race handling: two concurrent first-requests for the same Clerk
  // user (e.g. page opened in two tabs during signup) both skip the
  // dedup SELECT above and both enter this tx. The loser hits the
  // UNIQUE index on user.clerk_user_id and Postgres raises 23505.
  // Catch it, re-SELECT the winner's row, and return `created: false`
  // so the loser sees the same UX as any other idempotent retry
  // instead of a 500. Pre-landing review finding, 2026-04-20.
  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .insert(accounts)
        .values({ plan: "free" })
        .returning({ id: accounts.id, plan: accounts.plan });

      if (!account) throw new Error("Failed to create account row");

      const [user] = await tx
        .insert(users)
        .values({
          accountId: account.id,
          clerkUserId: input.clerkUserId,
          email: input.email,
        })
        .returning({ id: users.id });

      if (!user) throw new Error("Failed to create user row");

      await tx
        .update(accounts)
        .set({ ownerUserId: user.id })
        .where(eq(accounts.id, account.id));

      return {
        userId: user.id,
        accountId: account.id,
        plan: account.plan,
        created: true,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Another caller won the race. Re-SELECT to return their row.
      const [winner] = await db
        .select({
          userId: users.id,
          accountId: users.accountId,
          plan: accounts.plan,
        })
        .from(users)
        .innerJoin(accounts, eq(users.accountId, accounts.id))
        .where(eq(users.clerkUserId, input.clerkUserId))
        .limit(1);

      if (winner) {
        return {
          userId: winner.userId,
          accountId: winner.accountId,
          plan: winner.plan,
          created: false,
        };
      }
    }
    throw err;
  }
}

/*
  Postgres unique_violation is SQLSTATE 23505. The postgres-js driver
  exposes it as `.code` on the thrown error; drizzle just rethrows.
  Narrow defensively so we don't swallow unrelated errors.
*/
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}
