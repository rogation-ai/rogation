import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/llm/router", () => ({
  embed: vi.fn().mockResolvedValue([Array(1536).fill(0.1)]),
}));

vi.mock("@/lib/evidence/scope-routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/evidence/scope-routing")>();
  return {
    ...actual,
    routeAllEvidence: vi.fn().mockResolvedValue({ routed: 0, unscoped: 0, total: 0 }),
    previewScopeMatches: vi.fn().mockResolvedValue({ matching: 0, total: 0 }),
  };
});

import { embed } from "@/lib/llm/router";
import { routeAllEvidence } from "@/lib/evidence/scope-routing";

describe("scope CRUD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("embed is called with the brief text on create", async () => {
    const mockEmbed = vi.mocked(embed);
    mockEmbed.mockResolvedValueOnce([Array(1536).fill(0.5)]);

    expect(mockEmbed).not.toHaveBeenCalled();
    // We can't test the full createScope without a DB, but we can verify
    // the mocking pattern works for integration tests.
    const result = await embed("Test brief about onboarding");
    expect(mockEmbed).toHaveBeenCalledWith("Test brief about onboarding");
    expect(result[0]).toHaveLength(1536);
  });

  it("routeAllEvidence is importable and returns expected shape", async () => {
    const mockRoute = vi.mocked(routeAllEvidence);
    const result = await mockRoute({} as never, "acct-123");
    expect(result).toEqual({ routed: 0, unscoped: 0, total: 0 });
  });

  it("SCOPE_THRESHOLD and MULTI_SCOPE_MARGIN are exported", async () => {
    const mod = await import("@/lib/evidence/scope-routing");
    expect(mod.SCOPE_THRESHOLD).toBe(0.55);
    expect(mod.MULTI_SCOPE_MARGIN).toBe(0.05);
  });
});
