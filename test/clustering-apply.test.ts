import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  evidence,
  evidenceEmbeddings,
  evidenceToCluster,
  insightClusters,
  opportunities,
  opportunityToCluster,
  specs,
  users,
} from "@/db/schema";
import {
  applyClusterActions,
  markDownstreamStale,
} from "@/lib/evidence/clustering/apply";
import { resolveClusterIds } from "@/lib/evidence/clustering/resolve-cluster-id";
import type { ClusterPlan } from "@/lib/evidence/clustering/actions";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  DB-backed tests for applyClusterActions — the single write path
  for cluster re-compute.

  Strategy: seed a small known-state (2 accounts, a few clusters each,
  a few evidence rows with hand-chosen embeddings), hand-write a
  ClusterPlan for each scenario, apply, then read back and assert
  on the resulting DB state.

  What's covered:
    - KEEP attachments + title/desc update + prompt_hash bump
    - MERGE tombstones losers, re-parents edges, preserves winner id
    - SPLIT preserves origin id on first child, fresh uuids for rest
    - NEW creates fresh row + edges
    - Centroid recompute: mean vectors end up correct; empty cluster → NULL
    - Stale wiring: untouched old cluster gets stale=true; touched gets false
    - RLS: applying an account-A plan under account-B binding returns zero rows

  Skip if no TEST_DATABASE_URL.
*/

const PROMPT_HASH = "testhash1234";

function e(...vals: number[]): number[] {
  // Produce a 1536-d vector where the first N entries are vals and
  // the rest are 0. Lets test cases craft distinguishable vectors
  // without typing out 1536 floats.
  const v = new Array(1536).fill(0);
  for (let i = 0; i < vals.length; i++) v[i] = vals[i]!;
  return v;
}

