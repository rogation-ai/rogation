/*
  Global vitest setup. Runs before any test file imports.

  Point the app's DB client at the test database so that when test
  code calls app helpers (e.g. `provisionAccountForClerkUser`), they
  share the same Postgres as `setupTestDb()`. Without this, the
  harness writes to TEST_DATABASE_URL but app code writes to
  whatever DATABASE_URL points at — two worlds.

  Setting DATABASE_URL before any module import means `@/db/client`'s
  singleton picks up the test URL on first read.
*/

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
