import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";

/*
  Integration test DB harness.

  Strategy: one shared `public` schema per test process. The first
  setupTestDb() call of the run drops + recreates `public`, installs
  extensions, runs every migration once. Every subsequent call (each
  test file's beforeAll) truncates every table so the next file sees
  a clean slate. `fileParallelism: false` in vitest.config.ts
  serializes files.

  Why not per-file isolated schemas: app code (e.g.
  `provisionAccountForClerkUser`) imports `db` from `@/db/client`,
  which uses the default search_path (public). Per-file schemas left
  the app's db pointing at empty public tables while the harness wrote
  to `test_<label>`. Two worlds, broken tests in CI.

  Gating: if TEST_DATABASE_URL isn't set, callers should `describe.skip`
  and emit a clear message. We never auto-run DB tests against a
  production DATABASE_URL — tests would wipe it.

  Requires pgvector + pgcrypto to be installed in the cluster. The
  bootstrap CREATEs them into public defensively.
*/

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const hasTestDb = Boolean(TEST_DATABASE_URL);

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDbHandle {
  db: TestDb;
  conn: ReturnType<typeof postgres>;
  schemaName: string;
  teardown: () => Promise<void>;
}

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

// Module-level flag: first setupTestDb() of the process does the full
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

async function bootstrapPublic(
  conn: ReturnType<typeof postgres>,
): Promise<void> {
  // Wipe and reinstall. Extensions live in public, so we recreate them
  // after the drop. Migrations' `CREATE EXTENSION IF NOT EXISTS` is
  // a no-op after this.
  await conn.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
  await conn.unsafe(`CREATE SCHEMA public`);
  await conn.unsafe(`GRANT ALL ON SCHEMA public TO public`);
  await conn.unsafe(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`);
  await conn.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public`);

  const migrations = readMigrations();
  for (const m of migrations) {
    const statements = m.sql
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await conn.unsafe(stmt);
    }
  }
}

async function truncateAll(
  conn: ReturnType<typeof postgres>,
): Promise<void> {
  const tables = await listTables(conn);
  if (tables.length === 0) return;
  const quoted = tables.map((t) => `"public"."${t}"`).join(", ");
  // RESTART IDENTITY resets sequences; CASCADE handles FKs.
  await conn.unsafe(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
}

export async function setupTestDb(label: string): Promise<TestDbHandle> {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is not set");
  }

  // One connection per handle. max=1 keeps drizzle transactions on
  // the same connection where search_path + RLS session vars live.
  const conn = postgres(TEST_DATABASE_URL, {
    prepare: false,
    max: 1,
  });

  if (!bootstrapped) {
    await bootstrapPublic(conn);
    bootstrapped = true;
  } else {
    await truncateAll(conn);
  }

  const db = drizzle(conn, { schema, casing: "snake_case" });

  return {
    db,
    conn,
    schemaName: "public",
    teardown: async () => {
      // Close this file's connection. Next file's setupTestDb() opens
      // a fresh one and truncates the shared public schema before
      // its tests run.
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
