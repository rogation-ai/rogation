import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/*
  Single source of truth for environment variables.
  Anything imported from here is type-checked and fails at boot if missing.
  Never read process.env directly outside this file.
*/

/*
  Derive the app's public URL with sensible fallbacks so OAuth callbacks,
  Stripe return URLs, and share-link origins don't silently point at
  localhost in production.

  Precedence:
    1. Explicit NEXT_PUBLIC_APP_URL (overrides everything — useful for
       custom domains, because Vercel's system vars still report the
       *.vercel.app alias after you wire a custom domain).
    2. VERCEL_PROJECT_PRODUCTION_URL on production builds — the stable
       alias for this Vercel project (no per-deploy hash in the URL).
    3. VERCEL_URL for preview builds — the one-off deployment URL so
       OAuth flows can test end-to-end on a PR preview.
    4. http://localhost:3000 for local dev.

  Vercel injects VERCEL_URL, VERCEL_PROJECT_PRODUCTION_URL, and VERCEL_ENV
  automatically on every build + at runtime. Users never set them.
*/
function resolveAppUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;

  // VERCEL_ENV: "production" | "preview" | "development"
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if ((vercelEnv === "preview" || vercelEnv === "production") && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}

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

    ANTHROPIC_API_KEY: z
      .string()
      .min(1)
      .describe(
        "Anthropic API key. Used for synthesis (Sonnet 4.6) and generation (Haiku 4.5).",
      ),

    OPENAI_API_KEY: z
      .string()
      .min(1)
      .describe("OpenAI API key. Used for evidence embeddings (text-embedding-3-small)."),

    /*
      Sentry DSN is optional — apps should boot without it. When unset,
      Sentry initialization is a no-op so dev + CI don't need a project.
    */
    SENTRY_DSN: z.string().url().optional(),

    /*
      Server-side PostHog key for webhook events (signup_completed etc.).
      Optional; capture is a no-op when unset so dev works without a
      PostHog project.
    */
    POSTHOG_API_KEY: z.string().optional(),

    /*
      Langfuse credentials for LLM trace capture via the router's onTrace
      hook. All three are optional; the wrapper in lib/llm/langfuse.ts
      no-ops when the secret + public keys aren't both set.
    */
    LANGFUSE_SECRET_KEY: z.string().optional(),
    LANGFUSE_PUBLIC_KEY: z.string().optional(),
    LANGFUSE_HOST: z.string().url().optional(),

    /*
      Stripe for subscription billing. Required — the checkout + portal
      + webhook code paths all fail at boot without the secret. Webhook
      signing secret comes from the Stripe dashboard after registering
      the endpoint.

      Price IDs are the per-tier subscription products created in the
      Stripe dashboard. Keep them in env so test vs live keys can point
      at different prices.
    */
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SIGNING_SECRET: z.string().min(1),
    STRIPE_PRICE_ID_SOLO: z.string().min(1),
    STRIPE_PRICE_ID_PRO: z.string().min(1),

    /*
      Upstash Redis REST credentials for rate limiting. Both optional —
      when either is missing, lib/rate-limit.ts fails open (returns
      { success: true }). Dev + CI run without Upstash; production sets
      both and limits engage automatically.
    */
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    /*
      Symmetric key for at-rest encryption of integration access tokens
      (Linear, Notion, etc.) stored in integration_credential. 32 raw
      bytes, base64-encoded — generate with `openssl rand -base64 32`.
      AES-256-GCM via lib/crypto/envelope.ts.

      Rotation path when we need it: add kek_version column reads + a
      second-key fallback in decrypt(). For v1, one key is enough.
    */
    INTEGRATION_ENCRYPTION_KEY: z
      .string()
      .min(44)
      .describe(
        "Base64-encoded 32-byte key for AES-256-GCM of OAuth access tokens.",
      ),

    /*
      Linear OAuth app credentials. Register at
      https://linear.app/settings/api/applications/new. Scopes are
      requested at authorize time (read, write, issues:create).
    */
    LINEAR_CLIENT_ID: z.string().min(1).optional(),
    LINEAR_CLIENT_SECRET: z.string().min(1).optional(),

    /*
      Inngest event + signing keys. Both optional — in dev the SDK
      talks to the local Inngest dev server at 127.0.0.1:8288 and
      neither variable is required. In production both must be set;
      the webhook at /api/inngest rejects unsigned POSTs when the
      signing key is configured.
    */
    INNGEST_EVENT_KEY: z.string().min(1).optional(),
    INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
      .string()
      .min(1)
      .describe("Clerk publishable key (pk_test_... or pk_live_...)."),
    /*
      Matches SENTRY_DSN so the same project captures server + client
      errors. Optional — browser Sentry is a no-op when unset.
    */
    NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),

    /*
      PostHog public key for browser analytics. Optional.
      NEXT_PUBLIC_POSTHOG_HOST defaults to https://us.posthog.com when
      unset, which is the US cloud ingest.
    */
    NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_HOST: z
      .string()
      .url()
      .default("https://us.posthog.com"),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    SENTRY_DSN: process.env.SENTRY_DSN,
    POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_HOST: process.env.LANGFUSE_HOST,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SIGNING_SECRET: process.env.STRIPE_WEBHOOK_SIGNING_SECRET,
    STRIPE_PRICE_ID_SOLO: process.env.STRIPE_PRICE_ID_SOLO,
    STRIPE_PRICE_ID_PRO: process.env.STRIPE_PRICE_ID_PRO,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    INTEGRATION_ENCRYPTION_KEY: process.env.INTEGRATION_ENCRYPTION_KEY,
    LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
    LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
    INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,
    NEXT_PUBLIC_APP_URL: resolveAppUrl(),
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
});
