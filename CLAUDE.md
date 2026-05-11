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

Current direction (set 2026-05-11): Industrial / Utilitarian, light-by-default, single sans family (**General Sans** for display + UI + body, **JetBrains Mono Display** for data/IDs/timestamps). Warm red brand-accent (#D04B3F) used sparingly — active nav + primary CTAs + severity-critical dots only. App shell is a persistent 240px left sidebar + 56px top bar (not top nav). No serif, no purple/violet, no Inter/Geist/Space Grotesk, no shadows on default cards, no chat-bubble UI for AI output (refinement turns render in-document). Approved mockup: `~/.gstack/projects/rogation-ai-rogation/designs/redesign-modern-20260511/variant-C.png`.

## Auth + API

- Auth: Clerk. `middleware.ts` at repo root runs Clerk on every non-static request. Public routes: `/`, `/pricing`, `/docs/*`, `/s/*` (share links), `/api/webhooks/*`, `/sign-in*`, `/sign-up*`. Everything else requires a session.
- Account provisioning: `lib/account/provision.ts > provisionAccountForClerkUser()` is the single source of truth. Canonical path is `server/trpc.ts > createContext` — when a request arrives with a Clerk session but no DB row, it calls the helper synchronously before the first page renders. The Clerk webhook (`app/api/webhooks/clerk/route.ts`) stays as idempotent defense-in-depth for OAuth flows that skip the tRPC surface. Webhooks are eventually-consistent and can't reach localhost without a tunnel — owning the critical path in `createContext` eliminates that friction forever. `SIGNUP_COMPLETED` fires exactly once, from whichever path wins the race (checked via `created: true` on the helper's return). Stripe customer creation is lazy on first upgrade, not here.
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

## Shared UI (Storybook)

Shared primitives from DESIGN.md §6 live under `components/ui/` with a `.stories.tsx` next to each. Storybook (v10) is the source of truth for every component variant — never eyeball a pill, a badge, or a meter in the running app alone.

