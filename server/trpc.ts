import { initTRPC, TRPCError } from "@trpc/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { ZodError } from "zod";
import { db } from "@/db/client";
import { users, accounts } from "@/db/schema";

/*
  tRPC server setup. Three pieces:

  1. createContext — runs per request. Pulls the Clerk session and (for
     signed-in users) resolves the DB user + account in one query. No DB
     access outside the resolver itself.

  2. publicProcedure — no auth. Landing page queries, share links.

  3. authedProcedure — requires a valid Clerk session AND a resolved user
     row in our DB. Injects ctx.accountId + ctx.userId into every resolver.

  Tenant safety: every authed procedure resolver is expected to pass
  ctx.accountId into its .where() clause. A follow-up commit adds:
  - generic scoped(db, accountId) proxy with per-table helpers
  - ESLint rule banning raw `db` imports outside db/ + webhooks
  - Postgres RLS policies as belt-and-suspenders
*/

type ClerkAuth = Awaited<ReturnType<typeof auth>>;

export interface Context {
  clerkUserId: string | null;
  userId: string | null;
  accountId: string | null;
  db: typeof db;
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

const requireAuth = t.middleware(({ ctx, next }) => {
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
  // Narrow the types so authed resolvers don't have to null-check.
  return next({
    ctx: {
      ...ctx,
      clerkUserId: ctx.clerkUserId,
      userId: ctx.userId,
      accountId: ctx.accountId,
    },
  });
});

export const authedProcedure = t.procedure.use(requireAuth);

// Re-export so downstream code has one typed handle for the account lookup.
export { accounts };
