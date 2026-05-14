"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/settings/context", label: "Product context" },
  { href: "/settings/scopes", label: "Scopes" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/billing", label: "Billing" },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();

  return (
    <div className="flex gap-8 px-6 py-8 max-w-5xl mx-auto">
      <nav className="w-48 shrink-0">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-tertiary)] mb-3">
          Settings
        </h2>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block px-3 py-2 text-sm font-medium rounded-[var(--radius-sm)] transition-colors ${
                    active
                      ? "text-[var(--color-brand-accent)] bg-[var(--color-surface-raised)] border-l-2 border-[var(--color-brand-accent)] pl-[10px]"
                      : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)]"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
