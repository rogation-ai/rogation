import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { evidence, evidenceEmbeddings, pmScopes } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import { cosineSim } from "@/lib/evidence/clustering/knn";

export const SCOPE_THRESHOLD = 0.7;
export const MULTI_SCOPE_MARGIN = 0.05;

export interface ScopeRouteResult {
  evidenceId: string;
  scopeId: string | null;
  similarity: number;
}

export async function routeEvidenceToScope(
  db: Tx,
  accountId: string,
  evidenceId: string,
): Promise<ScopeRouteResult> {
  const scopes = await db
    .select({
      id: pmScopes.id,
      briefEmbedding: pmScopes.briefEmbedding,
    })
    .from(pmScopes)
    .where(
      and(
        eq(pmScopes.accountId, accountId),
        isNotNull(pmScopes.briefEmbedding),
      ),
    );

  if (scopes.length === 0) {
    return { evidenceId, scopeId: null, similarity: 0 };
  }

  const [embRow] = await db
    .select({ embedding: evidenceEmbeddings.embedding })
    .from(evidenceEmbeddings)
    .where(eq(evidenceEmbeddings.evidenceId, evidenceId))
    .limit(1);

  if (!embRow) {
    return { evidenceId, scopeId: null, similarity: 0 };
  }

  const scored = scopes
    .filter((s): s is typeof s & { briefEmbedding: number[] } =>
      Array.isArray(s.briefEmbedding),
    )
    .map((s) => ({
      scopeId: s.id,
      sim: cosineSim(embRow.embedding, s.briefEmbedding),
    }))
    .sort((a, b) => b.sim - a.sim);

  if (scored.length === 0 || scored[0]!.sim < SCOPE_THRESHOLD) {
    return { evidenceId, scopeId: null, similarity: scored[0]?.sim ?? 0 };
  }

  const bestScopeId = scored[0]!.scopeId;
  const bestSim = scored[0]!.sim;

  await db
    .update(evidence)
    .set({ scopeId: bestScopeId })
    .where(
      and(
        eq(evidence.id, evidenceId),
        eq(evidence.accountId, accountId),
      ),
    );

  return { evidenceId, scopeId: bestScopeId, similarity: bestSim };
}

export interface BulkRouteResult {
  routed: number;
  unscoped: number;
  total: number;
}

export async function routeAllEvidence(
  db: Tx,
  accountId: string,
): Promise<BulkRouteResult> {
  const scopes = await db
    .select({
      id: pmScopes.id,
      briefEmbedding: pmScopes.briefEmbedding,
    })
    .from(pmScopes)
    .where(
      and(
        eq(pmScopes.accountId, accountId),
        isNotNull(pmScopes.briefEmbedding),
      ),
    );

  const activeScopes = scopes.filter(
    (s): s is typeof s & { briefEmbedding: number[] } =>
      Array.isArray(s.briefEmbedding),
  );

  if (activeScopes.length === 0) {
    await db
      .update(evidence)
      .set({ scopeId: null })
      .where(eq(evidence.accountId, accountId));
    return { routed: 0, unscoped: 0, total: 0 };
  }

  const rows = await db
    .select({
      evidenceId: evidence.id,
      embedding: evidenceEmbeddings.embedding,
    })
    .from(evidence)
    .innerJoin(
      evidenceEmbeddings,
      eq(evidenceEmbeddings.evidenceId, evidence.id),
    )
    .where(eq(evidence.accountId, accountId));

  let routed = 0;
  let unscoped = 0;

  for (const row of rows) {
    const scored = activeScopes
      .map((s) => ({
        scopeId: s.id,
        sim: cosineSim(row.embedding, s.briefEmbedding),
      }))
      .sort((a, b) => b.sim - a.sim);

    const best = scored[0]!;
    const assignedScopeId = best.sim >= SCOPE_THRESHOLD ? best.scopeId : null;

    await db
      .update(evidence)
      .set({ scopeId: assignedScopeId })
      .where(eq(evidence.id, row.evidenceId));

    if (assignedScopeId) {
      routed++;
    } else {
      unscoped++;
    }
  }

  // Evidence without embeddings stays unscoped
  const noEmbRows = await db
    .select({ id: evidence.id })
    .from(evidence)
    .leftJoin(
      evidenceEmbeddings,
      eq(evidenceEmbeddings.evidenceId, evidence.id),
    )
    .where(
      and(
        eq(evidence.accountId, accountId),
        isNull(evidenceEmbeddings.evidenceId),
      ),
    );

  unscoped += noEmbRows.length;

  return { routed, unscoped, total: rows.length + noEmbRows.length };
}

export interface PreviewResult {
  matching: number;
  total: number;
}

export async function previewScopeMatches(
  db: Tx,
  accountId: string,
  briefEmbedding: number[],
): Promise<PreviewResult> {
  const rows = await db
    .select({
      embedding: evidenceEmbeddings.embedding,
    })
    .from(evidence)
    .innerJoin(
      evidenceEmbeddings,
      eq(evidenceEmbeddings.evidenceId, evidence.id),
    )
    .where(eq(evidence.accountId, accountId));

  let matching = 0;
  for (const row of rows) {
    const sim = cosineSim(row.embedding, briefEmbedding);
    if (sim >= SCOPE_THRESHOLD) matching++;
  }

  return { matching, total: rows.length };
}
