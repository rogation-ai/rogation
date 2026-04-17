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

## Rate limiting

Upstash Redis + sliding-window algorithm via `@upstash/ratelimit`. One module, one preset table, one check helper.

- **Presets.** `lib/rate-limit.ts > RATE_LIMIT_PRESETS` is the audit trail. Surfaces: `share-link` (by IP, for `/s/:token` enumeration protection), `spec-chat` (by accountId, for chat refinement abuse), `checkout-create` (by accountId, 10/hr — Stripe API costs real money when spammed), `webhook` (per-IP defense in depth on signed endpoints).
- **Fail open.** `checkLimit(preset, identifier)` returns `{ success: true }` when Upstash isn't configured. Dev + CI run without Redis. Production should set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. Missing keys in prod are silent — the tradeoff is choose one of: (a) keep it optional for easy dev, or (b) make it required later when we can't boot without it.
- **Usage pattern (tRPC resolver).**
  - Call `await checkLimit(preset, ctx.accountId)` at the top.
  - On `!result.success`, throw `TRPCError.TOO_MANY_REQUESTS` with `cause: { type: "rate_limited", limit, resetAt }` so the UI can show "try again in X minutes."
- **Applied today.** `billing.createCheckout` (10 / hour / account) — throttles Stripe-API-costing operations. `/s/*` + `spec-chat` limiters activate when those surfaces ship (infrastructure is ready; middleware hooks are a one-liner).
- **Tuning.** Watch Upstash's analytics dashboard; if legitimate traffic hits the wall, bump the preset. The preset table is the one place to edit — every caller picks up the new limit automatically.

## Billing (Stripe)

Stripe is the source of truth for subscription state. `account.plan`, `account.stripe_customer_id`, `account.stripe_subscription_id`, and `account.subscription_status` all mirror Stripe — never the other way around. Changes flow from Stripe → webhook → DB.

- **Lazy customer creation.** New accounts have `stripe_customer_id = NULL` until first checkout. `ensureStripeCustomer()` in `lib/stripe/checkout.ts` creates + persists on demand. Keeps the Stripe dashboard clean + reduces the Clerk webhook's blast radius (eng review decision #3).
- **Entrypoints.** `trpc.billing.createCheckout({ tier })` returns a Checkout Session URL for the client to redirect to. `trpc.billing.createPortal()` returns a Customer Portal URL for existing subscribers.
- **Price mapping.** `lib/stripe/prices.ts` owns the tier ↔ Stripe price ID mapping, bidirectionally. Solo + Pro prices come from env so test vs live configurations can differ. Free has no price.
- **Webhook.** `app/api/webhooks/stripe/route.ts` verifies signatures via `stripe.webhooks.constructEvent`. Handlers:
  - `customer.subscription.created` / `.updated` → set `plan` + `subscription_status` + `stripe_subscription_id` + `trial_ends_at`.
  - `customer.subscription.deleted` → revert to `free`, keep `stripe_customer_id` so re-subscription doesn't spawn a second customer.
  - `invoice.payment_failed` → set status `past_due`; Stripe's dunning + eventual `subscription.deleted` handle the rest.
  - Everything else is acknowledged with `{ ok, ignored }` so Stripe doesn't retry events we don't process.
- **Idempotency.** Every handler writes a SET (not accumulating), so redelivery converges on the correct state. No events table needed yet.
- **RLS bypass.** The Stripe webhook runs with no session variable bound, so its updates hit every account regardless of tenant — that's intentional: signed-webhook is the trust boundary, not RLS. Same pattern as the Clerk webhook.

