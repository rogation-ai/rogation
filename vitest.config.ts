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
    // DB-backed tests run sequentially to avoid cross-pollution on a
    // shared test schema. Unit tests are fine in parallel, but our
    // integration tests share tables; single file concurrency only.
    fileParallelism: false,
    testTimeout: 15_000,
    env: {
      // Tests never need env validation — they provide their own
      // DATABASE_URL via TEST_DATABASE_URL or skip.
      SKIP_ENV_VALIDATION: "true",
    },
  },
});
