# TODOs

Deferred work items captured during planning. Each has context so someone picking it up months later understands the motivation, current state, and where to start.

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
