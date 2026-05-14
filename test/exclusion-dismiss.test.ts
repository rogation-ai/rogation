import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  clusterExclusions,
  evidence,
  evidenceToCluster,
  insightClusters,
  users,
} from "@/db/schema";
import {
  dismissCluster,
  listExclusions,
  unexclude,
  deleteExclusion,
} from "@/lib/evidence/exclusions";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  DB-backed tests for the exclusion (dismiss / unexclude / delete) flow.

  Locks down the invariants that close the L3 AI Learning Loop:

  1. dismissCluster creates an exclusion row, flags attached evidence,
     and tombstones the cluster with reason = 'dismiss'.

  2. unexclude restores evidence flags, deactivates the exclusion, and
     un-tombstones the cluster — but only if tombstone_reason is 'dismiss'
     (merge-tombstoned clusters stay tombstoned).

  3. deleteExclusion hard-deletes the exclusion row and restores evidence.

  4. listExclusions returns exclusions with per-exclusion evidence counts.

  Skip if no TEST_DATABASE_URL. The CI service container sets it.
*/

describe.skipIf(!hasTestDb)("exclusion dismiss/unexclude (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountA: string;
  let userA: string;
  let clusterAId: string;
  let evidenceA1Id: string;
  let evidenceA2Id: string;

  beforeAll(async () => {
    handle = await setupTestDb("exclusion-dismiss");
    accountA = await seedAccount(handle, "excl@test.dev");
    userA = await readFirstUser(handle, accountA);

    // Seed a cluster with two attached evidence rows
    const seeded = await seedClusterWithEvidence(handle, accountA);
    clusterAId = seeded.clusterId;
    evidenceA1Id = seeded.evidenceIds[0]!;
    evidenceA2Id = seeded.evidenceIds[1]!;
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("dismissCluster creates exclusion + flags evidence + tombstones cluster", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);

      const result = await dismissCluster(
        { db: tx, accountId: accountA, userId: userA },
        clusterAId,
      );

      expect(result.exclusionId).toBeTruthy();
      expect(result.evidenceFlagged).toBe(2);

      // Verify the exclusion row was created
      const [exclusion] = await tx
        .select({
          id: clusterExclusions.id,
          label: clusterExclusions.label,
          isActive: clusterExclusions.isActive,
          sourceClusterId: clusterExclusions.sourceClusterId,
        })
        .from(clusterExclusions)
        .where(eq(clusterExclusions.id, result.exclusionId));
      expect(exclusion).toBeTruthy();
      expect(exclusion!.isActive).toBe(true);
      expect(exclusion!.sourceClusterId).toBe(clusterAId);

      // Verify evidence is flagged
      const flagged = await tx
        .select({
          id: evidence.id,
          excluded: evidence.excluded,
          flaggedByExclusionId: evidence.flaggedByExclusionId,
        })
        .from(evidence)
        .where(eq(evidence.flaggedByExclusionId, result.exclusionId));
      expect(flagged).toHaveLength(2);
      expect(flagged.every((e) => e.excluded)).toBe(true);

      // Verify cluster is tombstoned (self-reference)
      const [cluster] = await tx
        .select({
          tombstonedInto: insightClusters.tombstonedInto,
          tombstoneReason: insightClusters.tombstoneReason,
        })
        .from(insightClusters)
        .where(eq(insightClusters.id, clusterAId));
      expect(cluster!.tombstonedInto).toBe(clusterAId);
      expect(cluster!.tombstoneReason).toBe("dismiss");
    });
  });

  it("dismissCluster throws when cluster not found", async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await bind(tx, accountA);
        await dismissCluster(
          { db: tx, accountId: accountA, userId: userA },
          "00000000-0000-0000-0000-000000000000",
        );
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it("dismissCluster throws when cluster already tombstoned", async () => {
    // clusterAId was tombstoned in the first test. Trying again should fail.
    await expect(
      handle.db.transaction(async (tx) => {
        await bind(tx, accountA);
        await dismissCluster(
          { db: tx, accountId: accountA, userId: userA },
          clusterAId,
        );
      }),
    ).rejects.toThrowError(/already dismissed/i);
  });

  it("dismissCluster stores the reason", async () => {
    // Seed a fresh cluster to dismiss with a reason
    const { clusterId: freshCluster } = await seedClusterWithEvidence(
      handle,
      accountA,
      "reason-test",
    );

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const result = await dismissCluster(
        { db: tx, accountId: accountA, userId: userA },
        freshCluster,
        "Not relevant to our product",
      );

      const [exclusion] = await tx
        .select({ reason: clusterExclusions.reason })
        .from(clusterExclusions)
        .where(eq(clusterExclusions.id, result.exclusionId));
      expect(exclusion!.reason).toBe("Not relevant to our product");
    });
  });

  it("listExclusions returns exclusions with evidence count", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const list = await listExclusions({ db: tx, accountId: accountA });

      // We have at least 2 exclusions from prior tests (clusterA + reason-test)
      expect(list.length).toBeGreaterThanOrEqual(2);
      // The first exclusion (from dismissing clusterA) has 2 evidence rows
      const clusterAExclusion = list.find(
        (e) => e.sourceClusterId === clusterAId,
      );
      expect(clusterAExclusion).toBeTruthy();
      expect(clusterAExclusion!.evidenceCount).toBe(2);
    });
  });

  it("unexclude restores evidence + deactivates exclusion + un-tombstones cluster", async () => {
    // Find the exclusion for clusterA
    let exclusionId: string;
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const list = await listExclusions({ db: tx, accountId: accountA });
      const match = list.find((e) => e.sourceClusterId === clusterAId);
      expect(match).toBeTruthy();
      exclusionId = match!.id;
    });

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const result = await unexclude(
        { db: tx, accountId: accountA, userId: userA },
        exclusionId!,
      );

      expect(result.evidenceRestored).toBe(2);
      expect(result.clusterRestored).toBe(true);

      // Verify evidence is no longer flagged
      const rows = await tx
        .select({
          id: evidence.id,
          excluded: evidence.excluded,
          flaggedByExclusionId: evidence.flaggedByExclusionId,
        })
        .from(evidence)
        .where(eq(evidence.id, evidenceA1Id));
      expect(rows[0]!.excluded).toBe(false);
      expect(rows[0]!.flaggedByExclusionId).toBeNull();

      // Verify exclusion is deactivated
      const [exclusion] = await tx
        .select({ isActive: clusterExclusions.isActive })
        .from(clusterExclusions)
        .where(eq(clusterExclusions.id, exclusionId!));
      expect(exclusion!.isActive).toBe(false);

      // Verify cluster is un-tombstoned
      const [cluster] = await tx
        .select({
          tombstonedInto: insightClusters.tombstonedInto,
          tombstoneReason: insightClusters.tombstoneReason,
        })
        .from(insightClusters)
        .where(eq(insightClusters.id, clusterAId));
      expect(cluster!.tombstonedInto).toBeNull();
      expect(cluster!.tombstoneReason).toBeNull();
    });
  });

  it("unexclude does not un-tombstone merge-reason tombstoned clusters", async () => {
    // Seed a cluster, tombstone it with reason 'merge', then create an exclusion
    // manually. Unexclude should NOT un-tombstone it.
    const { clusterId: mergeCluster, evidenceIds } =
      await seedClusterWithEvidence(handle, accountA, "merge-test");

    // Tombstone the cluster with reason='merge' (simulating a real merge)
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      await tx
        .update(insightClusters)
        .set({
          tombstonedInto: mergeCluster,
          tombstoneReason: "merge",
        })
        .where(eq(insightClusters.id, mergeCluster));
    });

    // Create an exclusion row manually pointing at the merge-tombstoned cluster
    let exclusionId: string;
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const [excl] = await tx
        .insert(clusterExclusions)
        .values({
          accountId: accountA,
          sourceClusterId: mergeCluster,
          label: "merge test exclusion",
          dismissedBy: userA,
        })
        .returning({ id: clusterExclusions.id });
      exclusionId = excl!.id;

      // Flag the evidence
      await tx
        .update(evidence)
        .set({
          excluded: true,
          flaggedByExclusionId: exclusionId,
        })
        .where(eq(evidence.id, evidenceIds[0]!));
    });

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const result = await unexclude(
        { db: tx, accountId: accountA, userId: userA },
        exclusionId!,
      );

      // Evidence should be restored
      expect(result.evidenceRestored).toBe(1);
      // But cluster should NOT be un-tombstoned (it was merge-tombstoned)
      expect(result.clusterRestored).toBe(false);

      const [cluster] = await tx
        .select({
          tombstonedInto: insightClusters.tombstonedInto,
          tombstoneReason: insightClusters.tombstoneReason,
        })
        .from(insightClusters)
        .where(eq(insightClusters.id, mergeCluster));
      expect(cluster!.tombstonedInto).toBe(mergeCluster);
      expect(cluster!.tombstoneReason).toBe("merge");
    });
  });

  it("deleteExclusion hard deletes + restores evidence", async () => {
    // Dismiss a fresh cluster so we have a clean exclusion to delete
    const { clusterId: delCluster } = await seedClusterWithEvidence(
      handle,
      accountA,
      "delete-test",
    );

    let exclusionId: string;
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const result = await dismissCluster(
        { db: tx, accountId: accountA, userId: userA },
        delCluster,
      );
      exclusionId = result.exclusionId;
    });

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const result = await deleteExclusion(
        { db: tx, accountId: accountA, userId: userA },
        exclusionId!,
      );

      expect(result.evidenceRestored).toBeGreaterThanOrEqual(1);

      // Verify the exclusion row is gone
      const rows = await tx
        .select({ id: clusterExclusions.id })
        .from(clusterExclusions)
        .where(eq(clusterExclusions.id, exclusionId!));
      expect(rows).toHaveLength(0);

      // Verify evidence is restored
      const ev = await tx
        .select({
          excluded: evidence.excluded,
          flaggedByExclusionId: evidence.flaggedByExclusionId,
        })
        .from(evidence)
        .where(eq(evidence.accountId, accountA));
      const stillFlagged = ev.filter(
        (e) => e.flaggedByExclusionId === exclusionId!,
      );
      expect(stillFlagged).toHaveLength(0);
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

