# gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn.

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

## Stack

- Web: Next.js 15 App Router + React 19 + TypeScript strict
- Styling: Tailwind 4 (CSS-first). All colors go through CSS variables defined in `app/globals.css` (source of truth: `DESIGN.md`). Never hardcoded hex in components.
- Package manager: bun. Use `bun install`, `bun add`, `bun run <script>`. Do not mix with npm/pnpm.
- DB: Postgres + pgvector. ORM: Drizzle. Schema is `db/schema.ts`, migrations in `db/migrations/`.
- Deploy: Vercel (web + API) + Neon or Supabase (DB) + Inngest Cloud (jobs).

## Database

- Schema lives in `db/schema.ts`. Every table is account-scoped via `account_id`. Tenant isolation is enforced by the `scoped(db)` helper in the tRPC middleware (not yet wired; see eng review decision CQ-1).
- Migrations live in `db/migrations/`. Generate with `bun run db:generate`. Apply with `bun run db:migrate`. Never edit a committed migration — add a new one.
- Fresh Postgres requires the `vector` extension (pgvector) and `pgcrypto`. The initial migration enables both via `CREATE EXTENSION IF NOT EXISTS`.
- Every LLM-generated entity (insight_cluster, opportunity, spec, spec_refinement, entity_feedback) has a `prompt_hash` column so an eval regression can pinpoint the prompt version that produced it.
- Compound indexes on `(account_id, created_at DESC)` for every high-traffic list. Evidence ingestion idempotency via `UNIQUE (account_id, source_type, source_ref)`.

## Environment

All env reads go through `env.ts` (typed via `@t3-oss/env-nextjs` + zod). Never read `process.env` directly outside that file. Missing required env vars fail at boot, not at first request.

## Design

`DESIGN.md` is the source of truth for every design decision: typography, color, spacing, radius, motion, component inventory, state matrix, responsive posture (mobile-read / desktop-write), WCAG 2.2 AA baseline. When writing UI, read DESIGN.md first; tokens must come from the CSS variables in `app/globals.css`.

## Auth + API

- Auth: Clerk. `middleware.ts` at repo root runs Clerk on every non-static request. Public routes: `/`, `/pricing`, `/docs/*`, `/s/*` (share links), `/api/webhooks/*`, `/sign-in*`, `/sign-up*`. Everything else requires a session.
- Clerk webhook: `app/api/webhooks/clerk/route.ts` handles `user.created` by creating an `account` + `user` row in one transaction. Idempotent on redelivery (de-duped via `clerkUserId` unique index). Stripe customer creation is lazy on first upgrade, not here.
- API layer: tRPC on Next.js App Router at `app/api/trpc/[trpc]/route.ts`.
  - Context: `server/trpc.ts` — pulls the Clerk session, resolves `{ userId, accountId }` from our DB in one query, exposes `ctx.db`.
  - `publicProcedure`: no auth, used for landing page and share link reads.
  - `authedProcedure`: requires a valid Clerk session AND a resolved DB user. Narrowed `ctx.userId` / `ctx.accountId` are guaranteed non-null.
  - Root router: `server/root.ts`. Feature routers under `server/routers/`.
- Client: `lib/trpc.ts` exports typed React hooks. `app/providers.tsx` wires `<Providers>` (TanStack Query + tRPC) inside `<ClerkProvider>` in the root layout.

## Testing

- Framework: Vitest 4 (unit + integration). Playwright for E2E and eval infra land in later commits.
- Command: `bun run test` (CI single run), `bun run test:watch` (dev), `bun run test:ui`.
- All-in-one local gate: `bun run check` runs typecheck + lint + build + test. Same gate CI runs.
- Integration tests that need Postgres gate on `TEST_DATABASE_URL`. Missing → test is skipped with a message. Never point it at a DB with real data — the harness creates + drops schemas.
- See [TESTING.md](TESTING.md) for layers, conventions, and local setup (docker pgvector).

## CI

GitHub Actions at `.github/workflows/ci.yml`. Every push to `main` and every PR runs:

1. `bun install --frozen-lockfile`
2. `bun run typecheck` (tsc --noEmit)
3. `bun run lint` (next lint → eslint)
4. `bun run build` (next build)
5. `bun run test` (vitest run, with a pgvector service container so `TEST_DATABASE_URL` is set and tenant-iso tests actually execute)

`concurrency: cancel-in-progress: true` drops stale runs when a newer commit arrives on the same ref. Failing any step fails the PR — no required-check bypass.

Test expectations for every new feature commit:

- 100% coverage is the goal — tests make vibe coding safe.
- Write the unit test alongside each new function.
- Write a regression test as part of every bug fix.
- When adding a conditional (if/else/switch), write tests for BOTH branches.
- When adding an error handler, write a test that triggers the error.
- Never commit code that makes existing tests fail.

## Tenant isolation

Every data row belongs to an account. Three layers enforce this:

1. **ESLint rule (layer 1).** `no-restricted-imports` blocks direct imports of `@/db/client` outside `db/`, `server/trpc.ts`, `app/api/webhooks/**`, and `scripts/**`. Feature code reaches the DB only via `ctx.db` in a tRPC procedure.
2. **Transaction-scoped session variable (layer 2).** `authedProcedure` wraps every resolver in a Postgres transaction and calls `set_config('app.current_account_id', <accountId>, true)` via `bindAccountToTx()` in `db/scoped.ts`. Inside the resolver, `ctx.db` is the transaction handle — every query is filtered by RLS policies.
3. **Postgres RLS (layer 3).** Migration `0001_rls_policies.sql` enables RLS on every account-scoped table with a `FOR ALL` policy that reads `app.current_account_id()`. Even if the app layer forgets a `.where()`, Postgres returns only the caller's rows. WITH CHECK clauses reject cross-account writes.

**Exceptions (bypass RLS intentionally):**

- Migrations run as the table owner.
- The Clerk webhook runs before an auth session exists; it imports `db` directly (allowlisted in the ESLint rule) and writes without the session variable set. This is safe because the webhook creates new rows rather than reading other tenants' data.
- `createContext` in `server/trpc.ts` reads `users.clerkUserId -> accountId` outside the transaction, because the account hasn't been resolved yet. This read is bounded to the one row keyed by the Clerk user id.

**Adding a new account-scoped table?** Every new table with an `account_id` column needs a matching `CREATE POLICY` block in a new migration. There is no inheritance — Postgres RLS is per-table. Copy the pattern from `0001_rls_policies.sql`.
