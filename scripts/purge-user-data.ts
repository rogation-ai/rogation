import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  accounts,
  activityLog,
  entityFeedback,
  evidence,
  insightClusters,
  insightRuns,
  integrationCredentials,
  integrationState,
  llmUsage,
  opportunities,
  opportunityScoreWeights,
  outcomes,
  specRefinements,
  specs,
  users,
} from "@/db/schema";

/*
  Purge all account-scoped content for a user, keep the user + account rows.

  Resolves the user by email or clerk id, walks every account-scoped table,
  and deletes rows. The user, their account, and Stripe linkage stay intact
  so billing + auth keep working — only the generated/imported content is
  wiped.

  Foreign-key cascades do most of the work (evidence → embeddings + edges;
  opportunity → spec → spec_refinement; cluster → edges). The script still
  enumerates every table for clarity and to catch tables that don't cascade
  from a single root (activity_log, entity_feedback, llm_usage, integrations).

  Usage:
    bun run scripts/purge-user-data.ts --email=pm@acme.com [--dry-run]
    bun run scripts/purge-user-data.ts --clerk-id=user_abc123 [--dry-run]
*/

interface Args {
  email: string | null;
  clerkId: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const arg = argv.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.slice(flag.length + 1) : null;
  };
  const args: Args = {
    email: get("--email"),
    clerkId: get("--clerk-id"),
    dryRun: argv.includes("--dry-run"),
  };
  if (!args.email && !args.clerkId) {
    throw new Error("must pass --email=<email> or --clerk-id=<id>");
  }
  if (args.email && args.clerkId) {
    throw new Error("pass only one of --email or --clerk-id");
  }
  return args;
}

// Tables that carry account_id directly. Order matters only for the count
// report — actual deletes ride FK cascades, but we wipe leaves first to keep
// the numbers honest if a future table loses its cascade.
const ACCOUNT_SCOPED_TABLES = [
  { name: "spec", table: specs },
  { name: "outcome", table: outcomes },
  { name: "opportunity_score_weights", table: opportunityScoreWeights },
  { name: "opportunity", table: opportunities },
  { name: "insight_run", table: insightRuns },
  { name: "insight_cluster", table: insightClusters },
  { name: "evidence", table: evidence },
  { name: "entity_feedback", table: entityFeedback },
  { name: "activity_log", table: activityLog },
  { name: "integration_state", table: integrationState },
  { name: "integration_credential", table: integrationCredentials },
  { name: "llm_usage", table: llmUsage },
] as const;

export interface PurgeResult {
  userId: string;
  accountId: string;
  email: string;
  perTable: Record<string, number>;
  total: number;
  dryRun: boolean;
}

export async function purgeUserData(args: Args): Promise<PurgeResult> {
  const userRow = args.email
    ? await db
        .select({ id: users.id, accountId: users.accountId, email: users.email })
        .from(users)
        .where(eq(users.email, args.email))
        .limit(1)
    : await db
        .select({ id: users.id, accountId: users.accountId, email: users.email })
        .from(users)
        .where(eq(users.clerkUserId, args.clerkId!))
        .limit(1);

  const user = userRow[0];
  if (!user) {
    throw new Error(
      `no user found for ${args.email ? `email=${args.email}` : `clerk-id=${args.clerkId}`}`,
    );
  }

  const perTable: Record<string, number> = {};
  let total = 0;

  await db.transaction(async (tx) => {
    // spec_refinement is scoped by spec_id, not account_id. Count via join,
    // then let the spec delete cascade.
    const refinementCountRows = await tx.execute<{ count: string }>(
      sql`select count(*)::text as count
          from spec_refinement r
          join spec s on s.id = r.spec_id
          where s.account_id = ${user.accountId}`,
    );
    const refinementCount = Number(refinementCountRows[0]?.count ?? 0);
    perTable.spec_refinement = refinementCount;
    total += refinementCount;

    for (const { name, table } of ACCOUNT_SCOPED_TABLES) {
      const countRows = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from ${table} where account_id = ${user.accountId}`,
      );
      const count = Number(countRows[0]?.count ?? 0);
      perTable[name] = count;
      total += count;

      if (!args.dryRun && count > 0) {
        await tx.delete(table).where(eq(table.accountId, user.accountId));
      }
    }

    if (args.dryRun) {
      // Roll the transaction back so dry-run is truly side-effect-free.
      throw new DryRunRollback();
    }
  }).catch((err) => {
    if (err instanceof DryRunRollback) return;
    throw err;
  });

  return {
    userId: user.id,
    accountId: user.accountId,
    email: user.email,
    perTable,
    total,
    dryRun: args.dryRun,
  };
}

class DryRunRollback extends Error {
  constructor() {
    super("dry-run rollback");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await purgeUserData(args);

  console.log(
    `${result.dryRun ? "[dry-run] would purge" : "purged"} data for user ${result.email} (id=${result.userId}, account=${result.accountId})`,
  );
  for (const [name, count] of Object.entries(result.perTable)) {
    console.log(`  ${name.padEnd(28)} ${count}`);
  }
  console.log(`  ${"TOTAL".padEnd(28)} ${result.total}`);
  console.log(
    "user + account rows preserved (Stripe linkage + Clerk auth intact)",
  );

  // Verify ownership ensure we kept what we said we'd keep.
  const stillThere = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, result.userId))
    .limit(1);
  if (stillThere.length !== 1) {
    throw new Error("user row missing after purge — this is a bug");
  }
  const acct = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, result.accountId))
    .limit(1);
  if (acct.length !== 1) {
    throw new Error("account row missing after purge — this is a bug");
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
