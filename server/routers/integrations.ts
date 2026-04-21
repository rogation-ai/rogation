import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  integrationCredentials,
  integrationState,
  type LinearIntegrationConfig,
} from "@/db/schema";
import { decrypt } from "@/lib/crypto/envelope";
import {
  fetchViewer,
  LinearApiError,
} from "@/lib/integrations/linear/client";
import { linearOauthConfigured } from "@/lib/integrations/linear/oauth";
import { authedProcedure, router } from "@/server/trpc";

/*
  Integrations router. Wraps the state + credential tables with the
  few surfaces the settings UI actually needs:

  - list(): all providers for this account, with derived {connected,
    status, config} fields. Never returns the raw access token.
  - linearTeams(): decrypts the Linear token server-side, fetches the
    team list via GraphQL, returns id/name/key only. A fresh call so
    teams added/renamed in Linear show up without disconnect/reconnect.
  - setLinearDefaultTeam(): persists the selected team on config.
  - disconnect(): deletes the credential row AND resets state, so a
    reconnect starts clean. Credential deletion invalidates the token
    from our side (we can't revoke at Linear without a separate API
    call; that's a future commit).

  Trust boundary: only authed procedures. RLS filters every query to
  the caller's account. Tokens never cross the tRPC wire.
*/

function isLinearConfig(v: unknown): v is LinearIntegrationConfig {
  return typeof v === "object" && v !== null;
}

export const integrationsRouter = router({
  /*
    Server-side feature flags: which providers actually have OAuth
    credentials wired on this deployment. The settings UI reads this
    BEFORE rendering a "Connect X" button so we never show an action
    the user can't complete. Separate from list() because an account
    with zero integration_state rows still needs to know "Connect Linear
    is real" vs "Linear is coming soon."
  */
  providers: authedProcedure.query(async () => {
    return {
      linear: { configured: linearOauthConfigured() },
      // When Notion/Zendesk/PostHog/Canny OAuth modules land, add them
      // here. Each needs a helper like linearOauthConfigured() that
      // only returns true when BOTH client id + secret are set.
      notion: { configured: false },
    };
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
      .from(integrationState);

    const credRows = await ctx.db
      .select({ provider: integrationCredentials.provider })
      .from(integrationCredentials);
    const connected = new Set(credRows.map((r) => r.provider));

    return rows.map((r) => ({
      ...r,
      connected: connected.has(r.provider),
      config: isLinearConfig(r.config) ? r.config : null,
    }));
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
      .where(eq(integrationCredentials.provider, "linear"))
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
        // Token was revoked at Linear. Mark it so the UI can prompt a
        // reconnect rather than showing a generic failure.
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

      // Validate teamId against the live team list. A client could
      // otherwise POST a teamId from a different workspace (or a
      // deleted team) and we'd happily persist it, setting the PM up
      // for a 404 on their next push. Re-fetching also gives us the
      // canonical name/key, so the client doesn't control display
      // strings at all.
      const [cred] = await ctx.db
        .select({
          ciphertext: integrationCredentials.ciphertext,
          nonce: integrationCredentials.nonce,
        })
        .from(integrationCredentials)
        .where(eq(integrationCredentials.provider, "linear"))
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
