import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

/*
  Signed-in app shell. All feature screens (Evidence library, Insights,
  What to build, Spec editor, Outcomes) live under this layout. Per
  DESIGN.md responsive posture, write actions happen at desktop only;
  mobile gets read-only browse.

  Top-bar nav is flat for v1 — a sidebar lands when more than ~5
  features exist + the feature graph has depth. The current four
  screens all sit at the top level.
*/

const NAV = [
  { href: "/app", label: "Upload" },
  { href: "/insights", label: "Insights" },
  { href: "/build", label: "What to build" },
];

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-h-dvh"
      style={{ background: "var(--color-surface-app)" }}
    >
      <header
        className="flex items-center justify-between border-b px-6 py-4"
        style={{ borderColor: "var(--color-border-subtle)" }}
      >
        <div className="flex items-center gap-8">
          <Link
            href="/app"
            className="text-lg font-semibold tracking-tight"
            style={{ color: "var(--color-brand-accent)" }}
          >
            Rogation
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="hover:opacity-80"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <UserButton />
      </header>
      <div className="mx-auto max-w-6xl px-6 py-10">{children}</div>
    </div>
  );
}