async function seedAccount(
  handle: TestDbHandle,
  email: string,
): Promise<string> {
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

async function readFirstUser(
  handle: TestDbHandle,
  accountId: string,
): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.accountId, accountId))
      .limit(1);
    await tx.execute(sql`ALTER TABLE "user" ENABLE ROW LEVEL SECURITY`);
    if (!row) throw new Error("seed user missing");
    return row.id;
  });
}

async function seedClusterWithEvidence(
  handle: TestDbHandle,
  accountId: string,
  suffix = "default",
): Promise<{ clusterId: string; evidenceIds: string[] }> {
  return handle.db.transaction(async (tx) => {
    await bind(tx, accountId);

    // Create a cluster
    const [cluster] = await tx
      .insert(insightClusters)
      .values({
        accountId,
        title: `seed cluster ${suffix}`,
        description: `for exclusion test ${suffix}`,
        severity: "medium",
        frequency: 2,
        promptHash: `prompt_hash_${suffix}`,
      })
      .returning({ id: insightClusters.id });
    if (!cluster) throw new Error("seed cluster insert failed");

    // Create two evidence rows
    const evidenceRows = await tx
      .insert(evidence)
      .values([
        {
          accountId,
          sourceType: "paste_ticket",
          sourceRef: `excl-test-${suffix}-1`,
          content: `Evidence 1 for ${suffix}`,
          contentHash: `hash_${suffix}_1`,
        },
        {
          accountId,
          sourceType: "paste_ticket",
          sourceRef: `excl-test-${suffix}-2`,
          content: `Evidence 2 for ${suffix}`,
          contentHash: `hash_${suffix}_2`,
        },
      ])
      .returning({ id: evidence.id });

    // Link evidence to cluster
    for (const ev of evidenceRows) {
      await tx.insert(evidenceToCluster).values({
        evidenceId: ev.id,
        clusterId: cluster.id,
        relevanceScore: 0.9,
      });
    }

    return {
      clusterId: cluster.id,
      evidenceIds: evidenceRows.map((e) => e.id),
    };
  });
}
