import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";

/*
  Integration test DB harness.

  Strategy: one shared `public` schema per test process + a dedicated
  non-superuser role for RLS enforcement.

  Why the role: TEST_DATABASE_URL typically authenticates as `postgres`,
  which is a Postgres SUPERUSER. Superusers bypass row-level security
  unconditionally — even `FORCE ROW LEVEL SECURITY` can't touch them.
  Tests that verify tenant isolation would silently pass while data
  leaked across accounts. The harness creates a `test_app` role
  (NOSUPERUSER) at bootstrap, grants it everything it needs, and has
  every subsequent connection SET ROLE to it via the `options` URL
  parameter. The ONE initial bootstrap connection stays superuser so
  we can CREATE ROLE + run migrations + set FORCE RLS.

  Bootstrap runs once per process (first setupTestDb call): drop +
  recreate `public`, install extensions, run migrations, create the
  test role, grant, FORCE RLS on account-scoped tables. Every
  subsequent setupTestDb call truncates every table so the next file
  sees a clean slate. `fileParallelism: false` in vitest.config.ts
  serializes files.

  Gating: if TEST_DATABASE_URL isn't set, callers should `describe.skip`
  and emit a clear message. We never auto-run DB tests against a
  production DATABASE_URL — tests would wipe it.

  Requires pgvector + pgcrypto to be installed in the cluster. The
  bootstrap CREATEs them into public defensively.
*/

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const hasTestDb = Boolean(TEST_DATABASE_URL);

const TEST_ROLE = "test_app";
const TEST_ROLE_PASSWORD = "test_app";

/*
  Append `options=-c role=<role>` to a connection URL so every
  connection opened with it issues an implicit SET ROLE on startup.
  This is how we force RLS enforcement even when the underlying user
  is a superuser: SET ROLE to a non-superuser demotes the session.
*/
export function withRole(baseUrl: string, role = TEST_ROLE): string {
  const u = new URL(baseUrl);
  const existing = u.searchParams.get("options") ?? "";
  const roleOpt = `-c role=${role}`;
  u.searchParams.set(
    "options",
    existing ? `${existing} ${roleOpt}` : roleOpt,
  );
  return u.toString();
}

/*
  Tables where RLS must be enforced against the test role (via FORCE
  ROW LEVEL SECURITY, since test_app owns the tables as GRANT-ee).
  Excludes `account` and `user` because `provisionAccountForClerkUser`
  creates new rows via the app's db client without any session var
  bound (bootstrap path — no accountId to bind yet). Provisioning
  runs under the role but the policies on account/user are
  deliberately permissive to the owner path in v1.
*/
const FORCE_RLS_TABLES = [
  "evidence",
  "evidence_embedding",
  "insight_cluster",
  "evidence_to_cluster",
  "opportunity",
  "opportunity_to_cluster",
  "opportunity_score_weights",
  "spec",
  "spec_refinement",
  "outcome",
  "activity_log",
  "entity_feedback",
  "integration_credential",
  "integration_state",
  "llm_usage",
];

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDbHandle {
  db: TestDb;
  conn: ReturnType<typeof postgres>;
  schemaName: string;
  teardown: () => Promise<void>;
}

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

// Module-level flag: first setupTestDb() of the process runs the full
// bootstrap; every later call just truncates.
let bootstrapped = false;

function readMigrations(): Array<{ tag: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      tag: f.replace(/\.sql$/, ""),
      sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
    }));
}

