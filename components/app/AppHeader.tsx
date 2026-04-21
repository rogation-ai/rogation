"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { UpgradeButton } from "@/components/app/UpgradeButton";

/*
  Signed-in app header. Separated from app/(app)/layout.tsx because
  the hamburger needs useState and active-nav needs usePathname —
  both client-only. The layout itself stays a server component and
  renders this header inline.

  Mobile (<md): wordmark + hamburger button. Tapping opens a drawer
  listing every nav link, one per row, 44px tap target. Tapping a
  link closes the drawer (React re-renders on route change).
  Desktop (md+): horizontal nav beside the wordmark, no drawer.
*/

export const NAV = [
  { href: "/app", label: "Upload" },
  { href: "/evidence", label: "Evidence" },
  { href: "/insights", label: "Insights" },
  { href: "/build", label: "What to build" },
  { href: "/settings/integrations", label: "Integrations" },
] as const;

export function AppHeader(): React.JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // /app needs exact-match so deeper routes don't all highlight it;
  // everything else does a prefix match so /evidence/anything stays
  // "Evidence" and /settings/<sub> stays "Integrations" (Settings
  // only has one page today).
  function isActive(href: string): boolean {
    if (href === "/app") return pathname === "/app";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <header
      className="border-b"
      style={{ borderColor: "var(--color-border-subtle)" }}
    >
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-8">
          <Link
            href="/app"
            className="text-lg font-semibold tracking-tight"
            style={{ color: "var(--color-brand-accent)" }}
          >
            Rogation
          </Link>
          <nav className="hidden items-center gap-4 text-sm md:flex">
            {NAV.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className="relative py-3 transition hover:opacity-80"
                  style={{
                    color: active
                      ? "var(--color-brand-accent)"
                      : "var(--color-text-secondary)",
                  }}
                >
                  {item.label}
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 -bottom-[17px] h-[2px]"
                      style={{ background: "var(--color-brand-accent)" }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <UpgradeButton />
          <div className="hidden md:block">
            <UserButton />
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
            aria-expanded={drawerOpen}
            className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-md"
            style={{ color: "var(--color-text-primary)" }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {drawerOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {drawerOpen && (
        <nav
          className="flex flex-col border-t md:hidden"
          style={{ borderColor: "var(--color-border-subtle)" }}
        >
          {NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setDrawerOpen(false)}
                aria-current={active ? "page" : undefined}
                className="flex min-h-[44px] items-center border-b border-l-4 px-6 text-sm"
                style={{
                  color: active
                    ? "var(--color-brand-accent)"
                    : "var(--color-text-primary)",
                  borderLeftColor: active
                    ? "var(--color-brand-accent)"
                    : "transparent",
                  borderBottomColor: "var(--color-border-subtle)",
                }}
              >
                {item.label}
              </Link>
            );
          })}
          <div
            className="flex items-center justify-end px-6 py-3"
            style={{ color: "var(--color-text-secondary)" }}
          >
            <UserButton />
          </div>
        </nav>
      )}
    </header>
  );
}
