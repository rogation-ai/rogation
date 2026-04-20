# Changelog

All notable changes to Rogation are recorded here. Format loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are 4-digit `MAJOR.MINOR.PATCH.MICRO`.

---

## [0.1.0.0] - 2026-04-20

First real release. Takes Rogation from empty repo to a working v1 PM-synthesis app: paste evidence, watch clusters form, pick an opportunity, stream a spec, refine it over chat, push it to Linear as a real issue.

### Added

- **Evidence ingestion.** Paste or upload `.txt / .md` today; the 2 MB / file + 10 MB / batch + 20-file limits live in `lib/evidence/ingest.ts`. Content-hash dedup (`sha256` of normalized text) means re-pasting the same transcript doesn't count against the Free-plan cap. PDF / VTT / CSV parsers land in a follow-up.
- **Clustering (synthesis).** `trpc.insights.run` kicks off a full re-cluster. Sonnet 4.6 reads the whole corpus inside a prompt-cache boundary, returns typed cluster IR, and the orchestrator validates every evidence reference before persisting. Every cluster carries the `prompt_hash` of the version that produced it so eval regressions pinpoint the prompt.
- **Opportunities + ranking.** Five LLM-scored primitives (impact, strategy, effort, confidence, frequency-normalised) feed a pure weighted score that the client re-ranks optimistically on slider drag. Sliders persist per-account; the server's `rescoreOpportunities` uses the exact same formula the UI does, no drift possible.
- **Spec editor.** Click "Generate spec" → 10-30 s streaming SSE generate → typed IR → deterministic markdown render → A/B/C/D readiness grade. Refinement chat on the same page does IR-aware edits ("tighten US2's AC", "add an edge case for offline") as streaming turns, each producing a new spec version; old versions are retained.
- **Linear push.** One click on `/spec/[id]` creates a real Linear issue with title + acceptance criteria + full markdown. Plan-gated (Solo+), rate-limited (30/hr/account), token-encrypted at rest (AES-256-GCM, HMAC-signed OAuth state with a 10-minute TTL).
- **Billing (Stripe).** Lazy customer creation on first upgrade. Checkout Session + Customer Portal surfaces. Signature-verified webhook mirrors subscription state back into the DB so Stripe is the source of truth for `account.plan`.
- **Feedback thumbs.** Rate clusters, opportunities, specs. Each vote captures the target's `prompt_hash` server-side so `SELECT prompt_hash, COUNT(*) FILTER (WHERE rating='down')` surfaces prompt regressions in one query.
- **Plan limits + token budget.** `PLAN_LIMITS` in `lib/plans.ts` is the source of truth for caps (evidence/insights/opportunities/specs/integrations). `ctx.assertLimit(resource)` throws `FORBIDDEN` on cap hit so the UI renders the paywall. Monthly token budget is a single-row read on every LLM call via `llm_usage`.
- **Rate limiting.** Upstash sliding window across 5 surfaces (share-link IP, spec-chat per-account, checkout-create, webhook IP, linear-push per-account). Fails open when Upstash isn't configured so dev + CI never block.
- **Observability triangle.** Sentry (errors) across server + edge + browser with a structured noise filter. PostHog (funnel: signup → first upload → first insight → first spec export). Langfuse (LLM traces with user + account attribution on every call).
- **Shared UI primitives (12/15 from DESIGN.md §6).** `PlanMeter`, `SeverityPill`, `ConfidenceBadge`, `EmptyState`, `LoadingSkeleton`, `NumberedStepper`, `StaleBanner`, `ReadinessGrade`, `StreamingCursor`, `FeedbackThumbs`, `CitationChip`, `FrequencyBar`. Stories live next to each component; Storybook 10 is the source of truth.
- **Tenant guard, three layers.** ESLint-rule allowlist on `@/db/client`, transaction-scoped `app.current_account_id` session var, Postgres RLS policies with `FOR ALL` + `WITH CHECK` on every account-scoped table.
- **Auth.** Clerk middleware on every non-static route. Lazy account provisioning in `createContext` is now the canonical path; the Clerk webhook stays as eventually-consistent defense-in-depth. Two-tab signup race is handled cleanly — one tab creates, the other dedups, neither sees a 500.
- **Sample-data seeder.** `trpc.evidence.seedSample` ingests 15 curated pieces that cluster into 5 distinct pain points. Idempotent via stable `sample:<slug>` source refs. One-click populated editor.

### Infrastructure

- Next.js 15 App Router + React 19 + TypeScript strict + Tailwind 4 (CSS-first tokens).
- Drizzle ORM + Postgres + pgvector (1536-d, matches OpenAI `text-embedding-3-small`).
- Bun as the package manager. `bun run check` = typecheck + lint + build + test.
- GitHub Actions CI with a pgvector service container so RLS integration tests actually run.
- Vitest 4 for unit + integration. 199 passing today; 25 DB-gated skipped until `TEST_DATABASE_URL` is set.

### Known deferred (P1 / P2 in TODOS.md)

- Coverage gaps at the tRPC-resolver / Route-Handler wrappers (plan gate, rate-limit gate, OAuth callback account-mismatch). Core logic is ★★★ tested; wrappers deferred until we build a tRPC caller harness.
- Split `INTEGRATION_ENCRYPTION_KEY` from a separate `INTEGRATION_STATE_SIGNING_KEY` so credential storage rotation isn't coupled to in-flight OAuth signing.
- Re-enable Clerk bot protection + rotate Anthropic/OpenAI/Clerk dev keys that passed through local `.env.example` history during QA.

### Adversarial review follow-ups (logged for next sprint)

- Add `accountId` filter to the `spec.linear_issue_*` update (consistency with the 4 integration_state updates).
- `AbortSignal.timeout(10_000)` on Linear fetch calls so a hung provider doesn't pin a serverless invocation.
- Validate `setLinearDefaultTeam` input against the live team list rather than trusting the client.
- Map Linear GraphQL `AUTHENTICATION_ERROR` to a 401-equivalent so stale-token users see the reconnect CTA instead of a generic failure.
- Reset `integration_state.config.defaultTeamId` when reconnect lands on a different workspace.
