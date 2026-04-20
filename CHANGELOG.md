# Changelog

All notable changes to Rogation are recorded here. Format loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are 4-digit `MAJOR.MINOR.PATCH.MICRO`.

---

## [0.3.0.0] - 2026-04-20

Pricing page. First real path from "try it free" to "pay us money" without a support-channel hand-off.

### Added

- **Public `/pricing` page.** Three tier cards (Free / Solo / Pro) with feature lists + live CTAs. Signed-out visitors land in sign-up (with `?upgrade=<tier>` carried through). Signed-in free users get an Upgrade button that kicks off `trpc.billing.createCheckout` and redirects to Stripe Checkout. Existing paid subscribers get a Manage billing button that opens the Stripe Customer Portal. Current plan is marked so PMs don't buy a second subscription by accident. Wired the "Pricing" link on the landing page (was a dead `#` anchor).

## [0.2.0.0] - 2026-04-20

P1 hardening sprint. Finishes the shared UI inventory, tightens every rough edge on the Linear integration we flagged during v0.1 adversarial review, and fixes the "version: unknown" field the health probe was returning from Vercel.

### Added

- **`SourceIcon`, `SegmentTag`, `IntegrationLogoButton`.** The final three shared UI primitives from DESIGN.md §6 (15/15 shipped). `SourceIcon` renders a monochrome 16px glyph for each evidence source (transcript, PDF, CSV, pasted ticket, Zendesk, PostHog, Canny). `SegmentTag` is the small outlined pill users will tap to filter evidence and clusters by segment. `IntegrationLogoButton` is the flat outlined tile for onboarding + `/settings/integrations` (connected, default, disabled states). Stories + pure-helper unit tests alongside.

### Changed

- **Linear push is account-safe end to end.** The spec-row update that stamps `linear_issue_*` now filters by `accountId` (matches the 4 `integration_state` updates). A rogue spec id across tenants can no longer land an issue on the wrong spec row.
- **Linear client times out at 10s.** Every GraphQL request now carries `AbortSignal.timeout(10_000)`. A hung Linear provider can't pin a serverless invocation anymore — it surfaces as a 504-class `LinearApiError` the caller already handles.
- **Revoked-token detection.** Linear returns HTTP 200 with a GraphQL error envelope on a revoked token. The client now parses `extensions.type === "AUTHENTICATION_ERROR"` and throws status 401, so the existing reconnect path in the integrations router fires instead of showing a generic failure.
- **`setLinearDefaultTeam` validates against the live workspace.** A client posting a stale or cross-workspace `teamId` now gets a 400 with "That team no longer exists in your Linear workspace." The mutation also dropped `teamName` / `teamKey` from its input — they're looked up server-side from the live team list, so the client never controls display strings.
- **Reconnect to a different workspace resets the default team.** `integration_state.config.defaultTeamId` / `defaultTeamName` / `defaultTeamKey` carry over only when the reconnect lands on the same workspace id. Switching workspaces clears them, preventing a "why is my next push 404-ing on a team I don't remember picking?" trap.

### Fixed

- **`GET /api/health` now returns the real version.** `process.env.npm_package_version` isn't populated by Vercel's serverless runtime, so the probe was returning `version: "unknown"`. Reads `package.json` at build time instead, so the canary check in `/land-and-deploy` can now assert the deployed version.

## [0.1.0.1] - 2026-04-20

Deploy plumbing for Vercel. Adds a public health probe so uptime monitors and the `/land-and-deploy` workflow have something concrete to check after a merge.

### Added

- **`GET /api/health`.** Returns `{ok, db, version, commit, latencyMs}` — 200 when the app responds AND Postgres answers `SELECT 1`, 503 when the DB is unreachable. No auth, no account context. Paired with `VERCEL_GIT_COMMIT_SHA` so canary checks can assert the live commit matches the just-merged SHA.
- **Deploy Configuration section in CLAUDE.md.** Captures platform (Vercel), health contract, merge method, and a 6-step checklist for first-time Vercel setup (link project, set env vars, verify probe). `/land-and-deploy` reads this automatically on future deploys.

### Changed

- **ESLint trust allowlist.** `app/api/health/**` joins `db/**`, `server/trpc.ts`, `app/api/webhooks/**`, and `lib/account/**` as paths allowed to import `@/db/client` directly. The health probe is intentionally account-agnostic.
- **`.gitignore`.** Hardened with `.env*.local` (added by `vercel link`) so per-environment local env files can never be committed.

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
