# TODOs

Deferred work items captured during planning. Each has context so someone picking it up months later understands the motivation, current state, and where to start.

---

## chargeAndEnforce spend persistence across rollback (P2)

**What:** `lib/llm/usage.ts > chargeAndEnforce(db, plan, accountId, usage)` UPSERTs the monthly `llm_usage` row and then throws FORBIDDEN when the call pushes past the hard cap. CLAUDE.md promises "The spend is recorded *before* the throw, so overruns are visible in logs + alerting." The implementation runs the UPSERT inside the caller's transaction — when the throw propagates, the tx rolls back and the UPSERT rolls back with it. No overrun row persists.

**Why:** Over-cap accounts should surface in alerting even when the caller's flow rolls back. Today they don't. The observability claim in CLAUDE.md is aspirational.

**How to close:** `chargeUsage` needs a connection independent of the caller's tx. Two options:
1. Open a short-lived autocommit connection via `postgres()` for the UPSERT only, then throw from the outer scope.
2. Emit an Inngest event (`llm-usage/charge`) and let a worker UPSERT out of band. Asynchronous, loses strict ordering vs same-call reads but matches the router's existing fire-and-forget pattern for `onTrace`.

Option 1 is simpler and keeps post-charge reads in-transaction-consistent. Option 2 is more robust under DB pressure.

**Blocked by:** Nothing. Pick up alongside the next observability commit.

---

## Weekly digest email

**What:** Weekly "3 new insights since last week" email to re-engage PMs.

**Why:** Section 10 risk 3 of the v1 design — PMs aren't daily users. Digest email drives re-engagement and feeds the activation/retention loop.

**Pros:**
- Measurable retention lift for the core persona.
- Low build cost (cron + template + Resend or Postmark integration).
- Gives us a weekly push surface for product updates and eval improvements.

