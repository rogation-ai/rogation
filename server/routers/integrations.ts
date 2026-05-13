import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  integrationCredentials,
  integrationState,
  users,
  type LinearIntegrationConfig,
  type NotionIntegrationConfig,
} from "@/db/schema";
import { decrypt } from "@/lib/crypto/envelope";
import {
  fetchViewer,
  LinearApiError,
} from "@/lib/integrations/linear/client";
import { linearOauthConfigured } from "@/lib/integrations/linear/oauth";
import {
  fetchBotUser,
  NotionApiError,
} from "@/lib/integrations/notion/client";
import { notionOauthConfigured } from "@/lib/integrations/notion/oauth";
import {
  nangoConfigured,
  getNango,
  createConnectSession,
} from "@/lib/integrations/nango/client";
import { pushSpecToNotion } from "@/lib/evidence/push-notion";
import { canExport, canConnectProvider } from "@/lib/plans";
import { checkLimit } from "@/lib/rate-limit";
import { authedProcedure, router } from "@/server/trpc";

/*
  Integrations router. Wraps the state + credential tables with the
  surfaces the settings UI + spec editor need.

  Trust boundary: only authed procedures. RLS filters every query to
  the caller's account. Tokens never cross the tRPC wire.
*/

function isLinearConfig(v: unknown): v is LinearIntegrationConfig {
  return typeof v === "object" && v !== null;
}

function isNotionConfig(v: unknown): v is NotionIntegrationConfig {
  return typeof v === "object" && v !== null;
}

