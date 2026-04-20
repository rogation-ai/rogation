import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bindAccountToTx, type Tx } from "@/db/scoped";
import { accounts, users } from "@/db/schema";
import type { PlanTier } from "@/lib/plans";

/*
  Auth helper for non-tRPC entry points (Route Handlers, webhooks with
  session, server components). Mirrors the tRPC authed middleware:

    1. Pull the Clerk session.
    2. Resolve userId + accountId + plan from the DB.
    3. Open a transaction + bind app.current_account_id so RLS
       engages for every query inside.
    4. Run the caller's function with a ready-to-use ctx.

  If auth fails at any step, returns null — the caller decides whether
  to respond 401 / 403 / 404. We don't throw because Route Handlers
  should own their own error shape.

  Do NOT reuse this from feature code. Feature code goes through tRPC.
  This helper only exists because multipart file upload can't ride
  tRPC's transport cleanly.
*/

export interface AuthedContext {
  clerkUserId: string;
  userId: string;
  accountId: string;
  plan: PlanTier;
  db: Tx;
}

export async function withAuthedAccountTx<T>(
  fn: (ctx: AuthedContext) => Promise<T>,
): Promise<T | null> {
  const session = await auth().catch(() => null);
  const clerkUserId = session?.userId;
  if (!clerkUserId) return null;

  // Resolve user + account outside the RLS tx — we don't know the
  // account yet, and this read is keyed by the unique clerk_user_id.
  const [row] = await db
    .select({
      userId: users.id,
      accountId: users.accountId,
      plan: accounts.plan,
    })
    .from(users)
    .innerJoin(accounts, eq(users.accountId, accounts.id))
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  if (!row) return null;

  return db.transaction(async (tx) => {
    await bindAccountToTx(tx, row.accountId);
    return fn({
      clerkUserId,
      userId: row.userId,
      accountId: row.accountId,
      plan: row.plan,
      db: tx,
    });
  });
}
