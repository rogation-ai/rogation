import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  evidence,
  evidenceToCluster,
  insightClusters,
  opportunities as opportunitiesTbl,
  opportunityToCluster,
  specRefinements,
  specs,
} from "@/db/schema";
import { complete, completeStream, type CompleteOpts } from "@/lib/llm/router";
import { specGenerate } from "@/lib/llm/prompts/spec-generate";
import { specRefine } from "@/lib/llm/prompts/spec-refine";
import { gradeSpec, type ReadinessChecklist } from "@/lib/spec/readiness";
import { renderSpecMarkdown } from "@/lib/spec/renderers/markdown";
import type { SpecIR } from "@/lib/spec/ir";
import type { Tx } from "@/db/scoped";

/*
  Spec orchestrator.

  One entry point — generateSpec(ctx, opportunityId) — that:
    1. Reads the opportunity + its linked clusters + ~3 quotes/cluster.
    2. Calls spec-generate (Haiku, task="generation").
    3. Grades the returned IR deterministically (lib/spec/readiness).
    4. Renders Markdown once, stores it alongside the IR so exports
       never need to re-render from stale IR.
    5. UPSERTs on (opportunityId, version). Every regeneration bumps
       version; the editor reads the latest.

  Streaming + refinement chat live in separate commits. This is the
  blocking path — you click "Generate spec" and wait ~10-30s.

  Citations validation: the prompt's parse() only checks per-criterion
  references. This orchestrator additionally enforces that every
  clusterId echoed back in citations[] is a real cluster UUID from
  what we sent in. Defense against a stray UUID hallucination.
*/

const QUOTES_PER_CLUSTER = 3;
const MAX_CLUSTERS_PER_SPEC = 20;

export interface SpecCtx {
  db: Tx;
  accountId: string;
}

export interface SpecGenerateResult {
  specId: string;
  version: number;
  grade: "A" | "B" | "C" | "D";
  ir: SpecIR;
  markdown: string;
  promptHash: string;
}

export async function generateSpec(
  ctx: SpecCtx,
  opportunityId: string,
  opts: CompleteOpts = {},
): Promise<SpecGenerateResult> {
  const [opp] = await ctx.db
    .select({
      id: opportunitiesTbl.id,
      title: opportunitiesTbl.title,
      description: opportunitiesTbl.description,
      reasoning: opportunitiesTbl.reasoning,
      impactEstimate: opportunitiesTbl.impactEstimate,
      effortEstimate: opportunitiesTbl.effortEstimate,
    })
    .from(opportunitiesTbl)
    .where(
      and(
        eq(opportunitiesTbl.id, opportunityId),
        eq(opportunitiesTbl.accountId, ctx.accountId),
      ),
    )
    .limit(1);

  if (!opp) {
    throw new Error(
      `Opportunity ${opportunityId} not found (or belongs to another account)`,
    );
  }

  const clusterLinks = await ctx.db
    .select({ clusterId: opportunityToCluster.clusterId })
    .from(opportunityToCluster)
    .where(eq(opportunityToCluster.opportunityId, opportunityId));

  const clusterIds = clusterLinks.map((l) => l.clusterId);
  if (clusterIds.length === 0) {
    throw new Error(
      "Opportunity has no linked clusters — can't generate a spec without evidence",
    );
  }
  if (clusterIds.length > MAX_CLUSTERS_PER_SPEC) {
    // Cap so the prompt doesn't blow out Haiku's context. In practice
    // the scorer links 1-5 clusters per opportunity.
    clusterIds.length = MAX_CLUSTERS_PER_SPEC;
  }

  const clusterRows = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
      severity: insightClusters.severity,
      frequency: insightClusters.frequency,
    })
    .from(insightClusters)
    .where(inArray(insightClusters.id, clusterIds));

  const quotes = await sampleQuotes(ctx, clusterIds, QUOTES_PER_CLUSTER);

  const realClusterIds = new Set(clusterRows.map((c) => c.id));

  const { output } = await complete(
    specGenerate,
    {
      opportunity: {
        title: opp.title,
        description: opp.description,
        reasoning: opp.reasoning,
        effort: opp.effortEstimate,
        impact: opp.impactEstimate ?? {},
      },
      clusters: clusterRows.map((c, i) => ({
        id: c.id,
        label: `C${i + 1}`,
        title: c.title,
        description: c.description,
        severity: c.severity,
        frequency: c.frequency,
        quotes: quotes.get(c.id) ?? [],
      })),
    },
    { cache: true, ...opts },
  );

  // Every citation must point at a cluster we actually sent. This is
  // the orchestrator's last line of defense; the prompt's parse() is
  // type-only.
  for (const c of output.spec.citations) {
    if (!realClusterIds.has(c.clusterId)) {
      throw new Error(
        `spec-generate returned unknown clusterId "${c.clusterId}" in citations`,
      );
    }
  }

  const { grade, checklist } = gradeSpec(output.spec);
  const markdown = renderSpecMarkdown(output.spec);

  // Bump version: current max version for this opportunity + 1.
  const [existing] = await ctx.db
    .select({ version: specs.version })
    .from(specs)
    .where(eq(specs.opportunityId, opportunityId))
    .orderBy(desc(specs.version))
    .limit(1);
  const nextVersion = (existing?.version ?? 0) + 1;

  const [inserted] = await ctx.db
    .insert(specs)
    .values({
      opportunityId,
      accountId: ctx.accountId,
      version: nextVersion,
      contentIr: output.spec,
      contentMd: markdown,
      readinessGrade: grade,
      readinessChecklist: checklist,
      promptHash: specGenerate.hash,
    })
    .returning({ id: specs.id });

  if (!inserted) {
    throw new Error("spec insert returned no row");
  }

  return {
    specId: inserted.id,
    version: nextVersion,
    grade,
    ir: output.spec,
    markdown,
    promptHash: specGenerate.hash,
  };
}

