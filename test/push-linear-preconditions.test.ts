import { describe, expect, it, vi } from "vitest";

/*
  Unit coverage for the push-to-Linear preconditions chain. Each case
  short-circuits at exactly one step and returns the corresponding
  error code. The LinearClient + decrypt are mocked; the drizzle
  query builder is stubbed with a queue — the orchestrator runs three
  selects in a known order (spec → credential → state) then updates,
  so we just hand out rows by position.

  Why these matter: the error code we return drives which CTA the
  spec editor shows (upgrade, connect, pick team, reconnect). A
  regression where two cases return the same code silently would
  leave PMs stuck on the wrong screen.
*/

vi.mock("@/lib/integrations/linear/client", () => ({
  createIssue: vi.fn(),
  LinearApiError: class LinearApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/crypto/envelope", () => ({
  decrypt: vi.fn(() => "decrypted-token"),
}));

/*
  Build a tx stub whose .select() returns rows in the order the
  orchestrator requests them. The orchestrator runs exactly three
  selects in the push-linear.ts > pushSpecToLinear flow:

    1. spec (joined opportunity)
    2. integration_credential
    3. integration_state

  Each can be null (missing row) or an object (matching row).
*/
function makeTx(queue: Array<unknown | null>) {
  const copy = [...queue];
  const updates: Array<unknown> = [];

  const builder = {
    innerJoin() {
      return builder;
    },
    where() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    async limit() {
      const row = copy.shift();
      return row ? [row] : [];
    },
  };

  return {
    select() {
      return {
        from() {
          return builder;
        },
      };
    },
    update() {
      return {
        set(s: unknown) {
          updates.push(s);
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
    _updates: updates,
  };
}

describe("pushSpecToLinear preconditions", () => {
  it("returns spec-not-found when no spec row exists", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx([null]);
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("spec-not-found");
  });

  it("returns not-connected when no credential row", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx([
      {
        id: "s1",
        contentIr: { title: "t" },
        contentMd: "md",
        oppTitle: "opp",
      },
      null, // no credential
    ]);
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("not-connected");
  });

  it("returns no-default-team when config has no defaultTeamId", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx([
      {
        id: "s1",
        contentIr: { title: "t" },
        contentMd: "md",
        oppTitle: "opp",
      },
      { ciphertext: "ct", nonce: "n" },
      { config: { workspaceName: "Acme" } }, // no defaultTeamId
    ]);
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("no-default-team");
  });

  it("returns no-default-team when stateRow missing entirely", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx([
      {
        id: "s1",
        contentIr: { title: "t" },
        contentMd: "md",
        oppTitle: "opp",
      },
      { ciphertext: "ct", nonce: "n" },
      null,
    ]);
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("no-default-team");
  });

  it("happy path: creates issue and persists url + identifier", async () => {
    const client = await import("@/lib/integrations/linear/client");
    vi.mocked(client.createIssue).mockResolvedValueOnce({
      id: "iss-1",
      identifier: "CORE-42",
      url: "https://linear.app/acme/issue/CORE-42",
    });

    const tx = makeTx([
      {
        id: "s1",
        contentIr: { title: "Fix onboarding" },
        contentMd: "# Fix onboarding\n\nfoo",
        oppTitle: "Onboarding confusion",
      },
      { ciphertext: "ct", nonce: "n" },
      { config: { defaultTeamId: "t-1", defaultTeamName: "Core" } },
    ]);

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identifier).toBe("CORE-42");
      expect(res.url).toContain("CORE-42");
    }
    expect(client.createIssue).toHaveBeenCalledWith(
      "decrypted-token",
      expect.objectContaining({ teamId: "t-1", title: "Fix onboarding" }),
    );
    // Spec row got linear_issue_* written
    const s = tx._updates[0] as Record<string, unknown>;
    expect(s.linearIssueId).toBe("iss-1");
    expect(s.linearIssueUrl).toContain("CORE-42");
    expect(s.linearIssueIdentifier).toBe("CORE-42");
  });

  it("falls back to opportunity title when IR title is blank", async () => {
    const client = await import("@/lib/integrations/linear/client");
    vi.mocked(client.createIssue).mockResolvedValueOnce({
      id: "iss-1",
      identifier: "CORE-1",
      url: "u",
    });
    const tx = makeTx([
      {
        id: "s1",
        contentIr: { title: "   " },
        contentMd: "md",
        oppTitle: "Opportunity fallback title",
      },
      { ciphertext: "ct", nonce: "n" },
      { config: { defaultTeamId: "t-1" } },
    ]);
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(true);
    expect(client.createIssue).toHaveBeenCalledWith(
      "decrypted-token",
      expect.objectContaining({ title: "Opportunity fallback title" }),
    );
  });

  it("401 from Linear → token-invalid + state flipped to token_invalid", async () => {
    const client = await import("@/lib/integrations/linear/client");
    vi.mocked(client.createIssue).mockRejectedValueOnce(
      new client.LinearApiError("revoked", 401),
    );
    const tx = makeTx([
      {
        id: "s1",
        contentIr: { title: "t" },
        contentMd: "md",
        oppTitle: "opp",
      },
      { ciphertext: "ct", nonce: "n" },
      { config: { defaultTeamId: "t-1" } },
    ]);
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("token-invalid");
    // Last update was integration_state.status = "token_invalid"
    const set = tx._updates[0] as Record<string, unknown>;
    expect(set.status).toBe("token_invalid");
  });
});
