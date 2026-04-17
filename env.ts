import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/*
  Single source of truth for environment variables.
  Anything imported from here is type-checked and fails at boot if missing.
  Never read process.env directly outside this file.
*/

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z
      .string()
      .url()
      .describe(
        "Postgres connection string (Supabase or Neon). Must have pgvector extension available.",
      ),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
});
