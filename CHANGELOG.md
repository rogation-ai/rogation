# Changelog

All notable changes to Rogation are recorded here. Format loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are 4-digit `MAJOR.MINOR.PATCH.MICRO`.

---

## [0.10.9.0] - 2026-05-14

PMs can now dismiss irrelevant clusters. Dismissed evidence is permanently excluded from future clustering runs, and a centroid-based matching layer flags new incoming evidence that resembles dismissed patterns for review. PMs manage exclusions from Settings > Learning.

### Added
- Nuclear exclusion system: dismiss a cluster to permanently flag all its evidence as excluded and tombstone the cluster. Two-layer defense: layer 1 flags existing evidence, layer 2 matches new incoming evidence against exclusion centroids.
- Pending review for new evidence: when new evidence matches a dismissed pattern (cosine sim >= 0.75), it is flagged as `exclusion_pending` for PM review instead of being silently excluded.
- LLM prompt augmentation: dismissed pattern labels are injected into clustering prompts so the LLM avoids re-creating dismissed themes.
- Settings > Learning page with exclusion management: view active/inactive exclusions, strength bar, unexclude (restore evidence + reactivate cluster), and delete.
- Dismiss button on cluster detail header (Insights page) with confirmation dialog and optional reason field.
- Pending review banner on Insights page when evidence matches a dismissed pattern.
- Evidence list filter: `showExcluded` option to view excluded evidence separately.
- `cluster_exclusion` table with centroid vector, strength-based decay (0.02/run, 180-day window), and RLS policy.
- `tombstone_reason` enum on `insight_cluster` to distinguish merge vs dismiss tombstones (prevents un-tombstoning merged clusters).
- `excluded`, `exclusion_pending`, `flagged_by_exclusion_id` columns on evidence table.
- `withExcludedFilter()` DRY helper applied to all clustering queries.
- `cluster-dismiss` rate limit preset (20/hr/account).
- `canManageExclusions()` plan gate: dismiss is available to all plans, management UI (Settings > Learning) is Solo+ only.
- 16 new test cases across 2 test files (8 pure + 8 DB-gated).

---

## [0.10.8.0] - 2026-05-14

Scope filtering now actually filters. The selector that shipped with v0.10.7.0 was writing `?scope=<id>` to the URL but no consumer page was reading it — so changing the dropdown did nothing. This release wires it end-to-end and tightens the routing threshold so realistic PM briefs actually route evidence.

### Fixed

- **Scope filtering on /evidence, /insights, and /build** now responds to the global scope dropdown. New shared `useScopeFilter` hook normalises the URL param (uuid / "unscoped" / undefined) and threads it into every consumer query. Garbage URL input (`?scope=garbage`) is silently coerced to no-filter instead of 500-ing the page.
- **Scope routing threshold** lowered from 0.70 to 0.55. The previous floor was too tight for `text-embedding-3-small`; realistic briefs ("iOS Safari, mobile checkout, scroll jank") routed 0 of 13 sample-corpus rows. 0.55 lets same-domain evidence in while still rejecting orthogonal noise.
- **`scopes.reroute` data-loss guard.** If every scope's brief embedding lagged, `routeAllEvidence` previously NULLed `scope_id` on every evidence row in the account. One click of the new "Re-route" button could erase the entire scope graph. Bails out instead and reports the unscoped count.
- **`scopes.reroute` rate limit + error mapping.** New `scope-reroute` preset (10/hour/account) prevents mash-clicking from holding long transactions and contending with concurrent ingest writes. Try/catch with TRPCError mapping matches every other mutation in the router.
- **Stale cluster selection on /insights.** Switching scope no longer leaves the previous scope's cluster id selected (which 404'd the detail query).

### Added

- **"Re-route all evidence" action** in a new kebab menu on /settings/scopes. Useful when adding new evidence after creating a scope, or after a threshold change. Demoted from a header CTA to a dropdown item so it doesn't compete with the primary "New scope" flow.
- **Empty-state hint** on scope cards with 0 attached evidence: "No matches yet — try widening the brief."
- **`scopes.reroute` tRPC mutation** wrapping the existing `routeAllEvidence` helper.
- **Regression tests** covering the URL → query normaliser (7 cases including injection-shaped input) and the previously-failing 0.55-0.70 threshold band.

## [0.10.7.0] - 2026-05-13

PMs can now create scopes to route evidence by domain. Each scope has a text brief that gets embedded; incoming evidence is matched by cosine similarity and filtered across all pages.

