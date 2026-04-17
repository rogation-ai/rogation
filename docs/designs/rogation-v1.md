# Rogation v1 — Solution Design

**Status:** Draft · **Owner:** Hamza · **Last updated:** 2026-04-17
**Prior review:** `/plan-ceo-review` on 2026-04-17

---

## 1. Problem statement

Product Managers do not need to write documents faster. They need to turn fragmented and heterogeneous product signals into decisions that are:

1. Strategically defensible (evidence-backed, traceable)
2. Actionable for teams (clear enough to ship)
3. Easy to share across functions (eng, sales, support, exec)

Synthesis alone is not the full problem. Alignment across functions and permission to act are equally load-bearing. V1 focuses on synthesis + decision + spec export because that is the self-serve PM's immediate pain. Cross-functional views are Phase 3.

## 2. Target user (v1)

Individual Product Manager at a growth-stage SaaS company (50-300 employees).

- Self-serve, bottom-up adoption. Buyer = user. No IT approval needed.
- Has access to at least one of: Zendesk, PostHog/Amplitude/Mixpanel, Canny, interview recordings.
- Credit card discretion up to ~$100/mo without explicit approval.
- Works alongside eng/sales/support peers but does not need a shared workspace in v1.

**Not the v1 ICP:** VPs of Product, CPOs, enterprise buyers, teams requiring SOC2, PMs without access to any customer-facing data.

## 3. Competitive positioning

**Landscape snapshot (April 2026):**

| Tool | Synthesis | Decision | AI-native | Delivery model |
| ------ | ----------- | ---------- | ----------- | ---------------- |
| Productboard Spark | Strong | Strong | Yes | Enterprise-sold, IT approval |
| Mimir.build | Strong | Strong | Yes | Dev-tools flavored |
| Kraftful, Enterpret, Chattermill, Zeda | Partial | Partial | Mixed | Mid-market sold |
| Sentisum | Strong | Partial | Yes | Mid-market sold |
| Pendo Listen | Partial (analytics-led) | Partial | Partial | Enterprise-sold |

**Rogation's wedge vs Spark (the primary threat):**

Spark is enterprise-sold. Individual PMs at 50-300 person companies cannot buy it this afternoon. Rogation is self-serve, opinionated, card-swipe, and works Day 1 with zero IT involvement.

Landing page positioning:

> "Spark for when you have Productboard and a team. Rogation for when you have 20 interviews, a pile of support tickets, and a decision to make Friday."

**Existential risk:** If Productboard ships a self-serve $49/mo PM tier, the wedge closes. Monitor this monthly. Mitigation: move fast, integrate deeply into the individual PM's daily tools (Linear, Notion, Slack) before they do.

## 4. V1 scope

### The one job v1 does

Upload evidence → get clustered insights → pick what to build next → export a spec.

### Five screens

1. **Evidence library.** Upload, paste, connect. Normalized evidence rows with source, date, segment tag.
2. **Insights.** Clustered pain points. Frequency, severity, representative quotes, segment breakdown, contradictions surfaced.
3. **What to build.** Ranked opportunities with reasoning, cited sources, predicted impact (retention, revenue, activation), effort estimate, confidence score.
4. **Spec editor.** PRD + user stories + acceptance criteria + edge cases + QA checklist. Chat sidebar for iterative refinement. Readiness score flags missing edges. Export to Linear, Notion, or Markdown.
5. **Outcomes.** Manual metric entry or PostHog connection. Predicted vs actual chart. Feeds opportunity scoring confidence.

### What ships in v1

- Upload transcripts (Zoom export, Fireflies, Grain, plain text, PDF)
- Paste support tickets (bulk text, CSV)
- Three integrations: Zendesk, PostHog, Canny (personal API token only)
- Insight clustering with citations
- Opportunity scoring with 5 customizable weights + "reset to recommended"
- Spec generator with iterative refinement
- View-only public share links (30-day expiry)
- Export to Linear ticket, Notion page, Markdown
- Manual outcome entry + optional PostHog auto-pairing

### What does NOT ship in v1 (cut from original spec)

- Multi-tenant org workspace, org-owner role, approval workflows, status workflows
- SOC2, enterprise audit logs (keep lightweight activity log only)
- API for custom data ingestion
- Full RBAC with engineer/reviewer roles
- Comment threads, mentions, cross-functional views
- Deep enterprise integrations (Intercom workspace, Slack org, Mixpanel enterprise)
- Custom prompt versioning, prompt marketplaces