Local testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe` gives a signing secret for `STRIPE_WEBHOOK_SIGNING_SECRET` in `.env.local`.

## Plan limits

Every mutation that creates a resource or touches a gated feature goes through `lib/plans.ts`. Never hardcode a cap or a feature gate inline.

- **Source of truth.** `PLAN_LIMITS` in `lib/plans.ts` — one const per tier (`free` / `solo` / `pro`) with resource caps, monthly token budget, export targets, watermark flags, outcome tracking flag.
- **Countable resources.** `evidence`, `insights`, `opportunities`, `specs`, `integrations`. Each maps to a table row count. Adding a new countable resource means extending `CountableResource`, `RESOURCE_TABLE`, and every `PlanLimits`.
- **Enforcement.** Inside any `authedProcedure` resolver, call `await ctx.assertLimit('evidence')` before creating the row. It throws `TRPCError.FORBIDDEN` with a structured `plan_limit_reached` payload the UI renders as a paywall modal (design review Pass 7). On success returns `{ current, max }` so you can drive the inline `PlanMeter` without a second count.
- **Feature gates.** `canExport(plan, 'linear')`, `exportHasWatermark(plan)`, `shareLinksHaveWatermark(plan)`, `hasOutcomeTracking(plan)`. All O(1) table lookups.
- **Token budget.** `PLAN_LIMITS[tier].monthlyTokenBudget` is the 100% hard cap. `tokenBudgetSoftCap(tier)` returns the 80% warn line. Accumulation table (`llm_usage`) + `onUsage` hook wiring land in the observability commit.

Pattern at a call site:

```ts
export const evidenceRouter = router({
  upload: authedProcedure.mutation(async ({ ctx, input }) => {
    await ctx.assertLimit("evidence"); // throws FORBIDDEN at cap
    await ctx.db.insert(evidence).values({ ... });
  }),
});
```

## Analytics (PostHog)

Product funnel capture for the activation pipeline from plan §7: `signup_completed` → `first_upload_started` → `first_insight_viewed` → `first_spec_exported`.

- **Typed event catalog.** `lib/analytics/events.ts` has one `EVENTS` const + an `EventProperties` type map. Client + server `capture()` both enforce the payload shape at compile time. Never write raw event strings inline — typos become silent data gaps in PostHog dashboards.
- **Client-side.** `lib/analytics/posthog-client.ts` init + identify + capture, wired through `app/providers.tsx > AnalyticsBridge`. `identify()` fires when Clerk resolves a user, `reset()` fires on sign-out. Autocapture is OFF; session replay is OFF (both billable — flip on per-investigation).
- **Server-side.** `lib/analytics/posthog-server.ts` captures from webhooks + tRPC. The Clerk webhook emits `signup_completed` and calls `flushServer()` before responding so Vercel's worker teardown doesn't lose the event.
- **Env.** `NEXT_PUBLIC_POSTHOG_KEY` (browser), `POSTHOG_API_KEY` (server), `NEXT_PUBLIC_POSTHOG_HOST` (defaults to `https://us.posthog.com`). All optional; capture is a no-op when keys are missing so dev works without a project.
- **PII.** Never pass evidence content, prompt text, or credentials as event properties. Only Clerk userId + plan tier + enum-like descriptors.

## LLM trace capture (Langfuse)

Every LLM call through the router records a Langfuse trace when keys are configured. Paired with Sentry (errors) + PostHog (user behavior), this closes the observability triangle.

- **Path.** `complete(prompt, input, { onUsage: ctx.chargeLLM, onTrace: ctx.traceLLM })`. `ctx.traceLLM` is bound to `{accountId, userId}` by the authed tRPC middleware, so every trace carries user attribution.
- **Trace shape.** prompt name + hash, model, input, output, latency, error if any. Tags: `[promptName, model]` for fast filtering. `metadata.accountId` + `metadata.promptHash` for the eval regression workflow.
- **Env.** `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` + optional `LANGFUSE_HOST` (defaults to `https://cloud.langfuse.com`). When either key is missing, `traceLLM()` is a no-op. Production deploy sets all three; dev runs without.
- **Best-effort.** Tracing errors are caught + logged inside `traceLLM()`, never propagate to the caller. A dropped trace is acceptable; a broken user request because of tracing is not.
- **Batching.** Module-level singleton client, `flushAt: 5`, `flushInterval: 5s`. Call `flushLangfuse()` at the end of webhooks + serverless handlers so the process doesn't die with events queued.

## Sentry (error tracking)

Sentry is wired across all three Next.js runtimes (server, edge, browser) with one noise filter to keep the dashboard signal, not alert spam.

- **Config files.** `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation-client.ts`. The root `instrumentation.ts` dispatches to server vs edge at startup. Each init gates on its DSN var — no DSN, no-op.
- **DSN.** `SENTRY_DSN` (server + edge) and `NEXT_PUBLIC_SENTRY_DSN` (browser) are both **optional**. Dev + CI boot without them. Production deploy sets them both (same value).
- **Noise filter.** `lib/sentry-filter.ts` is the single source of truth for "is this a real bug?" — used as Sentry's `beforeSend` on every runtime. Dropped: `TRPCError` with code `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `BAD_REQUEST` / `TOO_MANY_REQUESTS` / `CONFLICT` / `PAYLOAD_TOO_LARGE` / `TIMEOUT`. `ZodError`. Kept: everything else — unexpected throws, `INTERNAL_SERVER_ERROR`, native errors.
- **PII off by default.** `sendDefaultPii: false`. If a real debug session needs user IP or Clerk ID, flip it per-event, not globally.
- **Sampling.** Server + edge at 0.1, browser at 0.05. Replays off (each replay is a billable event — flip on per-investigation).
- **Source maps.** Uploaded at build time when `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` are set (production CI only). Without them the build emits a warning + continues — stacktraces in Sentry will be minified until you wire the token.
- **Global error boundary.** `app/global-error.tsx` catches render errors that escape nested `error.tsx` boundaries. Required by Sentry in App Router. Renders standalone `<html>` because it replaces the root layout.
- **Tunnel route.** `/monitoring` routes Sentry requests through Next.js to bypass ad-blockers. Nothing else uses that path.