- **Run.** `bun run storybook` (dev, port 6006). `bun run build-storybook` (static export for preview hosting).
- **Config.** `.storybook/main.ts` + `.storybook/preview.tsx`. Preview imports `app/globals.css` so every story renders against real design tokens. Backgrounds addon flips between marketing cream + app white + dark palettes.
- **Addons.** `@storybook/addon-docs` (auto prop tables), `@storybook/addon-a11y` (live axe-core check on every story; enforces DESIGN.md §9 WCAG 2.2 AA baseline).
- **Rule.** Any component referenced by more than one feature commit goes in `components/ui/`. One-off feature components live in `app/(app)/<feature>/components/`.
- **Pure logic colocated.** Threshold math (e.g. `PlanMeter.bandFor(pct)`, `ConfidenceBadge.bandForConfidence(score)`) is exported from the component file and unit-tested in `test/ui-primitives.test.ts`. Visual regression is a follow-up (Storybook's test-runner or Chromatic).

**Shipped primitives (12/15 from DESIGN.md §6):**

- `PlanMeter` — inline "7/10" with colour bands + Upgrade CTA at cap.
- `SeverityPill` — low/medium/high/critical with optional count.
- `ConfidenceBadge` — 0-1 score → Low/Medium/High band.
- `EmptyState` — headline + context + primary/secondary actions.
- `LoadingSkeleton` — line / heading / card / list variants. Never use a spinner on a list.
- `NumberedStepper` — upload → cluster → insight progress strip on /app.
- `StaleBanner` — warn on cluster staleness or thin corpus.
- `ReadinessGrade` — A/B/C/D stoplight on every spec with the 4-check breakdown.
- `StreamingCursor` — blinking caret on streamed LLM output; reduced-motion safe.
- `FeedbackThumbs` — up/down toggle with aria-pressed; parent owns state.
- `CitationChip` — severity dot + truncated cluster title + deep-link to `/insights?cluster=<id>`. Renders `"Cluster unavailable"` fallback when the target got refined away.
- `FrequencyBar` — value/max horizontal bar. `percentFor(value, max)` is the pure helper; unit-tested for div-by-zero + clamp.

Remaining: `SourceIcon`, `SegmentTag`, `IntegrationLogoButton`. Ship alongside the commits that consume them (source icons land with PDF/VTT/CSV parsers; segment tag with segment-filter UX; integration logo with Linear/Notion OAuth).

## Evidence ingestion

First feature pipeline. PMs land on `/app`, see the onboarding wizard (approved mockup: `onboarding-upload-A-v2`), paste transcripts or support tickets, and hit "Add evidence." Each paste:

1. `ctx.assertLimit("evidence")` — Free cap stops at 10. Throws FORBIDDEN with `plan_limit_reached` so the UI can render the paywall.
2. `normalizeEvidenceText()` + `hashEvidenceContent()` — SHA-256 of the normalized text (BOM stripped, CRLF → LF, trailing-whitespace trimmed, exactly one trailing newline). Lib: `lib/evidence/hash.ts`.
3. Dedup: query by `(accountId, contentHash)`; if found, return the existing row with `deduped: true` instead of counting twice.
4. Insert evidence row (RLS-scoped via `ctx.db`).
5. `embed()` from `lib/llm/router.ts` via OpenAI `text-embedding-3-small` (1536-d — matches the `evidence_embedding.vector` column). Stored synchronously. Batch upload + Inngest worker land when file-upload ships.

Router entrypoints (`trpc.evidence.*`):

- `paste({ content, sourceRef?, segment? })` — text-only; 128 KB max.
- `list({ limit, cursor? })` — newest first, RLS-scoped.
- `delete({ id })` — 404 if not yours.
- `count()` — drives the onboarding stepper's current-step state.

**Shared ingest pipeline.** `lib/evidence/ingest.ts > ingestEvidence()` is the single write path for both the paste mutation and the file-upload Route Handler. Contract: assertLimit → normalize + hash → dedup → insert → embed. Caller owns the RLS-bound transaction. Never bypass this helper to write an `evidence` row from elsewhere — otherwise dedup, budget, and embedding stop matching across paths.

**File upload.** `POST /api/evidence/upload` (multipart). Each file flows through `parseTextFile()` (2 MB / file, 10 MB / batch, 20 files max) then `ingestEvidence()`. Per-file results are returned individually so the UI shows a mixed success/dedup/reject list. A Free-plan cap hit stops the batch to stay within limits. Today: `.txt / .md / .log / .csv / .json / .yaml` by extension or `text/*` mime. PDF / VTT / CSV-specific parsers with column awareness land in focused follow-up commits.

**Auth outside tRPC.** `server/auth.ts > withAuthedAccountTx(fn)` is the Route-Handler-facing equivalent of the tRPC authed middleware: resolves the Clerk session → looks up user + account + plan → opens a transaction → binds `app.current_account_id`. Do NOT reuse from feature code — feature code goes through tRPC. This helper exists because multipart uploads can't ride tRPC cleanly.

**Sample-data seeder.** `lib/evidence/sample-seed.ts > seedSampleEvidence(ctx)` ingests a curated 15-piece corpus that clusters into 5 distinct pain points (onboarding confusion, mobile perf, share-link expiry, pricing confusion, CSV export bugs). Wired to the "Use sample data" button on `/app`. Idempotent — the UNIQUE(account, source_type, source_ref) dedup index means re-clicking returns `deduped` counts for everything already present, not duplicate rows. Plan-cap aware: if we hit the Free-plan 10-row cap mid-seed, the loop bails with `capReached: true` so the UI surfaces the upgrade CTA instead of a generic error. Every sample piece has a stable `sample:<slug>` sourceRef so the dedup semantic is permanent across schema migrations. Emits `SAMPLE_DATA_USED` with `{inserted, deduped, capReached}` so funnel analysis can separate "PM brought their own data" vs "PM used samples to evaluate."

**PostHog event:** `FIRST_UPLOAD_STARTED` fires once per session when `evidence.count` crosses zero — funnel step 2 from plan §7.

**What's not in this commit (follow-ups):**

- PDF / VTT / CSV parsers with structural awareness (papaparse, unpdf, custom VTT).
- Integration pull (Zendesk / PostHog / Canny).
- Inngest worker for async embedding at batch scale.
- Sample-data seeder.
- Evidence library screen listing every row.

The onboarding page shows the dropzone + integration buttons + sample-data link as disabled, matching the approved mockup but clearly labelled as "ships in the next commit" so the UI direction is preserved.

## Clustering (synthesis)

Turns the evidence corpus into `insight_cluster` rows — the "pain points" PMs see on the Insights screen. Two paths: full clustering for cold starts, incremental for everything else. The orchestrator picks per design §7; callers don't choose.

- **Prompts.** `lib/llm/prompts/synthesis-cluster.ts` (full) and `lib/llm/prompts/synthesis-incremental.ts` (KNN-triaged incremental). Both wrap evidence in `<evidence id="En"><![CDATA[...]]></evidence>` blocks with a system prompt binding the trust boundary (evidence is data, never instructions). CDATA is escaped (`]]>` → `]]]]><![CDATA[>`) to block prompt injection via user content. Prompt caching is on; the evidence block hits Anthropic's cache across runs in a 5-minute window.
- **Orchestrator.** `lib/evidence/clustering/orchestrator.ts > runClustering(ctx)` is the single entrypoint. Takes a per-account `pg_advisory_xact_lock` so concurrent dispatches serialize. Rule: `existingClusters === 0 && evidenceCount <= 50` → `runFullClustering` (cold start); else → `runIncrementalClustering`. Both paths return a `ClusterPlan`; the orchestrator funnels both through the shared `applyClusterActions` write path.
- **Incremental path (`lib/evidence/clustering/incremental.ts`).** Loads live clusters + centroids, KNN-buckets candidate evidence by cosine similarity to every centroid. `sim ≥ HIGH_CONF` (0.82) → auto-attach, skip the LLM. `LOW_CONF ≤ sim < HIGH_CONF` → send to LLM as "uncertain". `sim < LOW_CONF` (0.65) → send as "NEW candidate". The LLM sees only the boundary cases + nearest cluster hints. Capped at 50 clusters × 3 quotes + 50 candidates per prompt.
- **Apply (`lib/evidence/clustering/apply.ts`).** Single DB write path. Executes KEEP (update + attach), MERGE (tombstone losers via self-FK, re-parent edges, update winner), SPLIT (first child reuses origin id, rest fresh), NEW. Per-cluster recompute of centroid + frequency via `recomputeClusterAggregates` after every edge change. Stale wiring: touched → `stale=false`, untouched with newest attached evidence >14 days older than the account's newest → `stale=true`.
- **Async dispatch (Lane E).** `trpc.insights.run` creates a `pending` `insight_run` row and emits `EVENT_CLUSTER_REQUESTED`; the Inngest worker at `lib/inngest/functions/cluster-evidence.ts` picks it up, transitions status to `running` → `done|failed`, writes metrics (`mode`, `clustersCreated`, `evidenceUsed`, `durationMs`). Rate-limited at 10/hour/account via the `cluster-run` preset. Worker concurrency is `limit: 1, key: event.data.accountId` — per-account serialization, cross-account parallelism. Retries: 0.
- **Dispatch helper (`lib/evidence/clustering/dispatch.ts`).** Rate-limit → dedupe in-flight → insert pending row → emit event. Deduping: if a non-terminal run exists for the account, returns its id with `deduped: true` instead of spawning a second — blocks double-click waste. Send-before-commit ordering is intentional; the worker's ownership check is the backstop if the outer tx fails to commit.
- **Router.** `trpc.insights.*`:
  - `list()` / `detail({clusterId})` / `byIds({clusterIds})` — read paths.
  - `run()` — async dispatch. Returns `{runId, deduped}`.
  - `runStatus({runId})` — RLS-scoped, drives UI polling (1.5s interval via TanStack Query's `refetchInterval`).
  - `latestRun()` — most recent run for the account, or null. Drives the "resume polling after page reload" behavior.
- **Insights screen (`app/(app)/insights/page.tsx`).** Polls `runStatus` while active, resumes from `latestRun` on mount, surfaces failures via the `StaleBanner` slot, stops polling + shows "Taking too long — retry" after a 5-minute client-side cutoff (operational reaping of DB rows is deferred).
- **Centroid backfill (`scripts/backfill-centroids.ts`).** One-shot CLI. Scans every live cluster with `centroid IS NULL` (all accounts in one pass; owner role bypasses RLS), computes centroid via the shared `recomputeClusterAggregates`. Idempotent; supports `--dry-run` and `--limit=N`. Required for clusters created before Lane D since the incremental path uses centroids as KNN anchors. Rollout runbook: `docs/runbooks/incremental-reclustering-rollout.md`.

Adding a new prompt revision: edit the system string in the prompt file. The `prompt_hash` column on every `insight_cluster` / `insight_run` row auto-changes (content-addressed via `definePrompt`) so eval regressions pinpoint which version produced which row. Run `bun run test:eval` against `test/evals/incremental-clustering.eval.ts` before merging any prompt change.

## Opportunities (What to build)

Turns clusters into ranked, shippable opportunities with 5 weight sliders and live client-side re-rank (design review §14.4).

- **Prompt.** `lib/llm/prompts/opportunity-score.ts` takes short-labeled clusters (with representative quotes) and returns a list of opportunities with 5 primitives each: `impact.{retention,revenue,activation}`, `strategy`, `effort` (XS/S/M/L/XL), `confidence`. The LLM does NOT compute a final score — that's the server's job from the primitives + current weights.
- **Orchestrator.** `lib/evidence/opportunities.ts > runFullOpportunities(ctx)` reads clusters (cap 50), samples 3 quotes each, calls the LLM, validates labels map back to real cluster ids, wipes prior opportunities + writes new ones + edges. One LLM call per re-gen.
- **Pure score formula.** `computeScore(primitives, clusterIds, frequencies, weights)` — weighted sum of `(frequency-normalised, impact-weighted, strategy) - w.effort * effort` multiplied by `confidence`. Clamped `>= 0`. Unit tested in `test/opportunity-score.test.ts`. Both the UI's drag-feedback path and the server's `rescoreOpportunities()` call the exact same formula — drift there would silently change ranked output.
- **Weights.** Stored in `opportunity_score_weights` (one row per account, defaults to all 1s). `readWeights(ctx)` / `writeWeights(ctx, ws)`. Sliders are floats in [0, 3]; anything above 3 is noise.
- **Router.** `trpc.opportunities.*`: `list`, `forCluster({clusterId})`, `weights`, `run`, `updateWeights({weights})`.
  - `run` invokes the LLM (expensive, regenerate button on UI).
  - `updateWeights` persists + calls `rescoreOpportunities` server-side. The UI doesn't wait for this response — it re-ranks optimistically with the same formula during drag, and the server catches up on 300ms release debounce.
- **/build screen.** `app/(app)/build/page.tsx`: ranked opportunity cards on the left, 5 labeled sliders + Reset button on the right. Reset reads the defaults from `trpc.opportunities.weights` (not hardcoded). `ConfidenceBadge` + effort chip + score on each row.
- **Insights right rail.** `LinkedOpportunities(clusterId)` queries `opportunities.forCluster`. Shows "Turn into spec →" CTA pointing at `/build#opp-<id>` (anchor deep-link lands when spec editor ships).

## Specs (editor)

Turns one opportunity + its linked clusters into a shippable product spec. One blocking LLM call today (streaming + refinement chat ship in follow-up commits).

- **IR not strings.** `lib/spec/ir.ts` is the typed intermediate rep: `title`, `summary`, `userStories[]`, `acceptanceCriteria[]`, `nonFunctional[]`, `edgeCases[]`, `qaChecklist[]`, `citations[]`. All renderers (Markdown today, Linear + Notion next) consume `SpecIR`, never a looser shape. Stored in `spec.content_ir` (jsonb).
- **Prompt.** `lib/llm/prompts/spec-generate.ts`, task `"generation"` (Haiku 4.5). Opportunity + clusters wrapped in `<opportunity>` / `<cluster>` XML with CDATA'd content (same trust-boundary pattern as synthesis). Parse validates cross-refs: every acceptance criterion's `storyId` must map to a real `userStory.id`, every story must have ≥1 criterion. Citations carry real cluster UUIDs — the orchestrator additionally verifies every cited clusterId was in what we sent.
- **Readiness grade.** `lib/spec/readiness.ts > gradeSpec(spec)` is a pure, unit-tested checklist: `edgesCovered` (≥3), `validationSpecified` (every story has ≥1 criterion), `nonFunctionalAddressed` (≥1), `acceptanceTestable` (every g/w/t non-empty). 4/4 → A, 3/4 → B, 2/4 → C, ≤1 → D. The LLM is never asked to grade itself; same IR always produces the same grade so prompt regressions are measurable.
- **Renderer.** `lib/spec/renderers/markdown.ts > renderSpecMarkdown(spec)` is deterministic. Rendered once at generation time + stored in `spec.content_md` so export is a single read instead of a re-render from possibly-stale IR.
- **Orchestrator.** `lib/evidence/specs.ts > generateSpec(ctx, opportunityId)` — reads opp + linked clusters (cap 20) + 3 quotes/cluster, calls the prompt, validates citation UUIDs, grades + renders, UPSERTs with `version = prev + 1`. Every regeneration produces a new version; earlier versions are retained.
- **Router.** `trpc.specs.*`: `list`, `getLatest({opportunityId})`, `generate({opportunityId})`, `exportMarkdown({opportunityId})`. `exportMarkdown` returns `{filename, content}` — filename sanitized from the spec title.
- **Editor.** `app/(app)/spec/[opportunityId]/page.tsx` — opportunity header, empty state with "Generate spec" CTA, rendered spec view on success, sidebar with `ReadinessGrade`, `Download .md`, `Regenerate`, version + updatedAt. "Create spec →" button on each row of `/build`. First successful markdown download fires `FIRST_SPEC_EXPORTED` (localStorage-guarded so re-downloads don't double-count).
- **Component.** `components/ui/ReadinessGrade.tsx` — A/B/C/D letter in a coloured circle + a 4-row checklist with ✓/· glyphs. Pure presentation: takes grade + checklist props, no data fetching.

## Spec streaming (SSE)

Spec generation runs 10-30s. Streaming tokens makes the wait feel like progress instead of a spinner that might be hung.

- **Router.** `completeStream(prompt, input, opts)` in `lib/llm/router.ts` wraps Anthropic's streaming API. Yields `{type:"delta", text}` per `content_block_delta` + a final `{type:"done", text, output, usage}` after `stream.finalMessage()`. parse() runs on the full accumulated body — never on a chunk — so partial JSON never throws mid-stream. No retries (mid-stream resumption isn't worth the complexity; fall back to `complete()` if you need retries).
- **Orchestrator.** `lib/evidence/specs.ts > generateSpecStream(ctx, oppId)` is the streaming twin of `generateSpec`. Same validation (cluster UUIDs), same grading (`gradeSpec`), same markdown caching, same UPSERT-with-version persistence. Both paths produce the same row — a client that uses streaming never sees a spec the blocking path wouldn't accept.
- **Route Handler.** `POST /api/specs/generate` opens a `ReadableStream<Uint8Array>` wrapped around `generateSpecStream`. Emits `event: delta` / `event: done` / `event: error` SSE frames. The DB transaction lives inside the streaming generator — connection drop = rollback = no half-written spec. Request-abort propagates into the Anthropic stream via a shared `AbortController`, so closing the tab stops burning tokens immediately.
- **SSE wire format.** `lib/sse.ts > encodeServerEvent(ev)` + `parseServerEvents(buffer)` own the framing. Shared between the route handler and the browser client so there's one source of truth. Unit-tested in `test/sse.test.ts`.
- **Browser client.** `lib/client/sse-fetch.ts > sseFetch({url, body, signal, onEvent})` — fetch+ReadableStream+TextDecoder. Handles UTF-8 decoding + partial-frame re-prepend across chunk boundaries + abort propagation. Browser `EventSource` isn't used because it only supports GET.
- **StreamingCursor primitive.** `components/ui/StreamingCursor.tsx` (9th shared primitive). Inline or block variant. CSS `@keyframes rogation-cursor-blink` in `app/globals.css`, auto-frozen by the global `prefers-reduced-motion` rule. Purely presentational; parents render it based on stream state.
- **Editor flow.** Click "Generate spec" → `sseFetch()` → live text accumulates in `<StreamingPreview>` with the cursor. On `done`, `utils.specs.getLatest.invalidate()` swaps the preview for the rendered `<SpecView>`. Abort cancels the stream AND the LLM call upstream.

## Spec refinement chat

PMs don't regenerate from scratch when one section is off — they iterate. The chat panel under every spec view is IR-aware: "tighten US2's AC", "add an edge case for offline mode", "drop the security non-functional". Each turn produces a full new `SpecIR` + an assistant reply, persisted as spec version `N+1` with a chat-history row.

- **Prompt.** `lib/llm/prompts/spec-refine.ts`, task `"refinement"` (Haiku 4.5). Input: `{ currentSpec: SpecIR, history: {role,content}[], userMessage: string }`. Output: `{ assistantMessage, spec }` — full replacement, not a diff. Same XML+CDATA trust boundary as synthesis/generate. The system prompt explicitly instructs the model to preserve unchanged sections verbatim so we don't silently lose content across turns.
- **Why full replacement over diffs.** The grade is computed on the full IR, diffs make parse() every-path-optional, and a missed array index in a patch silently drops a PM's section. Tokens are cheap; correctness is not.
- **Shared validators.** `lib/spec/validators.ts > validateSpecIR(raw)` is the single source of truth used by BOTH `spec-generate.ts` and `spec-refine.ts`. A refinement can never produce a spec generation wouldn't accept — cross-reference invariants (every storyId resolves, every story has ≥1 criterion) run through the same function.
- **Orchestrator.** `lib/evidence/specs.ts > refineSpecStream(ctx, opportunityId, userMessage)` reads the latest spec + prior chat (bounded at 20 turns), calls `specRefine` via `completeStream()`, grades + renders on completion, UPSERTs as `version + 1`, then appends `{user, assistant}` rows to `spec_refinement` attached to the NEW spec id. Chat history belongs to the latest version so the "next turn" query is a single FK lookup.
- **Why attach chat to the new spec.** An earlier draft attached the user turn to the old spec pre-call + the assistant turn to the new spec post-call. It works but makes "show me the conversation that produced this version" a weird union query. Attaching both turns to the new spec keeps the invariant simple: `spec_refinement.spec_id = specs.id` always points at the version the conversation was about.
- **Route.** `POST /api/specs/refine` streams SSE using the same `encodeServerEvent` framing as `/api/specs/generate`. Rate-limited per-account via `checkLimit("spec-chat", accountId)` (20/min, preset table in `lib/rate-limit.ts`). Limit fails BEFORE the LLM call so throttled requests spend zero provider tokens. `userMessage` capped at 2000 chars.
- **tRPC.** `trpc.specs.refinements({ opportunityId })` → `Array<{id, role, content, createdAt}>` sorted ascending. Client invalidates it on every `done` event so new turns swap in without a page reload.
- **Editor chat panel.** `<ChatPanel>` in `app/(app)/spec/[opportunityId]/page.tsx`. Scrollable history of prior turns + a streaming "Assistant" bubble with `<StreamingCursor/>` during the current turn + a textarea with `⌘Enter`-to-send. Empty state explicitly prompts for the right kind of ask ("tighten", "reword", "add an edge case…") so PMs don't freeze at the blank input.

## Feedback thumbs (eval loop)

PMs thumbs-up/down clusters, opportunities, and specs. Each vote captures the target's `prompt_hash` server-side so:

```sql
SELECT prompt_hash,
       COUNT(*) FILTER (WHERE rating = 'down') AS downs,
       COUNT(*) FILTER (WHERE rating = 'up')   AS ups
FROM entity_feedback
GROUP BY prompt_hash
ORDER BY downs::float / NULLIF(ups + downs, 0) DESC;
```

tells us which prompt hash is regressing. Run after every prompt edit to confirm the new hash isn't tanking real-user approval.

- **Schema.** `entity_feedback` existed in the initial migration; `db/migrations/0003_entity_feedback_unique.sql` adds a partial `UNIQUE(account_id, user_id, entity_type, entity_id) WHERE user_id IS NOT NULL` so the vote mutation can UPSERT on the conflict target. Null `user_id` (deleted voter) doesn't participate in the unique index — historical votes stay tied to the row.
- **Server.** `lib/evidence/feedback.ts`: `voteOnEntity`, `removeVote`, `myVotes`, `aggregateByPrompt`. The `prompt_hash` is looked up server-side from the target row (`insight_cluster.prompt_hash` / `opportunity.prompt_hash` / `spec.prompt_hash`) at vote time — clients never send it, so a fake/forged hash can't poison the eval stream. Cross-account votes fail because RLS scopes the lookup to zero rows, which the helper treats as "target not found."
- **Router.** `trpc.feedback.*`: `vote` / `remove` / `mine({ entityType, entityIds })` / `aggregate`. `mine` is the batch-read the client hook uses on page load.
- **Primitive.** `components/ui/FeedbackThumbs.tsx` (10th shared primitive). Two buttons, `aria-pressed` toggled state, clicking the active rating clears it (undo). `sm` + `lg` size variants.
- **Client hook.** `lib/client/use-feedback-thumbs.ts > useFeedbackThumbs(entityType, entityIds)` returns `{ votes, setVote, isPending }`. Feature pages call it once with the full id list for the page, then render `<FeedbackThumbs value={votes[id]} onChange={v => setVote(id, v)} />` per row. No N+1.
- **Wired surfaces.** Insights (cluster detail header), `/build` (per opportunity row), `/spec/[id]` (alongside the readiness grade). Every v1 LLM-generated entity is ratable.
- **Tests.** `test/feedback.test.ts` — DB-gated. Locks down: prompt_hash captured server-side, UPSERT on revote (no duplicates), RLS blocks cross-account votes, `myVotes` batch-reads, `aggregateByPrompt` computes correct ups/downs.

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

## Notion integration

Second integration target (after Linear). Same pattern: OAuth → encrypted token → per-provider helpers. See `docs/integrations/notion-setup.md` for the one-time admin setup.

- **OAuth module.** `lib/integrations/notion/oauth.ts` — `notionOauthConfigured()`, `buildAuthorizeUrl(state)`, `exchangeCodeForToken(code)`. Token exchange uses HTTP Basic auth (client_id:client_secret) + a JSON body; the response is long-lived (no refresh token) and carries `workspace_id` / `workspace_name` / `workspace_icon` / `bot_id` for display.
- **REST client.** `lib/integrations/notion/client.ts` — thin wrapper over `api.notion.com/v1` with `Notion-Version` pinned. `NotionApiError` carries `status` + `code` so callers flip to `token_invalid` on 401. Helpers: `fetchBotUser`, `findWritablePage`, `createSpecDatabase`, `createSpecPage`, `fetchDatabase`.
- **Callback auto-provisioning.** `app/api/oauth/notion/callback/route.ts` does more than store a token — on first connect it calls `findWritablePage()` + `createSpecDatabase()` to create a "Rogation Specs" database under the first page the bot was granted access to. Schema: Title (title), Opportunity (rich_text), Readiness (select A/B/C/D), Version (number), Source (url), Created (date). If no writable page exists, the credential is still saved but `config.setupReason = 'no_writable_page'` + `status = 'disabled'` so the UI shows a "Reconnect with page access" CTA instead of silently stranding the PM.
- **Config.** `NotionIntegrationConfig` in `db/schema.ts`: `workspaceId`, `workspaceName`, `workspaceIcon`, `botId`, `defaultDatabaseId`, `defaultDatabaseName`, `setupReason`. No migration needed — `integrationProvider` enum already includes `notion`.
- **Push path.** `lib/evidence/push-notion.ts > pushSpecToNotion(ctx, opportunityId)`. Preconditions mirror Linear: spec exists → integration connected → default DB provisioned → non-empty title → token valid. Each failure returns a structured error code that the router maps to a specific `TRPCError` code; the spec editor shows a matching CTA.
- **Router.** `trpc.integrations.*` grew three surfaces: `providers.notion.configured`, `notionWorkspace()` (display + liveness probe), `pushSpecToNotion({opportunityId})`. `disconnect({provider})` already accepted `notion` in its enum.
- **UI.** Notion card on `/settings/integrations` (Connect / Reconnect / Disconnect / setup-needed state) + `NotionPushBlock` on `/spec/[opportunityId]` that mirrors the Linear block (5 mutually exclusive states).
- **Rate limit.** Reuses the `linear-push` preset (30 / hour / account). Same cost profile — one provider mutation + one DB write per call.
- **Plan gate.** Pro only (`canExport(plan, 'notion')`). Free + Solo see the upgrade CTA instead of the push button.

## Deploy Configuration (configured by /setup-deploy)

- Platform: Vercel (linked — project `sanxores-projects/rogation`)
- Production URL: `https://rogation-sanxores-projects.vercel.app` (auto-alias — replace with custom domain once configured)
- Staging / preview: Vercel PR previews are enabled by default. Protected by Vercel auth (401 to unauthenticated requests) — not reached by `/land-and-deploy` canary.
- Deploy trigger: automatic on push to `main` (Vercel Git integration via linked project)
- Deploy status: poll production URL `/api/health` until it returns 200 with the new commit SHA
- Health check endpoint: `GET /api/health` → 200 `{ok:true, db:"up", version, commit, latencyMs}` or 503 `{ok:false, db:"down"}`. Returns 503 on DB outage so monitors can alarm. Source: `app/api/health/route.ts`.
- Merge method: squash (GitHub repo default)
- Project type: Next.js web app + API routes

### Custom deploy hooks

- Pre-merge: `bun run check` (typecheck + lint + build + test) — already runs in CI
- Post-deploy verification: `curl -fs $PROD_URL/api/health` and assert `commit` matches the just-merged SHA

### Status + next checkpoint

- Vercel env vars: all 11 required keys set in the Vercel dashboard (confirmed 2026-04-20)
- First production deploy: pending PR #3 merge (prior attempts failed the Vercel "vulnerable Next.js" guard — fixed by the 15.1.0 → 15.5.15 bump in PR #3)
- After PR #3 merges, verify the assigned production URL with `vercel ls` and update this section if Vercel assigns a different alias than the expected `rogation-sanxores-projects.vercel.app`
