import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  /*
    @vitejs/plugin-react handles the automatic JSX transform so Vitest
    can parse .tsx files. Next.js keeps tsconfig.json's jsx set to
    "preserve" for its own compiler; the test pipeline is a separate
    world and needs this override.
  */
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    // DB-backed tests share the `public` schema and truncate between
    // files. Strict serial execution is required — parallel files
    // would TRUNCATE each other's fixtures mid-test.
    fileParallelism: false,
    // Global setup points app-side DATABASE_URL at TEST_DATABASE_URL
    // so test code and the app's `@/db/client` singleton use the same
    // Postgres. Must run before any test module imports.
    setupFiles: ["./test/setup.ts"],
    testTimeout: 15_000,
    env: {
      // Tests never need env validation — they provide their own
      // DATABASE_URL via TEST_DATABASE_URL or skip.
      SKIP_ENV_VALIDATION: "true",
    },
  },
});
