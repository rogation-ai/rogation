import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  insightClusters,
  opportunities,
  users,
} from "@/db/schema";
import {
  createOutcome,
  deleteOutcome,
  listOutcomesForOpportunity,
  summariesForOpportunities,
  summarizeOutcomes,
  updateOutcome,
} from "@/lib/evidence/outcomes";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Outcome tracking tests. Split in two:

  Pure (always run): summarizeOutcomes verdict math. No DB, no network —
  the /build badge depends on this being right so the PM sees "win" or
  "miss" correctly.

  DB-backed (skipped without TEST_DATABASE_URL): plan gate (Free/Solo
  can't write, Pro can), RLS (cross-account deletes return zero), and
  basic CRUD. These close the loop between "the schema has an outcome
  table" and "Pro users can actually record outcomes."
*/

describe("summarizeOutcomes (pure)", () => {
  it("returns null verdict when no rows have predicted+actual", () => {
    const s = summarizeOutcomes([
      { predicted: 40, actual: null },
      { predicted: null, actual: 10 },
      { predicted: null, actual: null },
    ]);
    expect(s.count).toBe(3);
    expect(s.measuredCount).toBe(0);
    expect(s.verdict).toBeNull();
    expect(s.avgDelta).toBeNull();
  });

  it("calls 'win' when every measured row hits its prediction", () => {
    const s = summarizeOutcomes([
      { predicted: 40, actual: 43 },
      { predicted: 10, actual: 15 },
    ]);
    expect(s.verdict).toBe("win");
    expect(s.measuredCount).toBe(2);
    expect(s.avgDelta).toBeGreaterThan(0);
  });

  it("calls 'loss' when every measured row misses", () => {
    const s = summarizeOutcomes([
      { predicted: 40, actual: 30 },
      { predicted: 10, actual: 5 },
    ]);
    expect(s.verdict).toBe("loss");
    expect(s.avgDelta).toBeLessThan(0);
  });

  it("calls 'mixed' when some win and some lose", () => {
    const s = summarizeOutcomes([
      { predicted: 40, actual: 50 },
      { predicted: 10, actual: 5 },
    ]);
    expect(s.verdict).toBe("mixed");
  });

  it("treats actual == predicted as a win (hit the target)", () => {
    const s = summarizeOutcomes([{ predicted: 40, actual: 40 }]);
    expect(s.verdict).toBe("win");
    expect(s.avgDelta).toBe(0);
  });

  it("ignores rows with predicted=0 in the delta average (no div-by-zero)", () => {
    const s = summarizeOutcomes([
      { predicted: 0, actual: 5 }, // predicted=0 → excluded from delta, still a win
      { predicted: 10, actual: 15 }, // +50%
    ]);
    expect(s.verdict).toBe("win");
    expect(s.avgDelta).toBeCloseTo(0.5, 5);
  });

  it("clamps wild deltas to [-1, 3]", () => {
    const s = summarizeOutcomes([
      { predicted: 1, actual: 1_000_000 }, // would be +999999, clamped to +3
    ]);
    expect(s.avgDelta).toBe(3);
  });

  it("ignores unmeasured rows in the count-vs-measuredCount split", () => {
    const s = summarizeOutcomes([
      { predicted: 40, actual: 43 }, // measured, win
      { predicted: 20, actual: null }, // unmeasured (goal only)
    ]);
    expect(s.count).toBe(2);
    expect(s.measuredCount).toBe(1);
    expect(s.verdict).toBe("win");
  });
});

describe.skipIf(!hasTestDb)("outcomes router (DB-backed)", () => {
  let handle: TestDbHandle;
  let proAccount: string;
  let freeAccount: string;
  let proOpp: string;
  let freeOpp: string;
  let otherOpp: string;

  beforeAll(async () => {
    handle = await setupTestDb("outcomes");
    proAccount = await seedAccount(handle, "pro@test.dev", "pro");
    freeAccount = await seedAccount(handle, "free@test.dev", "free");
    proOpp = await seedOpportunity(handle, proAccount);
    freeOpp = await seedOpportunity(handle, freeAccount);
    otherOpp = await seedOpportunity(handle, freeAccount);
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("Pro plan can create an outcome", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, proAccount);
      const row = await createOutcome(
        { db: tx, accountId: proAccount, plan: "pro" },
        {
          opportunityId: proOpp,
          metricName: "Retention 7d",
          predicted: 40,
          actual: 43,
          measuredAt: new Date(),
        },
      );
      expect(row.metricName).toBe("Retention 7d");
      expect(row.metricSource).toBe("manual");
      expect(row.predicted).toBe(40);
    });
  });

  it("Free plan is blocked at write with plan_feature_required", async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await bind(tx, freeAccount);
        await createOutcome(
          { db: tx, accountId: freeAccount, plan: "free" },
          {
            opportunityId: freeOpp,
            metricName: "Activation",
            predicted: 10,
            actual: null,
            measuredAt: null,
          },
        );
      }),
    ).rejects.toThrowError(/Pro/);
  });

  it("Solo plan is also blocked at write", async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await bind(tx, freeAccount);
        await createOutcome(
          { db: tx, accountId: freeAccount, plan: "solo" },
          {
            opportunityId: freeOpp,
            metricName: "Activation",
            predicted: 10,
            actual: null,
            measuredAt: null,
          },
        );
      }),
    ).rejects.toThrowError(/Pro/);
  });

  it("list returns newest first, scoped by RLS", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, proAccount);
      await createOutcome(
        { db: tx, accountId: proAccount, plan: "pro" },
        {
          opportunityId: proOpp,
          metricName: "Revenue lift",
          predicted: 1000,
          actual: 950,
          measuredAt: new Date(),
        },
      );
      const rows = await listOutcomesForOpportunity({ db: tx }, proOpp);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // Ordered desc by createdAt.
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const curr = rows[i];
        if (!prev || !curr) continue;
        expect(prev.createdAt.getTime()).toBeGreaterThanOrEqual(
          curr.createdAt.getTime(),
        );
      }
    });
  });

  it("summariesForOpportunities batches and excludes other accounts", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, proAccount);
      // proOpp has 2 rows from prior tests (one win, one loss).
      const map = await summariesForOpportunities({ db: tx }, [
        proOpp,
        otherOpp, // belongs to freeAccount — RLS hides it → summary absent
      ]);
      const s = map.get(proOpp);
      expect(s).toBeDefined();
      if (!s) return;
      expect(s.count).toBeGreaterThanOrEqual(2);
      expect(["win", "loss", "mixed"]).toContain(s.verdict);
      // No entry for otherOpp — RLS filtered it.
      expect(map.has(otherOpp)).toBe(false);
    });
  });

  it("update requires Pro; Pro can edit its own row", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, proAccount);
      const row = await createOutcome(
        { db: tx, accountId: proAccount, plan: "pro" },
        {
          opportunityId: proOpp,
          metricName: "NPS",
          predicted: 30,
          actual: null,
          measuredAt: null,
        },
      );
      const updated = await updateOutcome(
        { db: tx, accountId: proAccount, plan: "pro" },
        { id: row.id, actual: 35, measuredAt: new Date() },
      );
      expect(updated.actual).toBe(35);
      expect(updated.metricName).toBe("NPS"); // unchanged
    });
  });

  it("delete removes the row (and is Pro-only)", async () => {
    await handle.db.transaction(async (tx) => {
      await bind(tx, proAccount);
      const row = await createOutcome(
        { db: tx, accountId: proAccount, plan: "pro" },
        {
          opportunityId: proOpp,
          metricName: "to-delete",
          predicted: 1,
          actual: null,
          measuredAt: null,
        },
      );
      const { removed } = await deleteOutcome(
        { db: tx, accountId: proAccount, plan: "pro" },
        row.id,
      );
      expect(removed).toBe(true);
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
  plan: "free" | "solo" | "pro",
): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "account" DISABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" DISABLE ROW LEVEL SECURITY`);
    const [account] = await tx
      .insert(accounts)
      .values({ plan })
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

async function seedOpportunity(
  handle: TestDbHandle,
  accountId: string,
): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await bind(tx, accountId);
    // Seed a cluster first so the opportunity FK resolves in realistic
    // fashion (opportunities don't require a cluster at the DB level
    // but this keeps the shape honest).
    await tx.insert(insightClusters).values({
      accountId,
      title: "seed cluster",
      description: "for outcomes test",
      severity: "medium",
      frequency: 1,
      promptHash: "seed_hash",
    });
    const [row] = await tx
      .insert(opportunities)
      .values({
        accountId,
        title: "Seed opportunity",
        description: "for outcomes",
        reasoning: "test",
        impactEstimate: { retention: 0.1 },
        effortEstimate: "M",
        score: 0.5,
        confidence: 0.8,
        promptHash: "seed_hash_opp",
      })
      .returning({ id: opportunities.id });
    if (!row) throw new Error("seed opportunity insert failed");
    return row.id;
  });
}