describe.skipIf(!hasTestDb)("applyClusterActions (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    handle = await setupTestDb("clustering_apply");
    accountA = await seedAccount(handle, "a-apply@test.dev");
    accountB = await seedAccount(handle, "b-apply@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("KEEP updates title + attaches evidence + bumps prompt_hash", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const c1 = await insertCluster(tx, accountA, "old title", "old desc", "initial_hash");
      const ev1 = await insertEvidenceRow(tx, accountA, "paste 1", e(1, 0));

      const plan: ClusterPlan = {
        keeps: [
          {
            clusterId: c1,
            newTitle: "new title",
            newDescription: "new desc",
            attachEvidenceIds: [ev1],
          },
        ],
        merges: [],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set([c1]),
      };

      const result = await applyClusterActions(tx, plan, accountA, PROMPT_HASH);
      expect(result.clustersCreated).toBe(0);
      expect(result.touchedClusterIds.has(c1)).toBe(true);

      const [row] = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.id, c1));
      expect(row?.title).toBe("new title");
      expect(row?.description).toBe("new desc");
      expect(row?.promptHash).toBe(PROMPT_HASH);
      expect(row?.frequency).toBe(1);
      expect(row?.stale).toBe(false);

      const edges = await tx
        .select()
        .from(evidenceToCluster)
        .where(eq(evidenceToCluster.clusterId, c1));
      expect(edges).toHaveLength(1);
      expect(edges[0]?.evidenceId).toBe(ev1);
    });
  });

  it("MERGE tombstones losers, preserves winner id, re-parents edges", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const winner = await insertCluster(tx, accountA, "winner", "w", "h");
      const loser1 = await insertCluster(tx, accountA, "loser1", "l1", "h");
      const loser2 = await insertCluster(tx, accountA, "loser2", "l2", "h");
      const evA = await insertEvidenceRow(tx, accountA, "a", e(1));
      const evB = await insertEvidenceRow(tx, accountA, "b", e(0, 1));
      const evC = await insertEvidenceRow(tx, accountA, "c", e(0, 0, 1));
      await attachEdge(tx, evA, winner);
      await attachEdge(tx, evB, loser1);
      await attachEdge(tx, evC, loser2);

      const plan: ClusterPlan = {
        keeps: [],
        merges: [
          {
            winnerId: winner,
            loserIds: [loser1, loser2],
            newTitle: "merged",
            newDescription: "merged desc",
          },
        ],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set([winner]),
      };

      await applyClusterActions(tx, plan, accountA, PROMPT_HASH);

      // Winner survives with new title + 3 evidence.
      const [w] = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.id, winner));
      expect(w?.title).toBe("merged");
      expect(w?.tombstonedInto).toBeNull();
      expect(w?.frequency).toBe(3);

      // Losers tombstoned.
      const losers = await tx
        .select()
        .from(insightClusters)
        .where(
          and(
            eq(insightClusters.accountId, accountA),
            eq(insightClusters.tombstonedInto, winner),
          ),
        );
      expect(losers).toHaveLength(2);

      // resolveClusterIds chases the chain.
      const resolved = await resolveClusterIds({ db: tx }, [loser1, loser2]);
      expect(resolved.get(loser1)).toBe(winner);
      expect(resolved.get(loser2)).toBe(winner);

      // All 3 edges now on winner.
      const edges = await tx
        .select()
        .from(evidenceToCluster)
        .where(eq(evidenceToCluster.clusterId, winner));
      expect(edges).toHaveLength(3);
    });
  });

  it("SPLIT preserves origin id on first child, fresh uuids on rest", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const origin = await insertCluster(tx, accountA, "origin", "o", "h");
      const ev1 = await insertEvidenceRow(tx, accountA, "1", e(1));
      const ev2 = await insertEvidenceRow(tx, accountA, "2", e(0, 1));
      const ev3 = await insertEvidenceRow(tx, accountA, "3", e(0, 0, 1));
      await attachEdge(tx, ev1, origin);
      await attachEdge(tx, ev2, origin);
      await attachEdge(tx, ev3, origin);

      const plan: ClusterPlan = {
        keeps: [],
        merges: [],
        splits: [
          {
            originId: origin,
            children: [
              {
                title: "first",
                description: "desc1",
                severity: "high",
                evidenceIds: [ev1],
                keepOriginId: true,
              },
              {
                title: "second",
                description: "desc2",
                severity: "medium",
                evidenceIds: [ev2, ev3],
                keepOriginId: false,
              },
            ],
          },
        ],
        newClusters: [],
        centroidsToRecompute: new Set([origin]),
      };

      const result = await applyClusterActions(tx, plan, accountA, PROMPT_HASH);
      expect(result.clustersCreated).toBe(1); // only the 2nd child is new

      const [first] = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.id, origin));
      expect(first?.title).toBe("first");
      expect(first?.frequency).toBe(1);

      const all = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.accountId, accountA));
      const second = all.find((c) => c.title === "second");
      expect(second).toBeDefined();
      expect(second!.id).not.toBe(origin);
      expect(second!.frequency).toBe(2);
    });
  });

  it("NEW creates fresh row + edges + computes centroid on recompute", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const ev1 = await insertEvidenceRow(tx, accountA, "n1", e(1, 0, 0));
      const ev2 = await insertEvidenceRow(tx, accountA, "n2", e(0, 1, 0));

      const plan: ClusterPlan = {
        keeps: [],
        merges: [],
        splits: [],
        newClusters: [
          {
            title: "new cluster",
            description: "desc",
            severity: "critical",
            evidenceIds: [ev1, ev2],
          },
        ],
        centroidsToRecompute: new Set(),
      };

      const result = await applyClusterActions(tx, plan, accountA, PROMPT_HASH);
      expect(result.clustersCreated).toBe(1);

      const all = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.accountId, accountA));
      const fresh = all.find((c) => c.title === "new cluster");
      expect(fresh).toBeDefined();
      expect(fresh!.frequency).toBe(2);
      // Centroid = mean of (1,0,0,...) + (0,1,0,...) = (0.5, 0.5, 0, ...)
      expect(fresh!.centroid).not.toBeNull();
      expect(fresh!.centroid![0]).toBeCloseTo(0.5, 6);
      expect(fresh!.centroid![1]).toBeCloseTo(0.5, 6);
      expect(fresh!.centroid![2]).toBeCloseTo(0, 6);
    });
  });

  it("empty-cluster-after-move sets centroid to NULL", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const drained = await insertCluster(
        tx,
        accountA,
        "drained",
        "d",
        "h",
      );
      // Seed with one evidence + edge, then plan to detach via SPLIT
      // where all evidence goes to a new child.
      const evX = await insertEvidenceRow(tx, accountA, "x", e(1));
      await attachEdge(tx, evX, drained);
      // Set a non-null centroid first so we can verify it gets cleared.
      await tx
        .update(insightClusters)
        .set({ centroid: e(1) })
        .where(eq(insightClusters.id, drained));

      const plan: ClusterPlan = {
        keeps: [
          {
            clusterId: drained,
            newTitle: null,
            newDescription: null,
            // Not attaching anything, and the SPLIT branch would be
            // more natural but for this test we just force recompute
            // on a cluster after nulling its edges.
            attachEvidenceIds: [],
          },
        ],
        merges: [],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set([drained]),
      };

      // Manually drain edges as if the test scenario removed them.
      await tx
        .delete(evidenceToCluster)
        .where(eq(evidenceToCluster.clusterId, drained));

      await applyClusterActions(tx, plan, accountA, PROMPT_HASH);

      const [row] = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.id, drained));
      expect(row?.frequency).toBe(0);
      expect(row?.centroid).toBeNull();
    });
  });

  it("stale wiring: old untouched cluster → true, touched → false", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);

      // Old cluster: attach evidence with a 30-day-old created_at.
      const oldCluster = await insertCluster(tx, accountA, "old", "d", "h");
      const oldEv = await insertEvidenceRowAt(
        tx,
        accountA,
        "old",
        e(1),
        daysAgo(30),
      );
      await attachEdge(tx, oldEv, oldCluster);

      // Recent cluster to TOUCH.
      const touchCluster = await insertCluster(tx, accountA, "touch", "d", "h");
      await tx
        .update(insightClusters)
        .set({ stale: true })
        .where(eq(insightClusters.id, touchCluster));

      // Very recent evidence so the "newest" reference is fresh.
      const newEv = await insertEvidenceRow(tx, accountA, "new", e(0, 1));

      const plan: ClusterPlan = {
        keeps: [
          {
            clusterId: touchCluster,
            newTitle: null,
            newDescription: null,
            attachEvidenceIds: [newEv],
          },
        ],
        merges: [],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set([touchCluster]),
      };

      await applyClusterActions(tx, plan, accountA, PROMPT_HASH);

      const [oldRow] = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.id, oldCluster));
      expect(oldRow?.stale).toBe(true);

      const [touchedRow] = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.id, touchCluster));
      expect(touchedRow?.stale).toBe(false);
    });
  });

  it("markDownstreamStale: empty trigger set is a no-op", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const cluster = await insertCluster(tx, accountA, "c", "d", "h");
      const oppId = await insertOpportunity(tx, accountA, [cluster]);
      await markDownstreamStale(tx, accountA, new Set());
      const [row] = await tx
        .select({ stale: opportunities.stale })
        .from(opportunities)
        .where(eq(opportunities.id, oppId));
      expect(row?.stale).toBe(false);
    });
  });

  it("markDownstreamStale: opps linked to trigger cluster get stale + cascade to specs", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const cluster = await insertCluster(tx, accountA, "c", "d", "h");
      const otherCluster = await insertCluster(tx, accountA, "other", "d", "h");
      const linkedOpp = await insertOpportunity(tx, accountA, [cluster]);
      const unlinkedOpp = await insertOpportunity(tx, accountA, [otherCluster]);
      const linkedSpec = await insertSpec(tx, accountA, linkedOpp);
      const unlinkedSpec = await insertSpec(tx, accountA, unlinkedOpp);

      await markDownstreamStale(tx, accountA, new Set([cluster]));

      const [linkedOppRow] = await tx
        .select({ stale: opportunities.stale })
        .from(opportunities)
        .where(eq(opportunities.id, linkedOpp));
      expect(linkedOppRow?.stale).toBe(true);

      const [unlinkedOppRow] = await tx
        .select({ stale: opportunities.stale })
        .from(opportunities)
        .where(eq(opportunities.id, unlinkedOpp));
      expect(unlinkedOppRow?.stale).toBe(false);

      const [linkedSpecRow] = await tx
        .select({ stale: specs.stale })
        .from(specs)
        .where(eq(specs.id, linkedSpec));
      expect(linkedSpecRow?.stale).toBe(true);

      const [unlinkedSpecRow] = await tx
        .select({ stale: specs.stale })
        .from(specs)
        .where(eq(specs.id, unlinkedSpec));
      expect(unlinkedSpecRow?.stale).toBe(false);
    });
  });

  it("MERGE cascades stale=true to linked opportunities + specs", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      // Two clusters; opportunity links to the loser. After MERGE,
      // the loser is tombstoned → opp + spec must go stale.
      const winner = await insertCluster(tx, accountA, "winner", "d", "h");
      const loser = await insertCluster(tx, accountA, "loser", "d", "h");
      const evW = await insertEvidenceRow(tx, accountA, "w", e(1));
      const evL = await insertEvidenceRow(tx, accountA, "l", e(0, 1));
      await attachEdge(tx, evW, winner);
      await attachEdge(tx, evL, loser);
      const oppId = await insertOpportunity(tx, accountA, [loser]);
      const specId = await insertSpec(tx, accountA, oppId);

      const plan: ClusterPlan = {
        keeps: [],
        merges: [
          {
            winnerId: winner,
            loserIds: [loser],
            newTitle: "merged",
            newDescription: "d",
          },
        ],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set([winner]),
      };

      await applyClusterActions(tx, plan, accountA, PROMPT_HASH);

      const [oppRow] = await tx
        .select({ stale: opportunities.stale })
        .from(opportunities)
        .where(eq(opportunities.id, oppId));
      expect(oppRow?.stale).toBe(true);

      const [specRow] = await tx
        .select({ stale: specs.stale })
        .from(specs)
        .where(eq(specs.id, specId));
      expect(specRow?.stale).toBe(true);
    });
  });

  it("KEEP-only run does NOT stale downstream opportunities (regression guard for D1)", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const cluster = await insertCluster(tx, accountA, "c", "d", "h");
      const ev1 = await insertEvidenceRow(tx, accountA, "e1", e(1));
      const ev2 = await insertEvidenceRow(tx, accountA, "e2", e(0, 1));
      await attachEdge(tx, ev1, cluster);
      const oppId = await insertOpportunity(tx, accountA, [cluster]);

      // KEEP that attaches a new evidence row — centroid + frequency
      // will move, but the cluster set didn't reshape. Per D1, opp
      // must stay non-stale.
      const plan: ClusterPlan = {
        keeps: [
          {
            clusterId: cluster,
            newTitle: null,
            newDescription: null,
            attachEvidenceIds: [ev2],
          },
        ],
        merges: [],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set([cluster]),
      };

      await applyClusterActions(tx, plan, accountA, PROMPT_HASH);

      const [oppRow] = await tx
        .select({ stale: opportunities.stale })
        .from(opportunities)
        .where(eq(opportunities.id, oppId));
      expect(oppRow?.stale).toBe(false);
    });
  });

  it("RLS: plan referencing an account-B cluster from account-A context is a no-op on B", async () => {
    let bCluster = "";
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountB);
      bCluster = await insertCluster(tx, accountB, "b-only", "d", "h");
    });

    // Apply from account A's session — update should not touch B's row.
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const plan: ClusterPlan = {
        keeps: [
          {
            clusterId: bCluster,
            newTitle: "hijacked",
            newDescription: "hijacked",
            attachEvidenceIds: [],
          },
        ],
        merges: [],
        splits: [],
        newClusters: [],
        centroidsToRecompute: new Set(),
      };
      // No throw: the UPDATE filters to zero rows under RLS.
      await applyClusterActions(tx, plan, accountA, PROMPT_HASH);
    });

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountB);
      const [row] = await tx
        .select()
        .from(insightClusters)
        .where(eq(insightClusters.id, bCluster));
      expect(row?.title).toBe("b-only");
    });
  });
});

