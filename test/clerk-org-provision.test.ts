import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockInnerJoin = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();

const chainMethods = {
  select: mockSelect,
  from: mockFrom,
  innerJoin: mockInnerJoin,
  where: mockWhere,
  limit: mockLimit,
  insert: mockInsert,
  values: mockValues,
  returning: mockReturning,
  update: mockUpdate,
  set: mockSet,
};

function resetChain() {
  mockSelect.mockReturnValue(chainMethods);
  mockFrom.mockReturnValue(chainMethods);
  mockInnerJoin.mockReturnValue(chainMethods);
  mockWhere.mockReturnValue(chainMethods);
  mockInsert.mockReturnValue(chainMethods);
  mockValues.mockReturnValue(chainMethods);
  mockUpdate.mockReturnValue(chainMethods);
  mockSet.mockReturnValue(chainMethods);
}

const mockTx = { ...chainMethods };
const mockDb = {
  ...chainMethods,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
    fn(mockTx),
  ),
};

vi.mock("@/db/client", () => ({ db: mockDb }));

vi.mock("@/db/schema", () => ({
  accounts: {
    id: "id",
    plan: "plan",
    clerkOrgId: "clerk_org_id",
    ownerUserId: "owner_user_id",
  },
  users: {
    id: "id",
    accountId: "account_id",
    clerkUserId: "clerk_user_id",
    email: "email",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  isNull: vi.fn((...args: unknown[]) => ({ type: "isNull", args })),
}));

describe("provisionAccountForClerkOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
  });

  it("returns existing account when org already provisioned", async () => {
    mockLimit
      .mockResolvedValueOnce([{ accountId: "acc-1", plan: "free" as const }])
      .mockResolvedValueOnce([{ id: "user-1" }]);

    const { provisionAccountForClerkOrg } = await import(
      "@/lib/account/provision"
    );

    const result = await provisionAccountForClerkOrg({
      clerkOrgId: "org_123",
      clerkUserId: "user_clerk_1",
      email: "test@example.com",
    });

    expect(result.created).toBe(false);
    expect(result.accountId).toBe("acc-1");
  });

  it("creates new account for new org", async () => {
    mockLimit.mockResolvedValueOnce([]);
    mockReturning
      .mockResolvedValueOnce([{ id: "acc-new", plan: "free" as const }])
      .mockResolvedValueOnce([{ id: "user-new" }]);

    const { provisionAccountForClerkOrg } = await import(
      "@/lib/account/provision"
    );

    const result = await provisionAccountForClerkOrg({
      clerkOrgId: "org_new",
      clerkUserId: "user_clerk_2",
      email: "new@example.com",
    });

    expect(result.created).toBe(true);
    expect(result.accountId).toBe("acc-new");
  });
});

describe("ensureUserInAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
  });

  it("returns existing user if already in account", async () => {
    mockLimit.mockResolvedValueOnce([{ id: "user-existing" }]);

    const { ensureUserInAccount } = await import(
      "@/lib/account/provision"
    );

    const result = await ensureUserInAccount(
      "acc-1",
      "clerk_user_1",
      "test@example.com",
    );

    expect(result.created).toBe(false);
    expect(result.userId).toBe("user-existing");
  });

  it("creates user row when joining existing account", async () => {
    mockLimit.mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: "user-new" }]);

    const { ensureUserInAccount } = await import(
      "@/lib/account/provision"
    );

    const result = await ensureUserInAccount(
      "acc-1",
      "clerk_user_new",
      "new@example.com",
    );

    expect(result.created).toBe(true);
    expect(result.userId).toBe("user-new");
  });
});
