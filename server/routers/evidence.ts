import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { evidence, evidenceToCluster, insightClusters } from "@/db/schema";
import { ingestEvidence } from "@/lib/evidence/ingest";
import {
  markDownstreamStale,
  recomputeClusterAggregates,
} from "@/lib/evidence/clustering/apply";
import { seedSampleEvidence } from "@/lib/evidence/sample-seed";
import { withScopeFilter } from "@/lib/evidence/scope-filter";
import { countResource } from "@/lib/plans";
import { authedProcedure, router } from "@/server/trpc";

/*
  Evidence tRPC router.

  The paste mutation delegates to `ingestEvidence()` from
  lib/evidence/ingest.ts so the paste + file-upload (Route Handler)
  paths share the exact same dedup + insert + embed pipeline. The
  router's job is input validation + error wrapping; ingest owns the
  write path.
*/

const MAX_PASTE_BYTES = 128 * 1024; // 128 KB per paste — generous for transcripts.

export const evidenceRouter = router({
  paste: authedProcedure
    .input(
      z.object({
        content: z
          .string()
          .min(1, "Paste at least one character")
          .refine(
            (s) => Buffer.byteLength(s, "utf8") <= MAX_PASTE_BYTES,
            {
              message:
                "Content exceeds 128 KB; upload as a file instead",
            },
          ),
        sourceRef: z.string().min(1).optional(),
        segment: z.string().max(128).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ingestEvidence(
        {
          db: ctx.db,
          accountId: ctx.accountId,
          plan: ctx.plan,
        },
        {
          content: input.content,
          sourceType: "paste_ticket",
          sourceRef: input.sourceRef,
          segment: input.segment,
        },
      );
    }),

  list: authedProcedure
    .input(
      z.object({
        limit: z.number().int().positive().max(100).default(50),
        cursor: z.string().datetime().optional(),
        scopeId: z.string().uuid().or(z.literal("unscoped")).nullish(),
        showExcluded: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const scopeWhere = withScopeFilter(input.scopeId, evidence.scopeId);
      const excludedWhere = input.showExcluded
        ? eq(evidence.excluded, true)
        : eq(evidence.excluded, false);
      const rows = await ctx.db
        .select({
          id: evidence.id,
          sourceType: evidence.sourceType,
          sourceRef: evidence.sourceRef,
          content: evidence.content,
          segment: evidence.segment,
          scopeId: evidence.scopeId,
          excluded: evidence.excluded,
          exclusionPending: evidence.exclusionPending,
          createdAt: evidence.createdAt,
        })
        .from(evidence)
        .where(and(eq(evidence.accountId, ctx.accountId), scopeWhere, excludedWhere))
        .orderBy(desc(evidence.createdAt))
        .limit(input.limit);

      const nextCursor =
        rows.length === input.limit ? rows[rows.length - 1]?.createdAt : null;

      return { rows, nextCursor };
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Capture cluster ids the evidence was attached to BEFORE the
      // cascade wipes evidence_to_cluster — we need them to recompute
      // each cluster's frequency + centroid post-delete. Without this,
      // clusters keep stale aggregates (and stale rows show up in
      // /insights even after their evidence is gone).
      const edges = await ctx.db
        .select({ clusterId: evidenceToCluster.clusterId })
        .from(evidenceToCluster)
        .where(eq(evidenceToCluster.evidenceId, input.id));
      const affectedClusterIds = Array.from(
        new Set(edges.map((e) => e.clusterId)),
      );

      const result = await ctx.db
        .delete(evidence)
        .where(
          and(
            eq(evidence.id, input.id),
            eq(evidence.accountId, ctx.accountId),
          ),
        )
        .returning({ id: evidence.id });

      if (result.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Evidence not found",
        });
      }

      for (const clusterId of affectedClusterIds) {
        await recomputeClusterAggregates(ctx.db, clusterId, ctx.accountId);
      }

      // Fan out staleness for clusters that transitioned to orphaned
      // (frequency = 0) by this delete. Same semantics as MERGE/SPLIT/
      // tombstone in apply.ts: the source data shifted, so linked
      // opportunities + specs need a "regen to refresh" flag. Skip
      // partial-shrink cases (cluster of 50 lost 1 evidence) — too
      // noisy and the cluster is still represented.
      if (affectedClusterIds.length > 0) {
        const orphanedRows = await ctx.db
          .select({ id: insightClusters.id })
          .from(insightClusters)
          .where(
            and(
              eq(insightClusters.accountId, ctx.accountId),
              inArray(insightClusters.id, affectedClusterIds),
              eq(insightClusters.frequency, 0),
            ),
          );
        if (orphanedRows.length > 0) {
          await markDownstreamStale(
            ctx.db,
            ctx.accountId,
            new Set(orphanedRows.map((r) => r.id)),
          );
        }
      }

      return { id: result[0]!.id };
    }),

  /** Quick count, cheaper than list(). Drives the onboarding stepper. */
  count: authedProcedure.query(async ({ ctx }) => {
    const count = await countResource(ctx.db, "evidence", ctx.accountId);
    return { count };
  }),

  /**
   * Seed a curated 15-piece sample corpus so a new account can see
   * clusters + opportunities + specs end-to-end without bringing
   * their own data. Idempotent — re-running returns deduped counts.
   */
  seedSample: authedProcedure.mutation(async ({ ctx }) => {
    return seedSampleEvidence({
      db: ctx.db,
      accountId: ctx.accountId,
      plan: ctx.plan,
    });
  }),
});
