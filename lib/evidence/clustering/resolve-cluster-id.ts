import { inArray } from "drizzle-orm";
import { insightClusters } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import { ClusteringError } from "./errors";

/*
  Batched tombstone-chain resolver.

  Callers that read cluster ids (opportunity_to_cluster joins,
  evidence_to_cluster fanouts, citation resolvers) pass a batch of
  ids through here to get the "live" id — the MERGE winner if any
  tombstones are in the chain.

  Why a single chokepoint:
  - `COALESCE(tombstoned_into, id)` is spelled exactly once. If the
    tombstone semantics ever change, one file changes.
  - Batched with `id = ANY($1)` → O(1) queries per readers'
    batch regardless of input size. No N+1.
  - Cycle detection is centralized — an accidental self-tombstone
    (A → B → A) surfaces as a typed error, not an infinite loop.

  Depth bound: MERGE of a MERGE is rare but legal. Cap at 4 hops
  (origin + 3 redirects) which handles "merge of merge of merge"
  and flags anything longer as a bug — our actions.ts planner
  never produces chains longer than 1 in a single run, but runs
  compose over time.

  RLS: the caller's transaction has `app.current_account_id` bound,
  so cross-account rows return zero. Verified in the DB-gated test.
*/

const MAX_CHAIN_DEPTH = 4;

export interface ResolveCtx {
  db: Tx;
}

interface RawRow {
  id: string;
  tombstonedInto: string | null;
}

/**
 * Return a map from every input id to its ultimate live id.
 *
 * Semantics:
 * - Input id → itself, if no tombstone set or row doesn't exist in
 *   our scope (RLS-filtered out or simply missing). Missing rows
 *   map to themselves so callers joining against a possibly-deleted
 *   row don't crash; the join will find nothing and move on.
 * - Input id → final winner, if the row's tombstoned_into is set.
 *   Chain is followed up to MAX_CHAIN_DEPTH; beyond that throws
 *   `tombstone_cycle`.
 * - Input id → itself, if following the chain hits a row RLS hides
 *   (cross-account winner, impossible in practice because MERGE
 *   never crosses accounts).
 */
export async function resolveClusterIds(
  ctx: ResolveCtx,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (ids.length === 0) return result;

  // Dedup inputs, keep the full input list for the final map.
  const toFetch = new Set<string>(ids);
  const rows = new Map<string, RawRow>();

  let depth = 0;
  let frontier = Array.from(toFetch);
  while (frontier.length > 0) {
    if (depth > MAX_CHAIN_DEPTH) {
      throw new ClusteringError(
        "tombstone_cycle",
        `tombstone chain exceeds MAX_CHAIN_DEPTH (${MAX_CHAIN_DEPTH}); suspected cycle`,
      );
    }
    // Use drizzle's inArray builder, not sql`ANY(${arr}::uuid[])` —
    // the tag expands arrays into ($1, $2) records that postgres
    // rejects as "cannot cast record to uuid[]".
    const fetched: RawRow[] = await ctx.db
      .select({
        id: insightClusters.id,
        tombstonedInto: insightClusters.tombstonedInto,
      })
      .from(insightClusters)
      .where(inArray(insightClusters.id, frontier));
    for (const r of fetched) rows.set(r.id, r);
    // Queue up any tombstoned_into targets we haven't fetched yet.
    const nextFrontier: string[] = [];
    for (const r of fetched) {
      if (r.tombstonedInto && !rows.has(r.tombstonedInto)) {
        nextFrontier.push(r.tombstonedInto);
      }
    }
    frontier = nextFrontier;
    depth += 1;
  }

  // Follow the chain from each input id to its terminal row. The
  // visited set doubles as the cycle detector AND the depth guard:
  // every distinct row the walk touches is added, and we throw the
  // moment either a repeat is seen or the set hits MAX_CHAIN_DEPTH.
  for (const id of ids) {
    let cur = id;
    const visited = new Set<string>([cur]);
    while (true) {
      const row = rows.get(cur);
      if (!row || row.tombstonedInto === null) break;
      if (visited.has(row.tombstonedInto)) {
        throw new ClusteringError(
          "tombstone_cycle",
          `tombstone cycle detected starting at ${id} (hit ${row.tombstonedInto} twice)`,
        );
      }
      if (visited.size >= MAX_CHAIN_DEPTH) {
        throw new ClusteringError(
          "tombstone_cycle",
          `tombstone chain for ${id} exceeds MAX_CHAIN_DEPTH (${MAX_CHAIN_DEPTH})`,
        );
      }
      visited.add(row.tombstonedInto);
      cur = row.tombstonedInto;
    }
    result.set(id, cur);
  }

  return result;
}
