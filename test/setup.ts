/*
  Global vitest setup. Runs before any test module imports.

  Point the app's DB client at the test database AND force every
  connection it opens to SET ROLE to the non-superuser test role. The
  app's @/db/client uses `env.DATABASE_URL` lazily on first query, so
  mutating process.env here is sufficient.

  Why the role: TEST_DATABASE_URL authenticates as `postgres`
  (superuser by default in the pgvector docker image and most local
  setups). Superusers bypass RLS unconditionally. Without SET ROLE,
  app code running during tests silently leaks rows across accounts.
  See test/setup-db.ts for the full rationale.

  The `options=-c role=test_app` query string in the URL becomes a
  startup option every Postgres connection receives, which runs an
  implicit SET ROLE on connect.
*/

if (process.env.TEST_DATABASE_URL) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  const existing = url.searchParams.get("options") ?? "";
  const roleOpt = "-c role=test_app";
  url.searchParams.set(
    "options",
    existing ? `${existing} ${roleOpt}` : roleOpt,
  );
  process.env.DATABASE_URL = url.toString();
}
