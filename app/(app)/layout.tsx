import { AppSidebar } from "@/components/app/AppSidebar";
import { AppTopBar } from "@/components/app/AppTopBar";

/*
  Signed-in app shell. Sidebar (240px, desktop only) + top bar (56px)
  + canvas. DESIGN.md §5. Mobile collapses the sidebar into a drawer
  owned by the top bar.

  Both shell pieces are client components (active-nav, drawer state,
  trpc.account.me query) — this layout stays a server component and
  composes them.
*/
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex min-h-dvh"
      style={{ background: "var(--color-surface-app)" }}
    >
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopBar />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
