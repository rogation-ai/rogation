import { PostHog } from "posthog-node";
import { env } from "@/env";
import type { EventName, EventProperties } from "./events";

/*
  Server-side PostHog. Used from webhooks (Clerk user.created) + tRPC
  routes that want to emit funnel events server-side (e.g. spec
  exported — server knows more than the client).

  When POSTHOG_API_KEY is unset, the module exports a no-op stub so
  call sites never need a conditional. identify() + capture() are safe
  to call anywhere, any time.
*/

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!env.POSTHOG_API_KEY) return null;
  if (client) return client;
  client = new PostHog(env.POSTHOG_API_KEY, {
    host: env.NEXT_PUBLIC_POSTHOG_HOST,
    // Batch mode — posthog-node's default. Short flushAt since our
    // webhook traffic is bursty, not steady.
    flushAt: 5,
    flushInterval: 10_000,
  });
  return client;
}

/**
 * Associate a user in PostHog with their Clerk id + an initial property
 * set (plan tier, signup source). Idempotent.
 */
export function identifyServer(
  distinctId: string,
  properties: Record<string, unknown>,
): void {
  const c = getClient();
  if (!c) return;
  c.identify({ distinctId, properties });
}

/**
 * Typed server capture. Mirrors the client signature so the two
 * runtimes stay in step.
 */
export function captureServer<E extends EventName>(
  distinctId: string,
  event: E,
  properties: E extends keyof EventProperties ? EventProperties[E] : never,
): void {
  const c = getClient();
  if (!c) return;
  c.capture({
    distinctId,
    event,
    properties: properties as Record<string, unknown>,
  });
}

/**
 * Flush pending events. Call at the end of a request that captured
 * server-side to avoid losing events on container teardown. Vercel
 * serverless functions kill the process after the response, so
 * un-flushed events disappear.
 */
export async function flushServer(): Promise<void> {
  if (!client) return;
  await client.flush();
}
