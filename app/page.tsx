export default function Home() {
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
          <a href="#">Pricing</a>
          <a href="#">Docs</a>
          <a href="#">Log in</a>
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

      <button
        className="mt-8 rounded-md px-5 py-3 text-sm font-medium text-white transition hover:brightness-110"
        style={{ background: "var(--color-brand-accent)" }}
      >
        Start free
      </button>

      <p
        className="mt-24 text-xs uppercase tracking-widest"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Foundations laid. Evidence → Insights → Spec coming wk 1-12.
      </p>
    </main>
  );
}