/* ----------------------------- helpers ----------------------------- */

async function bind(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  accountId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.current_account_id', ${accountId}, true)`,
  );
}

async function seedAccount(handle: TestDbHandle, email: string): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "account" DISABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [account] = await tx
      .insert(accounts)
      .values({ plan: "free" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed account insert failed");
    await tx.insert(users).values({
      accountId: account.id,
      clerkUserId: `clerk_${account.id}`,
      email,
    });
    await tx.execute(sql`ALTER TABLE "account" ENABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" ENABLE ROW LEVEL SECURITY`);
    return account.id;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertCluster(
  tx: any,
  accountId: string,
  title: string,
  description: string,
  promptHash: string,
): Promise<string> {
  const [row] = await tx
    .insert(insightClusters)
    .values({
      accountId,
      title,
      description,
      severity: "medium",
      frequency: 0,
      promptHash,
    })
    .returning({ id: insightClusters.id });
  if (!row) throw new Error("insertCluster failed");
  return row.id as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertEvidenceRow(
  tx: any,
  accountId: string,
  marker: string,
  embedding: number[],
): Promise<string> {
  return insertEvidenceRowAt(tx, accountId, marker, embedding, new Date());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertEvidenceRowAt(
  tx: any,
  accountId: string,
  marker: string,
  embedding: number[],
  createdAt: Date,
): Promise<string> {
  const [row] = await tx
    .insert(evidence)
    .values({
      accountId,
      sourceType: "upload_text",
      sourceRef: `src_${marker}_${Date.now()}_${Math.random()}`,
      content: `content_${marker}`,
      contentHash: `hash_${marker}_${Date.now()}_${Math.random()}`,
      createdAt,
    })
    .returning({ id: evidence.id });
  if (!row) throw new Error("insertEvidenceRow failed");
  await tx.insert(evidenceEmbeddings).values({
    evidenceId: row.id,
    embedding,
    model: "text-embedding-3-small",
  });
  return row.id as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function attachEdge(
  tx: any,
  evidenceId: string,
  clusterId: string,
): Promise<void> {
  await tx.insert(evidenceToCluster).values({
    evidenceId,
    clusterId,
    relevanceScore: 1,
  });
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertOpportunity(
  tx: any,
  accountId: string,
  linkedClusterIds: string[],
): Promise<string> {
  const [row] = await tx
    .insert(opportunities)
    .values({
      accountId,
      title: "opp",
      description: "d",
      reasoning: "r",
      effortEstimate: "M",
      score: 1,
      confidence: 0.5,
      promptHash: "opphash",
    })
    .returning({ id: opportunities.id });
  if (!row) throw new Error("insertOpportunity failed");
  if (linkedClusterIds.length > 0) {
    await tx.insert(opportunityToCluster).values(
      linkedClusterIds.map((clusterId) => ({
        opportunityId: row.id,
        clusterId,
      })),
    );
  }
  return row.id as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertSpec(
  tx: any,
  accountId: string,
  opportunityId: string,
): Promise<string> {
  const [row] = await tx
    .insert(specs)
    .values({
      opportunityId,
      accountId,
      version: 1,
      contentIr: { title: "t", summary: "s" },
      promptHash: "spechash",
    })
    .returning({ id: specs.id });
  if (!row) throw new Error("insertSpec failed");
  return row.id as string;
}