async function listTables(
  conn: ReturnType<typeof postgres>,
): Promise<string[]> {
  const rows = await conn<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '__drizzle%'
  `;
  return rows.map((r) => r.tablename);
}

async function bootstrapPublic(): Promise<void> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");

  // Open a dedicated superuser connection for bootstrap. Separate from
  // every other connection in the process — those all SET ROLE via
  // their URL options.
  const boot = postgres(TEST_DATABASE_URL, { prepare: false, max: 1 });
  try {
    // Drop everything and start fresh. DROP SCHEMA CASCADE wipes any
    // previous run's artifacts including the test_app-owned grants.
    await boot.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
    await boot.unsafe(`DROP SCHEMA IF EXISTS app CASCADE`);
    await boot.unsafe(`CREATE SCHEMA public`);
    await boot.unsafe(`GRANT ALL ON SCHEMA public TO public`);
    await boot.unsafe(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`);
    await boot.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public`);

    // Idempotent role creation. DO block because CREATE ROLE has no
    // IF NOT EXISTS. We use a well-known password because this role
    // only exists on test databases and TEST_DATABASE_URL is already
    // guarded against pointing at prod.
    await boot.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
          CREATE ROLE ${TEST_ROLE} LOGIN NOSUPERUSER NOINHERIT
            PASSWORD '${TEST_ROLE_PASSWORD}';
        END IF;
      END
      $$;
    `);

    // Allow the role to connect to the current database.
    await boot.unsafe(
      `GRANT CONNECT ON DATABASE ${getDatabaseName(TEST_DATABASE_URL)} TO ${TEST_ROLE}`,
    );

    const migrations = readMigrations();
    for (const m of migrations) {
      const statements = m.sql
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await boot.unsafe(stmt);
      }
    }

    // Grant the test role full DML on public + usage on the app helper
    // schema so `app.current_account_id()` resolves.
    await boot.unsafe(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
    await boot.unsafe(`GRANT USAGE ON SCHEMA app TO ${TEST_ROLE}`);
    await boot.unsafe(
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`,
    );
    await boot.unsafe(
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${TEST_ROLE}`,
    );
    await boot.unsafe(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${TEST_ROLE}`,
    );
    await boot.unsafe(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${TEST_ROLE}`,
    );

    // Force RLS on account-scoped tables. Without FORCE, even though
    // test_app is not the owner, table-level privileges granted above
    // still apply — FORCE makes the policies the final filter.
    for (const table of FORCE_RLS_TABLES) {
      await boot.unsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }

    // Transfer ownership of `account` and `user` to test_app so seed
    // code in 6 test files can DISABLE/ENABLE RLS on those tables to
    // bootstrap initial rows. (The policy is `id = app.current_account_id()`
    // which is NULL before any account exists — can't satisfy WITH CHECK
    // on first insert, so seed code briefly turns RLS off.) These two
    // tables are not in FORCE_RLS_TABLES, so test_app owning them means
    // provisionAccountForClerkUser also works under the role via the
    // documented owner-bypass for the bootstrap path.
    await boot.unsafe(`ALTER TABLE "account" OWNER TO ${TEST_ROLE}`);
    await boot.unsafe(`ALTER TABLE "user" OWNER TO ${TEST_ROLE}`);
  } finally {
    await boot.end({ timeout: 2 });
  }
}

function getDatabaseName(url: string): string {
  const u = new URL(url);
  return u.pathname.replace(/^\//, "") || "postgres";
}

async function truncateAll(
  conn: ReturnType<typeof postgres>,
): Promise<void> {
  const tables = await listTables(conn);
  if (tables.length === 0) return;
  const quoted = tables.map((t) => `"public"."${t}"`).join(", ");
  // RESTART IDENTITY resets sequences; CASCADE handles FKs.
  // Truncation runs as superuser (the truncating connection is opened
  // without the role option) because test_app can't truncate without
  // additional grants and TRUNCATE bypasses RLS anyway.
  await conn.unsafe(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
}

export async function setupTestDb(label: string): Promise<TestDbHandle> {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is not set");
  }

  if (!bootstrapped) {
    await bootstrapPublic();
    bootstrapped = true;
  } else {
    // Truncate between files as superuser (TRUNCATE needs ownership
    // which test_app doesn't have).
    const truncConn = postgres(TEST_DATABASE_URL, { prepare: false, max: 1 });
    try {
      await truncateAll(truncConn);
    } finally {
      await truncConn.end({ timeout: 2 });
    }
  }

  // Handle connection runs as test_app so RLS policies apply. max=1
  // keeps drizzle transactions pinned to the same connection where
  // session vars live.
  const conn = postgres(withRole(TEST_DATABASE_URL), {
    prepare: false,
    max: 1,
  });

  const db = drizzle(conn, { schema, casing: "snake_case" });

  return {
    db,
    conn,
    schemaName: "public",
    teardown: async () => {
      await conn.end({ timeout: 2 });
    },
  };
}

// Helper for calling set_config inside a test transaction.
export async function bindAccount(
  tx: Parameters<TestDb["transaction"]>[0] extends (t: infer T) => unknown
    ? T
    : never,
  accountId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.current_account_id', ${accountId}, true)`,
  );
}
