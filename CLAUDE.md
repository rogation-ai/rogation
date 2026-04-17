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
