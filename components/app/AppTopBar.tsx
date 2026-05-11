"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { NAV } from "@/components/app/AppSidebar";

/*
  56px top bar above the canvas. Hosts:
    - Mobile (<md): hamburger + wordmark on the left, UserButton right.
      The hamburger opens a drawer rendering the same NAV items + plan
      link.
    - Desktop (md+): breadcrumb derived from the current pathname on
      the left, UserButton right. The sidebar already owns the
      wordmark, so this bar stays quiet on wide screens.

  Reserved for ⌘K (global command palette) in v1.1 — placeholder slot
  in the middle. Not wired yet.
*/

export function AppTopBar(): React.JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const crumb = breadcrumbFor(pathname);

  return (
    <header
      className="sticky top-0 z-10 flex h-14 items-center justify-between border-b px-4 md:px-6"
      style={{
        background: "var(--color-surface-app)",
        borderColor: "var(--color-border-subtle)",
      }}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={drawerOpen ? "Close menu" : "Open menu"}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
          className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md"
          style={{ color: "var(--color-text-primary)" }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
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

        <Link
          href="/app"
          className="md:hidden text-sm font-semibold tracking-tight"
          style={{ color: "var(--color-brand-accent)" }}
        >
          Rogation
        </Link>

        <span
          className="hidden md:inline text-sm"
          style={{ color: "var(--color-text-primary)" }}
        >
          {crumb}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <UserButton />
      </div>

      {drawerOpen && (
        <nav
          id="mobile-app-drawer"
          className="md:hidden absolute left-0 right-0 top-14 flex flex-col border-b"
          style={{
            background: "var(--color-surface-raised)",
            borderColor: "var(--color-border-subtle)",
          }}
        >
          {NAV.map((item) => {
            const active =
              item.href === "/app"
                ? pathname === "/app"
                : pathname === item.href ||
                  pathname.startsWith(`${item.prefix ?? item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setDrawerOpen(false)}
                aria-current={active ? "page" : undefined}
                className="flex min-h-[44px] items-center border-b px-6 text-sm"
                style={{
                  color: active
                    ? "var(--color-brand-accent)"
                    : "var(--color-text-primary)",
                  borderBottomColor: "var(--color-border-subtle)",
                }}
              >
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/settings/billing"
            onClick={() => setDrawerOpen(false)}
            className="flex min-h-[44px] items-center px-6 text-sm font-medium"
            style={{ color: "var(--color-brand-accent)" }}
          >
            Billing
          </Link>
        </nav>
      )}
    </header>
  );
}

/*
  Derive a short breadcrumb from the current path. Examples:
    /app                  → "Upload"
    /evidence             → "Evidence"
    /insights             → "Insights"
    /build                → "Build"
    /spec/abc-123         → "Specs / abc-123"
    /settings/integrations → "Settings / Integrations"
    /settings/billing      → "Settings / Billing"

  Kept inside this file because there's no other consumer. Pure helper.
*/
export function breadcrumbFor(pathname: string): string {
  if (pathname === "/app") return "Upload";
  if (pathname === "/evidence") return "Evidence";
  if (pathname === "/insights") return "Insights";
  if (pathname === "/build") return "Build";
  if (pathname.startsWith("/spec/")) {
    const id = pathname.slice("/spec/".length);
    return `Specs / ${id}`;
  }
  if (pathname.startsWith("/settings/")) {
    const tail = pathname.slice("/settings/".length);
    const cap = tail.charAt(0).toUpperCase() + tail.slice(1);
    return `Settings / ${cap === "Context" ? "Product context" : cap}`;
  }
  return "Rogation";
}