## 5. System architecture

```text
┌────────────────────────────────────────────────────────────┐
│ WEB APP (Next.js 15 + Tailwind + shadcn/ui)                │
│ 5 screens · share links · export to Linear/Notion/MD       │
└───────────────────────┬────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────┐
│ API (tRPC) · single-tenant-per-account · Clerk auth        │
└───┬────────────────┬───────────────┬───────────────────────┘
    │                │               │
    ▼                ▼               ▼
┌─────────┐   ┌──────────────┐   ┌──────────────────┐
│INGESTION│   │  SYNTHESIS   │   │   GENERATION     │
│ upload  │   │  cluster     │   │  opp score       │
│ parse   │   │  rank        │   │  spec gen        │
│ 3 integ │   │  cite        │   │  refine loop     │
└────┬────┘   └──────┬───────┘   └────────┬─────────┘
     │               │                     │
     ▼               ▼                     ▼
┌───────────────────────────────────────────────────────────┐
│ POSTGRES (evidence, insights, opps, specs, outcomes)      │
│ + pgvector (evidence embeddings)                          │
│ + S3-compat object store (raw transcripts/uploads)        │
│ + Inngest (background jobs: ingest, cluster, refresh)     │
└───────────────────────────────────────────────────────────┘
```

**Stack:**

- Web: Next.js 15 + Tailwind + shadcn/ui (YC-flavored, bold primary color, minimal)
- API: tRPC on Next.js API routes
- DB: Postgres (Supabase or Neon) + pgvector
- Background jobs: Inngest
- Auth: Clerk
- Payments: Stripe (self-serve checkout)
- LLM routing: Claude for synthesis (long-context wins), faster model for generation (speed + cost)
- Storage: Supabase Storage or S3
- Deploy: Vercel (web + API) + Neon/Supabase (DB) + Inngest Cloud (jobs)

**Trust boundary rule:** evidence content is low-trust input. Synthesis reads it, but never drives tool calls or executes generated text. All user-uploaded content is passed through a prompt-injection-safe template that treats it as data, not instructions.

## 6. Data model (v1)

```text
account(id, owner_user_id, plan, stripe_customer_id, created_at)
user(id, account_id, email, created_at)

evidence(id, account_id, source_type, source_ref, content,
         segment, date, created_at)
evidence_embedding(evidence_id, vector)

insight_cluster(id, account_id, title, description,
                severity, frequency, updated_at)
evidence_to_cluster(evidence_id, cluster_id, relevance_score)

opportunity(id, account_id, title, description, reasoning,
            impact_estimate, effort_estimate, score,
            confidence, status, updated_at)
opportunity_to_cluster(opportunity_id, cluster_id)
opportunity_score_weights(account_id, frequency_w, revenue_w,
                          retention_w, strategy_w, effort_w)

spec(id, opportunity_id, version, content_md,
     readiness_score, created_at)
outcome(id, opportunity_id, metric_name, metric_source,
        predicted, actual, measured_at)

activity_log(id, account_id, actor_user_id, action,
             entity_type, entity_id, created_at)
```

Everything else in the original spec's data model (organizations, roles, approvals, audit_events, prompt_versions, generated_artifacts polymorphism) moves to Phase 3+.

## 7. V1 success metrics

| Metric | Target |
| -------- | -------- |
| Time to first spec (median, from signup) | < 15 min |
| 7-day activation (signup → first spec exported) | ≥ 25% |
| Week-4 retention (any active action) | ≥ 40% |
| Free → paid conversion | ≥ 8% |
| In-product insight quality (positive feedback rate) | ≥ 60% |

Insight quality is measured by a thumbs-up/down on every generated insight and opportunity. This data feeds the internal eval set and the scoring model over time.

## 8. Pricing & GTM

### Pricing

- **Free.** 10 evidence uploads, 3 insights, 1 opportunity, 1 spec. Watermarked exports.
- **Solo — $49/mo ($39/mo annual).** Unlimited usage, 1 integration, Markdown export only.
- **Pro — $99/mo ($79/mo annual).** Unlimited integrations, Linear + Notion export, outcome tracking, share links without watermark.

Both tiers: card-swipe Stripe checkout. "Expense this" email template for the PM to send to their manager.