function isProviderConfig(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export const integrationsRouter = router({
  /*
    Server-side feature flags: which providers actually have OAuth
    credentials wired on this deployment. The settings UI reads this
    BEFORE rendering a "Connect X" button so we never show an action
    the user can't complete.
  */
  providers: authedProcedure.query(async ({ ctx }) => {
    return {
      linear: { configured: linearOauthConfigured() },
      notion: { configured: notionOauthConfigured() },
      slack: {
        configured: nangoConfigured(),
        allowed: canConnectProvider("slack", ctx.plan),
      },
      hotjar: {
        configured: nangoConfigured(),
        allowed: canConnectProvider("hotjar", ctx.plan),
      },
    };
  }),

  nangoConnectToken: authedProcedure.mutation(async ({ ctx }) => {
    if (!nangoConfigured()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Nango is not configured on this deployment.",
      });
    }

    const [user] = await ctx.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    const token = await createConnectSession({
      id: ctx.accountId,
      email: user?.email ?? "",
      displayName: user?.email ?? "",
    });
    return { token };
  }),

  list: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        provider: integrationState.provider,
        status: integrationState.status,
        lastSyncedAt: integrationState.lastSyncedAt,
        lastError: integrationState.lastError,
        config: integrationState.config,
      })
      .from(integrationState)
      .where(eq(integrationState.accountId, ctx.accountId));

    const credRows = await ctx.db
      .select({ provider: integrationCredentials.provider })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.accountId, ctx.accountId));
    const connected = new Set(credRows.map((r) => r.provider));

    return rows.map((r) => {
      const config = isProviderConfig(r.config) ? r.config : null;
      const isNangoProvider = r.provider === "slack" || r.provider === "hotjar";
      const isConnected = isNangoProvider
        ? !!(config as { nangoConnectionId?: string } | null)?.nangoConnectionId
        : connected.has(r.provider);
      return { ...r, connected: isConnected, config };
    });
  }),

  linearTeams: authedProcedure.query(async ({ ctx }) => {
    if (!linearOauthConfigured()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Linear OAuth is not configured on this server.",
      });
    }
    const [cred] = await ctx.db
      .select({
        ciphertext: integrationCredentials.ciphertext,
        nonce: integrationCredentials.nonce,
      })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.accountId, ctx.accountId),
          eq(integrationCredentials.provider, "linear"),
        ),
      )
      .limit(1);

    if (!cred) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Linear is not connected for this account.",
      });
    }

    const token = decrypt(cred);
    try {
      const viewer = await fetchViewer(token);
      return {
        workspace: viewer.workspace,
        teams: viewer.teams,
      };
    } catch (err) {
      if (err instanceof LinearApiError && err.status === 401) {
        await ctx.db
          .update(integrationState)
          .set({ status: "token_invalid", lastError: err.message })
          .where(
            and(
              eq(integrationState.accountId, ctx.accountId),
              eq(integrationState.provider, "linear"),
            ),
          );
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Linear token was revoked. Reconnect to continue.",
        });
      }
      throw err;
    }
  }),

  setLinearDefaultTeam: authedProcedure
    .input(z.object({ teamId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ config: integrationState.config })
        .from(integrationState)
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, "linear"),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Linear is not connected.",
        });
      }

      const [cred] = await ctx.db
        .select({
          ciphertext: integrationCredentials.ciphertext,
          nonce: integrationCredentials.nonce,
        })
        .from(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.accountId, ctx.accountId),
            eq(integrationCredentials.provider, "linear"),
          ),
        )
        .limit(1);

      if (!cred) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Linear is not connected.",
        });
      }

      let liveTeams;
      try {
        const token = decrypt(cred);
        const viewer = await fetchViewer(token);
        liveTeams = viewer.teams;
      } catch (err) {
        if (err instanceof LinearApiError && err.status === 401) {
          await ctx.db
            .update(integrationState)
            .set({ status: "token_invalid", lastError: err.message })
            .where(
              and(
                eq(integrationState.accountId, ctx.accountId),
                eq(integrationState.provider, "linear"),
              ),
            );
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Linear token was revoked. Reconnect to continue.",
          });
        }
        throw err;
      }

      const team = liveTeams.find((t) => t.id === input.teamId);
      if (!team) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That team no longer exists in your Linear workspace.",
        });
      }

      const current = isLinearConfig(existing.config) ? existing.config : {};
      const next: LinearIntegrationConfig = {
        ...current,
        defaultTeamId: team.id,
        defaultTeamName: team.name,
        defaultTeamKey: team.key,
      };

      await ctx.db
        .update(integrationState)
        .set({ config: next, updatedAt: new Date() })
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, "linear"),
          ),
        );

      return { ok: true };
    }),

  /*
    Notion workspace display + re-validation. Used by the settings page
    to show the workspace name/icon and confirm the token still works.
  */
  notionWorkspace: authedProcedure.query(async ({ ctx }) => {
    if (!notionOauthConfigured()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Notion OAuth is not configured on this server.",
      });
    }
    const [cred] = await ctx.db
      .select({
        ciphertext: integrationCredentials.ciphertext,
        nonce: integrationCredentials.nonce,
      })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.accountId, ctx.accountId),
          eq(integrationCredentials.provider, "notion"),
        ),
      )
      .limit(1);

    if (!cred) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Notion is not connected for this account.",
      });
    }

    const [state] = await ctx.db
      .select({ config: integrationState.config })
      .from(integrationState)
      .where(
        and(
          eq(integrationState.accountId, ctx.accountId),
          eq(integrationState.provider, "notion"),
        ),
      )
      .limit(1);

    const config = isNotionConfig(state?.config) ? state.config : {};

    try {
      const token = decrypt(cred);
      // Cheap liveness probe — confirms the token wasn't revoked since
      // connect. We don't depend on the response payload; config holds
      // the display text from the OAuth callback.
      await fetchBotUser(token);
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 401) {
        await ctx.db
          .update(integrationState)
          .set({ status: "token_invalid", lastError: err.message })
          .where(
            and(
              eq(integrationState.accountId, ctx.accountId),
              eq(integrationState.provider, "notion"),
            ),
          );
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Notion token was revoked. Reconnect to continue.",
        });
      }
      throw err;
    }

    return {
      workspaceId: config.workspaceId ?? null,
      workspaceName: config.workspaceName ?? null,
      workspaceIcon: config.workspaceIcon ?? null,
      defaultDatabaseId: config.defaultDatabaseId ?? null,
      defaultDatabaseName: config.defaultDatabaseName ?? null,
      setupReason: config.setupReason ?? null,
    };
  }),

  /*
    Push the latest spec for an opportunity as a Notion page.

    Gates (in order):
      1. Plan must allow Notion export (Pro only, matching Linear).
      2. Rate limit: 30 / hour / account (shared "linear-push" preset
         is reused — same cost profile, keeps the table lean).
      3. Integration connected + default DB provisioned + token valid.
         All checked inside pushSpecToNotion; structured error codes
         drive which CTA the UI shows.
  */
  pushSpecToNotion: authedProcedure
    .input(z.object({ opportunityId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!canExport(ctx.plan, "notion")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Notion export requires the Pro plan.",
          cause: { type: "plan_limit_reached", feature: "notion-export" },
        });
      }

      // Share the linear-push preset: both are 1-mutation-per-call
      // provider hits with the same abuse envelope.
      const rl = await checkLimit("linear-push", ctx.accountId);
      if (!rl.success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many Notion pushes. Try again shortly.",
          cause: { type: "rate_limited", limit: rl.limit, resetAt: rl.reset },
        });
      }

      const result = await pushSpecToNotion(
        { db: ctx.db, accountId: ctx.accountId },
        input.opportunityId,
      );

      if (!result.ok) {
        const code =
          result.error === "spec-not-found"
            ? "NOT_FOUND"
            : result.error === "token-invalid"
              ? "FORBIDDEN"
              : result.error === "notion-api-error"
                ? "INTERNAL_SERVER_ERROR"
                : "PRECONDITION_FAILED";
        throw new TRPCError({
          code,
          message: result.message,
          cause: { type: "notion-push-failed", reason: result.error },
        });
      }

      return {
        url: result.url,
        pageId: result.pageId,
      };
    }),

  slackChannels: authedProcedure.query(async ({ ctx }) => {
    const nango = getNango();
    if (!nango) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Nango is not configured.",
      });
    }

    const [state] = await ctx.db
      .select({ config: integrationState.config })
      .from(integrationState)
      .where(
        and(
          eq(integrationState.accountId, ctx.accountId),
          eq(integrationState.provider, "slack"),
        ),
      )
      .limit(1);

    const config = state?.config as { nangoConnectionId?: string; channels?: { id: string; name: string }[] } | null;
    if (!config?.nangoConnectionId) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Slack is not connected.",
      });
    }

    try {
      const response = await nango.proxy({
        method: "GET",
        endpoint: "/conversations.list",
        connectionId: config.nangoConnectionId,
        providerConfigKey: "slack",
        params: {
          types: "public_channel",
          exclude_archived: "true",
          limit: "200",
        },
      });

      const data = response.data as {
        channels?: Array<{ id: string; name: string; num_members: number }>;
      };

      return {
        channels: (data.channels ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          memberCount: c.num_members,
        })),
        selectedChannels: config.channels ?? [],
      };
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch Slack channels.",
      });
    }
  }),

  setSlackChannels: authedProcedure
    .input(
      z.object({
        channels: z.array(
          z.object({ id: z.string(), name: z.string() }),
        ).min(1).max(5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [state] = await ctx.db
        .select({ config: integrationState.config })
        .from(integrationState)
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, "slack"),
          ),
        )
        .limit(1);

      const config = (state?.config ?? {}) as Record<string, unknown>;

      await ctx.db
        .update(integrationState)
        .set({
          config: { ...config, channels: input.channels },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, "slack"),
          ),
        );

      return { ok: true };
    }),

  connectNango: authedProcedure
    .input(
      z.object({
        provider: z.enum(["slack", "hotjar"]),
        connectionId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!canConnectProvider(input.provider, ctx.plan)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `${input.provider} requires a higher plan.`,
          cause: { type: "plan_limit_reached", feature: `${input.provider}-connector` },
        });
      }

      await ctx.db
        .insert(integrationState)
        .values({
          accountId: ctx.accountId,
          provider: input.provider,
          status: "active",
          config: { nangoConnectionId: input.connectionId },
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [integrationState.accountId, integrationState.provider],
          set: {
            status: "active",
            config: { nangoConnectionId: input.connectionId },
            lastError: null,
            updatedAt: new Date(),
          },
        });

      return { ok: true };
    }),

  disconnectNango: authedProcedure
    .input(z.object({ provider: z.enum(["slack", "hotjar"]) }))
    .mutation(async ({ ctx, input }) => {
      const nango = getNango();
      const [state] = await ctx.db
        .select({ config: integrationState.config })
        .from(integrationState)
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, input.provider),
          ),
        )
        .limit(1);

      const config = state?.config as { nangoConnectionId?: string } | null;
      if (nango && config?.nangoConnectionId) {
        try {
          await nango.deleteConnection(input.provider, config.nangoConnectionId);
        } catch {
          // Nango connection may already be deleted; proceed with local cleanup
        }
      }

      await ctx.db
        .update(integrationState)
        .set({
          status: "disabled",
          config: null,
          lastError: null,
          cursor: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, input.provider),
          ),
        );

      return { ok: true };
    }),

  disconnect: authedProcedure
    .input(z.object({ provider: z.enum(["linear", "notion"]) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.accountId, ctx.accountId),
            eq(integrationCredentials.provider, input.provider),
          ),
        );

      await ctx.db
        .update(integrationState)
        .set({
          status: "disabled",
          config: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationState.accountId, ctx.accountId),
            eq(integrationState.provider, input.provider),
          ),
        );

      return { ok: true };
    }),
});