### Added
- Scope routing via embedding similarity. PMs write a brief describing a domain (e.g. "onboarding"), evidence is auto-routed to the closest scope above a 0.70 cosine threshold.
- Settings > Scopes page with full CRUD: create, edit, delete scopes. Preview button shows how many evidence rows would match a brief before committing.
- Scope selector in the sidebar. Hidden when no scopes exist. Filters evidence, insights, build, and specs pages via `?scope=id` URL param.
- `withScopeFilter()` DRY helper applied to all list resolvers (evidence, insights, opportunities, specs).
- Scope-isolated clustering. The orchestrator, incremental, and full clustering paths all filter by scopeId. Advisory lock includes scopeId for cross-scope parallelism.
- Migration 0012: `pm_scope` table, `scope_id` nullable FK on evidence/clusters/opportunities/specs/insight_runs, compound indexes, RLS policy.

### Fixed
- Cluster dispatch dedup now includes scopeId so cross-scope dispatches don't incorrectly return a pending run from a different scope.

---

## [0.10.6.0] - 2026-05-13

Multiple PMs can now share a Rogation workspace via Clerk Organizations.

### Added
- Clerk Organizations support with "Membership optional" mode. Existing personal accounts keep working unchanged.
- Organization switcher in the sidebar. Create orgs, invite teammates, switch between personal and org context.
- Org-aware account resolution: `createContext()` branches on `orgId` from Clerk's `auth()`. Org context resolves accounts by `clerkOrgId`, personal context uses the existing `clerkUserId` path.
- `provisionAccountForClerkOrg()` and `ensureUserInAccount()` for org account creation and member join, with idempotent race handling.
- Webhook handlers for `organization.created` and `organizationMembership.created` events.
- Users can now belong to multiple accounts (personal + orgs) via `(clerk_user_id, account_id)` compound unique index.
- TanStack Query cache resets on org switch so stale cross-org data never leaks.

---

## [0.10.5.1] - 2026-05-12

### Fixed
- Clustering no longer fails with `embeddings_pending` when evidence was uploaded via file upload and the Inngest embedding worker did not process the embed events. The orchestrator now backfills missing embeddings inline before either the full or incremental clustering path runs.

---

## [0.10.5.0] - 2026-05-11

Clustering produces fewer, stronger clusters. Evidence counts on cluster cards update instantly after evidence deletion.

### Fixed
- Cluster card evidence count now updates immediately after deleting evidence, without requiring a page reload. Root cause: `evidence.delete` mutation was not invalidating the `insights.list`/`detail`/`byIds` TanStack Query caches. Three-line fix.
- Stale UX copy in the delete confirmation dialog and success toast removed ("will look thinner after next refresh" no longer accurate).

### Changed
- `HIGH_CONF` cosine-similarity threshold for auto-attach lowered from 0.82 to 0.78, catching more obvious cluster matches without LLM calls.
- Representative quotes per cluster sent to the LLM increased from 3 to 6, giving the model better signal about each cluster's theme.
- KNN hints per candidate increased from 2 to 4 for richer context during uncertainty resolution.
- Quote sampling switched from recency-ordered to centroid-nearest with a 24-row candidate window per cluster. Clusters whose centroid is missing (pre-backfill) fall back to recency.
- Incremental clustering no longer throws past 50 candidates. The orchestrator chunks into up to 5 passes of 50 under one advisory lock.
- Cold-start clustering uses farthest-first diversity sampling when the corpus exceeds the 50-row LLM prompt cap, then auto-continues with incremental chunks for the remainder. No more dead-end "too many evidence rows" error.
- Duplicate evidence labels across clusters are now logged to Sentry and deduped (keep-first) instead of throwing. Gains visibility without losing the run.
- Both clustering prompts now instruct the LLM to prefer fewer, bigger clusters and avoid singletons.

### Added
- Post-apply consolidation pass merges micro-clusters (frequency < 2) into their nearest non-tombstoned neighbour when centroid similarity is high enough (>= 0.70). Only runs on clusters created in the current run. Uses `skipDownstreamStale` to avoid re-staling just-linked opportunities.
- `farthestFirstIndices` in `knn.ts` for embedding-space diversity sampling.
- `CONSOLIDATION_MERGE_SIM` and `MIN_CLUSTER_SIZE` constants in `thresholds.ts`.
- `ApplyOpts.skipDownstreamStale` flag on `applyClusterActions` for consolidation.
- `ApplyResult.createdClusterIds` to track freshly-inserted clusters per apply call.
- `IncrementalResult.candidatesRemaining` so the orchestrator knows when to loop.

