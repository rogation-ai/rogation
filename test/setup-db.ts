import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";

/*
  Integration test DB harness.

  Strategy: create a throwaway schema per test file, apply both
  migrations to it, return a Drizzle client bound to it, drop it on
  teardown. Isolation is free — parallel test files don't touch each
  other — and the real DB stays clean.

  Gating: if TEST_DATABASE_URL isn't set, callers should `describe.skip`
  and emit a clear message. We never auto-run DB tests against a
  production DATABASE_URL — tests would wipe it.

  Requires pgvector to be installed in the cluster (not just the schema).
  Supabase and Neon have it preloaded.
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

function readMigrations(): Array<{ tag: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      tag: f.replace(/\.sql$/, ""),
      // drizzle-kit emits `"public"."foo"` for types + some refs. For
      // per-schema test isolation we want everything unqualified so it
      // lands in the test schema (search_path[0]) and dies with
      // `DROP SCHEMA CASCADE` on teardown. Without this strip, CREATE
      // TYPE survives across test files and the second run hits
      // `type "..." already exists`.
      sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /"public"\./g,
        "",
      ),
    }));
}

export async function setupTestDb(
  label: string,
): Promise<TestDbHandle> {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is not set");
  }

  // Unique schema per test run + file label, safe for concurrent runs.
  const schemaName = `test_${label.replace(/[^a-z0-9_]/gi, "_")}_${Date.now().toString(36)}`;

  // Bootstrap: create the schema + ensure extensions exist in public.
  // Installing vector/pgcrypto in public (not the test schema) means
  // parallel test files don't race each other — the migration's
  // CREATE EXTENSION IF NOT EXISTS is a no-op, but the `vector` type
  // is always resolvable via search_path fallback to public.
  const boot = postgres(TEST_DATABASE_URL, { prepare: false, max: 1 });
  await boot.unsafe(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`);
  await boot.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public`);
  await boot.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await boot.end({ timeout: 2 });

  // Main connection: max=1 so every query (including drizzle
  // transactions) runs on the same connection where we set
  // search_path. Tests within a single file are sequential — no
  // parallelism benefit from a larger pool, and max>1 tripped
  // postgres.js's UNSAFE_TRANSACTION guard for drizzle transactions.
  const conn = postgres(TEST_DATABASE_URL, {
    prepare: false,
    max: 1,
    connection: { search_path: `"${schemaName}",public` },
  });

  // Apply migrations in order. Each migration file is parsed at
  // drizzle-kit's --> statement-breakpoint markers so we can run each
  // statement independently (some drivers don't accept multi-statement
  // strings).
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

  const db = drizzle(conn, { schema, casing: "snake_case" });

  return {
    db,
    conn,
    schemaName,
    teardown: async () => {
      try {
        await conn.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await conn.end({ timeout: 2 });
      }
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
