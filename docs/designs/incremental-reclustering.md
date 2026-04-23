# Incremental re-clustering (Phase B)

Status: design draft
Owner: Rogation core
Supersedes: `docs/designs/rogation-v1.md §5` (Phase A full re-cluster)
Prompt-hash touching: yes (new `synthesis-incremental` prompt)

## 1. Problem

`runFullClustering` throws above 50 evidence rows. A Pro PM uploading a 200-row Zendesk CSV hits the wall on their first real run. The v1 eng review locked in the incremental path as the answer. This doc specifies it.

Three goals, ranked:

1. **Scale past 50 rows** without blowing prompt size, latency, or token budget.
2. **Preserve `cluster.id`** across runs so `opportunity_to_cluster` FKs don't churn and PMs don't see their "Linked opportunities" rail empty after a re-cluster.
3. **Keep churn honest.** When a cluster legitimately merges or splits, tombstone the old id, don't silently rewrite history.

## 2. Non-goals

- Real-time clustering as each evidence row lands. Re-cluster stays user-triggered + Inngest-async.
- Cross-account clustering. RLS scope is per-account, always.
- Replacing the full-re-cluster path. Small corpora (≤ threshold) keep using it; the code stays.

## 3. Data flow

```
                                 ┌──────────────────────────────┐
 evidence (new + touched)────►   │  KNN vs existing clusters    │
                                 │  (centroids, cosine sim)     │
                                 └──────────────┬───────────────┘
                                                │
                   ┌────────────────────────────┼────────────────────────────┐
                   ▼                            ▼                            ▼
         sim >= HIGH_CONF            LOW_CONF <= sim < HIGH_CONF      sim < LOW_CONF
         attach to cluster           mark cluster "touched"           start "candidate new"
         (no LLM call)               (goes into LLM pass)             (goes into LLM pass)
                                                │
                                                ▼
                                  ┌─────────────────────────────┐
                                  │ LLM merge/split pass        │
                                  │ Input: touched clusters +   │
                                  │   their existing evidence + │
                                  │   new/uncertain evidence    │
                                  │ Output: KEEP | MERGE | SPLIT │
                                  │         | NEW               │
                                  └─────────────┬───────────────┘
                                                ▼
                                  ┌─────────────────────────────┐
                                  │ Apply actions in one tx:    │
                                  │  KEEP  → no-op              │
                                  │  MERGE → tombstone losers,  │
                                  │          re-parent edges    │
                                  │  SPLIT → keep origin,       │
                                  │          insert children,   │
                                  │          move edges         │
                                  │  NEW   → insert fresh id    │
                                  └─────────────────────────────┘
```

## 4. The four actions

The prompt returns one of these per cluster-or-candidate:

| Action | What it does | Cluster ID |
|---|---|---|
| KEEP | Evidence stays attached; title/description may be updated in place | Stable |
| MERGE | Two+ clusters collapse into one. Loser ids tombstoned. Winner absorbs edges. | Winner stable |
| SPLIT | One cluster becomes N. Original id kept as first child. Others fresh. | First child stable |
| NEW | Brand new cluster from unattached evidence | Fresh |

**Winner selection rule (deterministic):** highest `frequency`, tiebreak oldest `created_at`, tiebreak lowest UUID. Never let the LLM pick the winner — determinism matters for eval reproducibility.

## 5. Tombstoning (the cluster-id-stability plumbing)

Add `insight_cluster.tombstoned_into uuid null` (self-FK). When a cluster loses a MERGE, set `tombstoned_into = <winner>`, clear its evidence edges, don't delete the row. Opportunities pointing at the tombstoned id continue to resolve: when an opportunity reads its clusters, the query follows the tombstone chain once (`COALESCE(tombstoned_into, id)`).

**Why not delete:** `opportunity_to_cluster` cascades on delete. A cascade wipes the opportunity's evidence story even though the work was merged, not erased. PMs see "Linked opportunities" go empty. Tombstoning fixes that without schema-surgery on every table that references clusters.

**Eval impact:** `prompt_hash` on a KEEP cluster stays as whatever produced it. Only MERGE winners and NEW clusters get the new run's hash. This means "which prompt produced which row" stays honest per-cluster.

## 6. KNN mechanics

