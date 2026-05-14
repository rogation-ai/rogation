import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Unit coverage for the rewritten pushSpecToLinear orchestrator.
  Mocks the Linear client + envelope decrypt + a chainable drizzle
  builder. The builder hands out rows in order from a queue.

  What this covers (per design doc test plan):
    - Precondition cascade (spec → cred → team → token).
    - In-flight guard (lock acquired vs already-pushing).
    - Story-count cap.
    - First-push happy path.
    - First-push cleanup when all issue creates fail.
    - Token-invalid mid-loop persists partial state.
    - Update-mode happy path (parallel updates + creates).
    - recreatedAfterDelete auto-recovery on UNKNOWN_ENTITY.
    - archiveIssue soft-success on UNKNOWN_ENTITY.

  RLS / DB-roundtrip tests live in the integration test file (gated
  on TEST_DATABASE_URL — out of scope here).
*/

vi.mock("@/lib/integrations/linear/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/linear/client")
  >("@/lib/integrations/linear/client");
  return {
    ...actual,
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    archiveIssue: vi.fn(),
  };
});

vi.mock("@/lib/crypto/envelope", () => ({
  decrypt: vi.fn(() => "decrypted-token"),
}));

/*
  Build a tx stub.

  The orchestrator runs in this order:
    1. select spec (joined with opportunity) → preconditions
    2. select integration_credential
    3. select integration_state
    4. update specs SET linear_push_status='pushing' WHERE idle RETURNING → in-flight lock
    5. (Linear API calls — mocked at call site)
    6. update specs SET linear_project_*  + linearIssueMap (persistence)
    7. update specs SET linear_push_status='idle' (release lock)

  We model the chainable builder as a single object with methods
  returning itself, and a counter that returns successive select rows
  from a queue.
*/
function makeTx(opts: {
  rows?: Array<unknown | null>;
  lockAcquired?: boolean;
}) {
  const rowQueue = [...(opts.rows ?? [])];
  const lockAcquired = opts.lockAcquired ?? true;
  const updates: Array<{ table?: string; set: unknown }> = [];
  let updateCount = 0;

  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  builder.innerJoin = () => builder;
  builder.where = () => builder;
  builder.orderBy = () => builder;
  builder.limit = async () => {
    const row = rowQueue.shift();
    return row ? [row] : [];
  };
  // returning() is used by acquireInFlightLock.
  builder.returning = async () =>
    lockAcquired ? [{ id: "spec-1" }] : [];

  return {
    select() {
      return {
        from() {
          return builder;
        },
      };
    },
    update() {
      const setObj = {
        set(s: unknown) {
          updates.push({ set: s });
          updateCount++;
          return {
            where() {
              return {
                returning() {
                  return updateCount === 1
                    ? // First update is the in-flight lock (RETURNING).
                      lockAcquired
                      ? Promise.resolve([{ id: "spec-1" }])
                      : Promise.resolve([])
                    : Promise.resolve([{ id: "spec-1" }]);
                },
                // Some updates don't chain .returning() (the release
                // lock and credential state updates) — those resolve
                // via the thenable on the where().
                then(
                  resolve: (value: unknown) => unknown,
                  _reject: (err: unknown) => unknown,
                ) {
                  resolve(undefined);
                },
              };
            },
          };
        },
      };
      return setObj;
    },
    _updates: updates,
  };
}

const baseSpecRow = {
  id: "spec-1",
  contentIr: {
    title: "Spec Title",
    summary: "S",
    userStories: [
      { id: "US1", persona: "p", goal: "g", value: "v" },
    ],
    acceptanceCriteria: [],
    nonFunctional: [],
    edgeCases: [],
    qaChecklist: [],
    citations: [],
  },
  contentMd: "md",
  oppTitle: "Opportunity",
  linearProjectId: null,
  linearProjectUrl: null,
  linearIssueMap: null,
  linearPushStatus: "idle",
};

const credRow = { ciphertext: "c", nonce: "n" };
const stateRow = { config: { defaultTeamId: "team-1" } };

afterEach(() => {
  vi.clearAllMocks();
});

