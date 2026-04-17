import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/env";
import * as schema from "./schema";

/*
  Single postgres connection pool for the app.
  Reuses one client in dev to avoid exhausting connections on HMR.
  Import `db` from here, never instantiate a new client elsewhere.

  Tenant safety: every query SHOULD go through the scoped(db) helper
  wired in the tRPC middleware. Raw `db.select()` at a route handler is
  a lint error (ESLint rule lands with the auth commit).
*/

const globalForDb = globalThis as unknown as {
  conn: ReturnType<typeof postgres> | undefined;
};

const conn = globalForDb.conn ?? postgres(env.DATABASE_URL, { prepare: false });
if (env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema, casing: "snake_case" });
export type Database = typeof db;
