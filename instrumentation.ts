import * as Sentry from "@sentry/nextjs";

/*
  Next.js 15 instrumentation hook. Runs once per runtime at startup.
  We dispatch to runtime-specific Sentry configs so the edge runtime
  doesn't pull in node-only SDK pieces.
*/
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/*
  Capture server-side exceptions that Next.js surfaces via
  instrumentation. Without this, unhandled render + route-handler
  errors don't reach Sentry.
*/
export const onRequestError = Sentry.captureRequestError;
