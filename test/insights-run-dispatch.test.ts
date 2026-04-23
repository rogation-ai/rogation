import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { accounts, insightRuns } from "@/db/schema";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Dispatch tests for the cluster-run async path (Lane E).

  Targets the lib helper `dispatchClusterRun` — which trpc.insights.run
  is a thin wrapper over — so we don't have to spin up a tRPC caller
  against the app's db singleton.

  Mocks @/lib/inngest/client and @/lib/rate-limit.

  Covers:
    - inserts a `pending` insight_run + emits EVENT_CLUSTER_REQUESTED
    - rate-limit rejection throws TOO_MANY_REQUESTS + no row + no send
    - inngest.send throws inside the caller's tx → row rolls back
    - runStatus-style RLS isolation: a run created for account A is
      invisible to a tx bound to account B
*/

const mockSend = vi.fn();
vi.mock("@/lib/inngest/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inngest/client")>(
    "@/lib/inngest/client",
  );
  return {
    ...actual,
    inngest: { send: (...args: unknown[]) => mockSend(...args) },
  };
});

const mockCheckLimit = vi.fn();
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit",
  );
  return {
    ...actual,
    checkLimit: (...args: unknown[]) => mockCheckLimit(...args),
  };
});

describe.skipIf(!hasTestDb)("dispatchClusterRun (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    handle = await setupTestDb("insights_run_dispatch");
    accountA = await seedAccount(handle, "a-dispatch@test.dev");
    accountB = await seedAccount(handle, "b-dispatch@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  beforeEach(async () => {
    mockSend.mockReset();
    mockCheckLimit.mockReset();
    mockCheckLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 10,
      reset: Date.now() + 3600_000,
    });
    // Each test commits inside its tx; truncate to avoid cross-test pollution.
    await handle.db.execute(sql`TRUNCATE TABLE insight_run RESTART IDENTITY CASCADE`);
  });

  it("inserts pending insight_run + emits EVENT_CLUSTER_REQUESTED + returns runId", async () => {
    mockSend.mockResolvedValueOnce({ ids: ["ev_1"] });
    const { dispatchClusterRun } = await import(
      "@/lib/evidence/clustering/dispatch"
    );

    const runId = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      const res = await dispatchClusterRun({ db: tx, accountId: accountA });
      return res.runId;
    });

    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith({
      name: "insights/cluster.requested",
      data: { runId, accountId: accountA },
    });

    const [row] = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return tx
        .select()
        .from(insightRuns)
        .where(eq(insightRuns.id, runId))
        .limit(1);
    });
    expect(row?.status).toBe("pending");
    expect(row?.mode).toBe("incremental");
    expect(row?.accountId).toBe(accountA);
  });

  it("rate-limit rejection throws TOO_MANY_REQUESTS + no row + no send", async () => {
    mockCheckLimit.mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 3600_000,
    });
    const { dispatchClusterRun } = await import(
      "@/lib/evidence/clustering/dispatch"
    );

    await expect(
      handle.db.transaction(async (tx) => {
        await bind(tx, accountA);
        await dispatchClusterRun({ db: tx, accountId: accountA });
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(mockSend).not.toHaveBeenCalled();
    const rows = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return tx
        .select({ id: insightRuns.id })
        .from(insightRuns)
        .where(eq(insightRuns.accountId, accountA));
    });
    expect(rows).toHaveLength(0);
  });

  it("if inngest.send throws inside caller's tx, the insert rolls back", async () => {
    mockSend.mockRejectedValueOnce(new Error("inngest down"));
    const { dispatchClusterRun } = await import(
      "@/lib/evidence/clustering/dispatch"
    );

    await expect(
      handle.db.transaction(async (tx) => {
        await bind(tx, accountA);
        await dispatchClusterRun({ db: tx, accountId: accountA });
      }),
    ).rejects.toThrow(/inngest down/);

    const rows = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return tx
        .select({ id: insightRuns.id })
        .from(insightRuns)
        .where(eq(insightRuns.accountId, accountA));
    });
    expect(rows).toHaveLength(0);
  });

  it("RLS: a run for account A is invisible to a tx bound to account B", async () => {
    mockSend.mockResolvedValue({ ids: ["ev"] });
    const { dispatchClusterRun } = await import(
      "@/lib/evidence/clustering/dispatch"
    );

    const runId = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return (await dispatchClusterRun({ db: tx, accountId: accountA })).runId;
    });

    // Same row queried under account B's session var → zero rows.
    const seenFromB = await handle.db.transaction(async (tx) => {
      await bind(tx, accountB);
      return tx
        .select({ id: insightRuns.id })
        .from(insightRuns)
        .where(eq(insightRuns.id, runId));
    });
    expect(seenFromB).toHaveLength(0);

    // Same row queried under account A's session var → exactly one row.
    const seenFromA = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return tx
        .select({ id: insightRuns.id })
        .from(insightRuns)
        .where(eq(insightRuns.id, runId));
    });
    expect(seenFromA).toHaveLength(1);
  });

  it("dedupes: non-terminal run returns existing runId + deduped=true, no new row, no new send", async () => {
    mockSend.mockResolvedValueOnce({ ids: ["ev_1"] });
    const { dispatchClusterRun } = await import(
      "@/lib/evidence/clustering/dispatch"
    );

    // First dispatch creates a pending run.
    const first = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return dispatchClusterRun({ db: tx, accountId: accountA });
    });
    expect(first.deduped).toBe(false);
    expect(mockSend).toHaveBeenCalledOnce();

    // Second dispatch while the first is still pending returns the
    // same id, doesn't insert, doesn't send.
    const second = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return dispatchClusterRun({ db: tx, accountId: accountA });
    });
    expect(second.runId).toBe(first.runId);
    expect(second.deduped).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce(); // still 1

    const rows = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return tx
        .select({ id: insightRuns.id })
        .from(insightRuns)
        .where(eq(insightRuns.accountId, accountA));
    });
    expect(rows).toHaveLength(1);

    // Once the in-flight run reaches a terminal status, a new
    // dispatch is allowed through. Update inside a bound tx so RLS
    // on insight_run doesn't filter the row.
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      await tx
        .update(insightRuns)
        .set({ status: "done" })
        .where(eq(insightRuns.id, first.runId));
    });

    mockSend.mockResolvedValueOnce({ ids: ["ev_2"] });
    const third = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return dispatchClusterRun({ db: tx, accountId: accountA });
    });
    expect(third.deduped).toBe(false);
    expect(third.runId).not.toBe(first.runId);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("latestRun-style: most recent row for the account comes first", async () => {
    mockSend.mockResolvedValue({ ids: ["ev"] });
    const { dispatchClusterRun } = await import(
      "@/lib/evidence/clustering/dispatch"
    );

    // Two dispatches separated by a terminal transition so dedupe
    // doesn't coalesce them.
    const first = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return (await dispatchClusterRun({ db: tx, accountId: accountA })).runId;
    });
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      await tx
        .update(insightRuns)
        .set({ status: "done" })
        .where(eq(insightRuns.id, first));
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return (await dispatchClusterRun({ db: tx, accountId: accountA })).runId;
    });
    expect(first).not.toBe(second);

    const [latest] = await handle.db.transaction(async (tx) => {
      await bind(tx, accountA);
      return tx
        .select({ id: insightRuns.id })
        .from(insightRuns)
        .where(eq(insightRuns.accountId, accountA))
        .orderBy(desc(insightRuns.startedAt))
        .limit(1);
    });
    expect(latest?.id).toBe(second);
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
    if (!account) throw new Error("seed account");
    await tx.execute(sql`
      INSERT INTO "user" (account_id, clerk_user_id, email)
      VALUES (${account.id}, ${`clerk_${account.id}`}, ${email})
    `);
    await tx.execute(sql`ALTER TABLE "account" ENABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE "user" ENABLE ROW LEVEL SECURITY`);
    return account.id;
  });
}
