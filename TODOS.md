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