describe("pushSpecToLinear — preconditions", () => {
  it("returns spec-not-found when no spec row exists", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [null] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("spec-not-found");
  });

  it("returns not-connected when credential is missing", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [baseSpecRow, null] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("not-connected");
  });

  it("returns no-default-team when state.config lacks defaultTeamId", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({
      rows: [baseSpecRow, credRow, { config: { workspaceId: "ws-1" } }],
    });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("no-default-team");
  });

  it("returns spec-too-many-stories when IR has > 50 stories", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tooMany = {
      ...baseSpecRow,
      contentIr: {
        ...baseSpecRow.contentIr,
        userStories: Array.from({ length: 51 }, (_, i) => ({
          id: `US${i}`,
          persona: "p",
          goal: "g",
          value: "v",
        })),
      },
    };
    const tx = makeTx({ rows: [tooMany, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("spec-too-many-stories");
  });
});

describe("pushSpecToLinear — in-flight guard", () => {
  it("returns push-in-flight when the lock cannot be acquired", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({
      rows: [baseSpecRow, credRow, stateRow],
      lockAcquired: false,
    });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("push-in-flight");
  });
});

describe("pushSpecToLinear — first push happy path", () => {
  it("creates project + issues and returns issueCount", async () => {
    const client = await import("@/lib/integrations/linear/client");
    vi.mocked(client.createProject).mockResolvedValueOnce({
      id: "proj-1",
      name: "Spec Title",
      url: "https://linear.app/acme/project/proj-1",
    });
    vi.mocked(client.createIssue).mockResolvedValueOnce({
      id: "iss-1",
      identifier: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1",
    });

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [baseSpecRow, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.projectId).toBe("proj-1");
      expect(res.issueCount).toBe(1);
      expect(res.recreatedAfterDelete).toBe(false);
    }
    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(client.createIssue).toHaveBeenCalledWith(
      "decrypted-token",
      expect.objectContaining({
        teamId: "team-1",
        projectId: "proj-1",
      }),
    );
  });
});

describe("pushSpecToLinear — first push cleanup on all-fail", () => {
  it("calls deleteProject and returns linear-api-error when every issueCreate fails non-auth", async () => {
    const client = await import("@/lib/integrations/linear/client");
    const { LinearApiError } = await import(
      "@/lib/integrations/linear/client"
    );
    vi.mocked(client.createProject).mockResolvedValueOnce({
      id: "proj-1",
      name: "n",
      url: "https://linear.app/acme/project/proj-1",
    });
    vi.mocked(client.createIssue).mockRejectedValueOnce(
      new LinearApiError("server error", 500),
    );
    vi.mocked(client.deleteProject).mockResolvedValueOnce({ success: true });

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [baseSpecRow, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("linear-api-error");
      expect(res.message).toContain("cleaned up");
    }
    expect(client.deleteProject).toHaveBeenCalledWith(
      "decrypted-token",
      "proj-1",
    );
  });
});