- Cluster centroid = mean of its evidence embeddings (1536-d). Stored as `insight_cluster.centroid vector(1536)` column (new). Recomputed whenever `evidence_to_cluster` edges change for that cluster.
- KNN for a new evidence row: `ORDER BY centroid <=> $newVec LIMIT 5` using HNSW on the centroid column.
- Thresholds (starting values, tune after first real corpus):
  - `HIGH_CONF` = 0.82 cosine sim → auto-attach, no LLM call
  - `LOW_CONF` = 0.65 → below this, candidate for NEW
  - Between = "uncertain", goes into the LLM pass

Thresholds live in `lib/evidence/clustering/thresholds.ts` (one const, not env) so they're versioned with the code and bisectable.

## 7. What triggers incremental vs full

```
if evidenceCount <= 50 AND no existing clusters:
  runFullClustering()    # cold start
elif evidenceCount <= 50 AND existing clusters:
  runIncrementalClustering()  # stability matters even for small corpora
else:
  runIncrementalClustering()  # required at scale
```

Rationale: once clusters exist, opportunities may reference them. We never want a user action to silently rewrite cluster ids.

## 8. Prompt budget math

Full re-cluster on 200 rows at avg 500 tokens/row = 100k input tokens. Sonnet 4.6 can do it but cache miss = $0.30+/run.

Incremental on same corpus, typical ingestion of ~10 new rows touches maybe 3 existing clusters. Prompt carries: 3 cluster titles + ~30 evidence blocks + 10 new/uncertain rows = ~20k tokens. ~5x cheaper, ~5x faster.

## 9. Data model changes

```diff
 insight_cluster (
   id, account_id, title, description, severity, frequency,
   contradictions, prompt_hash, stale, created_at, updated_at,
+  centroid vector(1536) null,             -- recomputed on edge change
+  tombstoned_into uuid null references insight_cluster(id)
 )

+index insight_cluster_centroid_hnsw on insight_cluster
+  using hnsw (centroid vector_cosine_ops)
+  where tombstoned_into is null;          -- don't match tombstones
```

No change to `evidence_to_cluster` (relevance_score column already there, finally gets real values).

## 10. Module layout

```
lib/evidence/
  synthesis.ts                 # existing: runFullClustering (unchanged)
  clustering/
    orchestrator.ts            # new: picks full vs incremental
    incremental.ts             # new: runIncrementalClustering
    knn.ts                     # new: centroid math + KNN query
    actions.ts                 # new: applyClusterActions (pure, tx-ready)
    thresholds.ts              # new: HIGH_CONF, LOW_CONF, constants
lib/llm/prompts/
  synthesis-cluster.ts         # existing (unchanged)
  synthesis-incremental.ts     # new prompt: KEEP/MERGE/SPLIT/NEW
```

Keep `runFullClustering` intact. The orchestrator is the only new public surface the tRPC router touches.

## 11. Prompt contract (`synthesis-incremental`)

Input:
```xml
<existing>
  <cluster id="C1" title="..." severity="high">
    <evidence id="E1">...</evidence>
    <evidence id="E2">...</evidence>
  </cluster>
</existing>
<candidate>
  <evidence id="E12" knn_nearest="C1 C3">...</evidence>
</candidate>
```

Output (strict JSON, same validation pattern as full re-cluster):
```json
{
  "actions": [
    { "type": "KEEP", "clusterId": "C1", "newTitle": null, "newDescription": null, "attachEvidence": ["E12"] },
    { "type": "MERGE", "winnerId": "C3", "loserIds": ["C5"], "newTitle": "...", "newDescription": "..." },
    { "type": "SPLIT", "originId": "C2", "children": [{"title":"...", "description":"...", "severity":"...", "evidenceIds":[...]}] },
    { "type": "NEW", "title": "...", "description": "...", "severity": "medium", "evidenceIds": ["E15","E16"] }
  ]
}
```

Every id in the output must resolve to something in the input. Validator rejects otherwise. Same trust-boundary pattern as `synthesis-cluster`: evidence content is CDATA'd, never flows into tool calls.

## 12. Failure modes

| Mode | Detection | Behavior |
|---|---|---|
| LLM returns unknown cluster id | validator pre-commit | abort run, no writes |
| LLM assigns same evidence to 2 clusters | validator pre-commit | abort |
| MERGE winner not in input | validator pre-commit | abort |
| Centroid out of date (race) | version column on cluster | re-read, re-run KNN once |
| Opportunity points at newly-tombstoned id | runtime query chases `tombstoned_into` | user sees opportunity unchanged |
| Evidence has no embedding yet (async worker queue) | skip from KNN pass, queue for next run | warn in run result |
| Budget exhausted mid-run | `ctx.assertBudget()` before LLM call | throw FORBIDDEN, no DB writes |