---

## [0.10.4.1] - 2026-05-11

Page load performance: instant nav feedback and 44% smaller First Load JS.

### Fixed
- Sidebar navigation no longer freezes on the previous page during route transitions. A shared `loading.tsx` skeleton renders the instant a link is clicked, so the active-nav indicator, top-bar title, and content area all update immediately instead of waiting for RSC + tRPC to resolve.
- Sentry SDK (~126 KB gzipped) no longer blocks First Contentful Paint on every page including the public landing page. Moved to a deferred dynamic import inside `requestIdleCallback` with a `setTimeout` fallback. Shared First Load JS drops from 185 KB to 103 KB (-44%). Landing page drops from 187 KB to 107 KB.

---

## [0.10.4.0] - 2026-05-11

UX audit + full design system migration. The app moves from the editorial-serif system (Tiempos + cream + warm-black) to Industrial / Light / General Sans. Paid users can now self-serve their subscription from inside the app.

### Added
- `/settings/billing` page with current plan, per-resource usage bars, monthly LLM budget signal, and the shared tier-compare grid for in-app upgrade/downgrade via Stripe Checkout + Customer Portal
- Sidebar shell (240px left sidebar + 56px top bar) replaces the marketing-style top nav across all authed pages. Plan meter pinned to sidebar bottom shows the tightest resource with a full-width bar + mono numerals + inline Upgrade link
- Mobile drawer with all nav items + Billing link, 44px tap targets
- Product cut on the marketing landing: a stylized Insights preview with severity dots, mono frequency counts, and "updated 12m ago" timestamp
- Flow line on landing: "01 Paste evidence > 02 Cluster pain > 03 Score opportunities > 04 Stream spec > 05 Push to Linear" with JetBrains Mono numerals
- `components/billing/PricingTiers.tsx`: shared tier-card grid used by both `/pricing` and `/settings/billing`
- Decision tick CSS keyframe (`rogation-decision-tick`): 100ms warm-red pulse for numeric value changes