**Cons:**
- Another thing to tune (bad digests train users to unsubscribe).
- Needs enough data per account to be useful (don't send in week 1 of a new account).

**Context:** The v1 data model already has `activity_log` and `insight_cluster` with timestamps. All the data needed is present. Build order: pick email provider (Resend recommended — Layer 1) → template (React Email) → scheduled Inngest function → opt-out link → digest content builder (query last 7d of new insights + top opportunities).

**Depends on:** Outcome data + insight clustering stable (so v1 wk 8+ is the earliest sensible time).

**Blocked by:** Nothing technical — pure scope deferral.

---

## Coverage gaps at tRPC/route-handler wrappers (P1)

**What:** Three thin-wrapper branches lack unit tests because the project doesn't have a tRPC caller harness yet.

1. `app/api/oauth/linear/callback/route.ts` — the `account_mismatch` cross-check (state.accountId vs session.accountId). The underlying `verifyState` is 6/6 ★★★ tested in `test/oauth-state.test.ts`, but the cross-tenant guard is not.
2. `server/routers/integrations.ts > linearTeams` — the 401 → `status: "token_invalid"` state flip. Same pattern IS tested in `test/push-linear-preconditions.test.ts` via `pushSpecToLinear`, but the integrations router write path is a separate call site.
3. `server/routers/specs.ts > pushToLinear` — the plan-gate (`canExport` returns false → FORBIDDEN) and rate-limit gate (`checkLimit` returns false → TOO_MANY_REQUESTS). Both branches short-circuit BEFORE the well-tested orchestrator in `lib/evidence/push-linear.ts`.

**Why:** Security-critical logic is already ★★★ covered (crypto envelope, HMAC state, push orchestrator). The gaps are in the 3-10 lines of code that glue tRPC error codes to orchestrator return values. Surfaced by /ship coverage audit 2026-04-20 at 72% (between 60% min and 80% target). User accepted the risk; tracked here so it doesn't rot.

**How to close:** Either (a) build a minimal tRPC caller harness wrapping `appRouter.createCaller(ctx)` with mocked `ctx.db` + `ctx.plan`, or (b) write an integration test that signs up a real test account, provisions a Linear credential row, and exercises the resolver end-to-end. Option (a) is faster; option (b) catches RLS drift too.

**Blocked by:** Nothing. Pick up any time a resolver bug ships and you wish you had caught it here.

---

## Split OAuth state signing key from credential encryption key (P2)

**What:** `INTEGRATION_ENCRYPTION_KEY` is currently used for BOTH:
- AES-256-GCM encryption of stored OAuth access tokens (`lib/crypto/envelope.ts`)
- HMAC-SHA256 signing of in-flight OAuth state params (`lib/integrations/state.ts`)

Rotating that one env var invalidates every stored credential AND every in-flight OAuth flow at the same moment.

**Why:** Defense-in-depth decoupling. When the first key-rotation becomes necessary (compromise, scheduled rotation policy, SOC2 prep), you want to rotate credential encryption independently of OAuth state signing. Today's single-key setup forces a coordinated outage.

**How to close:** Add `INTEGRATION_STATE_SIGNING_KEY` to `env.ts` (optional, falls back to `INTEGRATION_ENCRYPTION_KEY` so existing deploys don't break). Update `lib/integrations/state.ts > keyBytes()` to prefer the new var when set. Document the rotation pattern in CLAUDE.md.

**Blocked by:** First real key rotation need. Probably ≥6 months out.

---

## Async Linear push via Inngest worker (P2)

**What:** `lib/evidence/push-linear.ts > pushSpecToLinear` runs Linear API calls (createProject + 1-N issueCreate/Update/Archive, with up to 3 retries × 21s backoff each) inside the authedProcedure's Postgres transaction. The resolver's tx holds a pool connection for the entire Linear round-trip — typically 3-5 seconds, worst case ~80 seconds under sustained rate limiting.

**Why:** Pre-customer state means 0-2 concurrent PMs and the connection pool easily tolerates the long tx. Once multi-account usage ramps, this becomes a real exhaustion risk: a burst of 5+ PMs hitting "Push" simultaneously starves the rest of the application of DB connections.

**How to close:** Mirror the cluster-evidence.ts pattern in `lib/inngest/functions/`. Push becomes async-dispatch:
1. `trpc.specs.pushToLinear` becomes a dispatch helper: inserts a `linear_push_run` row (pending), emits an Inngest event, returns `{runId, deduped}`.
2. Inngest worker `lib/inngest/functions/push-spec-to-linear.ts` picks it up: full orchestrator runs inside the worker, writes results + transitions run status.
3. New `trpc.specs.pushStatus({runId})` polled by the UI (1.5s refetchInterval, 5-minute cutoff — same pattern as `insights.runStatus`).
4. UI gets a streaming progress affordance for free (counter on ConfirmDialog inFlight).

**Blocked by:** Real customer multi-tenancy. Defer until at least one PM reports a timeout on push, OR when the second paying account onboards.

---

## Cross-spec-version Linear export propagation (P2)

**What:** When `generateSpec` or `refineSpecStream` creates a new spec version row, `linear_project_id`/`linear_project_url`/`linear_issue_map` land as NULL on the new row. Refining a spec via the chat panel and re-pushing creates a brand-new Linear project, orphaning the prior one.

**Why:** UX gap explicitly documented in the design doc (`hamza-sanxore-linear-project-spec-export-design-20260514-160230.md`). The refinement-gap banner currently mitigates this by showing the prior project link, but PMs who refine + push accumulate orphan projects until manually deleted.

**How to close:** Add `propagateLinearExportFields(priorSpecId, newSpecId)` helper. Call from both `generateSpec` (after the version+1 upsert) and `refineSpecStream` (in the streaming completion handler). Copy linear_project_id / linear_project_url / linear_issue_map across versions if the new spec is materially similar (cosine similarity ≥ 0.7 on contentIr.summary embedding, or a simpler "title unchanged" heuristic). When propagation fires, the next push takes the update-in-place path via the D3 modal.

**Blocked by:** PM feedback on whether iteration semantics matter — Gauthier may want fresh-project-per-refinement.

---

## Citation deep-link snapshot for refinement-resilience (P3)

**What:** Spec citations link from Linear back to `${APP_URL}/insights?cluster=<id>`. Cluster refinement (MERGE/SPLIT in the clustering orchestrator) creates tombstones, so the link may 404 by the time an engineer clicks it from Linear.

**Why:** Linear has no in-app fallback like `CitationChip`'s "Cluster unavailable" — the link goes dead silently. PM-engineer trust degrades when half the citations stop working.

**How to close:** Capture a generation-time snapshot of cluster title alongside the link in the citation footnote, so dead links remain self-explanatory: `- [PM said X](url) — _cluster: "Mobile checkout bugs" (snapshot at generation)_`. Requires the spec generation orchestrator to denormalize cluster title at the citation. ~30 lines.

**Blocked by:** Need to see real cluster churn rates first; may not matter if refinement is rare in practice.

---

## AC checkbox state read-back from Linear (P3)

**What:** Engineers tick acceptance-criteria checkboxes in the Linear issue. On the next push, the renderer rebuilds the description from the spec IR — clobbering whatever they ticked. Currently documented in the issue description footnote: "AC checkbox state is rebuilt from the spec on every push."

**Why:** Real engineering teams use AC checkboxes as a working "definition of done" tracker. Clobbering ticks on every refinement breaks that workflow.

**How to close:** Before `issueUpdate`, read the current description from Linear (`issue.description` query). Parse out the `- [x]` / `- [ ]` state for each AC line. When emitting the new description, preserve the existing checkbox state for ACs whose text matches an existing one (fuzzy match on AC body). Adds 1 GraphQL read per issue per update — doubles update-mode latency.

**Blocked by:** PM-reported pain ("I tested this, why did my checkboxes vanish?"). Not worth the read-back cost until someone asks.
