import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function Home() {
  /*
    If the visitor already has a session, skip the marketing page and
    take them to the signed-in shell. Server-side auth() runs inside the
    Clerk middleware, so we have a trusted session here.
  */
  const { userId } = await auth();
  if (userId) redirect("/app");

  return (
    <main className="mx-auto max-w-5xl px-6 py-20">
      <header className="flex items-center justify-between pb-24">
        <span
          className="font-semibold tracking-tight"
          style={{ color: "var(--color-brand-accent)" }}
        >
          Rogation
        </span>
        <nav
          className="flex gap-8 text-sm"
          style={{ color: "var(--color-text-secondary)" }}
        >
          <a href="#">Product</a>
          <Link href="/pricing">Pricing</Link>
          <a href="#">Docs</a>
          <Link
            href="/sign-in"
            className="transition hover:text-[var(--color-text-primary)]"
          >
            Log in
          </Link>
        </nav>
      </header>

      <h1
        className="text-6xl leading-[1.05] tracking-tight"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Turn 20 interviews into
        <br />
        Friday&apos;s decision.
      </h1>

      <p
        className="mt-6 max-w-xl text-lg"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Skip the mess of Spark or Productboard. Build feature specs from
        evidence, fast.
      </p>

      <Link
        href="/sign-up"
        className="mt-8 inline-block rounded-md px-5 py-3 text-sm font-medium text-white transition hover:brightness-110"
        style={{ background: "var(--color-brand-accent)" }}
      >
        Start free
      </Link>

      <p
        className="mt-24 text-xs uppercase tracking-widest"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Foundations laid. Evidence → Insights → Spec coming wk 1-12.
      </p>
    </main>
  );
}
