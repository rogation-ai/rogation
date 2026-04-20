import { and, eq } from "drizzle-orm";
import { evidence, evidenceEmbeddings } from "@/db/schema";
import type { evidenceSourceType } from "@/db/schema";
import { embed } from "@/lib/llm/router";
import type { PlanTier } from "@/lib/plans";
import { assertResourceLimit } from "@/lib/plans";
import type { Tx } from "@/db/scoped";
import {
  hashEvidenceContent,
  normalizeEvidenceText,
} from "@/lib/evidence/hash";
import { inngest, EVENT_EMBED_REQUESTED } from "@/lib/inngest/client";

/*
  Shared ingestion pipeline. Paste (tRPC) and file upload (Route
  Handler) both funnel through this so their semantics can't drift.

  Contract:
    1. assertResourceLimit("evidence") — throws FORBIDDEN at cap.
    2. Normalize text + SHA-256 content hash.
    3. Dedup by (accountId, contentHash) — return existing id with
       deduped: true.
    4. Insert the evidence row inside the caller's RLS-bound tx.
    5. Embed with OpenAI text-embedding-3-small (1536-d). Store in
       evidence_embedding.

  Separation of concerns:
    - The caller owns the transaction + RLS binding. This function
      expects a Tx where `app.current_account_id` is already set.
    - The caller owns plan-limit + budget enforcement at batch scope;
      this helper enforces per-item resource cap only.
*/

export type EvidenceSourceType =
  (typeof evidenceSourceType.enumValues)[number];

export interface IngestContext {
  db: Tx;
  accountId: string;
  plan: PlanTier;
}

export interface IngestInput {
  content: string;
  sourceType: EvidenceSourceType;
  /** Stable identifier for ingestion idempotency (e.g. filename). */
  sourceRef?: string;
  segment?: string;
  /** Optional metadata date for the evidence (e.g. interview timestamp). */
  date?: Date;
  /**
   * How to produce the 1536-d embedding:
   *   - "sync" (default): embed inside this transaction. Adds ~200ms
   *     per row. Right for paste (one row, user is watching).
   *   - "defer": emit an `evidence/embed.requested` Inngest event and
   *     return. The worker embeds out of band. Right for batch
   *     uploads so a 20-file import doesn't burn the request's
   *     serverless budget on OpenAI round-trips.
   */
  embed?: "sync" | "defer";
}

export interface IngestResult {
  id: string;
  deduped: boolean;
}

export async function ingestEvidence(
  ctx: IngestContext,
  input: IngestInput,
): Promise<IngestResult> {
  const normalized = normalizeEvidenceText(input.content);
  const contentHash = hashEvidenceContent(input.content);

  if (normalized.length === 0) {
    throw new Error("Cannot ingest empty content");
  }

  // Dedup FIRST, plan-limit AFTER. A re-ingest of an existing row
  // shouldn't count against the cap — otherwise "Use sample data"
  // at 10/10 throws FORBIDDEN on sample #1 instead of returning
  // `deduped: true` for all 10 (bug found 2026-04-18 QA).
  //
  // Concurrent identical pastes/uploads can still race past this; the
  // UNIQUE(account_id, source_type, source_ref) index is the last line
  // of defense (schema migration 0000).
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

  // Only NEW rows count against the plan cap.
  await assertResourceLimit(ctx.db, ctx.plan, ctx.accountId, "evidence");

  const sourceRef = input.sourceRef ?? `content:${contentHash.slice(0, 12)}`;

  const [row] = await ctx.db
    .insert(evidence)
    .values({
      accountId: ctx.accountId,
      sourceType: input.sourceType,
      sourceRef,
      content: normalized,
      contentHash,
      segment: input.segment,
      date: input.date,
      parseStatus: "ready",
    })
    .returning({ id: evidence.id });

  if (!row) {
    throw new Error("Evidence insert returned no row");
  }

  const embedMode = input.embed ?? "sync";

  if (embedMode === "sync") {
    // Paste path: one row, user is watching, ~200ms is fine. Worth
    // doing inside the tx so a failed embed rolls the row back —
    // retry the paste and you don't end up with an un-embedded row
    // stranded in the library.
    const [vector] = await embed(normalized);
    if (vector) {
      await ctx.db.insert(evidenceEmbeddings).values({
        evidenceId: row.id,
        embedding: vector,
        model: "text-embedding-3-small",
      });
    }
  } else {
    // Batch / upload path: defer. The evidence row is already
    // inserted so dedup + plan-meter + library list all reflect it
    // immediately. The Inngest worker inserts evidence_embedding
    // when it fires, with its own retry + backoff on provider
    // failures. Clustering (Phase A) reads raw content, so a brief
    // window without an embedding doesn't break anything —
    // KNN-based incremental re-cluster (Phase B) will skip un-embedded
    // rows until the worker catches up.
    //
    // Emitted AFTER the row insert so Inngest can never try to embed
    // an evidence_id that doesn't exist yet. If this call throws
    // (event key missing, Inngest down), the tx rolls back and the
    // caller sees the failure — better than leaving a dangling row.
    await inngest.send({
      name: EVENT_EMBED_REQUESTED,
      data: { accountId: ctx.accountId, evidenceId: row.id },
    });
  }

  return { id: row.id, deduped: false };
}
