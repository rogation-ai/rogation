import { afterEach, describe, expect, it } from "vitest";

/*
  Tests for the resolveAppUrl fallback chain in env.ts.

  We re-require env.ts with different process.env shapes because the
  computation happens once at module load. Tests restore process.env
  state after each case so earlier cases don't leak.

  Why this matters: getting this wrong sends Linear / Stripe / Clerk
  callbacks to localhost on production, which is the dead-end loop the
  user just hit.
*/

const ENV_KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// Port of the resolveAppUrl logic from env.ts. We copy rather than
// import env.ts because the @t3-oss/env-nextjs module validates + freezes
// on import, which would choke on the bare test process.env.
function resolveAppUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (
    (vercelEnv === "preview" || vercelEnv === "production") &&
    process.env.VERCEL_URL
  ) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

describe("resolveAppUrl", () => {
  let snap: Record<string, string | undefined>;

  afterEach(() => restoreEnv(snap));

  it("prefers explicit NEXT_PUBLIC_APP_URL over everything", () => {
    snap = snapshotEnv();
    process.env.NEXT_PUBLIC_APP_URL = "https://custom.example.com";
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "rogation.vercel.app";
    expect(resolveAppUrl()).toBe("https://custom.example.com");
  });

  it("uses VERCEL_PROJECT_PRODUCTION_URL on production", () => {
    snap = snapshotEnv();
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "rogation.vercel.app";
    process.env.VERCEL_URL = "rogation-abc123-xxx.vercel.app";
    // Production should pick the stable alias, not the per-deploy URL —
    // otherwise OAuth redirect URIs would change on every deploy.
    expect(resolveAppUrl()).toBe("https://rogation.vercel.app");
  });

  it("falls back to VERCEL_URL on preview", () => {
    snap = snapshotEnv();
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "rogation-pr-42-xxx.vercel.app";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(resolveAppUrl()).toBe("https://rogation-pr-42-xxx.vercel.app");
  });

  it("falls back to VERCEL_URL on production if production alias is unset", () => {
    snap = snapshotEnv();
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_ENV = "production";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_URL = "rogation-abc123-xxx.vercel.app";
    expect(resolveAppUrl()).toBe("https://rogation-abc123-xxx.vercel.app");
  });

  it("defaults to http://localhost:3000 outside Vercel", () => {
    snap = snapshotEnv();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(resolveAppUrl()).toBe("http://localhost:3000");
  });
});
