# Rogation

Turn 20 interviews into Friday's decision. Self-serve synthesis for Product Managers.

Paste transcripts, support tickets, or survey responses. Rogation clusters them into pain points, ranks opportunities against your weights, streams a spec in 30 seconds, lets you refine it over chat, then pushes it to Linear as a real issue. The whole loop — evidence in, ticket out — happens without leaving the browser.

- See [CHANGELOG.md](CHANGELOG.md) for what shipped in v0.1.0.0 (first release).
- See [docs/designs/rogation-v1.md](docs/designs/rogation-v1.md) for the v1 product design.
- See [DESIGN.md](DESIGN.md) for the design system (tokens, components, a11y baseline).
- See [TESTING.md](TESTING.md) for the test layers, local Postgres setup, and coverage gates.
- See [CLAUDE.md](CLAUDE.md) for the full architecture reference and project conventions.

## What's in v0.1.0.0

- **Evidence ingestion.** Paste text or upload `.txt / .md / .log / .csv / .json / .yaml`. Content-hash dedup, per-plan caps, 20 files / 10 MB per batch.
- **Clustering.** Two paths: full (cold start, Sonnet 4.6) and incremental (KNN-triaged, Haiku 4.5). The orchestrator picks per design §7. Async dispatch via an Inngest worker — the UI polls at 1.5s while a re-cluster runs and resumes across page reloads via `latestRun`. Every cluster carries the `prompt_hash` of the prompt that produced it, so eval regressions pinpoint the offending version.
- **Opportunities.** Five LLM-scored primitives feed a pure weighted score that re-ranks optimistically on slider drag; the server uses the exact same formula. When upstream clusters get reshaped by re-clustering, opportunities and specs flip to `stale=true` and surface a "Re-rank to refresh" banner — no more silently looking at outputs derived from evidence you've since deleted.
- **Spec editor.** Streaming SSE generation, A/B/C/D readiness grade, IR-aware refinement chat, every turn produces a new persisted spec version.
- **Linear push.** One click creates a real Linear issue with acceptance criteria + full markdown. OAuth, AES-256-GCM token storage, HMAC-signed state.
- **Billing.** Stripe Checkout + Customer Portal. Webhook-mirrored subscription state. Plan limits (`ctx.assertLimit`) enforced server-side.
- **Observability.** Sentry (errors, 3 runtimes, noise filter), PostHog (activation funnel), Langfuse (LLM traces with user attribution).
- **Tenant isolation.** Three layers: ESLint allowlist on `@/db/client`, transaction-scoped `app.current_account_id`, Postgres RLS with `FOR ALL` + `WITH CHECK`.

## Getting started

Requires [bun 1.3+](https://bun.sh) and Postgres 14+ with the `vector` extension (Supabase, Neon, or a local `pgvector/pgvector` container all work).

```bash
bun install
cp .env.example .env.local
# edit .env.local — see "Environment" below
bun run db:migrate
bun run dev
```

Then open <http://localhost:3000>.

## Environment

Required at boot (the app fails fast via `env.ts` when any of these are missing):

- `DATABASE_URL` — Postgres connection string with `pgvector` + `pgcrypto` available.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` — Clerk auth.
- `CLERK_WEBHOOK_SIGNING_SECRET` — signature verification on `/api/webhooks/clerk`.
- `ANTHROPIC_API_KEY` — Sonnet 4.6 (synthesis) + Haiku 4.5 (generation / refinement / scoring).
- `OPENAI_API_KEY` — `text-embedding-3-small` for evidence embeddings.
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SIGNING_SECRET` + `STRIPE_PRICE_ID_SOLO` + `STRIPE_PRICE_ID_PRO`.
- `NEXT_PUBLIC_APP_URL` — used for OAuth callbacks and Stripe redirects.

Optional (fail open / no-op when unset — dev and CI run without them):

- `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` — error tracking.
- `NEXT_PUBLIC_POSTHOG_KEY` + `POSTHOG_API_KEY` + `NEXT_PUBLIC_POSTHOG_HOST` — product analytics.
- `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_HOST` — LLM trace capture.
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — rate limiting (fails open in dev).
- `LINEAR_CLIENT_ID` + `LINEAR_CLIENT_SECRET` + `INTEGRATION_ENCRYPTION_KEY` — Linear OAuth + token storage.

Local Stripe webhook testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe` and paste the printed signing secret into `STRIPE_WEBHOOK_SIGNING_SECRET`.

See [.env.example](.env.example) for the full annotated list.

## Scripts

- `bun run dev` — Next.js dev server.
- `bun run build` — production build.
- `bun run check` — typecheck + lint + build + test (the local gate; same steps CI runs).
- `bun run typecheck` / `bun run lint` / `bun run test` — run each gate in isolation.
- `bun run test:watch` / `bun run test:ui` — Vitest in dev modes.
- `bun run storybook` — Storybook on port 6006 for the shared UI primitives (`components/ui/`).
- `bun run db:generate` — generate a new migration from schema changes.
- `bun run db:migrate` — apply pending migrations to `$DATABASE_URL`.
- `bun run db:push` — push schema directly (dev only).
- `bun run db:studio` — Drizzle Studio (web UI).

## Structure

```text
app/              Next.js App Router (pages, layouts, route handlers, webhooks)
components/ui/    Shared UI primitives (DESIGN.md §6) + colocated stories
db/               Drizzle schema, migrations, RLS policies, scoped client
lib/              Domain logic — evidence, LLM router + prompts, spec IR, billing
server/           tRPC context + routers (auth'd procedures, RLS binding)
test/             Vitest unit + integration suites (DB-gated via TEST_DATABASE_URL)
env.ts            Typed env — import `env` from here, never process.env
docs/designs/     Solution designs (v1 plan lives here)
DESIGN.md         Design system (tokens, components, a11y)
CLAUDE.md         Project conventions, architecture, tenant-isolation rules
TESTING.md        Test layers and local setup
CHANGELOG.md      What shipped, per-version
TODOS.md          Deferred work ledger
```
