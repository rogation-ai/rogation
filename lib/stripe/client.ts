import Stripe from "stripe";
import { env } from "@/env";

/*
  Singleton Stripe client. Every server-side Stripe call goes through
  this — never instantiate Stripe() elsewhere, or the test seam +
  API version pinning fall apart.

  apiVersion is pinned deliberately: Stripe's "latest" shifts under
  your feet if you don't pin. When upgrading the SDK, bump this in
  lockstep after reading the changelog.
*/

let client: Stripe | undefined;

export function stripe(): Stripe {
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-03-25.dahlia",
    typescript: true,
    appInfo: { name: "rogation", version: "0.0.0" },
  });
  return client;
}

// Test seam: unit tests substitute a mock client without module reloads.
export function __setStripeForTest(mock: Stripe | undefined): void {
  client = mock;
}
