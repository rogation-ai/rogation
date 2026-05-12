import { eq, and } from "drizzle-orm";
import { inngest } from "@/lib/inngest/client";
import { db } from "@/db/client";
import { accounts, integrationState } from "@/db/schema";
import { bindAccountToTx } from "@/db/scoped";
import { ingestEvidence } from "@/lib/evidence/ingest";
import { getNango } from "@/lib/integrations/nango/client";
import type { PlanTier } from "@/lib/plans";

/*
  Slack sync via Nango proxy. Runs every 5 minutes alongside auto-cluster-check.

  Architecture (Option A from eng review):
  - Nango handles OAuth + token refresh only
  - We pull messages directly via nango.proxy() calling Slack's conversations.history
  - Business logic (filtering, dedup, embedding) stays in our stack
  - integration_state.cursor tracks the last message timestamp per channel
*/

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  error?: string;
}

interface SlackChannelConfig {
  id: string;
  name: string;
}

interface SlackIntegrationConfig {
  nangoConnectionId?: string;
  channels?: SlackChannelConfig[];
  cursors?: Record<string, string>;
}

export const syncSlack = inngest.createFunction(
  {
    id: "sync-slack",
    retries: 1,
    concurrency: { limit: 1, key: "global" },
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    return step.run("sync-all-accounts", async () => {
      const nango = getNango();
      if (!nango) return { status: "nango_not_configured" };

      const activeSlack = await db
        .select({
          accountId: integrationState.accountId,
          config: integrationState.config,
          plan: accounts.plan,
        })
        .from(integrationState)
        .innerJoin(accounts, eq(integrationState.accountId, accounts.id))
        .where(
          and(
            eq(integrationState.provider, "slack"),
            eq(integrationState.status, "active"),
          ),
        );

      if (activeSlack.length === 0) return { status: "no_active_slack", synced: 0 };

      let totalIngested = 0;
      let totalDeduped = 0;

      for (const row of activeSlack) {
        const config = row.config as SlackIntegrationConfig | null;
        if (!config?.nangoConnectionId || !config?.channels?.length) continue;

        const result = await syncAccountSlack(
          nango,
          row.accountId,
          row.plan,
          config,
        );

        totalIngested += result.ingested;
        totalDeduped += result.deduped;
      }

      return { status: "ok", accounts: activeSlack.length, totalIngested, totalDeduped };
    });
  },
);

async function syncAccountSlack(
  nango: NonNullable<ReturnType<typeof getNango>>,
  accountId: string,
  plan: PlanTier,
  config: SlackIntegrationConfig,
): Promise<{ ingested: number; deduped: number }> {
  const cursors = config.cursors ?? {};
  let ingested = 0;
  let deduped = 0;
  const updatedCursors: Record<string, string> = { ...cursors };

  for (const channel of config.channels ?? []) {
    try {
      // Ensure the bot has joined the channel (required to read history)
      await nango.proxy({
        method: "POST",
        endpoint: "/conversations.join",
        connectionId: config.nangoConnectionId!,
        providerConfigKey: "slack",
        data: { channel: channel.id },
      }).catch(() => {});

      const oldest = cursors[channel.id];

      const response = await nango.proxy({
        method: "GET",
        endpoint: "/conversations.history",
        connectionId: config.nangoConnectionId!,
        providerConfigKey: "slack",
        params: {
          channel: channel.id,
          limit: "100",
          ...(oldest ? { oldest } : {}),
        },
      });

      const data = response.data as SlackHistoryResponse;
      if (!data.ok || !data.messages?.length) continue;

      const filtered = data.messages.filter((m) => {
        if (m.bot_id || m.subtype === "bot_message") return false;
        if (m.thread_ts && m.thread_ts !== m.ts) return false;
        if (!m.text || m.text.split(/\s+/).length < 10) return false;
        return true;
      });

      if (filtered.length === 0) {
        const newestTs = data.messages[0]?.ts;
        if (newestTs) updatedCursors[channel.id] = newestTs;
        continue;
      }

      await db.transaction(async (tx) => {
        await bindAccountToTx(tx, accountId);
        const ctx = { db: tx, accountId, plan };

        for (const msg of filtered) {
          try {
            const result = await ingestEvidence(ctx, {
              content: msg.text!,
              sourceType: "slack",
              sourceRef: `slack:${channel.id}:${msg.ts}`,
              embed: "defer",
            });
            if (result.deduped) {
              deduped++;
            } else {
              ingested++;
            }
          } catch (err: unknown) {
            if (
              err &&
              typeof err === "object" &&
              "cause" in err &&
              (err as { cause?: { type?: string } }).cause?.type ===
                "plan_limit_reached"
            ) {
              break;
            }
            throw err;
          }
        }
      });

      const newestTs = data.messages[0]?.ts;
      if (newestTs) updatedCursors[channel.id] = newestTs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("invalid_auth")) {
        await db
          .update(integrationState)
          .set({
            status: "token_invalid",
            lastError: "Slack token revoked",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(integrationState.accountId, accountId),
              eq(integrationState.provider, "slack"),
            ),
          );
        return { ingested, deduped };
      }
      console.error(`[sync-slack] Error syncing channel ${channel.name}:`, msg);
    }
  }

  await db
    .update(integrationState)
    .set({
      config: { ...config, cursors: updatedCursors },
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationState.accountId, accountId),
        eq(integrationState.provider, "slack"),
      ),
    );

  return { ingested, deduped };
}