### Distribution channels

- Product Hunt launch
- PM Twitter (founder-led, build-in-public thread cadence)
- Lenny's Newsletter guest post + sponsorship
- Reddit r/ProductManagement
- YC alum Slack (if in network)
- SEO: long-tail PM decision queries ("how to prioritize support tickets", "what to build next from user interviews")

### Activation hook

"Upload your last 20 interviews. Get your top 3 opportunities in 10 minutes."

Landing page flow: signup → upload wizard with sample-data fallback → first insight in < 2 minutes → first opportunity in < 5 minutes → first spec export at the paywall.

## 9. Roadmap

| Phase | Timeline | Scope | Primary buyer |
| ------- | ---------- | ------- | --------------- |
| v1 | wk 1-12 | 5 screens, 3 integrations, upload-first | Individual PM |
| v2 | mo 4-6 | +5 integrations, outcome loop polish, basic team sharing ($149 team) | IC PM + 2-5 person team |
| v3 | mo 7-12 | Team workspace, lightweight approvals, SSO, cross-functional views ($499 team) | Head of Product |
| v4 | yr 2 | SOC2, RBAC, enterprise integrations, custom models, API | VPP at 500+ |

## 10. Top risks (ranked)

1. **Spark ships self-serve tier.** Existential. Ship fast, own the individual-PM integration graph.
2. **Insight quality ceiling.** Generic or hallucinated clustering kills retention. Week-1 investment in a 100-task labeled eval set, run on every prompt/model change.
3. **Low daily usage.** PMs aren't daily users. Weekly digest email drives re-engagement ("3 new insights since last week").
4. **LLM cost ceiling.** Synthesis is token-heavy. Cache embeddings, dedupe evidence, batch cluster refreshes, route generation to cheaper models.
5. **Output trust.** PMs distrust recommendations without sources. Click-through citations on every claim, confidence labels, and a visible "evidence considered / evidence ignored" breakdown.
6. **Prompt injection via uploads.** Separate synthesis (low-trust input) from action (generation) using structured intermediates. Evidence content never drives tool calls.
7. **PII in transcripts.** Optional PII redaction on upload. Data residency option in Pro. DPA available on request.
8. **Integration maintenance cost.** Every integration breaks. v1 caps at 3. Each new integration must have usage data proving ROI before adding.
9. **Thin-corpus problem.** PM uploads 3 interviews and gets weak insights. Minimum-evidence nudge + sample-data mode for "try before you upload."
10. **Segment budget.** $49/mo must clear typical PM card discretion. Validate with 10+ discovery interviews before launch.

## 11. Open decisions (resolved 2026-04-17)

All 8 decisions resolved after /plan-eng-review and /plan-design-review. All defaults accepted with refinements noted below.

1. **Which 3 integrations first?** **RESOLVED:** Zendesk, PostHog, Canny. Three-legged stool of evidence types (support, behavior, requests).
2. **LLM provider and routing.** **RESOLVED + LOCKED BY ENG REVIEW:** Claude for synthesis, faster/cheaper model for generation. Typed router with task tiers, retries, streaming, budget hook, and Anthropic cache_control.
3. **Clustering algorithm.** **RESOLVED + LOCKED BY ENG REVIEW:** Embed + KNN + LLM merge/split pass on touched clusters only. Cluster IDs stable across incremental re-clusters.
4. **Scoring formula customization.** **RESOLVED:** 5 weight sliders (Frequency, Revenue, Retention, Strategic fit, Effort) + "reset to recommended." Live re-rank debounced 300ms with ghosted previous ranking (design review). No arbitrary formulas in v1.
5. **Spec format.** **RESOLVED:** One opinionated template (PRD + user stories + acceptance criteria + edge cases + QA checklist). Export-only customization. No template editing in v1.
6. **Outcome tracking.** **RESOLVED:** Manual metric entry + optional PostHog auto-pair by metric name, with an explicit name-mapping UI dropdown when auto-pair misses. User-owned mappings persisted.
7. **Readiness score formula.** **RESOLVED + LOCKED BY DESIGN REVIEW:** Letter grade (A/B/C/D) + deterministic checklist (edges / validation / non-functional / acceptance testable) + LLM notes collapsible.
8. **Sharing model.** **RESOLVED:** View-only public links, 30-day expiry, no auth. Entropy-safe tokens + rate limit on `/s/*` + revocation on subscription cancel (locked by eng review critical-gap fix). No comment threads in v1.