## 13. Tests

Unit (pure, no DB):
- `knn.centroidOf(embeddings[])` — empty, one, many, numeric stability
- `actions.validate(llmOutput, inputState)` — every rejection path
- `actions.pickWinner(clusters[])` — deterministic ordering
- `thresholds` — threshold constants documented with rationale

Integration (DB, `TEST_DATABASE_URL` required — depends on TODOS.md P1 fix):
- Cold start: no clusters + 30 evidence → runs full, creates N
- Warm run: existing 5 clusters + 3 new evidence, all HIGH_CONF → no LLM call, 3 attaches
- Merge scenario: 2 clusters + bridging evidence → 1 cluster, 1 tombstone, opportunities still resolve
- Split scenario: 1 cluster + diverging evidence → 2 clusters, original id preserved, opportunities point at first child
- Tombstone chain: opportunity → cluster → tombstoned_into → winner, resolves via COALESCE
- Cross-account isolation: account A's re-cluster never touches account B's centroids
- Budget guard: over-cap account gets FORBIDDEN, no partial writes
- Embed-pending evidence: row without embedding skipped, warned, not lost

E2E / eval:
- Corpus of 100 curated rows with known ground-truth clusters → regression baseline for `prompt_hash` changes

## 14. Rollout

1. Ship schema migration (`centroid`, `tombstoned_into`) + backfill centroids for existing clusters.
2. Ship `knn.ts` + `actions.ts` + `thresholds.ts` + unit tests. No callers yet.
3. Ship `synthesis-incremental.ts` prompt + validator. No callers yet.
4. Ship `incremental.ts` orchestrator behind an env flag `INCREMENTAL_CLUSTERING_ENABLED`.
5. Ship `orchestrator.ts` dispatching to full vs incremental. Keep flag default off.
6. Canary flip on one account (founder), watch 3 re-clusters, check eval baseline.
7. Flip flag on, remove flag in follow-up.

Each step is a separate bisectable commit.

## 15. Resolved decisions (2026-04-23)

1. **MERGE id stability.** Tombstone the loser, self-FK `tombstoned_into`, reads `COALESCE(tombstoned_into, id)`. Remap would silently rewrite opportunity paper trails.
2. **Centroid storage.** Stored `insight_cluster.centroid vector(1536)` column with HNSW, recomputed via `applyClusterActions` chokepoint. On-demand averaging doesn't scale past ~50 clusters/account.
3. **Cold-start rule.** `existingClusters == 0 AND evidenceCount <= 50` → `runFullClustering`. Everything else → `runIncrementalClustering`. Keeps the tested full path for cold start, uses incremental the moment cluster ids matter.
4. **Execution model.** Async via Inngest from day one. Sync on Vercel hits the 60s request ceiling on corpora of 200+, and the incremental path only exists because 50 rows isn't enough — shipping sync would guarantee a re-ship.

## 16. Async execution contract (decision 4 expanded)

```
trpc.insights.run(accountId)
  ├─ writes insight_run row (status="pending")
  ├─ sends event "insights/cluster.requested" { runId, accountId }
  └─ returns { runId }

Inngest fn (lib/inngest/functions/cluster-evidence.ts)
  ├─ on event "insights/cluster.requested"
  ├─ bindAccountToTx(accountId) inside RLS-scoped tx
  ├─ run orchestrator.run (full or incremental)
  ├─ on success: update insight_run status="done", counts, duration
  └─ on failure: status="failed", error message, Sentry capture

trpc.insights.runStatus(runId)
  └─ returns { status, clustersCreated, evidenceUsed, startedAt, finishedAt, error? }

Insights page
  ├─ on "Generate clusters" click → mutate run + read back runId
  ├─ poll runStatus every 1.5s while status in ("pending", "running")
  ├─ on "done" → invalidate clusters.list, hide banner
  └─ on "failed" → show error inline with retry
```

New table:

```
insight_run (
  id uuid pk,
  account_id uuid not null references account,
  status text not null,           -- pending | running | done | failed
  mode text not null,              -- "full" | "incremental"
  clusters_created int null,
  evidence_used int null,
  duration_ms int null,
  error text null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null
)
index insight_run_account_started on insight_run(account_id, started_at desc)
```

