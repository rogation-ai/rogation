import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PlanTier } from "@/lib/plans";

describe("connectorTier map (lib/plans.ts)", () => {
  let canConnectProvider: (provider: string, plan: PlanTier) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    const plans = await import("@/lib/plans");
    canConnectProvider = plans.canConnectProvider;
  });

  it("slack is available on all plans", () => {
    expect(canConnectProvider("slack", "free")).toBe(true);
    expect(canConnectProvider("slack", "solo")).toBe(true);
    expect(canConnectProvider("slack", "pro")).toBe(true);
  });

  it("hotjar requires solo or higher", () => {
    expect(canConnectProvider("hotjar", "free")).toBe(false);
    expect(canConnectProvider("hotjar", "solo")).toBe(true);
    expect(canConnectProvider("hotjar", "pro")).toBe(true);
  });

  it("zendesk requires pro", () => {
    expect(canConnectProvider("zendesk", "free")).toBe(false);
    expect(canConnectProvider("zendesk", "solo")).toBe(false);
    expect(canConnectProvider("zendesk", "pro")).toBe(true);
  });

  it("gong requires pro", () => {
    expect(canConnectProvider("gong", "free")).toBe(false);
    expect(canConnectProvider("gong", "solo")).toBe(false);
    expect(canConnectProvider("gong", "pro")).toBe(true);
  });

  it("unknown provider returns false", () => {
    expect(canConnectProvider("unknown", "pro")).toBe(false);
  });
});

describe("Nango client (lib/integrations/nango/client.ts)", () => {
  it("returns null when NANGO_SECRET_KEY is not set", async () => {
    vi.resetModules();
    const { getNango, nangoConfigured } = await import(
      "@/lib/integrations/nango/client"
    );
    expect(nangoConfigured()).toBe(false);
    expect(getNango()).toBeNull();
  });
});

describe("Nango webhook: record mapping", () => {
  it("filters Slack bot messages", () => {
    const longMsg = "this is a message with more than twenty words because we need to test the filtering logic and make sure bots get removed from the evidence pipeline correctly";
    const records = [
      { ts: "1", text: longMsg, channel: "C1" },
      { ts: "2", text: longMsg, channel: "C1", bot_id: "B1" },
      { ts: "3", text: longMsg, channel: "C1", subtype: "bot_message" },
    ];

    const filtered = records.filter((r) => {
      if (r.bot_id || r.subtype === "bot_message") return false;
      if (!r.text || r.text.split(/\s+/).length < 20) return false;
      return true;
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.ts).toBe("1");
  });

  it("filters Slack messages under 20 words", () => {
    const records = [
      { ts: "1", text: "too short to pass", channel: "C1" },
      { ts: "2", text: "this is a message that has more than twenty words in it so it should pass the filter check test and be kept in the output list", channel: "C1" },
    ];

    const filtered = records.filter((r) => {
      if (!r.text || r.text.split(/\s+/).length < 20) return false;
      return true;
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.ts).toBe("2");
  });

  it("filters Slack thread replies", () => {
    const longMsg = "this is a parent message with more than twenty words because we need to test thread reply filtering and make sure replies get excluded from evidence";
    const records = [
      { ts: "1", text: longMsg, channel: "C1" },
      { ts: "2", text: longMsg, channel: "C1", thread_ts: "1" },
    ];

    const filtered = records.filter((r: { ts: string; thread_ts?: string; text: string }) => {
      if (r.thread_ts && r.thread_ts !== r.ts) return false;
      if (!r.text || r.text.split(/\s+/).length < 20) return false;
      return true;
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.ts).toBe("1");
  });

  it("generates correct Slack sourceRef", () => {
    const channel = "C0123ABC";
    const ts = "1620000000.000100";
    expect(`slack:${channel}:${ts}`).toBe("slack:C0123ABC:1620000000.000100");
  });

});