## 12. Decisions rejected (explicitly not doing)

- **Building a multi-tenant workspace in v1.** ICP is individual PM. Workspace bloat delays the wedge.
- **SOC2 in v1.** Not required for card-swipe individual buyers. Deferred to v4.
- **API for custom ingestion.** Individual PMs don't integrate via API. Deferred to v4.
- **Enterprise integrations (Intercom org, Mixpanel enterprise, Slack org).** Personal-token only for v1.
- **PRD format customization.** One opinionated template in v1. Customization invites scope creep.
- **Full attribution for outcomes.** Manual + simple PostHog pairing only. Full attribution is a year-long project.
- **Cross-functional audience views.** Originally strong as a differentiator, deferred to v3 to keep v1 focused.

## 13. Appendix: Original spec delta

The original "AI specs to build Cursor for PM" document (attached to the `/plan-ceo-review` session on 2026-04-17) described a full enterprise-grade platform. This design narrows it materially for v1. The delta:

- Full enterprise platform → self-serve individual tool
- Multi-tenant + RBAC → single-tenant-per-account
- 8+ integrations → 3 integrations
- Comment/approval workflows → view-only share links
- SOC2 + audit → activity log
- API-first → web-app-first
- 12-18 month build → 12-week v1

Full original vision is preserved in the Phase 2-4 roadmap. V1 is the wedge.

## 14. Design specifications

Design system lives in the project's [DESIGN.md](../../DESIGN.md). This section adds plan-level design decisions that are specific to v1 behavior.

### 14.1 Information architecture (priority per screen)

Every screen declares what the user sees first, second, third. No screen ships without this.

- **Evidence library:** (1) coverage meter by source type + row count vs "thick enough" threshold, (2) filterable evidence table (source / date / segment), (3) upload / connect / paste entry points.
- **Insights:** (1) cluster title + compact metadata strip (Frequency · Severity · segments), (2) representative quotes as primary content body, (3) `Linked opportunities` card on right rail with `Turn into spec →` primary CTA, (4) `Show me why` citation trail button next to title, (5) contradictions surfaced inline where applicable.
- **What to build:** (1) ranked opportunity row with score + `ConfidenceBadge` + predicted impact, (2) cited insights beneath (via `CitationChip`), (3) effort estimate, (4) weight-slider sidebar with `Reset to recommended`.
- **Spec editor:** (1) `ReadinessGrade` (letter A/B/C/D + checklist + LLM notes) — the differentiator, always above the fold, (2) spec body with `StreamingCursor` during generation, (3) chat sidebar for iterative refinement, (4) export menu.
- **Outcomes:** (1) predicted-vs-actual delta per shipped opportunity, (2) metric source (manual / PostHog-paired), (3) entry / edit CTA.

### 14.2 Interaction state matrix

Every cell described in [DESIGN.md §7](../../DESIGN.md). Summary: each of the 5 app screens specifies loading, empty, partial, error, success, and limit-hit states. No "No items found" empty states. No spinners in place of skeletons.

### 14.3 User-journey fixes

Four emotional-arc breaks identified by design review, each with a v1 fix:

| # | Break | v1 fix |
| - | ----- | ------ |
| 1 | "90 seconds" promise with no in-product progress | Live per-stage status (parsing N files → embedding → clustering) + elapsed counter. Numbered progress bar from onboarding becomes the live status panel after upload. |
| 2 | Thin-corpus nudge appears after synthesis (letdown) | Move to upload screen: live counter ("6 more pieces for meaningful clusters") + sample-data fallback directly. Thin-corpus nudge on Insights stays as a dismissible top toast only when corpus is actually thin. |
| 3 | Blind paywall at first spec export | Show watermarked export preview (Linear / Notion / MD tabs) BEFORE Stripe checkout. Modal shows exactly what they're paying to unlock. |
| 4 | No celebratory moment at first spec | `FirstSpecMoment` component: success screen with the spec + "Share with your team" CTA + subtle confetti + weekly tip #1 teaser. Honors `prefers-reduced-motion`. |

### 14.4 Key interaction patterns (resolved)