/* ------------------------------ streaming ------------------------------ */

/**
 * Streaming variant of generateSpec. Yields raw text deltas as the LLM
 * emits them, and on completion parses + grades + renders + persists in
 * the caller's transaction (same as the blocking path).
 *
 * Use this from a Route Handler that can hold the tx + stream SSE to
 * the browser. The browser shows raw text with a blinking cursor and
 * refetches the rendered spec via tRPC once a `done` event arrives.
 *
 * Validation + persistence are identical to generateSpec — both paths
 * share the grading + markdown cache. A client that uses streaming
 * should never see a spec the blocking path wouldn't accept.
 */
export async function* generateSpecStream(
  ctx: SpecCtx,
  opportunityId: string,
  opts: CompleteOpts = {},
): AsyncGenerator<
  | { type: "delta"; text: string }
  | {
      type: "done";
      specId: string;
      version: number;
      grade: "A" | "B" | "C" | "D";
    },
  void,
  unknown
> {
  const [opp] = await ctx.db
    .select({
      id: opportunitiesTbl.id,
      title: opportunitiesTbl.title,
      description: opportunitiesTbl.description,
      reasoning: opportunitiesTbl.reasoning,
      impactEstimate: opportunitiesTbl.impactEstimate,
      effortEstimate: opportunitiesTbl.effortEstimate,
    })
    .from(opportunitiesTbl)
    .where(
      and(
        eq(opportunitiesTbl.id, opportunityId),
        eq(opportunitiesTbl.accountId, ctx.accountId),
      ),
    )
    .limit(1);

  if (!opp) {
    throw new Error(
      `Opportunity ${opportunityId} not found (or belongs to another account)`,
    );
  }

  const clusterLinks = await ctx.db
    .select({ clusterId: opportunityToCluster.clusterId })
    .from(opportunityToCluster)
    .where(eq(opportunityToCluster.opportunityId, opportunityId));

  const clusterIds = clusterLinks.map((l) => l.clusterId);
  if (clusterIds.length === 0) {
    throw new Error(
      "Opportunity has no linked clusters — can't generate a spec without evidence",
    );
  }
  if (clusterIds.length > MAX_CLUSTERS_PER_SPEC) {
    clusterIds.length = MAX_CLUSTERS_PER_SPEC;
  }

  const clusterRows = await ctx.db
    .select({
      id: insightClusters.id,
      title: insightClusters.title,
      description: insightClusters.description,
      severity: insightClusters.severity,
      frequency: insightClusters.frequency,
    })
    .from(insightClusters)
    .where(inArray(insightClusters.id, clusterIds));

  const quotes = await sampleQuotes(ctx, clusterIds, QUOTES_PER_CLUSTER);
  const realClusterIds = new Set(clusterRows.map((c) => c.id));

  const stream = completeStream(
    specGenerate,
    {
      opportunity: {
        title: opp.title,
        description: opp.description,
        reasoning: opp.reasoning,
        effort: opp.effortEstimate,
        impact: opp.impactEstimate ?? {},
      },
      clusters: clusterRows.map((c, i) => ({
        id: c.id,
        label: `C${i + 1}`,
        title: c.title,
        description: c.description,
        severity: c.severity,
        frequency: c.frequency,
        quotes: quotes.get(c.id) ?? [],
      })),
    },
    { cache: true, ...opts },
  );

  let finalOutput: Awaited<ReturnType<typeof specGenerate.parse>> | null = null;
  for await (const ev of stream) {
    if (ev.type === "delta") {
      yield { type: "delta", text: ev.text };
    } else {
      finalOutput = ev.output;
    }
  }

  if (!finalOutput) {
    throw new Error("specGenerateStream: upstream closed without a result");
  }

  for (const c of finalOutput.spec.citations) {
    if (!realClusterIds.has(c.clusterId)) {
      throw new Error(
        `spec-generate returned unknown clusterId "${c.clusterId}" in citations`,
      );
    }
  }

  const { grade, checklist } = gradeSpec(finalOutput.spec);
  const markdown = renderSpecMarkdown(finalOutput.spec);

  const [existing] = await ctx.db
    .select({ version: specs.version })
    .from(specs)
    .where(eq(specs.opportunityId, opportunityId))
    .orderBy(desc(specs.version))
    .limit(1);
  const nextVersion = (existing?.version ?? 0) + 1;

  const [inserted] = await ctx.db
    .insert(specs)
    .values({
      opportunityId,
      accountId: ctx.accountId,
      version: nextVersion,
      contentIr: finalOutput.spec,
      contentMd: markdown,
      readinessGrade: grade,
      readinessChecklist: checklist,
      promptHash: specGenerate.hash,
    })
    .returning({ id: specs.id });

  if (!inserted) {
    throw new Error("spec insert returned no row");
  }

  yield {
    type: "done",
    specId: inserted.id,
    version: nextVersion,
    grade,
  };
}

