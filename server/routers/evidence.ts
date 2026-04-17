import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { evidence, evidenceEmbeddings } from "@/db/schema";
import { hashEvidenceContent, normalizeEvidenceText } from "@/lib/evidence/hash";
import { embed } from "@/lib/llm/router";
import { countResource } from "@/lib/plans";
import { authedProcedure, router } from "@/server/trpc";

/*
  Evidence ingestion. First feature router.

  Paste path is wired here (synchronous embed + insert); file upload
  lands in a follow-up commit with the `/api/evidence/upload` Route
  Handler (multipart needs special plumbing that sits outside tRPC).

  Every write:
    1. assertLimit("evidence") — throws FORBIDDEN at the Free 10-row cap.
    2. Normalize + SHA-256 content → dedup against
       (account_id, content_hash). Return the existing row on dup.
    3. Insert evidence row via RLS-bound tx.
    4. embed() via the LLM router, store the 1536-d vector in
       evidence_embedding. No accountId on the child table; the RLS
       policy on evidence_embedding joins through the parent.

  Embedding is synchronous for v1. Once batch uploads are real, the
  Inngest worker takes over and this router just queues the job.
*/

const MAX_CONTENT_BYTES = 128 * 1024; // 128 KB per paste — generous for transcripts.

export const evidenceRouter = router({
  paste: authedProcedure
    .input(
      z.object({
        content: z
          .string()
          .min(1, "Paste at least one character")
          .refine(
            (s) => Buffer.byteLength(s, "utf8") <= MAX_CONTENT_BYTES,
            { message: "Content exceeds 128 KB; upload as a file instead" },
          ),
        sourceRef: z.string().min(1).optional(),
        segment: z.string().max(128).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.assertLimit("evidence");

      const normalized = normalizeEvidenceText(input.content);
      const contentHash = hashEvidenceContent(input.content);

      // Dedup: if this account already has this content, return the
      // existing row instead of counting twice against the cap.
      const [existing] = await ctx.db
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.accountId, ctx.accountId),
            eq(evidence.contentHash, contentHash),
          ),
        )
        .limit(1);

      if (existing) {
        return { id: existing.id, deduped: true };
      }

      const sourceRef =
        input.sourceRef ?? `paste:${contentHash.slice(0, 12)}`;

      const [row] = await ctx.db
        .insert(evidence)
        .values({
          accountId: ctx.accountId,
          sourceType: "paste_ticket",
          sourceRef,
          content: normalized,
          contentHash,
          segment: input.segment,
          parseStatus: "ready",
        })
        .returning({ id: evidence.id });

      if (!row) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Evidence insert returned no row",
        });
      }

      // Embed synchronously so the Insights page gets a complete view.
      // Chargeable against the monthly token budget (ctx.chargeLLM
      // handles the soft / hard cap), but embed() uses OpenAI so it
      // bypasses the Anthropic-flavored router. Direct token accounting
      // for embeddings lands with the Inngest worker rewrite.
      const [vector] = await embed(normalized);
      if (vector) {
        await ctx.db.insert(evidenceEmbeddings).values({
          evidenceId: row.id,
          embedding: vector,
          model: "text-embedding-3-small",
        });
      }

      return { id: row.id, deduped: false };
    }),

  list: authedProcedure
    .input(
      z.object({
        limit: z.number().int().positive().max(100).default(50),
        cursor: z.string().datetime().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: evidence.id,
          sourceType: evidence.sourceType,
          sourceRef: evidence.sourceRef,
          content: evidence.content,
          segment: evidence.segment,
          createdAt: evidence.createdAt,
        })
        .from(evidence)
        .where(eq(evidence.accountId, ctx.accountId))
        .orderBy(desc(evidence.createdAt))
        .limit(input.limit);

      const nextCursor =
        rows.length === input.limit ? rows[rows.length - 1]?.createdAt : null;

      return { rows, nextCursor };
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
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
        // RLS keeps cross-account deletes impossible; this means the
        // row never existed for this account.
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Evidence not found",
        });
      }

      return { id: result[0]!.id };
    }),

  /** Quick count, cheaper than list(). Drives the onboarding stepper. */
  count: authedProcedure.query(async ({ ctx }) => {
    const count = await countResource(ctx.db, "evidence", ctx.accountId);
    return { count };
  }),
});
