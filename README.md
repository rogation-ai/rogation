# Rogation

Turn 20 interviews into Friday's decision. Self-serve synthesis for Product Managers.

See [docs/designs/rogation-v1.md](docs/designs/rogation-v1.md) for the v1 product design and [DESIGN.md](DESIGN.md) for the design system.

## Getting started

Requires [bun 1.3+](https://bun.sh) and a Postgres 14+ instance with the `vector` extension available (Supabase or Neon work out of the box).

```bash
bun install
cp .env.example .env.local
# edit .env.local — set DATABASE_URL at minimum
bun run db:migrate
bun run dev
```

Then open <http://localhost:3000>.

## Scripts

- `bun run dev` — Next.js dev server
- `bun run build` — production build
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — Next ESLint
- `bun run db:generate` — generate a new migration from schema changes
- `bun run db:migrate` — apply pending migrations to `$DATABASE_URL`
- `bun run db:push` — push schema directly (dev only)
- `bun run db:studio` — Drizzle Studio (web UI for the DB)

## Structure

```text
app/              Next.js App Router (pages, layouts, route handlers)
db/               Drizzle schema, client, migrations
env.ts            Typed env — import `env` from here, never process.env
docs/designs/     Solution designs (v1 plan lives here)
DESIGN.md         Design system (tokens, components, a11y)
TODOS.md          Deferred work ledger
```
