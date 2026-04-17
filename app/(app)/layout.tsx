import { UserButton } from "@clerk/nextjs";

/*
  Signed-in app shell. All feature screens (Evidence library, Insights,
  What to build, Spec editor, Outcomes) live under this layout. Per
  DESIGN.md responsive posture, write actions happen at desktop only;
  mobile gets read-only browse.

  Sidebar + feature routes land as those features come online. For now
  just a minimal top bar with the user menu.
*/
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
        <a
          href="/app"
          className="text-lg font-semibold tracking-tight"
          style={{ color: "var(--color-brand-accent)" }}
        >
          Rogation
        </a>
        <UserButton />
      </header>
      <div className="mx-auto max-w-6xl px-6 py-10">{children}</div>
    </div>
  );
}
