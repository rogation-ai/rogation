import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bindAccountToTx } from "@/db/scoped";
import { evidence, evidenceEmbeddings } from "@/db/schema";
import { embed } from "@/lib/llm/router";
import { inngest, EVENT_EMBED_REQUESTED, type EvidenceEmbedRequestedData } from "@/lib/inngest/client";

/*
  Background worker: embed a single evidence row.

  Triggered by the `evidence/embed.requested` event sent from
  ingestEvidence() when mode is "defer". The evidence row is already
  inserted (content + dedup hash), so the worker only needs to read
  the content, compute the embedding, and UPSERT the
  evidence_embedding row.

  Idempotency + retry:
    - Inngest retries transient failures (OpenAI 429/5xx, network)
      with exponential backoff, up to `retries` times.
    - The worker checks for an existing evidence_embedding row first
      and exits early if present — safe to re-run after a partial
      failure or an Inngest replay.
    - If the evidence row was deleted between event send and worker
      pickup, the worker exits silently (no-op).

  Why we still bind app.current_account_id:
    RLS is always on. The worker runs outside a user session, so it
    must assert the account context explicitly. This also keeps the
    worker from accidentally reading or writing across tenants if the
    event payload is ever malformed.
*/

// Inngest exported separately so tests can import the pure handler
// without the Inngest wrapper.
export async function runEmbedEvidence(input: {
  accountId: string;
  evidenceId: string;
}): Promise<{ status: "embedded" | "deduped" | "missing" }> {
  const { accountId, evidenceId } = input;

  return db.transaction(async (tx) => {
    await bindAccountToTx(tx, accountId);

    // Fast exit if we already embedded this row (replay, double-send,
    // or previous attempt that crashed after the INSERT).
    const [existing] = await tx
      .select({ evidenceId: evidenceEmbeddings.evidenceId })
      .from(evidenceEmbeddings)
      .where(eq(evidenceEmbeddings.evidenceId, evidenceId))
      .limit(1);

    if (existing) {
      return { status: "deduped" as const };
    }

    const [row] = await tx
      .select({ content: evidence.content })
      .from(evidence)
      .where(eq(evidence.id, evidenceId))
      .limit(1);

    if (!row) {
      // Row deleted between the send + the worker pickup. Not an
      // error — the user removed it from the library before we got
      // to embedding it. Nothing to do.
      return { status: "missing" as const };
    }

    const [vector] = await embed(row.content);
    if (!vector) {
      throw new Error(
        `Embedding provider returned no vector for evidence ${evidenceId}`,
      );
    }

    await tx.insert(evidenceEmbeddings).values({
      evidenceId,
      embedding: vector,
      model: "text-embedding-3-small",
    });

    return { status: "embedded" as const };
  });
}

export const embedEvidence = inngest.createFunction(
  {
    id: "embed-evidence",
    // OpenAI's embeddings endpoint allows ~3k req/min on our tier.
    // 10 concurrent workers is safe and keeps batch uploads moving
    // without a burst that could starve other API traffic.
    concurrency: { limit: 10 },
    // Retry transient provider failures. Inngest backs off
    // exponentially between attempts.
    retries: 4,
    triggers: [{ event: EVENT_EMBED_REQUESTED }],
  },
  async ({ event, step }) => {
    const data = event.data as EvidenceEmbedRequestedData;
    return step.run("embed", async () =>
      runEmbedEvidence({
        accountId: data.accountId,
        evidenceId: data.evidenceId,
      }),
    );
  },
);
