import * as Sentry from "@sentry/nextjs";
import { sentryBeforeSend } from "@/lib/sentry-filter";

/*
  Edge-runtime Sentry init. Loaded for middleware.ts + any edge route
  handlers. Slim config — the edge runtime has a smaller SDK surface
  than node.
*/
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    environment: process.env.NODE_ENV,
    beforeSend: sentryBeforeSend,
  });
}