### Changed
- **Design system direction:** Industrial / Utilitarian, light-by-default. General Sans (Fontshare CDN) replaces Tiempos Headline + Söhne. JetBrains Mono Display replaces Söhne Mono. Warm red brand-accent (#D04B3F) retained as only personality color
- **Color tokens:** cool neutrals replace warm grays. Surface-app #FFFFFF (was warm white), borders #E8E8EB/#D4D4D9 (was warm #EAE5DC/#D9D3C7). Dark mode becomes true-neutral #0B0B0E (was warm #0E0D0B)
- **Radius:** md tightens 8px to 6px, lg 12px to 10px
- Pricing page CTAs render immediately for unauthed visitors (was gated on Clerk `isLoaded` for all visitors, showing "Loading..." for ~2s)
- Pricing page uses shared `PricingTiers` component
- Marketing landing + pricing pages use `--color-surface-marketing` for brand continuity
- All numeric displays (PlanMeter, FrequencyBar, evidence count, spec version, billing usage) use JetBrains Mono with tabular-nums
- UpgradeButton is plan-aware: red "Upgrade" pill for free users, muted "Billing" text link for paid users. Both route to `/settings/billing`

### Fixed
- Dead "Product" and "Docs" nav links on homepage (pointed to `#`, /docs returns 404)
- Inconsistent top-nav between `/` and `/pricing`
- Inline "Plan cap reached — upgrade to seed the rest." was plain text, now a clickable link to `/settings/billing`
- `color-mix(in oklab, ...)` inside `@keyframes` broke Lightning CSS silently (CSS bundle 404'd). Replaced with rgba()
- Product-cut eyebrow "INSIGHTS · 5 CLUSTERS" promoted from `<span>` to `<h2>` and lifted from text-tertiary to text-secondary for contrast
- All marketing CTAs + nav links meet 44px touch target floor (was 20-40px)

### Removed
- `components/app/AppHeader.tsx` (replaced by AppSidebar + AppTopBar)
- `components/app/UpgradeButton.tsx` (functionality absorbed into AppSidebar plan meter + AppTopBar drawer)

## [0.10.3.1] - 2026-05-11

Re-cluster works again after deleting all evidence and uploading new pieces.

### Fixed

- **Generate cluster failed silently after a clean-slate re-upload.** Deleting every piece of evidence behind a cluster recomputes its frequency to 0 and clears its centroid, but the cluster row stays in the DB so `opportunity_to_cluster` paper trails resolve. `/insights` and `/build` already filtered those orphans out, but the clustering orchestrator did not — so on the next "Generate", orphan rows inflated the live-cluster count, the dispatch flipped to the incremental path, and the LLM got a prompt full of `<cluster>` blocks with empty `<evidence>` because no edges existed. Result was either a parser throw the worker stuffed into a recovery transaction or an empty plan that produced zero new clusters and a silent no-op; opportunities then regenerated against nothing. `runClustering` now sweeps orphan clusters (`frequency = 0`, not tombstoned) at the top of every run under the existing per-account advisory lock — `opportunity_to_cluster` cascades clean up the dangling edges automatically. The orchestrator's cluster-count query and `runIncrementalClustering`'s cluster-load query both gain a `frequency > 0` filter as defense in depth. The cold-start condition is now `zero live clusters` — dropping the `≤ 50 evidence` qualifier so a delete-everything-then-bulk-upload flow routes to the only correct path (full clustering) instead of dying on "no live clusters" in the incremental branch.

## [0.10.3.0] - 2026-05-11

Product context as first-class LLM input. PMs paste a product brief and fill structured fields (ICP, stage, metric, features, roadmap) on a new /settings/context page. All five prompts consume the context when a per-account feature flag is enabled. Eval rotation compares context-on vs context-off via FeedbackThumbs.

### Added
- `/settings/context` page with split-view layout (form + live preview)
- Shared settings layout with left-nav (Product context, Integrations)
- Product brief, structured fields, feature flag, and rotation flag on account table
- `context_used` tracking on insight_cluster, opportunity, spec, and entity_feedback
- Two-block system message pattern preserving prompt_hash stability
- Multi-boundary cache markers in `buildUserContent()`
- Context bundle assembler with 12KB cap and per-field CDATA escaping
- `aggregateByPrompt()` grouping by `context_used` for eval dashboards
- 27 new tests (hash stability, rotation, bundle assembly, CDATA injection)

### Changed
- `Prompt.build()` return type widened to `number | number[]` for multi-boundary support
- `completeStream()` now respects `contextSystemInstruction`

## [0.10.2.1] - 2026-04-28

Stale opportunities disappear from /build when their evidence is gone.

### Fixed

- **Orphan opportunities lingered on /build.** v0.10.1.2 dropped orphan clusters from /insights and flipped linked opportunities to `stale = true`, but stopped short of hiding the opportunities themselves. Result: PMs deleted the last piece of evidence behind a cluster, watched it disappear from /insights, then saw the opportunity card stay put on /build — re-ranking didn't clear it, and "Regenerate" threw `No clusters to score` if every cluster went orphan in one pass. `listOpportunities` now joins `opportunity_to_cluster` against `insight_cluster` and only returns opps with at least one live linked cluster (`frequency > 0 AND tombstoned_into IS NULL`); the same join trims dead cluster ids out of `linkedClusterIds` so citation chips never deep-link to a hidden insight. `runFullOpportunities` no longer throws on zero live clusters — it wipes any prior opportunities and returns `0` so the regen path matches the read path. Opportunity rows themselves are kept in the DB so a re-cluster can revive them with their old `status` and feedback intact.

## [0.10.2.0] - 2026-04-28

Operator script to wipe a user's content without nuking their account.

### Added

- **`scripts/purge-user-data.ts`.** Resolves a user by `--email` or `--clerk-id`, then deletes every account-scoped row across evidence, clusters, runs, opportunities, scoring weights, specs, refinements, outcomes, activity log, entity feedback, integration credentials/state, and monthly LLM usage. The user row, account row, and Stripe linkage stay intact so billing and Clerk auth keep working — only generated/imported content is wiped. Supports `--dry-run`: counts every table inside a transaction, then rolls back. Verifies the user + account rows are still present after the purge so a future schema change that accidentally deletes them fails loud instead of silent. Useful for support flows ("reset my workspace, keep my login") and for resetting test accounts between manual QA passes.

## [0.10.1.2] - 2026-04-28

Deleting old evidence no longer leaves zombie clusters on /insights.

### Fixed

- **Orphan clusters after evidence delete.** Clusters whose evidence was fully deleted kept appearing on /insights with stale frequency counts. Two compounding causes: (1) `trpc.insights.list` / `detail` / `byIds` returned every row regardless of whether it still had evidence attached, and (2) `evidence.delete` cascaded `evidence_to_cluster` rows but never recomputed `insight_clusters.frequency` or `centroid`, so the stored aggregates lagged reality forever. Both paths now filter by `frequency > 0 AND tombstoned_into IS NULL`, and `evidence.delete` calls `recomputeClusterAggregates` for every cluster the deleted row was attached to. `runFullOpportunities` applies the same filter so orphans never feed the LLM either. Clusters that transition to `frequency = 0` from a delete also fan out staleness via `markDownstreamStale` — linked opportunities + specs flip `stale = true` so PMs see "regenerate to refresh" instead of citing a cluster that no longer appears on /insights. Partial shrinks (cluster of 50 loses 1) stay quiet.

## [0.10.1.1] - 2026-04-27

PDF uploads work again on production.

### Fixed

- **PDF parsing on Vercel serverless.** Swapped `pdf-parse@2` (which wraps `pdfjs-dist` v4 and depends on browser globals like `DOMMatrix`, `ImageData`, `Path2D`, and `@napi-rs/canvas`) for `unpdf` — a serverless-native pdfjs fork that ships pre-bundled without any DOM polyfills. Real-world symptom: `feedback-users-cattus.ai.pdf` and other valid PDFs failed in production with `Couldn't parse: DOMMatrix is not defined. Is it password-protected?`. Same `ParserResult` contract; encrypted PDFs still surface as typed `parse_failed`, scanned PDFs still as `empty`.

## [0.10.1.0] - 2026-04-27

When evidence shifts, "What to build" and your specs now know they're stale.

### Added

- **Stale banners on /build and /spec.** When re-clustering reshapes a cluster (merge, split, or removal), the opportunities derived from that cluster now show a "Linked clusters changed. Re-rank to refresh." banner on the card. Click it to regenerate. Specs whose source clusters changed show a page-level banner explaining that regenerating will create a new version and start a new chat thread. No more silently looking at opportunities and specs that were derived from evidence you've since deleted or reshaped.
- **`opportunity.stale` and `spec.stale` columns.** Set automatically by the cluster apply path on MERGE/SPLIT/tombstone. Cleared automatically on regeneration. Plain refresh runs that only update centroids or attach new evidence (KEEP) do NOT mark anything stale, so the banner doesn't cry wolf on every re-cluster.

### Changed

- **`trpc.opportunities.list` returns `stale`.** Existing callers keep working; the field is additive.
- **`trpc.specs.getLatest` returns `stale`.** Same — additive.

---

## [0.10.0.0] - 2026-04-23

Incremental re-clustering. Re-clustering is now fast, cheap, and stays out of your way.

### Added

- **Re-clustering runs in the background.** Clicking "Refresh clusters" no longer holds the page open for 30 seconds. The app dispatches the job to a worker and the UI polls for progress, so you can keep scrolling, pick another cluster to read, or close the tab and come back. Reload mid-run and the progress indicator picks up exactly where you left off.
- **Incremental path for warm accounts.** New evidence joins existing clusters via fast KNN matching; only the truly-uncertain pieces reach the LLM. A typical re-cluster on a seasoned account now costs a fraction of the full run and finishes in seconds instead of tens of seconds. The full path still handles cold-start accounts and small corpora.
- **Per-account serialization.** Two fast clicks on "Refresh" don't spawn two expensive runs anymore — the second one silently rides on the first. Different accounts still re-cluster in parallel.
- **Centroid backfill script + runbook.** `scripts/backfill-centroids.ts` populates cluster centroids for accounts that existed before the incremental path shipped. `docs/runbooks/incremental-reclustering-rollout.md` covers the full deploy sequence.

### For contributors

- New `insight_run` table tracks each re-cluster: `pending → running → done/failed` with metrics (`mode`, `clustersCreated`, `evidenceUsed`, `durationMs`).
- New Inngest worker `cluster-evidence` (concurrency: 1 per account, retries: 0). Listens on `insights/cluster.requested`.
- New tRPC surfaces: `insights.run` (dispatch), `insights.runStatus`, `insights.latestRun`. The polling UI on `/insights` drives all three.
- New prompt: `lib/llm/prompts/synthesis-incremental.ts` with a 100-row eval fixture at `test/evals/incremental-clustering.eval.ts`.
- Every LLM call through the shared `applyClusterActions` write path — full and incremental both funnel through one tested module. Stale-flag wiring, centroid recompute, and MERGE tombstoning live there.
- `cluster-run` rate-limit preset (10/hr/account) gates LLM spend.
- Inngest plan concurrency cap: `embed-evidence` must stay at 5. Higher values fail the entire app sync since Inngest validates plan caps before registering any function.

### Fixed

- **Inngest app sync on production.** `embed-evidence` declared `concurrency: 10` while the Inngest plan caps at 5. All-or-nothing validation meant the whole app (including the new `cluster-evidence` worker) never synced, so re-cluster dispatches would queue events with no handler. UI hung on "Refreshing…" indefinitely. Dropped to `concurrency: 5`.

## [0.9.0.3] - 2026-04-22

### Fixed — tenant isolation

- **Integration queries now scope by `account_id` explicitly.** Several SELECTs in the integrations router and the Notion push helper were filtering only by `provider`, trusting Postgres RLS to add the account scope. But the app connects as the table owner, and Postgres owners bypass RLS by default (this was an intentional v1 tradeoff per migration 0001's comment, meant to be covered by app-level filters — integrations just didn't have them). Result: `integrations.list` returned integration rows from every account with the same provider, and the UI picked the first match. On a shared Postgres with multiple users, that meant the settings page showed "Connected" cards owned by other accounts; Disconnect silently no-op'd (DELETE still had the proper filter); "Pick a team" and "Reconnect Notion with page access" appeared even when the user's real account had the config saved, because the UI was rendering someone else's row. Every SELECT in `server/routers/integrations.ts` and `lib/evidence/push-notion.ts` now has `eq(..accountId, ctx.accountId)` alongside the provider filter.

## [0.9.0.2] - 2026-04-22

### Fixed

- **Signing out + signing back in as a different user no longer shows the previous user's integration state.** The client-side query cache lived on across sessions because `QueryClient` was instantiated once and never reset. User B would briefly see user A's "Connected" integrations (and any other cached list/detail data) until the page was hard-refreshed. Both UX and a privacy issue on shared machines. Now: the cache is cleared on every Clerk `userId` transition (sign-out, sign-in, user swap).

## [0.9.0.1] - 2026-04-22

### Fixed

- **Integration Disconnect button now surfaces errors instead of failing silently.** Previously, if the tRPC mutation failed (network, auth, server error), the button did nothing and the user had no idea why. Now: inline red error text under the card, `aria-role="alert"`, "Disconnecting…" label while in flight, full error logged to `console.error` so DevTools shows the cause. Applies to both Linear and Notion cards.
- Defensive `preventDefault` + `stopPropagation` on the click handler to rule out any ancestor event swallowing.
- Force-refetch the integration list on success (not just invalidate) so the UI updates immediately instead of waiting for the next background revalidation.

## [0.9.0.0] - 2026-04-22

Notion integration. Pro users can now connect their Notion workspace and push specs straight to a "Rogation Specs" database that Rogation provisions automatically on first connect.

### Added

- **Connect Notion from `/settings/integrations`.** One-click OAuth, same as Linear. Rogation auto-creates a "Rogation Specs" database in the first page the bot can write to, schema: Title, Opportunity, Readiness (A/B/C/D), Version, Source link, Created date. No manual database setup.
- **"Push to Notion" on every spec.** Renders the spec IR as native Notion blocks (headings per section, bulleted lists for stories/criteria/edge cases) with a 99-block safety cap and markdown-chunking for long specs. Pro plan gate, 30/hr rate-limit per account.
- **Graceful-degrade everywhere.** If `NOTION_CLIENT_ID`/`NOTION_CLIENT_SECRET` aren't set on the deployment, the Connect button stays hidden and the card shows "Coming soon" rather than a dead-end click. If consent succeeds but the bot has no writable page, the UI shows "Reconnect with page access" with clear copy.
- **Admin runbook.** `docs/integrations/notion-setup.md` walks the deployment owner through registering the OAuth app at notion.so/my-integrations and wiring env vars on Vercel.

## [0.8.2.0] - 2026-04-21

Fix the OAuth-flow-lands-on-localhost bug. Linear authorization on `rogation.vercel.app` was redirecting users to `http://localhost:3000/api/oauth/linear/callback` after consent, because `NEXT_PUBLIC_APP_URL` wasn't set on Vercel and the `env.ts` schema defaulted to localhost. Same bug would have bitten Stripe return URLs and every other place that reads the app's public URL.

### Fixed

- **`env.ts` derives the app URL from Vercel's system env vars when no explicit `NEXT_PUBLIC_APP_URL` is set.** Precedence: explicit > `VERCEL_PROJECT_PRODUCTION_URL` on production > `VERCEL_URL` on preview > `http://localhost:3000` locally. Vercel auto-injects these — zero config needed. Preview deploys now get their own correct callback URL, so OAuth works end-to-end on PR previews without wiring env per branch.

### Added

- **`test/env-app-url.test.ts`.** Five unit tests lock down the fallback chain: explicit wins, production picks the stable alias (not the per-deploy hash, which would break every OAuth redirect on every deploy), preview uses the one-off URL, and localhost is the last-resort default. Regression protection for the exact class of bug that just shipped to prod.

---

## [0.8.1.0] - 2026-04-21

Fix the "Connect Linear" dead-end. Before: a Pro user on a deployment without Linear OAuth env vars wired would click Connect, land on a raw `{"error":"Linear OAuth not configured"}` JSON page, and have no path forward. Now: the button either works, or politely says "Coming soon."

### Fixed

- **`/api/oauth/linear/start` and `/api/oauth/linear/callback` redirect on failure.** Replaced raw JSON 503 responses with redirects back to `/settings/integrations?linear=error&reason=...` so every error path ends somewhere recoverable.
- **"Connect Linear" button no longer renders when OAuth isn't wired.** `/settings/integrations` now reads a new `trpc.integrations.providers` query that inspects server-side env and returns `{ linear: { configured: boolean } }`. When false, the card shows a "Coming soon" pill instead of a live Connect button. Same graceful-degradation tone already used deeper in the flow for `PRECONDITION_FAILED`.
- **Error banner copy is now reason-specific.** `reason=not_configured` → "Linear integration isn't set up on this deployment yet. Contact support." `reason=unauthorized` → "Sign in first, then try again." Generic fallback preserved for OAuth-denied cases. Tells the user whether retry will help.

### Added

- **`docs/integrations/linear-setup.md`.** Four-step admin runbook: register the Linear OAuth app, set callback URL, copy client id + secret to Vercel, redeploy. Clarifies the multi-tenant model ("you register one OAuth app; every user connects their own Linear workspace; your workspace is never shared") since that was a common point of confusion.

---

## [0.8.0.0] - 2026-04-21

Close the loop on shipped work. After a spec lands in production, Pro PMs record what moved — and the next time they rank opportunities, those results show up as a verdict badge. Taste compounds into data.

### Added

- **OutcomeCard on the spec sidebar.** Pro plan: inline add / edit / remove rows per metric (name, predicted, actual, optional measured-at). Free + Solo: a tier-appropriate upsell pointing at `/pricing`. Copy differs by tier — Solo gets a one-liner because they already pay; Free gets the full pitch.
- **Verdict badge on /build rows.** Opportunities with recorded outcomes show `✓ Shipped +N%`, `✗ Missed`, or `~ Mixed` — coloured green/red/grey, with the percentage delta in tabular-nums so badges don't shift under negative numbers. Opportunities with a recorded goal but no actual show `N metrics` instead. 20-opportunity page = 1 batched summary query.
- **`trpc.outcomes.*` router.** `list({ opportunityId })` + batched `summary({ opportunityIds })` are open on every plan so Pro→Solo downgrades preserve history. `create` / `update` / `delete` gate on `hasOutcomeTracking(plan)` and throw `FORBIDDEN { type: "plan_feature_required" }` so the UI can render an upsell instead of a toast error.
- **Pure `summarizeOutcomes()` helper.** Computes the win/loss/mixed verdict + the clamped avgDelta (±300%) from a set of predicted/actual pairs. Unit-tested across no-measurement, all-hit, all-miss, mixed, div-by-zero, and wild-outlier cases so the /build badge doesn't silently drift when new metric sources land.

### Changed

- Upgrade pathway from Free/Solo → Pro now has a visible, in-context prompt (the OutcomeCard upsell) instead of only appearing on `/pricing`. Gives PMs a concrete "this is what the paywall actually unlocks" moment at the end of the spec flow.

---

## [0.7.0.0] - 2026-04-21

Upload the file formats PMs actually have. Research PDFs, Zoom transcripts, Zendesk CSV exports all work now.

### Added

- **PDF parser.** Drop a user-research report, interview transcript, or internal PRD directly on the dropzone. `pdf-parse` extracts the text layer; scanned image-only PDFs return a clear "run OCR first" error instead of silently producing empty evidence. Password-protected PDFs surface a typed `parse_failed` instead of a 500.
- **WebVTT parser.** Zoom, Google Meet, and Teams transcript exports land as first-class evidence. Speaker tags (`<v Alice>`) become `Alice: …` prefixes so speaker attribution survives into the evidence corpus. Timing lines, NOTE/STYLE blocks, and inline styling are stripped.
- **CSV parser.** Zendesk, Airtable, Google Sheets exports upload cleanly. Instead of dumping raw `col1,col2,...` blobs into the LLM, each row is reformatted as `Key: value\nKey: value` blocks separated by blank lines. Pairs perfectly with the split-blocks checkbox — a 20-row ticket export becomes 20 evidence rows. 500-row cap per file. TSV uses the same path.
- **Parser dispatcher.** `lib/evidence/parsers/index.ts > parseEvidenceFile(file)` picks the right parser by extension or mime and returns a uniform `ParserResult`. The upload Route Handler no longer branches on format; every new format just adds a case to the dispatcher.
- **Per-format sourceType.** Evidence rows are now tagged `upload_pdf`, `upload_transcript`, `upload_csv`, or `upload_text` based on the parser that produced them. Future library filters can scope by format without guessing.

### Changed

- **Upload dropzone accepts the new formats.** `accept=".pdf,.vtt,.csv,.tsv,..."` on the file input + `application/pdf` mime hint so OS file pickers show PDF files. Copy updated to `"Text, PDF, VTT, and CSV. 2 MB per file, 20 files per batch."` — no more "coming soon" placeholder.

## [0.6.0.0] - 2026-04-20

Upload a file with 20 support tickets in it, get 20 evidence rows instead of one blob.

### Added

- **"Split each file into one entry per paragraph" checkbox on the Upload screen.** Opt-in. When enabled, .txt / .md files are split on blank-line separators before ingestion. Each block becomes its own evidence row with a `sourceRef` like `upload:tickets.txt#block-3` so dedup + the library list track individual entries. Single-newline-separated content (speaker-turn transcripts) stays intact. Capped at 100 blocks per file so a pathological input can't swamp the plan meter.

## [0.4.0.0] - 2026-04-20

Evidence library. PMs can finally see everything they've pasted and take it back.

### Added

- **`/evidence` route — the evidence library.** Lists every piece of evidence on the account newest-first with a source icon, segment tag, 240-char preview, and a per-row Delete button. Delete prompts first and warns that clusters citing this row will look thinner after the next re-cluster. Added to the signed-in nav next to Upload. Capped at 100 most recent; pagination lands when a real account breaks that.

## [0.3.0.0] - 2026-04-20

Pricing page. First real path from "try it free" to "pay us money" without a support-channel hand-off.

### Added

- **Public `/pricing` page.** Three tier cards (Free / Solo / Pro) with feature lists + live CTAs. Signed-out visitors land in sign-up (with `?upgrade=<tier>` carried through). Signed-in free users get an Upgrade button that kicks off `trpc.billing.createCheckout` and redirects to Stripe Checkout. Existing paid subscribers get a Manage billing button that opens the Stripe Customer Portal. Current plan is marked so PMs don't buy a second subscription by accident. Wired the "Pricing" link on the landing page (was a dead `#` anchor).

## [0.5.0.0] - 2026-04-20

Async evidence embedding. Batch uploads no longer spend the request budget on OpenAI round-trips.

### Added

- **Inngest worker for evidence embedding.** `lib/inngest/functions/embed-evidence.ts` consumes `evidence/embed.requested` events and inserts the 1536-d vector into `evidence_embedding` with retry + backoff on provider failures. Concurrency capped at 10 so a 20-file batch doesn't thunder-herd OpenAI. The Next.js webhook lives at `POST /api/inngest` (signed by Inngest SDK against `INNGEST_SIGNING_KEY`).
- **`ingestEvidence` embed modes.** New `embed: "sync" | "defer"` option. Paste stays sync (one row, ~200ms). File uploads (`POST /api/evidence/upload`) now defer — the evidence row is inserted, dedup + plan-meter reflect it instantly, and the worker fills in the vector out of band. A 20-file import previously burned ~4s on OpenAI calls inside the request; now it's ~0ms.
- **`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` env vars.** Both optional. In dev the SDK talks to the local Inngest dev server (`npx inngest-cli dev`); production sets both and the webhook verifies every call.

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