Concurrency: one running run per account. `insights.run` rejects with `CONFLICT` if a run row exists in `pending`/`running` state for this account. The worker clears it on completion or 5-minute heartbeat timeout.

Rate limit: reuse the existing Upstash pattern with a new `cluster-run` preset, 10/hour/account. Guards against accidental triple-click storms on the Generate button.

## 17. Rollout (revised)

1. Schema migration: `centroid`, `tombstoned_into`, `insight_run` table.
2. Backfill centroids for any existing clusters (one-off script, idempotent).
3. Ship `knn.ts` + `actions.ts` + `thresholds.ts` + unit tests. No callers yet.
4. Ship `synthesis-incremental.ts` prompt + validator. No callers yet.
5. Ship `incremental.ts` orchestrator + `runFullClustering` dispatch rule.
6. Ship Inngest function `cluster-evidence.ts` + `insight_run` writes.
7. Swap `trpc.insights.run` from sync orchestrator call to event emit + run row.
8. Ship Insights page polling + status UI.
9. Canary: run founder account through full → incremental → merge → split flows end-to-end.
10. Flip for all accounts, delete the feature flag.

Each step lands as a separate bisectable commit.

## 18. Eng review decisions (2026-04-23, locked)

Architecture:
- `applyClusterActions` is the single write path for cluster edges + centroid recompute. `runFullClustering` uses it too.
- `lib/evidence/clustering/resolve-cluster-id.ts > resolveClusterIds(ctx, ids[])` is the only place `COALESCE(tombstoned_into, id)` is spelled out. All readers batch through it.
- Inngest worker binds `app.current_account_id` via `bindAccountToTx(accountId)` from the event payload. Never bypasses RLS.
- Concurrency: `insights.run` CONFLICTs if a row in `pending`/`running` exists < 5 min old. No reaper — stale predicate handles it.
- Clustering waits for embeddings: the Inngest function fails fast with `ClusteringError { code: "embeddings_pending" }` if any account evidence lacks a vector. UI shows "Embeddings still processing" + retry.
- `prompt_hash` on KEEP updates iff `newTitle !== null || newDescription !== null`. Pure no-op KEEPs preserve the producing hash.
- Backfill script aborts with non-zero if any clustered evidence lacks an embedding.

Code quality:
- `lib/evidence/clustering/validators.ts > assertLabelsResolve` shared between `synthesis-cluster.ts` and `synthesis-incremental.ts`. Same pattern as spec validators.
- `ClusteringError { code: "unknown_label" | "duplicate_assignment" | "merge_winner_missing" | "centroid_stale" | "embeddings_pending" | "budget_exhausted" | "concurrent_run" }`. tRPC + Inngest map codes to typed UI errors.
- Thresholds are constants in `thresholds.ts`, not env vars. Change = commit = eval re-run.
- `insight_cluster.stale` column wired in: marked true when a cluster's evidence is > 14 days older than newest account evidence AND hasn't been a KEEP target in the latest run. Cleared by any action that touches it. `StaleBanner` reads this.

Tests:
- CI DB harness fix (TODOS.md P1) ships as commit 0. Unblocks 29/47 E2E tests for this feature.
- All 47 tests written up front. E2E tests are `test.skip()` with full spec bodies until harness lands.
- New `test/evals/incremental-clustering.eval.ts` with 100-row curated fixture establishes prompt baseline.

Performance:
- Partial HNSW index excludes tombstones: `WHERE tombstoned_into IS NULL`.
- `resolveClusterIds` batches with `id = ANY($1)`, returns `Map<oldId, finalId>`.
- Status polling uses exponential backoff: 1s → 2s → 4s, cap 4s.

## 19. NOT in scope

- Real-time clustering per evidence row. Stays user-triggered.
- Cross-account clustering. RLS is always per-account.
- Deleting `runFullClustering`. Cold-start path stays for corpora ≤ 50 with no existing clusters.
- Evidence de-clustering (removing from a cluster without reassigning). Evidence delete still cascades to `evidence_to_cluster` — no change there.
- Cluster renaming by hand. LLM owns title/description; PM can only thumbs-down + regenerate.
- Manual override UI to force a SPLIT or MERGE. Future commit if PMs ask.
- Realtime stream for run status (Inngest realtime or WS). Polling is fine at this scale.
- Phase C: drift detection that proactively re-runs clustering when corpus has drifted > X%.

