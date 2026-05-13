import { eq, isNull, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type ScopeFilter = string | null | undefined;

export function withScopeFilter(
  scopeId: ScopeFilter,
  column: PgColumn,
): SQL | undefined {
  if (scopeId === undefined || scopeId === null) return undefined;
  if (scopeId === "unscoped") return isNull(column);
  return eq(column, scopeId);
}
