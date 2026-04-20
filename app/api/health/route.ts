import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import pkg from "@/package.json";

/*
  Public health probe for /land-and-deploy + /canary + uptime monitors.

  Returns 200 when the app responds AND the DB answers a trivial query.
  Returns 503 when the DB is unreachable so Vercel / external monitors
  can alarm on it. Keep it cheap — it runs on every probe tick.

  No auth, no account context. Do NOT leak request details, env vars,
  or secrets in the payload. `commit` + `version` are intentionally
  public and match what's already in package.json / the PR title.
*/

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `process.env.npm_package_version` is set by npm/bun run, but Vercel's
// serverless runtime doesn't populate it, so we'd show "unknown" in
// prod. Import package.json at build time so the version lands as a
// constant in the compiled bundle. The `VERSION` file stays the source
// of truth, and /ship keeps package.json in sync with it.
const VERSION = (pkg as { version?: string }).version ?? "unknown";
const COMMIT = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown";

export async function GET() {
  const started = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json(
      {
        ok: true,
        db: "up",
        version: VERSION,
        commit: COMMIT,
        latencyMs: Date.now() - started,
      },
      { status: 200 },
    );
  } catch {
    return Response.json(
      {
        ok: false,
        db: "down",
        version: VERSION,
        commit: COMMIT,
        latencyMs: Date.now() - started,
      },
      { status: 503 },
    );
  }
}
