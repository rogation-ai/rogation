# Testing

100% test coverage is the goal. Tests are how vibe coding stays safe. Without them it's yolo coding; with them it's a superpower.

## Framework

- **Vitest 4** — unit, integration, and smoke tests.
- **Playwright** — will land with the first user-flow E2E (signup → upload → first insight).
- **Eval infra** — LLM quality gates (Braintrust / Langfuse / Helicone pick TBD). Every prompt change runs against the labeled eval set before merge (see `/plan-eng-review` decision #1 in `docs/designs/rogation-v1.md`).

## Running

```bash
bun run test          # CI-style single run
bun run test:watch    # dev mode
bun run test:ui       # Vitest browser UI
```

Integration tests that need Postgres read `TEST_DATABASE_URL` from the environment. Without it they skip with a clear message. Set it in `.env.test.local` — never point at a DB that holds real data.

## Layers

- **Unit** (`test/*.test.ts` with no DB dependency): pure functions, JSON schemas, scoring math, helpers. Runs in `bun run test` with no setup.
- **Integration** (`test/*.test.ts` with `describe.skipIf(!hasTestDb)`): schema-per-test Postgres, applies both migrations, seeds data, teardown drops the schema. Use for anything that needs the DB: RLS, tRPC round-trips, queries.
- **E2E** (`test/e2e/*.spec.ts` via Playwright, not yet wired): full browser user flows.
- **Eval** (`test/evals/*.eval.ts`, not yet wired): LLM output quality. Runs on prompt changes, blocks PR on regression below baseline.

## Conventions

- Test files live in `test/`, not next to source. Keeps source directories clean.
- One file per subject. `tenant-isolation.test.ts`, `evidence-ingest.test.ts`, etc.
- Import `vi.fn()` / `vi.mock()` only for units that have external I/O. Integration tests touch the real DB.
- Never commit code that breaks a passing test. If you change behavior on purpose, update the test in the same commit.
- Write a regression test as part of the fix for every bug you land. No exceptions.

## Test DB setup (local)

```bash
docker run -d \
  --name rogation-test \
  -e POSTGRES_PASSWORD=postgres \
  -p 5433:5432 \
  pgvector/pgvector:pg16

cp .env.test.example .env.test.local
# edit to: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres
bun run test
```

pgvector/pgvector images come with the `vector` extension available. The test harness creates `CREATE EXTENSION IF NOT EXISTS vector` in the fresh schema as part of the migration.

## What every new feature commit adds

- At minimum one unit test for the happy path.
- A regression test for each bug the commit fixes.
- An integration test for anything that touches the DB or tRPC context.
- A prompt-eval case for any LLM output the commit changes.
- Tests covering BOTH branches of every conditional added.
