import { and, eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * DRY WHERE clause fragment for excluding dismissed + pending evidence
 * from clustering queries. Same pattern as scope-filter.ts.
 *
 * Usage:
 *   .where(and(
 *     withExcludedFilter(evidence.excluded, evidence.exclusionPending),
 *     ...otherConditions,
 *   ))
 */
export function withExcludedFilter(
  excludedCol: PgColumn,
  pendingCol?: PgColumn,
) {
  if (pendingCol) {
    return and(eq(excludedCol, false), eq(pendingCol, false));
  }
  return eq(excludedCol, false);
}