| Decision | Resolution |
| -------- | ---------- |
| Citation affordance | Inline superscript numerals + hover popover with source preview + "View evidence" link. Tap = popover on mobile. |
| Readiness score format | Letter grade (A/B/C/D) + deterministic checklist (edges covered / validation / non-functional / acceptance testable) + LLM notes collapsible. |
| Plan-limit paywall | `PlanMeter` inline on every gated surface (e.g., "Evidence 7/10") + soft warn toast at 80% + blocking modal at 100% with plan comparison + export preview + "Start free trial" CTA. |
| Weight slider feedback | Live re-rank debounced 300ms, ghosted previous ranking visible during drag, `Reset to recommended` always visible. |
| Cluster-ID stability during re-cluster | `StaleBanner` top toast: "New evidence added — refresh clusters to include" + explicit refresh button. No auto-reshuffle. |
| Streaming spec generation | `StreamingCursor` blinks after last token while streaming. Stop button visible. Regenerate on error. Honors `prefers-reduced-motion`. |

### 14.5 Responsive posture

**Mobile-read, desktop-write.** Mobile (375–767px): browse evidence, read clusters, read/share specs, Stripe checkout, share-link view. Desktop (1024px+): full write experience. Tablet gracefully collapses to desktop-narrow. Mobile-blocked write actions show "Switch to desktop to [action]" — never a broken form.

### 14.6 Accessibility

**WCAG 2.2 AA across the board.** Keyboard navigation, ARIA landmarks, 44px touch targets, 4.5:1 body contrast, visible focus outline, honored `prefers-reduced-motion`. Enforced via `eslint-plugin-jsx-a11y` in CI, Storybook a11y addon, and a manual keyboard audit per screen before ship.

### 14.7 Brand voice

Editorial serif (Tiempos Headline / Fraunces) for display + strong sans (Söhne / Inter) for body + single warm red accent (`#D04B3F`). Marketing and app share one typographic voice — they are one product, not two. No purple/violet/indigo, no icons-in-colored-circles, no 3-column feature grids, no cookie-cutter section rhythm.