/* ------------------------------ refinement ------------------------------ */

const MAX_REFINE_HISTORY = 20;

/**
 * Refinement stream. Takes the latest spec's IR + the prior chat
 * history + the user's new message, calls spec-refine, persists the
 * revised spec as version N+1, and appends user + assistant rows to
 * spec_refinement so the history renders on reload.
 *
 * Rate-limited upstream via the `spec-chat` preset (caller responsibility
 * — enforce before invoking). This orchestrator trusts its caller to
 * have checked the limit.
 *
 * Each completed refine stream produces ONE new spec row. Prior
 * versions stay in the DB for the "compare versions" UX that ships
 * in the Linear/Notion export commit.
 */
export async function* refineSpecStream(
  ctx: SpecCtx,
  opportunityId: string,
  userMessage: string,
  opts: CompleteOpts = {},
): AsyncGenerator<
  | { type: "delta"; text: string }
  | {
      type: "done";
      specId: string;
      version: number;
      grade: "A" | "B" | "C" | "D";
      assistantMessage: string;
    },
  void,
  unknown
> {
  const latest = await getLatestSpec(ctx, opportunityId);
  if (!latest) {
    throw new Error(
      "Can't refine — no spec yet. Generate the first version first.",
    );
  }

  // Pull the chat history for the latest spec. Keep it bounded — a
  // PM iterating a lot doesn't need to re-send 100 messages to the
  // LLM every turn; the most recent window is sufficient.
  const historyRows = await ctx.db
    .select({
      role: specRefinements.role,
      content: specRefinements.content,
    })
    .from(specRefinements)
    .where(eq(specRefinements.specId, latest.id))
    .orderBy(asc(specRefinements.createdAt))
    .limit(MAX_REFINE_HISTORY);

  const stream = completeStream(
    specRefine,
    {
      currentSpec: latest.ir,
      history: historyRows,
      userMessage,
    },
    { cache: true, ...opts },
  );

  let finalOutput: Awaited<ReturnType<typeof specRefine.parse>> | null = null;
  for await (const ev of stream) {
    if (ev.type === "delta") {
      yield { type: "delta", text: ev.text };
    } else {
      finalOutput = ev.output;
    }
  }

  if (!finalOutput) {
    throw new Error("refineSpecStream: upstream closed without a result");
  }

  // Citations in a refinement reuse cluster UUIDs from the original
  // spec's set. We don't validate against the cluster table here —
  // the refine prompt is told to preserve citations unless evidence
  // was explicitly dropped, and the citation is advisory at the UI
  // layer. Cross-account leak is impossible anyway since the LLM
  // only sees the prior spec's citations.

  const { grade, checklist } = gradeSpec(finalOutput.spec);
  const markdown = renderSpecMarkdown(finalOutput.spec);
  const nextVersion = latest.version + 1;

  const [newSpec] = await ctx.db
    .insert(specs)
    .values({
      opportunityId,
      accountId: ctx.accountId,
      version: nextVersion,
      contentIr: finalOutput.spec,
      contentMd: markdown,
      readinessGrade: grade,
      readinessChecklist: checklist,
      promptHash: specRefine.hash,
    })
    .returning({ id: specs.id });

  if (!newSpec) {
    throw new Error("refined spec insert returned no row");
  }

  // Append the assistant's turn to the NEW spec row so the next
  // refinement sees the full conversation chained off the current
  // version. Attaching to the new spec (not the old) means the
  // "chat belongs to the latest" invariant stays simple to query.
  await ctx.db.insert(specRefinements).values([
    {
      specId: newSpec.id,
      role: "user",
      content: userMessage,
    },
    {
      specId: newSpec.id,
      role: "assistant",
      content: finalOutput.assistantMessage,
      promptHash: specRefine.hash,
    },
  ]);

  yield {
    type: "done",
    specId: newSpec.id,
    version: nextVersion,
    grade,
    assistantMessage: finalOutput.assistantMessage,
  };
}

