import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accounts, evidence, users } from "@/db/schema";
import { hashEvidenceContent } from "@/lib/evidence/hash";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  DB-gated integration over the evidence router's insert path. We don't
  exercise the router function directly — we simulate what it does
  (dedup + RLS-scoped write) so we cover the same invariants without
  wiring up a tRPC caller harness.

  Proves:
    1. Dedup: inserting the same content twice with the correct UNIQUE
       constraint returns one row, even if the app layer races.
    2. Cross-account dedup isolation: A's evidence with the same hash
       as B's is still counted as a new row for B (the unique index
       keys on account_id + source_type + source_ref).
    3. RLS: listing evidence after bind(A) returns only A's rows.
*/

describe.skipIf(!hasTestDb)("evidence ingest (DB-backed)", () => {
  let handle: TestDbHandle;
  let accountAId: string;
  let accountBId: string;

  beforeAll(async () => {
    handle = await setupTestDb("evidence_ingest");
    accountAId = await seedAccount(handle, "a@test.dev");
    accountBId = await seedAccount(handle, "b@test.dev");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("inserts a paste row with a content hash and returns the id", async () => {
    const content = "Customer interview with Alice about onboarding friction.";
    const contentHash = hashEvidenceContent(content);

    const id = await handle.db.transaction(async (tx) => {
      await bind(tx, accountAId);
      const [row] = await tx
        .insert(evidence)
        .values({
          accountId: accountAId,
          sourceType: "paste_ticket",
          sourceRef: `paste:${contentHash.slice(0, 12)}`,
          content,
          contentHash,
        })
        .returning({ id: evidence.id });
      return row?.id;
    });

    expect(id).toBeTruthy();
  });

  it("rejects a duplicate (account_id, source_type, source_ref) as a UNIQUE violation", async () => {
    const content = "Duplicate check.";
    const contentHash = hashEvidenceContent(content);
    const sourceRef = `paste:${contentHash.slice(0, 12)}`;

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountAId);
      await tx.insert(evidence).values({
        accountId: accountAId,
        sourceType: "paste_ticket",
        sourceRef,
        content,
        contentHash,
      });
    });

    // Second insert with the same sourceRef hits the unique index on
    // (account_id, source_type, source_ref) that backs ingestion
    // idempotency (eng review CQ #4). The router uses dedup-by-hash
    // BEFORE this point to avoid the crash; the constraint is the last
    // line of defense if two concurrent pastes slip through.
    const attempt = handle.db.transaction(async (tx) => {
      await bind(tx, accountAId);
      await tx.insert(evidence).values({
        accountId: accountAId,
        sourceType: "paste_ticket",
        sourceRef,
        content,
        contentHash,
      });
    });

    await expect(attempt).rejects.toThrowError(/unique|duplicate/i);
  });

  it("cross-account: B can paste the same content as A independently", async () => {
    const content = "Same content, two accounts.";
    const contentHash = hashEvidenceContent(content);
    const sourceRef = `paste:${contentHash.slice(0, 12)}`;

    // A wrote this content in the first test's noise; write it for B too.
    await handle.db.transaction(async (tx) => {
      await bind(tx, accountAId);
      await tx.insert(evidence).values({
        accountId: accountAId,
        sourceType: "paste_ticket",
        sourceRef,
        content,
        contentHash,
      });
    });

    await handle.db.transaction(async (tx) => {
      await bind(tx, accountBId);
      await tx.insert(evidence).values({
        accountId: accountBId,
        sourceType: "paste_ticket",
        sourceRef,
        content,
        contentHash,
      });
    });

    // B sees exactly one matching row under their scope.
    const bRows = await handle.db.transaction(async (tx) => {
      await bind(tx, accountBId);
      return tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.contentHash, contentHash),
            eq(evidence.accountId, accountBId),
          ),
        );
    });
    expect(bRows).toHaveLength(1);

    // A sees their copy and ONLY their copy via RLS — B's row is invisible.
    const aVisible = await handle.db.transaction(async (tx) => {
      await bind(tx, accountAId);
      return tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(eq(evidence.contentHash, contentHash));
    });
    expect(aVisible).toHaveLength(1);
  });
});

/* ------------------------------- helpers -------------------------------- */

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
    if (!account) throw new Error("Seed account insert failed");
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