## 15. Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
| -------------- | ----------- | --------- | ----- |
| Landing page | `~/.gstack/projects/rogation-ai-rogation/designs/landing-20260417/variant-B.png` | Editorial serif, warm cream background, red accent, problem-naming headline, evidence-to-spec narrative cards | Implementation: scale the two mock panels to ~60% viewport width so the proof artifact becomes the visual anchor. Fix "ARGTION" typo in nav. Lighten nav-item weight vs primary CTA. |
| Onboarding upload wizard | `~/.gstack/projects/rogation-ai-rogation/designs/onboarding-upload-20260417/variant-A-v2.png` | Numbered progress bar, dropzone merging the 90s promise, "Or connect a source" row of three outlined logo-buttons (not cards), sample-data fallback | v2 applies the three litmus fixes. Implementation should also show live parsing/embedding/clustering status after upload (Journey fix #1). |
| Insights screen | `~/.gstack/projects/rogation-ai-rogation/designs/insights-20260417/variant-A-v2.png` | Left cluster rail, center with compact metadata strip + quotes as primary body + "Show me why" pill next to title, right-rail `Linked opportunities` card with `Turn into spec →` CTA, thin-corpus as dismissible top toast | v2 resolves "one job per section" and promotes the commercial CTA. Left-rail cluster names in v2 are placeholders; real copy will come from synthesis output. |

Remaining screens (Evidence library, What to build, Spec editor, Outcomes) to be mocked during wk 2 implementation per the information-architecture spec in §14.1 and the state matrix in DESIGN.md §7. Add a follow-up `/plan-design-review` pass before wk 2 build if they need visual validation.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| ------ | ------- | --- | ---- | ------ | -------- |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean (resolved 2026-04-17) | HOLD_SCOPE mode, all 8 Section 11 decisions resolved (6 accepted as default, 1 refined with name-mapping UI, 1 refined with rate-limit + revocation), 0 critical gaps |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (PLAN) | 17 issues surfaced + resolved, 2 critical gaps flagged (share-link + spec-chat rate limit), addressed via in-scope TODO |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 3/10 → 9/10, 18 decisions added, 9 mockups generated + 2 iterated to v2, DESIGN.md written |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 (all 8 Section 11 defaults walked and confirmed 2026-04-17)

**SCOPE EXPANSIONS FROM ENG REVIEW:** User pulled 4 items into v1 during TODO triage:

- Linear + Notion OAuth (not just personal tokens)
- PII redaction pipeline (optional at upload)
- Unit economics doc (before token-budget caps are finalized)
- Rate limiting on `/s/*` + spec-chat refinement (critical gap)

Expect ~1.5-2 weeks of additional build time on the 12-week plan. Consider whether timeline holds or something else moves to v1.1.

**KEY ARCHITECTURAL DECISIONS LOCKED IN:**

- Eval + prompt-tracing infra (Braintrust/Langfuse/Helicone) ships wk 1
- Per-account monthly token budget with soft/hard caps
- Clerk webhook → account creation; Stripe customer lazily on first upgrade; subscription state in Postgres
- Typed LLM router with task tiers, retries, streaming, budget hook, cache_control
- Untrusted evidence wrapped in XML tags + strict JSON output schema + no tool use in synthesis
- Incremental clustering: embed + KNN + LLM merge/split on touched clusters only (IDs stable)
- Sentry + eval tracing + PostHog from wk 1
- Git-backed prompt files + prompt_hash column on every generated entity
- tRPC middleware with `ctx.accountId` + `scoped(db)` helper + ESLint rule + Postgres RLS
- Encrypted-at-rest integration tokens with per-account DEK + KMS-backed KEK
- Single Spec IR + 3 thin renderers (Markdown, Linear, Notion)
- Per-provider Inngest function + unique (account_id, source_type, source_ref) index + cursor-based state
- New tables: `spec_refinement`, `entity_feedback`
- Plan limits in code + enforced in tRPC middleware
- Token-by-token streaming for spec gen (SSE)
- pgvector + HNSW + account-partitioned queries; v2 migration trigger at p95>500ms or >200 accounts
- Compound indexes on (account_id, created_at DESC) + unique ingestion index
- Anthropic prompt caching on evidence corpus blocks

**CRITICAL GAPS (flagged + addressed):**

- `/s/*` share-link enumeration → rate-limit added to v1 scope
- Spec-chat refinement abuse → rate-limit added to v1 scope

**SCOPE EXPANSIONS FROM DESIGN REVIEW:** User pulled 2 items into v1:

- Dark mode (full paired palette, toggle + `prefers-color-scheme`)
- Storybook for all 15 shared components (with a11y addon + visual regression)

Both pile on top of the eng review's 4 in-scope additions (OAuth, PII redaction, unit econ, rate limiting). Cumulative scope growth vs the original 12-week draft is ~3-4 weeks. Reassess timeline vs v1.1 deferrals.

**KEY DESIGN DECISIONS LOCKED IN:**

- DESIGN.md ships in v1 with tokens (type, color, spacing, radius, motion) + component inventory (15 shared primitives) + dark-mode paired palette
- Storybook ships wk 1 with a11y addon + visual regression; every shared component has a story for every state variant in light + dark
- One typographic voice across marketing + app: editorial serif (Tiempos / Fraunces) + sans (Söhne / Inter) + warm red accent (#D04B3F)
- Information architecture specified for all 5 app screens (Section 14.1)
- Full 5×6 interaction state matrix + 6 state-specific designs (DESIGN.md §7)
- 4 emotional-arc breaks fixed (live progress, thin-corpus upstream, export preview pre-paywall, first-spec celebratory moment)
- Citation affordance: inline superscript + hover popover + "View evidence" link
- Readiness score: A/B/C/D letter + deterministic checklist + LLM notes
- Plan-limit paywall: inline meter + 80% soft warn + 100% blocking modal with export preview
- Weight slider: live re-rank debounced 300ms + ghosted previous ranking + always-visible Reset
- Cluster-ID stability: StaleBanner + explicit refresh (no auto-reshuffle)
- Responsive posture: mobile-read, desktop-write (v1)
- Accessibility: WCAG 2.2 AA enforced via eslint-plugin-jsx-a11y + Storybook a11y addon + per-screen manual audit
- Approved mockups: landing-B (with scaling note), onboarding-A-v2, insights-A-v2

**APPROVED MOCKUPS:** see Section 15

**VERDICT:** ENG + DESIGN + CEO CLEARED. All Section 11 decisions resolved 2026-04-17. Ready to implement. Remaining screens (Evidence library, What to build, Spec editor, Outcomes) should get a follow-up /plan-design-review pass before wk 2 build.
