import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

/*
  Sentry wrapper. Without SENTRY_AUTH_TOKEN the build skips source-map
  upload with a warning — fine for local + preview deploys. Production
  deploy sets the token so Sentry stacktraces de-minify.
*/
export default withSentryConfig(nextConfig, {
  // Project identity (safe to commit — matches your Sentry org/project).
  // Sourcemap upload is only attempted when SENTRY_AUTH_TOKEN is set.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  // Tunnel through a Next.js route to bypass ad-blockers that drop
  // requests to sentry.io domains.
  tunnelRoute: "/monitoring",
  // Don't fail the build if the Sentry CLI can't talk to the ingest
  // API (no token, offline build, etc.).
  errorHandler: (err) => {
    // eslint-disable-next-line no-console
    console.warn("[sentry build]", err.message);
  },
});
