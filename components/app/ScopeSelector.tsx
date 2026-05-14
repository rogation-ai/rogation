"use client";

import { Suspense } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";

export function ScopeSelector(): React.JSX.Element | null {
  return (
    <Suspense fallback={null}>
      <ScopeSelectorInner />
    </Suspense>
  );
}

function ScopeSelectorInner(): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data, isLoading } = trpc.scopes.list.useQuery();

  if (isLoading || !data || data.length === 0) return null;

  const currentScope = searchParams.get("scope") ?? "";

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "") {
      params.delete("scope");
    } else {
      params.set("scope", value);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div
      className="mx-3 mb-3 rounded border px-2 py-1.5"
      style={{ borderColor: "var(--color-border-subtle)" }}
    >
      <select
        value={currentScope}
        onChange={(e) => handleChange(e.target.value)}
        className="w-full bg-transparent text-[13px] font-medium outline-none"
        style={{ color: "var(--color-text-primary)" }}
        aria-label="Scope filter"
      >
        <option value="">All scopes</option>
        <option value="unscoped">Unscoped</option>
        {data.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.name} ({scope.evidenceCount})
          </option>
        ))}
      </select>
    </div>
  );
}
