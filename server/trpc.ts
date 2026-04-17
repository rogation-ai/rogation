import { initTRPC, TRPCError } from "@trpc/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { ZodError } from "zod";
import { db } from "@/db/client";
import { bindAccountToTx, type Tx } from "@/db/scoped";
import { users, accounts } from "@/db/schema";

/*
  tRPC server setup. Three pieces:

  1. createContext — runs per request. Pulls the Clerk session and (for
     signed-in users) resolves the DB user + account in one query. No DB
     access outside the resolver itself.

  2. publicProcedure — no auth. Landing page queries, share links.

  3. authedProcedure — requires a valid Clerk session AND a resolved user
     row in our DB. Wraps the resolver in a transaction that calls
     set_config('app.current_account_id', <accountId>, true), so every
     query inside is RLS-filtered by the Postgres policies from
     migration 0001.

     The resolver's `ctx.db` is the transaction handle. Reads + writes
     are account-bound automatically — a raw `ctx.db.select().from(evidence)`
     returns only the caller's rows, no WHERE needed. (Still write the
     WHERE for query planning; RLS is belt-and-suspenders, not an excuse
     to skip defensive filters.)
*/

type ClerkAuth = Awaited<ReturnType<typeof auth>>;

export type DbLike = typeof db | Tx;

export interface Context {
  clerkUserId: string | null;
  userId: string | null;
  accountId: string | null;
  db: DbLike;
}

export async function createContext(): Promise<Context> {
  let session: ClerkAuth;
  try {
    session = await auth();
  } catch {
    // auth() can throw when called outside the Clerk middleware path.
    // Treat as unauthenticated; authed procedures will reject downstream.
    return { clerkUserId: null, userId: null, accountId: null, db };
  }

  const clerkUserId = session.userId ?? null;

  if (!clerkUserId) {
    return { clerkUserId: null, userId: null, accountId: null, db };
  }

  // This read happens OUTSIDE the RLS transaction because we don't yet
  // know the account. Running as table owner, so RLS doesn't filter.
  const [row] = await db
    .select({ userId: users.id, accountId: users.accountId })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  // Signed-in via Clerk but no DB user yet. Usually means the webhook
  // hasn't delivered — rare but possible on the first request after
  // signup. Return as unauthenticated for now; the client can retry.
  if (!row) {
    return { clerkUserId, userId: null, accountId: null, db };
  }

  return { clerkUserId, userId: row.userId, accountId: row.accountId, db };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireAuth = t.middleware(async ({ ctx, next }) => {
  if (!ctx.clerkUserId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
  }
  if (!ctx.userId || !ctx.accountId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Account is being provisioned — try again in a moment.",
    });
  }

  const clerkUserId = ctx.clerkUserId;
  const userId = ctx.userId;
  const accountId = ctx.accountId;

  // Open a transaction, bind the RLS session var, and run the resolver
  // inside. Every query through ctx.db is account-filtered by Postgres.
  return await db.transaction(async (tx) => {
    await bindAccountToTx(tx, accountId);
    return next({
      ctx: {
        ...ctx,
        clerkUserId,
        userId,
        accountId,
        db: tx,
      },
    });
  });
});

export const authedProcedure = t.procedure.use(requireAuth);

// Re-export so downstream code has one typed handle for the account lookup.
export { accounts };
