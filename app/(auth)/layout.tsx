import Link from "next/link";

/*
  Shared shell for the auth screens. Centers the Clerk widget inside the
  marketing surface tokens so it feels like the same product as the landing.
  The Clerk appearance prop on <SignIn /> / <SignUp /> does the fine-grain
  color work; this layout just owns the page frame.
*/
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center px-6 py-16"
      style={{ background: "var(--color-surface-marketing)" }}
    >
      <Link
        href="/"
        className="mb-12 text-lg font-semibold tracking-tight transition hover:opacity-80"
        style={{ color: "var(--color-brand-accent)" }}
      >
        Rogation
      </Link>
      {children}
    </main>
  );
}
