"use client";

import { useSearchParams } from "next/navigation";

/*
  Reads the global ?scope=<id|unscoped> URL param written by
  components/app/ScopeSelector and normalises it for tRPC list calls
  (evidence, insights, opportunities, specs all accept the same shape).

  Caller MUST be inside a <Suspense> boundary because useSearchParams
  forces dynamic rendering. Return values:

    - undefined  → no filter (pass through; same as not setting scopeId)
    - "unscoped" → only rows with scope_id IS NULL
    - string     → uuid of a specific scope

  The runtime narrowing also discards malformed values: if someone hand-
  crafts ?scope=garbage, we treat it as "no filter" rather than passing
  garbage to the server (which would throw a Zod parse error and 500).
*/

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScopeFilter = string | "unscoped" | undefined;

export function normalizeScopeParam(raw: string | null): ScopeFilter {
  if (!raw) return undefined;
  if (raw === "unscoped") return "unscoped";
  if (UUID_RE.test(raw)) return raw;
  return undefined;
}

export function useScopeFilter(): ScopeFilter {
  const searchParams = useSearchParams();
  return normalizeScopeParam(searchParams.get("scope"));
}
