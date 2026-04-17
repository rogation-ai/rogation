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
}

export interface IngestResult {
  id: string;
  deduped: boolean;
}

export async function ingestEvidence(
  ctx: IngestContext,
  input: IngestInput,
): Promise<IngestResult> {
  await assertResourceLimit(ctx.db, ctx.plan, ctx.accountId, "evidence");

  const normalized = normalizeEvidenceText(input.content);
  const contentHash = hashEvidenceContent(input.content);

  if (normalized.length === 0) {
    throw new Error("Cannot ingest empty content");
  }

  // Dedup — the router + upload handler both check here before write.
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

  // Synchronous embed for v1. Batch uploads hit OpenAI's rate limit
  // at ~200 req/min — the Inngest worker in a follow-up moves this
  // off the request path.
  const [vector] = await embed(normalized);
  if (vector) {
    await ctx.db.insert(evidenceEmbeddings).values({
      evidenceId: row.id,
      embedding: vector,
      model: "text-embedding-3-small",
    });
  }

  return { id: row.id, deduped: false };
}