Adding a new expected-error pattern: add the TRPC code to `EXPECTED_TRPC_CODES` in `lib/sentry-filter.ts` and add a unit case to `test/sentry-filter.test.ts`. Don't copy-paste filter logic across call sites.

## Token budget

The LLM router's `onUsage` hook plugs into real enforcement via `lib/llm/usage.ts` and the `llm_usage` table.

- **Schema.** One row per `(account_id, month)`, PK on that pair. Columns accumulate `tokens_in`, `tokens_out`, `cache_read_tokens`, `cache_create_tokens`, `calls`. Month key is UTC `YYYY-MM` text — no timezone games at the DB level.
- **Charge path.** Every authed tRPC resolver has `ctx.chargeLLM(usage)`. Pass it straight to `complete()`: `await complete(prompt, input, { onUsage: ctx.chargeLLM })`. `chargeLLM` calls `chargeAndEnforce()`: UPSERTs the monthly row AND throws `FORBIDDEN` when the call pushed the account over the hard cap. The spend is recorded *before* the throw, so overruns are visible in logs + alerting.
- **Pre-call gate.** Batch LLM jobs (embed 500 evidence rows, re-cluster) should call `ctx.assertBudget()` once up front to fail fast when the account is already over the cap. Avoids burning provider latency on a call that's going to reject.
- **Soft cap (80%).** `tokenBudgetSoftCap(plan)` from `lib/plans.ts` returns the warning threshold. The UI banner reads it off `account.me.budget`. Email warning lands with the Stripe/notifications commit.
- **Monthly rollover.** A new UTC month = a new `(account, month)` row. No cron needed; the UPSERT finds no existing row and inserts. Cross-month isolation is verified in `test/llm-usage.test.ts`.
- **No per-call audit in this table.** One-row-per-month is deliberately O(1) for the read that happens on every LLM call. Per-call audit belongs in the eval-infra (Langfuse/Braintrust, observability commit) and Sentry traces.

## LLM router

Every LLM call goes through `lib/llm/router.ts`. Never import `@anthropic-ai/sdk` or `openai` anywhere else.

- **Task → model mapping.** `synthesis` → Sonnet 4.6 (long-context, deep reasoning). `generation` / `refinement` / `scoring` → Haiku 4.5 (fast + cheap). Swap a tier by editing `TASK_MODELS` in `router.ts`; every call site picks up the new model automatically.
- **Typed prompts.** Every prompt is a `Prompt<Input, Output>` built with `definePrompt()` from `lib/llm/prompts.ts`. Each prompt file exports one prompt. The template's `name + task + system` are sha256-hashed at load, and the hash lands on every row the prompt produces (`insight_cluster.prompt_hash`, `opportunity.prompt_hash`, `spec.prompt_hash`, etc.). Editing a template's system changes the hash automatically — no "forgot to bump the version" bugs.
- **Prompt caching.** Pass `{ cache: true }` to `complete()` and the router adds `cache_control: { type: "ephemeral" }` to the system message + the pre-boundary slice of the user message. Call sites control the boundary via the `cacheBoundary` field their `build()` returns. Expect ~10x cost reduction on re-reads of a stable evidence corpus.
- **Retries.** Transient failures (429 + 5xx + network) retry up to 3 times with jittered exponential backoff (500ms, 1500ms, 4500ms). 4xx other than 429 fail immediately — those are the caller's bug.
- **Budget hook.** `opts.onUsage` is called with `{ promptHash, tokensIn, tokensOut, cacheReadTokens, latencyMs, ... }` AFTER the provider call and BEFORE parsing the output. Throw from the hook to abort the request (plan-limits middleware wires this in the next commit).
- **Trace hook.** `opts.onTrace` is called after success or failure with the full `{input, output, error, latencyMs}` payload. Fire-and-forget — hook errors are caught + logged, never break the caller (Sentry + eval-infra wiring lands in the observability commit).
- **Embeddings.** `embed(text)` uses OpenAI `text-embedding-3-small` (1536-d, matches the `evidence_embedding.vector` column).

Adding a new prompt:

1. Create `lib/llm/prompts/<domain>-<what>.ts` with one `definePrompt()` call.
2. Write the `system` as the stable instruction, the `build()` as input-dependent assembly, and the `parse()` as typed output extraction (throw on schema mismatch).
3. Import it at the call site. Pass the prompt + input to `complete()`.
4. The hash changes on every edit to the template. Running the eval suite against the new hash is the quality gate.

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