## 20. What already exists (reused, not rebuilt)

- `evidenceEmbeddings` table + HNSW index: [db/schema.ts:206](../../db/schema.ts#L206) — reused directly.
- `insight_cluster.stale` + `contradictions` columns: already in initial migration, unused today. This plan wires `stale`.
- `embed()` in [lib/llm/router.ts](../../lib/llm/router.ts): unchanged.
- `complete()` + `definePrompt()` pattern: `synthesis-incremental.ts` uses it identically to `synthesis-cluster.ts`.
- `ctx.assertBudget()` + `ctx.chargeLLM()` + `ctx.assertLimit()`: identical call pattern.
- Inngest function scaffolding: [lib/inngest/functions/embed-evidence.ts](../../lib/inngest/functions/embed-evidence.ts) is the copy target.
- `bindAccountToTx()` in [db/scoped.ts](../../db/scoped.ts): the mechanism worker uses for RLS.
- `checkLimit()` in [lib/rate-limit.ts](../../lib/rate-limit.ts): new `cluster-run` preset joins existing table.
- `ClusteringError` mirrors `NotionApiError` / `LinearApiError` shape.

## 21. Failure modes (consolidated)

| Mode | Test covers | Error handling | User sees |
|---|---|---|---|
| LLM returns unknown cluster id | ✓ | pre-commit validator throws | retry button on /insights |
| LLM duplicate evidence assignment | ✓ | pre-commit validator throws | retry button |
| MERGE winner not in input | ✓ | pre-commit validator throws | retry button |
| SPLIT with 0 children | ✓ | pre-commit validator throws | retry button |
| Evidence embedding pending | ✓ | fail fast `embeddings_pending` | "Still embedding, retry in ~30s" |
| Budget exhausted mid-run | ✓ | `ctx.assertBudget()` pre-call | upgrade CTA |
| Concurrent run on same account | ✓ | CONFLICT from CONFLICT predicate | "Already running, wait" |
| Worker crashes mid-run | ✓ | 5-min stale predicate allows retry | retry button available after 5 min |
| Tombstone chain depth > 1 (merge of merge) | ✓ | `resolveClusterIds` follows chain, rejects infinite loop | invisible, opportunity still resolves |
| Centroid drift (race between edge write + read) | ✓ | `applyClusterActions` chokepoint; re-read on mismatch | invisible |
| Cross-account event payload | ✓ | RLS rejects, zero rows returned | worker errors, no data leak |

Critical gaps (no test + no error handling + silent failure): **0**.

## 22. Parallelization

| Lane | Modules | Depends on |
|---|---|---|
| 0 | `test/setup-db.ts`, `.github/workflows/ci.yml` (CI harness fix) | — |
| A | `lib/evidence/clustering/` (pure math + actions + validators) | — |
| B | `db/migrations/` (centroid, tombstoned_into, insight_run) | — |
| C | `lib/llm/prompts/synthesis-incremental.ts` + `test/evals/` | — |
| D | `lib/inngest/functions/cluster-evidence.ts` | A + B |
| E | `server/routers/insights.ts` + `app/(app)/insights/page.tsx` | D |
| F | Backfill script + rollout canary | B |

**Execution:** 0 first (unlocks tests). Then A + B + C in parallel worktrees. Then D. Then E + F in parallel.
**Conflict flags:** A and D both touch `lib/evidence/clustering/`; D imports from A so sequence, don't parallelize those two.

---

## Completion summary

- Step 0 Scope Challenge: scope accepted as-is (no reduction; incremental clustering is exactly what v1 plan locked in)
- Architecture Review: 8 checks, 5 issues → all 5 accepted
- Code Quality Review: 4 issues → all 4 accepted
- Test Review: diagram produced, 47 gaps → all to be written, CI harness bundled as commit 0, E2E as `test.skip()` with spec bodies
- Performance Review: 4 issues → 1 banked (batch resolver, already in Arch), 1 accepted (polling backoff)
- NOT in scope: 8 items written
- What already exists: 9 reuse points written
- TODOs.md updates: 0 proposed (all work is in scope of this plan)
- Failure modes: 11 tracked, 0 critical gaps
- Outside voice: skipped (user accepted every recommendation inline; deferring Codex to implementation-time code review)
- Parallelization: 7 lanes, 5 parallelizable after commit 0
- Lake Score: 10/10 recommendations chose complete option
