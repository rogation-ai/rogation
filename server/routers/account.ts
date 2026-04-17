import { eq } from "drizzle-orm";
import { accounts, users } from "@/db/schema";
import { authedProcedure, router } from "@/server/trpc";

/*
  account.me — returns the caller's own account + user row.
  Acts as the canonical "is my auth plumbed right?" probe and the
  client-side bootstrap call after sign-in.
*/
export const accountRouter = router({
  me: authedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({
        user: {
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
        },
        account: {
          id: accounts.id,
          plan: accounts.plan,
          subscriptionStatus: accounts.subscriptionStatus,
          trialEndsAt: accounts.trialEndsAt,
          createdAt: accounts.createdAt,
        },
      })
      .from(users)
      .innerJoin(accounts, eq(users.accountId, accounts.id))
      .where(eq(users.id, ctx.userId))
      .limit(1);

    if (!row) {
      // This should be impossible in practice: the tRPC middleware only
      // proceeds when ctx.userId is resolved, which means we already found
      // the user row. If we get here, the DB changed underneath us.
      throw new Error("Account row missing for authenticated user");
    }

    return row;
  }),
});
