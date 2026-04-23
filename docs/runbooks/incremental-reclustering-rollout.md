# Incremental re-clustering rollout

Ordered checklist for shipping the incremental re-cluster pipeline (Lanes A-F) to production. Run top-to-bottom. Stop on the first failure and triage before proceeding.

Design: [docs/designs/incremental-reclustering.md](../designs/incremental-reclustering.md).

## 1. Pre-deploy gate

- [ ] Lanes A-E merged into `main`.
- [ ] `db/migrations/0006_incremental_reclustering.sql` applied in prod (Drizzle's `drizzle_migrations` table shows `0006` as latest).
- [ ] Vercel env vars set: `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- [ ] `/api/inngest` route returns 200 on the production URL (Inngest uses this to register functions on deploy).

## 2. Dry-run backfill (staging or local against a prod snapshot)

```bash
DATABASE_URL=<prod_snapshot_url> bun run scripts/backfill-centroids.ts --dry-run --limit=50
```

Expected: `Found N clusters with NULL centroid`. `updated` + `skipped_empty` should sum to the scanned count. `failed=0`.

If `failed > 0`, read the per-cluster error lines and investigate before the real run.

## 3. Real backfill

```bash
DATABASE_URL=<prod_url> bun run scripts/backfill-centroids.ts
```

Expected: same counts as the dry-run, zero failures. Progress logs every 100 clusters.

If `failed > 0`, the script exits non-zero. Fix the root cause (usually a malformed embedding), re-run — backfill is idempotent.

## 4. Spot-check

```sql
SELECT COUNT(*) FROM insight_cluster
WHERE centroid IS NULL AND tombstoned_into IS NULL;
```

Expected: 0, or only clusters whose `frequency = 0` (no attached evidence — leaving centroid NULL is correct).

```sql
SELECT COUNT(*) FROM insight_cluster
WHERE centroid IS NULL AND tombstoned_into IS NULL AND frequency > 0;
```

Must return 0. Any non-zero row here is a bug: a cluster has attached evidence but no centroid.

## 5. Canary dispatch

1. Sign in to the production app as a test account with existing clusters + evidence.
2. Navigate to `/insights`. Click "Refresh clusters" (or "Generate clusters" on a thin corpus).
3. Confirm in parallel:
   - Inngest dashboard (cloud.inngest.com) shows the `insights/cluster.requested` event and the `cluster-evidence` function run.
   - The run transitions pending → running → done within 10-30s.
   - The UI polls every 1.5s and swaps to the refreshed cluster list on completion.
4. Reload the page mid-run. The "Clustering…" indicator should resume via `latestRun`.

If any of these fail, jump to rollback (§7).

## 6. Observability (first 24h post-deploy)

- Sentry: filter by `category:clustering` or `ClusteringError`. Any new `embeddings_pending`, `centroid_stale`, or unexpected throws → investigate.
- Langfuse: confirm the `synthesis-incremental` prompt hash appears in traces with reasonable token counts.
- Inngest dashboard: worker failure rate. Retries are 0 (design §4), so every failure surfaces immediately as a failed `insight_run` row.

## 7. Rollback

If the async path is broken:

1. Revert the Lane E PR (tRPC dispatch + polling UI). `trpc.insights.run` reverts to synchronous `runClustering(...)`.
2. Leave Lane D and the backfilled centroids in place. The sync path uses `runFullClustering` → `applyClusterActions` unchanged; backfilled centroids help the future incremental path and never break the full path.
3. No DB rollback needed. `insight_run` rows from the async window stay — they're just unreferenced history.

Rolling back Lane D or earlier is a data migration and out of scope here — it would require re-running full clustering to regenerate cluster ids, since incremental preserves ids the full path doesn't.
