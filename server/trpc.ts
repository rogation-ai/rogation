import { initTRPC, TRPCError } from "@trpc/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import superjson from "superjson";
import { ZodError } from "zod";
import { db } from "@/db/client";
import { bindAccountToTx, type Tx } from "@/db/scoped";
import { accounts, users } from "@/db/schema";
import {
  provisionAccountForClerkUser,
  provisionAccountForClerkOrg,
} from "@/lib/account/provision";
import { EVENTS } from "@/lib/analytics/events";
import {
  captureServer,
  flushServer,
  identifyServer,
} from "@/lib/analytics/posthog-server";
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
import { traceLLM } from "@/lib/llm/langfuse";
import type { TraceEvent, Usage } from "@/lib/llm/router";

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
  const clerkOrgId = (session as { orgId?: string | null }).orgId ?? null;

  if (!clerkUserId) {
    return {
      clerkUserId: null,
      userId: null,
      accountId: null,
      plan: null,
      db,
    };
  }

  // Org context: user has an active Clerk Organization selected.
  // Resolve the account by clerkOrgId, not by clerkUserId.
  if (clerkOrgId) {
    const [orgRow] = await db
      .select({
        userId: users.id,
        accountId: accounts.id,
        plan: accounts.plan,
      })
      .from(accounts)
      .innerJoin(users, eq(users.accountId, accounts.id))
      .where(
        and(
          eq(accounts.clerkOrgId, clerkOrgId),
          eq(users.clerkUserId, clerkUserId),
        ),
      )
      .limit(1);

    if (orgRow) {
      return {
        clerkUserId,
        userId: orgRow.userId,
        accountId: orgRow.accountId,
        plan: orgRow.plan,
        db,
      };
    }

    // Lazy fallback: org account exists but user hasn't been linked yet
    // (webhook race for organizationMembership.created).
    const user = await currentUser().catch(() => null);
    const email =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress;

    if (email) {
      const provisioned = await provisionAccountForClerkOrg({
        clerkOrgId,
        clerkUserId,
        email,
      });
      return {
        clerkUserId,
        userId: provisioned.userId,
        accountId: provisioned.accountId,
        plan: provisioned.plan,
        db,
      };
    }

    return { clerkUserId, userId: null, accountId: null, plan: null, db };
  }

  // Personal account context (no org selected, or orgs not enabled).
  // With multi-account users (L2a), a user may have rows in multiple
  // accounts. The personal account is the one with clerkOrgId IS NULL.
  const [row] = await db
    .select({
      userId: users.id,
      accountId: users.accountId,
      plan: accounts.plan,
    })
    .from(users)
    .innerJoin(accounts, eq(users.accountId, accounts.id))
    .where(
      and(
        eq(users.clerkUserId, clerkUserId),
        sql`${accounts.clerkOrgId} IS NULL`,
      ),
    )
    .limit(1);

  if (row) {
    return {
      clerkUserId,
      userId: row.userId,
      accountId: row.accountId,
      plan: row.plan,
      db,
    };
  }

  // Lazy auto-provision for personal accounts.
  const user = await currentUser().catch(() => null);
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress;

  if (!email) {
    return { clerkUserId, userId: null, accountId: null, plan: null, db };
  }

  const provisioned = await provisionAccountForClerkUser({
    clerkUserId,
    email,
  });

  if (provisioned.created) {
    identifyServer(clerkUserId, { email, plan: provisioned.plan });
    captureServer(clerkUserId, EVENTS.SIGNUP_COMPLETED, {
      plan: provisioned.plan,
    });
    flushServer().catch(() => {
      /* best effort */
    });
  }

  return {
    clerkUserId,
    userId: provisioned.userId,
    accountId: provisioned.accountId,
    plan: provisioned.plan,
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

    // onTrace sink for the LLM router. Pass this straight to
    // complete(prompt, input, { onTrace: ctx.traceLLM }).
    // Captures a Langfuse trace with user + account attribution when
    // Langfuse is configured; no-ops otherwise.
    const traceLLMBound = <I, O>(event: TraceEvent<I, O>): void => {
      traceLLM(event, { userId, accountId });
    };

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
        traceLLM: traceLLMBound,
      },
    });
  });
});

export const authedProcedure = t.procedure.use(requireAuth);

// Re-export so downstream code has one typed handle for the account lookup.
export { accounts };
