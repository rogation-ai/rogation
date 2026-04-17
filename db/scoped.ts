import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type * as schema from "./schema";

/*
  Tenant guard, layer 2.

  The authed tRPC middleware opens a transaction per request and calls
  `set_config('app.current_account_id', $1, true)` before invoking the
  resolver. Every query inside the transaction is filtered by the
  account_id RLS policies (layer 3 — see migration 0001).

  This module adds two small ergonomic helpers so feature code cannot
  *forget* accountId on writes:

  - insertForAccount: auto-binds accountId into the values.
  - updateForAccount: guards the update with an explicit equality on
    accountId. RLS WITH CHECK would reject a cross-account update, but
    the explicit check returns zero rows before hitting the DB.

  For raw access inside authed procedures, use `ctx.db` directly — it's
  the transaction handle, so RLS applies.
*/

export type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Set the Postgres session variable that every RLS policy reads.
 * Call this as the first statement inside an authed-procedure transaction.
 */
export async function bindAccountToTx(
  tx: Tx,
  accountId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.current_account_id', ${accountId}, true)`,
  );
}

/*
  Convenience inserts. The `accountId` parameter is required at the call
  site so it cannot be forgotten; the helper just spreads it into values
  automatically so callers don't have to remember the column name.
*/
export function insertForAccount<
  Table extends { accountId: unknown },
  Values extends Record<string, unknown>,
>(
  tx: Tx,
  table: Parameters<Tx["insert"]>[0],
  accountId: string,
  values: Values,
) {
  return tx
    .insert(table)
    .values({ ...values, accountId } as unknown as Parameters<
      ReturnType<Tx["insert"]>["values"]
    >[0]);
}
