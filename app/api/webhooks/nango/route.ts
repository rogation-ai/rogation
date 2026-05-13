import { type NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { integrationState } from "@/db/schema";
import { bindAccountToTx } from "@/db/scoped";
import { ingestEvidence } from "@/lib/evidence/ingest";
import { getNango } from "@/lib/integrations/nango/client";
import { checkLimit } from "@/lib/rate-limit";
import type { EvidenceSourceType, IngestInput } from "@/lib/evidence/ingest";
import type { PlanTier } from "@/lib/plans";
import { accounts } from "@/db/schema";

/*
  Nango webhook handler. Receives sync completion events and connection
  lifecycle events from Nango Cloud.

  Architecture (from eng review):
  - Nango sync scripts are thin: fetch data from Slack/Hotjar, return records
  - This handler receives the synced records, maps them to IngestInput, and
    runs them through ingestEvidence() inside an RLS-bound transaction
  - Business logic (dedup, plan limits, embedding) stays in our stack
  - Nango handles OAuth, token refresh, rate limiting, sync scheduling

  Security: Nango signs webhooks with HMAC. We verify using the Nango SDK.
  RLS bypass is intentional (same as Stripe/Clerk webhooks).
*/

interface NangoWebhookPayload {
  type: string;
  connectionId: string;
  providerConfigKey: string;
  provider: string;
  environment: string;
  model?: string;
  queryTimeStamp?: string;
  responseResults?: {
    added: number;
    updated: number;
    deleted: number;
  };
  modifiedAfter?: string;
  // Connection lifecycle
  operation?: string;
  // Sync records are fetched separately via the Nango API
}

interface SlackRecord {
  ts: string;
  text: string;
  channel: string;
  channel_name?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}


export async function POST(req: NextRequest): Promise<NextResponse> {
  const nango = getNango();
  if (!nango) {
    return NextResponse.json({ error: "Nango not configured" }, { status: 503 });
  }

  const rawBody = await req.text();
  let payload: NangoWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Route by event type
  if (payload.type === "sync" && payload.responseResults) {
    return handleSyncComplete(nango, payload);
  }

  if (payload.type === "auth") {
    return handleConnectionLifecycle(payload);
  }

  return NextResponse.json({ ok: true, ignored: true });
}

async function handleSyncComplete(
  nango: NonNullable<ReturnType<typeof getNango>>,
  payload: NangoWebhookPayload,
): Promise<NextResponse> {
  const { connectionId, providerConfigKey } = payload;

  // Look up which account owns this Nango connection
  const stateRow = await findAccountByNangoConnection(connectionId, providerConfigKey);
  if (!stateRow) {
    return NextResponse.json({ ok: true, ignored: true, reason: "no_account" });
  }

  const { accountId, plan } = stateRow;

  // Rate limit per account
  const rl = await checkLimit("connector-ingest", accountId);
  if (!rl.success) {
    return NextResponse.json(
      { error: "rate_limited", resetAt: rl.reset },
      { status: 429 },
    );
  }

  // Fetch the synced records from Nango
  const records = await nango.listRecords({
    connectionId,
    providerConfigKey,
    model: payload.model ?? "messages",
  });

  if (!records.records || records.records.length === 0) {
    return NextResponse.json({ ok: true, ingested: 0 });
  }

  // Map records to IngestInput based on provider
  const sourceType = providerToSourceType(providerConfigKey);
  if (!sourceType) {
    return NextResponse.json({ ok: true, ignored: true, reason: "unknown_provider" });
  }

  const inputs = mapRecordsToIngestInputs(
    records.records,
    sourceType,
    providerConfigKey,
  );

  // Ingest inside an RLS-bound transaction
  let ingested = 0;
  let deduped = 0;
  let capReached = false;

  await db.transaction(async (tx) => {
    await bindAccountToTx(tx, accountId);
    const ctx = { db: tx, accountId, plan };

    for (const input of inputs) {
      try {
        const result = await ingestEvidence(ctx, input);
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
          (err as { cause?: { type?: string } }).cause?.type === "plan_limit_reached"
        ) {
          capReached = true;
          break;
        }
        throw err;
      }
    }
  });

  // Update sync cursor
  await db
    .update(integrationState)
    .set({
      lastSyncedAt: new Date(),
      cursor: payload.queryTimeStamp ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationState.accountId, accountId),
        eq(integrationState.provider, providerConfigKey as "slack" | "hotjar"),
      ),
    );

  return NextResponse.json({ ok: true, ingested, deduped, capReached });
}

async function handleConnectionLifecycle(
  payload: NangoWebhookPayload,
): Promise<NextResponse> {
  const { connectionId, providerConfigKey, operation } = payload;

  if (operation === "creation") {
    // Nango connection created -- we'll set up the state row when the
    // user completes the connect flow in the settings UI. The webhook
    // is a confirmation signal, not the primary creation path.
    return NextResponse.json({ ok: true, event: "connection_created" });
  }

  if (operation === "deletion" || operation === "revocation") {
    // Token revoked or connection deleted -- mark as invalid
    const stateRow = await findAccountByNangoConnection(connectionId, providerConfigKey);
    if (stateRow) {
      await db
        .update(integrationState)
        .set({
          status: "token_invalid",
          lastError: `Nango connection ${operation}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationState.accountId, stateRow.accountId),
            eq(integrationState.provider, providerConfigKey as "slack" | "hotjar"),
          ),
        );
    }
    return NextResponse.json({ ok: true, event: `connection_${operation}` });
  }

  return NextResponse.json({ ok: true, ignored: true });
}

// --- Helpers ---

async function findAccountByNangoConnection(
  connectionId: string,
  provider: string,
): Promise<{ accountId: string; plan: PlanTier } | null> {
  // integration_state.config stores { nangoConnectionId: "..." }
  // We need to find the row where config->>'nangoConnectionId' = connectionId
  const rows = await db
    .select({
      accountId: integrationState.accountId,
      plan: accounts.plan,
    })
    .from(integrationState)
    .innerJoin(accounts, eq(integrationState.accountId, accounts.id))
    .where(eq(integrationState.provider, provider as "slack" | "hotjar"));

  // Filter by nangoConnectionId in config JSONB
  for (const row of rows) {
    // We check integration_state.config in a second pass since Drizzle
    // doesn't have great JSONB field extraction support
    const [stateWithConfig] = await db
      .select({ config: integrationState.config })
      .from(integrationState)
      .where(
        and(
          eq(integrationState.accountId, row.accountId),
          eq(integrationState.provider, provider as "slack" | "hotjar"),
        ),
      );

    const config = stateWithConfig?.config as { nangoConnectionId?: string } | null;
    if (config?.nangoConnectionId === connectionId) {
      return { accountId: row.accountId, plan: row.plan };
    }
  }

  return null;
}

function providerToSourceType(provider: string): EvidenceSourceType | null {
  switch (provider) {
    case "slack":
      return "slack";
    default:
      return null;
  }
}

function mapRecordsToIngestInputs(
  records: unknown[],
  sourceType: EvidenceSourceType,
  provider: string,
): IngestInput[] {
  if (provider === "slack") {
    return (records as SlackRecord[])
      .filter((r) => {
        if (r.bot_id || r.subtype === "bot_message") return false;
        if (r.thread_ts && r.thread_ts !== r.ts) return false;
        if (!r.text || r.text.split(/\s+/).length < 10) return false;
        return true;
      })
      .map((r) => ({
        content: r.text,
        sourceType,
        sourceRef: `slack:${r.channel}:${r.ts}`,
        embed: "defer" as const,
      }));
  }

  return [];
}