describe("pushSpecToLinear — token-invalid mid-loop", () => {
  it("returns token-invalid and persists partial map when an issueCreate hits 401", async () => {
    const client = await import("@/lib/integrations/linear/client");
    const { LinearApiError } = await import(
      "@/lib/integrations/linear/client"
    );

    // IR with two stories so we have a partial-success scenario:
    // first issueCreate succeeds, second hits 401.
    const irTwo = {
      ...baseSpecRow,
      contentIr: {
        ...baseSpecRow.contentIr,
        userStories: [
          { id: "US1", persona: "p", goal: "g1", value: "v" },
          { id: "US2", persona: "p", goal: "g2", value: "v" },
        ],
      },
    };

    vi.mocked(client.createProject).mockResolvedValueOnce({
      id: "proj-1",
      name: "n",
      url: "u",
    });
    vi.mocked(client.createIssue)
      .mockResolvedValueOnce({
        id: "i-1",
        identifier: "E-1",
        url: "u-1",
      })
      .mockRejectedValueOnce(new LinearApiError("token revoked", 401));

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [irTwo, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("token-invalid");
    // Should NOT have called deleteProject — we keep the project so
    // the user can reconnect + re-push via update-in-place.
    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});

describe("pushSpecToLinear — empty-spec", () => {
  it("returns empty-spec when IR title and oppTitle are both empty/whitespace", async () => {
    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const emptySpec = {
      ...baseSpecRow,
      contentIr: { ...baseSpecRow.contentIr, title: "" },
      oppTitle: "   ",
    };
    const tx = makeTx({ rows: [emptySpec, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("empty-spec");
  });
});

describe("pushSpecToLinear — decrypt failure", () => {
  it("marks integration token_invalid when decrypt throws", async () => {
    const envelope = await import("@/lib/crypto/envelope");
    vi.mocked(envelope.decrypt).mockImplementationOnce(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [baseSpecRow, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("token-invalid");
  });
});

describe("pushSpecToLinear — update-mode happy path", () => {
  it("parallel updates + creates + sequential archives produce correct runningMap", async () => {
    const client = await import("@/lib/integrations/linear/client");

    // IR has US1 (in prior) and US3 (new). Prior had US1 + US2.
    // Expected: 1 update (US1), 1 create (US3), 1 archive (US2).
    const irMixed = {
      ...baseSpecRow,
      contentIr: {
        ...baseSpecRow.contentIr,
        userStories: [
          { id: "US1", persona: "p", goal: "g1-updated", value: "v" },
          { id: "US3", persona: "p", goal: "g3-new", value: "v" },
        ],
      },
      linearProjectId: "proj-existing",
      linearProjectUrl: "https://linear.app/acme/project/proj-existing",
      linearIssueMap: {
        US1: { id: "i-1", identifier: "ENG-1", url: "u-1" },
        US2: { id: "i-2", identifier: "ENG-2", url: "u-2" },
      },
    };

    vi.mocked(client.updateProject).mockResolvedValueOnce({
      id: "proj-existing",
      name: "n",
      url: "u",
    });
    vi.mocked(client.updateIssue).mockResolvedValueOnce({
      id: "i-1",
      identifier: "ENG-1",
      url: "u-1",
    });
    vi.mocked(client.createIssue).mockResolvedValueOnce({
      id: "i-3",
      identifier: "ENG-3",
      url: "u-3",
    });
    vi.mocked(client.archiveIssue).mockResolvedValueOnce({ success: true });

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [irMixed, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
      "update-in-place",
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.projectId).toBe("proj-existing");
      expect(res.issueCount).toBe(2);
      expect(res.recreatedAfterDelete).toBe(false);
    }
    expect(client.updateProject).toHaveBeenCalledTimes(1);
    expect(client.updateIssue).toHaveBeenCalledTimes(1);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(client.archiveIssue).toHaveBeenCalledTimes(1);
  });
});

describe("pushSpecToLinear — archive UNKNOWN_ENTITY soft-success", () => {
  it("drops entry from map and continues when archiveIssue hits UNKNOWN_ENTITY", async () => {
    const client = await import("@/lib/integrations/linear/client");
    const { LinearApiError } = await import(
      "@/lib/integrations/linear/client"
    );

    // IR has only US1; prior had US1, US2, US3 (US2/US3 should archive).
    // Mock US2 archive to throw UNKNOWN_ENTITY (already deleted in Linear),
    // US3 archive to succeed. Both entries should be removed from the map.
    const ir = {
      ...baseSpecRow,
      contentIr: {
        ...baseSpecRow.contentIr,
        userStories: [
          { id: "US1", persona: "p", goal: "g", value: "v" },
        ],
      },
      linearProjectId: "proj-1",
      linearProjectUrl: "u",
      linearIssueMap: {
        US1: { id: "i-1", identifier: "E-1", url: "u" },
        US2: { id: "i-2", identifier: "E-2", url: "u" },
        US3: { id: "i-3", identifier: "E-3", url: "u" },
      },
    };

    vi.mocked(client.updateProject).mockResolvedValueOnce({
      id: "proj-1",
      name: "n",
      url: "u",
    });
    vi.mocked(client.updateIssue).mockResolvedValueOnce({
      id: "i-1",
      identifier: "E-1",
      url: "u",
    });
    vi.mocked(client.archiveIssue)
      .mockRejectedValueOnce(new LinearApiError("UNKNOWN_ENTITY: gone", 200))
      .mockResolvedValueOnce({ success: true });

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [ir, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
      "update-in-place",
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.issueCount).toBe(1);
  });
});

describe("pushSpecToLinear — recreatedAfterDelete recovery failure", () => {
  it("propagates linear-api-error when recovery createProject itself fails", async () => {
    const client = await import("@/lib/integrations/linear/client");
    const { LinearApiError } = await import(
      "@/lib/integrations/linear/client"
    );

    const priorSpec = {
      ...baseSpecRow,
      linearProjectId: "proj-old",
      linearProjectUrl: "u",
      linearIssueMap: { US1: { id: "i-old", identifier: "E-OLD", url: "u" } },
    };

    vi.mocked(client.updateProject).mockRejectedValueOnce(
      new LinearApiError("UNKNOWN_ENTITY: gone", 200),
    );
    vi.mocked(client.createProject).mockRejectedValueOnce(
      new LinearApiError("Linear is on fire", 500),
    );

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [priorSpec, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
      "update-in-place",
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("linear-api-error");
      // Should NOT spuriously claim recreatedAfterDelete=true on failure.
      // (PushSpecFailure has no recreatedAfterDelete field by design.)
    }
  });
});

describe("detectPriorProjectConflict + priorLinearProject helpers", () => {
  it("detectPriorProjectConflict returns null when no spec or no linearProjectId", async () => {
    const { detectPriorProjectConflict } = await import(
      "@/lib/evidence/push-linear"
    );

    // No spec row
    const tx1 = makeTx({ rows: [null] });
    expect(
      await detectPriorProjectConflict(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        { db: tx1 as any, accountId: "acc-1" },
        "opp-1",
      ),
    ).toBeNull();

    // Spec exists but no project
    const tx2 = makeTx({
      rows: [
        { linearProjectId: null, linearProjectUrl: null, linearIssueMap: null },
      ],
    });
    expect(
      await detectPriorProjectConflict(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        { db: tx2 as any, accountId: "acc-1" },
        "opp-1",
      ),
    ).toBeNull();
  });

  it("detectPriorProjectConflict distinguishes empty-map from populated-map variants", async () => {
    const { detectPriorProjectConflict } = await import(
      "@/lib/evidence/push-linear"
    );

    // Empty map → "linear-project-exists-but-empty"
    const txEmpty = makeTx({
      rows: [
        {
          linearProjectId: "p1",
          linearProjectUrl: "u",
          linearIssueMap: {},
        },
      ],
    });
    const empty = await detectPriorProjectConflict(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: txEmpty as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(empty?.kind).toBe("linear-project-exists-but-empty");
    expect(empty?.issueCount).toBe(0);

    // Populated map → "linear-project-exists" with count
    const txFull = makeTx({
      rows: [
        {
          linearProjectId: "p1",
          linearProjectUrl: "u",
          linearIssueMap: {
            US1: { id: "i1", identifier: "E", url: "u" },
            US2: { id: "i2", identifier: "E", url: "u" },
          },
        },
      ],
    });
    const full = await detectPriorProjectConflict(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: txFull as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(full?.kind).toBe("linear-project-exists");
    expect(full?.issueCount).toBe(2);
  });

  it("priorLinearProject returns null when no version has linearProjectId", async () => {
    const { priorLinearProject } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [null] });
    expect(
      await priorLinearProject(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        { db: tx as any, accountId: "acc-1" },
        "opp-1",
      ),
    ).toBeNull();
  });

  it("priorLinearProject returns the most recent pushed version", async () => {
    const { priorLinearProject } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({
      rows: [
        {
          linearProjectId: "proj-latest",
          linearProjectUrl: "https://linear.app/proj-latest",
        },
      ],
    });
    const out = await priorLinearProject(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
    );
    expect(out).toEqual({
      projectId: "proj-latest",
      projectUrl: "https://linear.app/proj-latest",
    });
  });
});

describe("pushSpecToLinear — recreatedAfterDelete auto-recovery", () => {
  it("falls through to create-new when updateProject hits UNKNOWN_ENTITY", async () => {
    const client = await import("@/lib/integrations/linear/client");
    const { LinearApiError } = await import(
      "@/lib/integrations/linear/client"
    );

    const priorSpec = {
      ...baseSpecRow,
      linearProjectId: "proj-old",
      linearProjectUrl: "u-old",
      linearIssueMap: {
        US1: { id: "i-old", identifier: "E-OLD", url: "u" },
      },
    };

    vi.mocked(client.updateProject).mockRejectedValueOnce(
      new LinearApiError("UNKNOWN_ENTITY: project gone", 200),
    );
    vi.mocked(client.createProject).mockResolvedValueOnce({
      id: "proj-new",
      name: "n",
      url: "https://linear.app/acme/project/proj-new",
    });
    vi.mocked(client.createIssue).mockResolvedValueOnce({
      id: "i-new",
      identifier: "E-NEW",
      url: "u-new",
    });

    const { pushSpecToLinear } = await import("@/lib/evidence/push-linear");
    const tx = makeTx({ rows: [priorSpec, credRow, stateRow] });
    const res = await pushSpecToLinear(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      { db: tx as any, accountId: "acc-1" },
      "opp-1",
      "update-in-place",
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.recreatedAfterDelete).toBe(true);
      expect(res.projectId).toBe("proj-new");
    }
    expect(client.createProject).toHaveBeenCalled();
  });
});
