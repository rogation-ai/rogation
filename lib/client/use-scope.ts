"use client";

import { useSearchParams } from "next/navigation";
import type { ScopeFilter } from "@/lib/evidence/scope-filter";

export function useScope(): ScopeFilter {
  const searchParams = useSearchParams();
  const scope = searchParams.get("scope");
  if (!scope) return undefined;
  if (scope === "unscoped") return "unscoped";
  return scope;
}
