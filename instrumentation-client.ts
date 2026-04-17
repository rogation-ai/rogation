import * as Sentry from "@sentry/nextjs";
import { sentryBeforeSend } from "@/lib/sentry-filter";

/*
  Browser-runtime Sentry init. Next.js 15 picks this up via the new
  instrumentation-client convention (replaces the older
  sentry.client.config.ts from v8). No-op when the DSN is unset.

  Runs in every browser tab, so sampling is lower to control volume.
*/
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.05,
    // Replays off by default — we can flip this on later when we
    // actually want to debug a user flow. Each replay session is a
    // billable event.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,
    environment: process.env.NODE_ENV,
    beforeSend: sentryBeforeSend,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
