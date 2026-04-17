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

## Tenant isolation

Every data row belongs to an account. Three layers enforce this:

1. **ESLint rule (layer 1, this commit).** `no-restricted-imports` blocks direct imports of `@/db/client` outside `db/`, `server/trpc.ts`, `app/api/webhooks/**`, and `scripts/**`. Feature code reaches the DB only via `ctx.db` in a tRPC procedure — where `ctx.accountId` is available and expected in every `.where()`.
2. **scoped(db, accountId) proxy (layer 2, follow-up commit).** Generic per-table helpers that pre-apply `accountId` to every query. Eliminates the "just remember to add the WHERE" class of bug.
3. **Postgres RLS (layer 3, follow-up commit).** Belt-and-suspenders at the database. Even a compromised app cannot read across accounts.
