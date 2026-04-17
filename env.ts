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

    CLERK_SECRET_KEY: z
      .string()
      .min(1)
      .describe("Clerk secret key (sk_test_... or sk_live_...)."),

    CLERK_WEBHOOK_SIGNING_SECRET: z
      .string()
      .min(1)
      .describe(
        "Webhook signing secret from Clerk dashboard. Required for webhook signature verification.",
      ),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
      .string()
      .min(1)
      .describe("Clerk publishable key (pk_test_... or pk_live_...)."),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
});
