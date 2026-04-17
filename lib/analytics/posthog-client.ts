"use client";

import posthog from "posthog-js";
import type { EventName, EventProperties } from "./events";

/*
  Browser-side PostHog. Module-level singleton; init() is idempotent.
  When NEXT_PUBLIC_POSTHOG_KEY is unset, capture + identify are no-ops
  so the app works offline / in dev / in tests without a project.

  Never pass PII through event properties. Clerk userId is the only
  identifier we use. Evidence content + prompts never leave the server.
*/

let initialized = false;

export function initPostHog(): void {
  if (initialized) return;
  if (typeof window === "undefined") return;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host:
      process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    // Autocapture is noisy for a focused funnel; flip on later if we
    // want "what do users click first" heatmaps.
    autocapture: false,
    disable_session_recording: true,
    loaded: (ph) => {
      if (process.env.NODE_ENV !== "production") {
        ph.debug(false);
      }
    },
  });

  initialized = true;
}

export function identify(userId: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.identify(userId, properties);
}

export function reset(): void {
  if (!initialized) return;
  posthog.reset();
}

/**
 * Typed capture. Event names come from lib/analytics/events.ts; the
 * properties shape is enforced by EventProperties so new events
 * declare their payload up front.
 */
export function capture<E extends EventName>(
  event: E,
  properties: E extends keyof EventProperties ? EventProperties[E] : never,
): void {
  if (!initialized) return;
  posthog.capture(event, properties as Record<string, unknown>);
}
