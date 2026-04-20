import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      /*
        Tenant guard, layer 1.

        Direct imports of the raw `db` handle are only allowed in:
        - db/**                       (the module itself)
        - server/trpc.ts              (context wiring)
        - app/api/webhooks/**         (signed-payload handlers w/ no session)
        - lib/account/**              (account provisioning runs BEFORE
                                       an account exists; no account_id
                                       to bind to, so no scoped tx
                                       makes sense here)
        - scripts/** (future)         (cli tools running as operators)

        Every other caller must go through ctx.db in a tRPC procedure,
        which carries ctx.accountId and is expected to constrain queries
        with eq(table.accountId, ctx.accountId).

        Layer 2 (scoped proxy) + layer 3 (Postgres RLS) land in follow-up
        commits. This rule is the first line of defense.
      */
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/client", "@/db/client.ts"],
              message:
                "Import `db` via the tRPC context (ctx.db), not directly. Only db/*, server/trpc.ts, and app/api/webhooks/** may import @/db/client. See CLAUDE.md §Tenant isolation.",
            },
          ],
        },
      ],
    },
  },
  {
    // Allowlist the trusted paths.
    files: [
      "db/**",
      "server/trpc.ts",
      "app/api/webhooks/**",
      "app/api/health/**",
      "lib/account/**",
      "lib/inngest/**",
      "scripts/**",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];

export default eslintConfig;
