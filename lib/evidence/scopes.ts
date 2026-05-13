import { and, desc, eq, sql } from "drizzle-orm";
import { evidence, insightClusters, pmScopes } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import { embed } from "@/lib/llm/router";
import {
  routeAllEvidence,
  previewScopeMatches,
  type BulkRouteResult,
  type PreviewResult,
} from "@/lib/evidence/scope-routing";

export interface ScopeCtx {
  db: Tx;
  accountId: string;
}

export interface ScopeRow {
  id: string;
  name: string;
  brief: string;
  evidenceCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function listScopes(ctx: ScopeCtx): Promise<ScopeRow[]> {
  const rows = await ctx.db
    .select({
      id: pmScopes.id,
      name: pmScopes.name,
      brief: pmScopes.brief,
      createdAt: pmScopes.createdAt,
      updatedAt: pmScopes.updatedAt,
    })
    .from(pmScopes)
    .where(eq(pmScopes.accountId, ctx.accountId))
    .orderBy(desc(pmScopes.createdAt));

  if (rows.length === 0) return [];

  const counts = await ctx.db
    .select({
      scopeId: evidence.scopeId,
      count: sql<number>`count(*)::int`,
    })
    .from(evidence)
    .where(eq(evidence.accountId, ctx.accountId))
    .groupBy(evidence.scopeId);

  const countMap = new Map(
    counts
      .filter((c) => c.scopeId !== null)
      .map((c) => [c.scopeId, c.count]),
  );

  return rows.map((r) => ({
    ...r,
    evidenceCount: countMap.get(r.id) ?? 0,
  }));
}

export interface CreateScopeInput {
  name: string;
  brief: string;
}

export interface CreateScopeResult {
  id: string;
  isFirstScope: boolean;
  routeResult: BulkRouteResult;
}

export async function createScope(
  ctx: ScopeCtx,
  input: CreateScopeInput,
): Promise<CreateScopeResult> {
  const [existingCount] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(pmScopes)
    .where(eq(pmScopes.accountId, ctx.accountId));
  const isFirstScope = (existingCount?.n ?? 0) === 0;

  const [briefVec] = await embed(input.brief);

  const [row] = await ctx.db
    .insert(pmScopes)
    .values({
      accountId: ctx.accountId,
      name: input.name,
      brief: input.brief,
      briefEmbedding: briefVec ?? null,
    })
    .returning({ id: pmScopes.id });

  if (!row) throw new Error("Scope insert returned no row");

  const routeResult = await routeAllEvidence(ctx.db, ctx.accountId);

  if (isFirstScope) {
    await ctx.db
      .update(insightClusters)
      .set({ stale: true })
      .where(eq(insightClusters.accountId, ctx.accountId));
  }

  return { id: row.id, isFirstScope, routeResult };
}

export interface UpdateScopeInput {
  name?: string;
  brief?: string;
}

export interface UpdateScopeResult {
  id: string;
  briefChanged: boolean;
  routeResult?: BulkRouteResult;
}

export async function updateScope(
  ctx: ScopeCtx,
  scopeId: string,
  input: UpdateScopeInput,
): Promise<UpdateScopeResult> {
  const [existing] = await ctx.db
    .select({ brief: pmScopes.brief })
    .from(pmScopes)
    .where(
      and(eq(pmScopes.id, scopeId), eq(pmScopes.accountId, ctx.accountId)),
    )
    .limit(1);

  if (!existing) throw new Error("Scope not found");

  const briefChanged = input.brief !== undefined && input.brief !== existing.brief;
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (input.name !== undefined) updates.name = input.name;
  if (briefChanged) {
    updates.brief = input.brief;
    const [briefVec] = await embed(input.brief!);
    updates.briefEmbedding = briefVec ?? null;
  }

  await ctx.db
    .update(pmScopes)
    .set(updates)
    .where(
      and(eq(pmScopes.id, scopeId), eq(pmScopes.accountId, ctx.accountId)),
    );

  let routeResult: BulkRouteResult | undefined;
  if (briefChanged) {
    routeResult = await routeAllEvidence(ctx.db, ctx.accountId);
    await ctx.db
      .update(insightClusters)
      .set({ stale: true })
      .where(eq(insightClusters.accountId, ctx.accountId));
  }

  return { id: scopeId, briefChanged, routeResult };
}

export async function deleteScope(
  ctx: ScopeCtx,
  scopeId: string,
): Promise<{ id: string }> {
  const result = await ctx.db
    .delete(pmScopes)
    .where(
      and(eq(pmScopes.id, scopeId), eq(pmScopes.accountId, ctx.accountId)),
    )
    .returning({ id: pmScopes.id });

  if (result.length === 0) throw new Error("Scope not found");

  // Re-route remaining evidence (deleted scope's FK cascaded to NULL).
  // If other scopes exist, evidence may re-attach to them.
  const [scopeCount] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(pmScopes)
    .where(eq(pmScopes.accountId, ctx.accountId));

  if ((scopeCount?.n ?? 0) > 0) {
    await routeAllEvidence(ctx.db, ctx.accountId);
  }

  return { id: result[0]!.id };
}

export async function previewScope(
  ctx: ScopeCtx,
  brief: string,
): Promise<PreviewResult> {
  const [briefVec] = await embed(brief);
  if (!briefVec) return { matching: 0, total: 0 };
  return previewScopeMatches(ctx.db, ctx.accountId, briefVec);
}

export async function scopeCount(ctx: ScopeCtx): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(pmScopes)
    .where(eq(pmScopes.accountId, ctx.accountId));
  return row?.n ?? 0;
}
