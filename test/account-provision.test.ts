import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accounts, users } from "@/db/schema";
import { provisionAccountForClerkUser } from "@/lib/account/provision";
import { hasTestDb, setupTestDb, type TestDbHandle } from "./setup-db";

/*
  Integration coverage for the account-provisioning helper. This is
  the canonical path that replaces relying on the Clerk webhook
  (eng-review decision from /qa 2026-04-18 — webhooks are eventually
  consistent; own the critical path).

  Locks down:
  - First call creates the account + user + sets owner_user_id.
  - Re-running for the same Clerk user id is idempotent: same row,
    `created: false`, no duplicates.
  - Concurrency-safe: the UNIQUE index on user.clerk_user_id is the
    last line of defense if two requests race.
  - Email + plan round-trip correctly.

  DB-gated. CI pgvector service container runs it.
*/

describe.skipIf(!hasTestDb)("provisionAccountForClerkUser (DB-backed)", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await setupTestDb("provision");
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  it("creates account + user + owner link on first call", async () => {
    const result = await provisionAccountForClerkUser({
      clerkUserId: "user_first_provision",
      email: "first@test.dev",
    });

    expect(result.created).toBe(true);
    expect(result.plan).toBe("free");

    // Owner link set? (account.owner_user_id -> user.id)
    const [acc] = await handle.db
      .select({
        id: accounts.id,
        ownerUserId: accounts.ownerUserId,
      })
      .from(accounts)
      .where(eq(accounts.id, result.accountId))
      .limit(1);
    expect(acc?.ownerUserId).toBe(result.userId);
  });

  it("is idempotent on re-run (returns the same row, created: false)", async () => {
    const first = await provisionAccountForClerkUser({
      clerkUserId: "user_idempotent",
      email: "idem@test.dev",
    });
    const second = await provisionAccountForClerkUser({
      clerkUserId: "user_idempotent",
      email: "different@test.dev", // ignored on dedup
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.accountId).toBe(first.accountId);

    // Only one user row for this Clerk id.
    const rows = await handle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, "user_idempotent"));
    expect(rows).toHaveLength(1);
  });

  it("persists email correctly for a new user", async () => {
    const result = await provisionAccountForClerkUser({
      clerkUserId: "user_email_check",
      email: "email-probe@test.dev",
    });

    const [u] = await handle.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, result.userId))
      .limit(1);
    expect(u?.email).toBe("email-probe@test.dev");
  });

  it("concurrent racing calls for the same Clerk user both return the same row", async () => {
    // Fire two provision calls at the same time for the same Clerk
    // id. The UNIQUE index on user.clerk_user_id guarantees only one
    // wins the insert; the loser hits SQLSTATE 23505 which the
    // helper now catches + re-SELECTs inside. Both callers see a
    // clean result pointing at the winner's row. This eliminates the
    // user-visible 500 on a two-tab signup. Pre-landing review
    // finding, 2026-04-20.
    const clerkId = "user_race";
    const [a, b] = await Promise.all([
      provisionAccountForClerkUser({ clerkUserId: clerkId, email: "a@t.dev" }),
      provisionAccountForClerkUser({ clerkUserId: clerkId, email: "a@t.dev" }),
    ]);

    // Both fulfilled, both point at the same user + account.
    expect(a.userId).toBe(b.userId);
    expect(a.accountId).toBe(b.accountId);
    // Exactly one of them did the insert; the other dedup'd.
    expect([a.created, b.created].sort()).toEqual([false, true]);

    // Exactly one DB row.
    const rows = await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM "user" WHERE clerk_user_id = ${clerkId}`,
    );
    const n = Number((rows[0] as { n: number } | undefined)?.n ?? 0);
    expect(n).toBe(1);
  });
});
