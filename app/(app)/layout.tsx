import { AppHeader } from "@/components/app/AppHeader";

/*
  Signed-in app shell. All feature screens (Evidence library, Insights,
  What to build, Spec editor, Outcomes) live under this layout. Per
  DESIGN.md responsive posture, write actions happen at desktop only;
  mobile gets read-only browse.

  Header is a client component so it can own the mobile drawer state
  and the active-nav indicator. This layout stays server-side.
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
      <AppHeader />
      <div className="mx-auto max-w-6xl px-6 py-10">{children}</div>
    </div>
  );
}
