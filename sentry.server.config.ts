import * as Sentry from "@sentry/nextjs";
import { sentryBeforeSend } from "@/lib/sentry-filter";

/*
  Server-runtime Sentry init. Runs at node startup via
  instrumentation.ts > register(). No-op when SENTRY_DSN is unset so
  dev + CI boot without a Sentry project.
*/
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Low default sampling; bump per-environment via env var if needed.
    tracesSampleRate: 0.1,
    // Don't send PII by default. Our route handlers never log tokens /
    // evidence content; Sentry PII would be user IPs + Clerk IDs, none
    // of which we want accumulating.
    sendDefaultPii: false,
    environment: process.env.NODE_ENV,
    beforeSend: sentryBeforeSend,
  });
}
