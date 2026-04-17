import { initTRPC, TRPCError } from "@trpc/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { ZodError } from "zod";
import { db } from "@/db/client";
import { bindAccountToTx, type Tx } from "@/db/scoped";
import { accounts, users } from "@/db/schema";
import {
  assertResourceLimit,
  type CountableResource,
  type LimitCheck,
  type PlanTier,
} from "@/lib/plans";
import {
  assertTokenBudget,
  chargeAndEnforce,
  type BudgetState,
  type MonthlyTotals,
} from "@/lib/llm/usage";
import type { Usage } from "@/lib/llm/router";

/*
  tRPC server setup. Three pieces:

  1. createContext — runs per request. Pulls the Clerk session and (for
     signed-in users) resolves the DB user + account + plan in one
     query. No DB access outside the resolver itself.

  2. publicProcedure — no auth. Landing page queries, share links.

  3. authedProcedure — requires a valid Clerk session AND a resolved user
     row. Wraps the resolver in a transaction that calls
     set_config('app.current_account_id', <accountId>, true), so every
     query inside is RLS-filtered.

     Authed context also carries:
     - ctx.plan: the account's current tier (free/solo/pro) for feature gates.
     - ctx.assertLimit(resource): throws FORBIDDEN when the per-tier cap
       is hit. One-liner for every create-mutation.
*/

type ClerkAuth = Awaited<ReturnType<typeof auth>>;

export type DbLike = typeof db | Tx;

export interface Context {
  clerkUserId: string | null;
  userId: string | null;
  accountId: string | null;
  plan: PlanTier | null;
  db: DbLike;
}

export async function createContext(): Promise<Context> {
  let session: ClerkAuth;
  try {
    session = await auth();
  } catch {
    // auth() can throw when called outside the Clerk middleware path.
    // Treat as unauthenticated; authed procedures will reject downstream.
    return {
      clerkUserId: null,
      userId: null,
      accountId: null,
      plan: null,
      db,
    };
  }

  const clerkUserId = session.userId ?? null;

  if (!clerkUserId) {
    return {
      clerkUserId: null,
      userId: null,
      accountId: null,
      plan: null,
      db,
    };
  }

  // This join runs OUTSIDE the RLS transaction because we don't yet
  // know the account. Running as table owner, so RLS doesn't filter.
  // Single keyed lookup, no cross-account exposure.
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

  // Signed-in via Clerk but no DB user yet. Usually means the webhook
  // hasn't delivered — rare but possible on the first request after
  // signup. Return as unauthenticated for now; the client can retry.
  if (!row) {
    return { clerkUserId, userId: null, accountId: null, plan: null, db };
  }

  return {
    clerkUserId,
    userId: row.userId,
    accountId: row.accountId,
    plan: row.plan,
    db,
  };
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
  if (!ctx.userId || !ctx.accountId || !ctx.plan) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Account is being provisioned — try again in a moment.",
    });
  }

  const clerkUserId = ctx.clerkUserId;
  const userId = ctx.userId;
  const accountId = ctx.accountId;
  const plan = ctx.plan;

  // Open a transaction, bind the RLS session var, and run the resolver
  // inside. Every query through ctx.db is account-filtered by Postgres.
  return await db.transaction(async (tx) => {
    await bindAccountToTx(tx, accountId);

    const assertLimit = (resource: CountableResource): Promise<LimitCheck> =>
      assertResourceLimit(tx, plan, accountId, resource);

    // Pre-call token budget gate. Use before a batch LLM job or
    // expensive single call to reject when the account is already over.
    const assertBudget = (): Promise<BudgetState> =>
      assertTokenBudget(tx, plan, accountId);

    // onUsage sink for the LLM router. Pass this straight to
    // complete(prompt, input, { onUsage: ctx.chargeLLM }).
    // Charges the current-month row AND throws if the call put the
    // account over the hard cap (the spend is still recorded).
    const chargeLLM = (usage: Usage): Promise<MonthlyTotals> =>
      chargeAndEnforce(tx, plan, accountId, usage);

    return next({
      ctx: {
        ...ctx,
        clerkUserId,
        userId,
        accountId,
        plan,
        db: tx,
        assertLimit,
        assertBudget,
        chargeLLM,
      },
    });
  });
});

export const authedProcedure = t.procedure.use(requireAuth);

// Re-export so downstream code has one typed handle for the account lookup.
export { accounts };