export interface RefinementRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

/**
 * Chat history for the latest spec of an opportunity. Used by the
 * editor's chat panel on page load + after each refinement stream
 * completes.
 */
export async function listRefinements(
  ctx: SpecCtx,
  opportunityId: string,
): Promise<RefinementRow[]> {
  const latest = await getLatestSpec(ctx, opportunityId);
  if (!latest) return [];

  return ctx.db
    .select({
      id: specRefinements.id,
      role: specRefinements.role,
      content: specRefinements.content,
      createdAt: specRefinements.createdAt,
    })
    .from(specRefinements)
    .where(eq(specRefinements.specId, latest.id))
    .orderBy(asc(specRefinements.createdAt));
}

/* ----------------------------- read helpers ----------------------------- */

export interface SpecRow {
  id: string;
  opportunityId: string;
  version: number;
  grade: "A" | "B" | "C" | "D" | null;
  checklist: ReadinessChecklist | null;
  ir: SpecIR;
  markdown: string | null;
  updatedAt: Date;
}

export async function getLatestSpec(
  ctx: SpecCtx,
  opportunityId: string,
): Promise<SpecRow | null> {
  const [row] = await ctx.db
    .select({
      id: specs.id,
      opportunityId: specs.opportunityId,
      version: specs.version,
      grade: specs.readinessGrade,
      checklist: specs.readinessChecklist,
      ir: specs.contentIr,
      markdown: specs.contentMd,
      updatedAt: specs.updatedAt,
    })
    .from(specs)
    .where(
      and(
        eq(specs.opportunityId, opportunityId),
        eq(specs.accountId, ctx.accountId),
      ),
    )
    .orderBy(desc(specs.version))
    .limit(1);

  if (!row) return null;
  return {
    ...row,
    ir: row.ir as SpecIR,
    checklist: (row.checklist as ReadinessChecklist | null) ?? null,
  };
}

export async function listSpecs(
  ctx: SpecCtx,
): Promise<
  Array<{
    id: string;
    opportunityId: string;
    opportunityTitle: string;
    version: number;
    grade: "A" | "B" | "C" | "D" | null;
    updatedAt: Date;
  }>
> {
  // Only the latest version per opportunity. Drizzle doesn't give us
  // DISTINCT ON ergonomically, so: fetch all and pick max version in
  // code. Spec rows stay small (< 1 per opportunity in v1).
  const rows = await ctx.db
    .select({
      id: specs.id,
      opportunityId: specs.opportunityId,
      version: specs.version,
      grade: specs.readinessGrade,
      updatedAt: specs.updatedAt,
      opportunityTitle: opportunitiesTbl.title,
    })
    .from(specs)
    .innerJoin(
      opportunitiesTbl,
      eq(opportunitiesTbl.id, specs.opportunityId),
    )
    .where(eq(specs.accountId, ctx.accountId))
    .orderBy(desc(specs.updatedAt));

  const byOpp = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = byOpp.get(r.opportunityId);
    if (!prev || r.version > prev.version) byOpp.set(r.opportunityId, r);
  }
  return Array.from(byOpp.values());
}

/* ------------------------------ internal ------------------------------ */

async function sampleQuotes(
  ctx: SpecCtx,
  clusterIds: string[],
  perCluster: number,
): Promise<Map<string, string[]>> {
  if (clusterIds.length === 0) return new Map();
  const edges = await ctx.db
    .select({
      clusterId: evidenceToCluster.clusterId,
      evidenceId: evidenceToCluster.evidenceId,
    })
    .from(evidenceToCluster)
    .where(inArray(evidenceToCluster.clusterId, clusterIds));

  const evidenceIds = Array.from(new Set(edges.map((e) => e.evidenceId)));
  if (evidenceIds.length === 0) return new Map();

  const bodies = await ctx.db
    .select({ id: evidence.id, content: evidence.content })
    .from(evidence)
    .where(inArray(evidence.id, evidenceIds));
  const bodyById = new Map(bodies.map((b) => [b.id, b.content]));

  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const list = out.get(edge.clusterId) ?? [];
    if (list.length < perCluster) {
      const content = bodyById.get(edge.evidenceId);
      if (content) list.push(content.slice(0, 240));
    }
    out.set(edge.clusterId, list);
  }
  return out;
}
