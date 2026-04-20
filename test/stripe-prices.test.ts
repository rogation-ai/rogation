import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  Unit tests over the price ↔ tier mapping. Mocks @/env so the tests
  are deterministic regardless of local env config.

  We mock the env module rather than the prices module so the real
  branch logic runs — otherwise this test reduces to "constants
  equal constants."
*/

vi.mock("@/env", () => ({
  env: {
    STRIPE_PRICE_ID_SOLO: "price_solo_fixture",
    STRIPE_PRICE_ID_PRO: "price_pro_fixture",
  },
}));

// Re-import after the mock so our env mock is used.
import {
  paidTierForPriceId,
  planFromSubscriptionEvent,
  priceIdForPaidTier,
} from "@/lib/stripe/prices";

describe("stripe price mapping", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("priceIdForPaidTier resolves solo + pro to their env price ids", () => {
    expect(priceIdForPaidTier("solo")).toBe("price_solo_fixture");
    expect(priceIdForPaidTier("pro")).toBe("price_pro_fixture");
  });

  it("paidTierForPriceId is the inverse of priceIdForPaidTier", () => {
    expect(paidTierForPriceId("price_solo_fixture")).toBe("solo");
    expect(paidTierForPriceId("price_pro_fixture")).toBe("pro");
  });

  it("paidTierForPriceId returns null for unknown prices", () => {
    expect(paidTierForPriceId("price_unknown")).toBeNull();
  });

  it("planFromSubscriptionEvent: active + solo price -> solo", () => {
    expect(planFromSubscriptionEvent("price_solo_fixture", "active")).toBe(
      "solo",
    );
  });

  it("planFromSubscriptionEvent: trialing counts as paid", () => {
    expect(planFromSubscriptionEvent("price_pro_fixture", "trialing")).toBe(
      "pro",
    );
  });

  it("planFromSubscriptionEvent: past_due / canceled / unpaid -> free", () => {
    for (const status of ["past_due", "canceled", "unpaid", "incomplete"]) {
      expect(
        planFromSubscriptionEvent("price_solo_fixture", status),
      ).toBe("free");
    }
  });

  it("planFromSubscriptionEvent: unknown price id throws (config drift signal)", () => {
    expect(() =>
      planFromSubscriptionEvent("price_rogue", "active"),
    ).toThrowError(/not mapped/);
  });
});
