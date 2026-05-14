"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Nango from "@nangohq/frontend";
import { trpc } from "@/lib/trpc";
import { SkeletonList } from "@/components/ui/LoadingSkeleton";

/*
  Settings → Integrations. First-class surface for Linear (Notion lands
  in a sibling commit). Three states per provider:

    - Not connected     → "Connect" button (GET /api/oauth/linear/start).
    - Connected, no team → auto-open team picker (primary action).
    - Connected + team   → show current team + "Change team" + "Disconnect".

  Error banner surfaces when the OAuth callback bounced back with
  `?linear=error`. Success toast on `?linear=connected`. Both read
  from query params once and stay put — refresh-safe.
*/

export default function IntegrationsSettingsPage(): React.JSX.Element {
  return (
    <Suspense fallback={<SkeletonList count={2} />}>
      <IntegrationsSettingsInner />
    </Suspense>
  );
}

function IntegrationsSettingsInner(): React.JSX.Element {
  const search = useSearchParams();
  const linearParam = search.get("linear");
  const notionParam = search.get("notion");
  const reason = search.get("reason");
  const [banner, setBanner] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  useEffect(() => {
    if (linearParam === "connected") {
      setBanner({ kind: "ok", text: "Linear connected." });
    } else if (linearParam === "error") {
      // Specific reasons tell the user whether retrying helps. A
      // generic "try again" next to a misconfigured server wastes
      // clicks; a clear "contact support" gets them unblocked faster.
      const text =
        reason === "not_configured"
          ? "Linear integration isn't set up on this deployment yet. Contact support."
          : reason === "unauthorized"
            ? "Sign in first, then try again."
            : reason === "insufficient_scope"
              ? "Linear didn't grant write access. Check that the OAuth app has read + write scopes enabled in its settings, then reconnect."
              : "Couldn't finish connecting Linear. Try again.";
      setBanner({ kind: "error", text });
    } else if (notionParam === "connected") {
      setBanner({
        kind: "ok",
        text: "Notion connected. Specs push into your Rogation Specs database.",
      });
    } else if (notionParam === "needs_page") {
      setBanner({
        kind: "error",
        text: "Notion connected, but no page was shared with Rogation. Reconnect and grant access to at least one page.",
      });
    } else if (notionParam === "error") {
      const text =
        reason === "not_configured"
          ? "Notion integration isn't set up on this deployment yet. Contact support."
          : reason === "unauthorized"
            ? "Sign in first, then try again."
            : "Couldn't finish connecting Notion. Try again.";
      setBanner({ kind: "error", text });
    }
  }, [linearParam, notionParam, reason]);

  const listQ = trpc.integrations.list.useQuery();
  const providersQ = trpc.integrations.providers.useQuery();

  const linear = useMemo(
    () => listQ.data?.find((r) => r.provider === "linear"),
    [listQ.data],
  );
  const notion = useMemo(
    () => listQ.data?.find((r) => r.provider === "notion"),
    [listQ.data],
  );
  const slack = useMemo(
    () => listQ.data?.find((r) => r.provider === "slack"),
    [listQ.data],
  );
  // Hotjar deferred to L1.5 (Nango doesn't support it; build from scratch after Slack thesis validates)

  return (
    <main className="space-y-8">
      <header className="space-y-1">
        <h1
          className="text-2xl font-semibold tracking-tight"
          style={{ color: "var(--color-text-primary)" }}
        >
          Integrations
        </h1>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Connect your feedback sources and where your team works.
        </p>
      </header>

      {banner ? (
        <div
          className="rounded-md border px-4 py-3 text-sm"
          role="status"
          style={{
            borderColor:
              banner.kind === "ok"
                ? "var(--color-success)"
                : "var(--color-danger)",
            background: "var(--color-surface-raised)",
            color: "var(--color-text-primary)",
          }}
        >
          {banner.text}
        </div>
      ) : null}

      {listQ.isLoading ? <SkeletonList count={4} /> : null}

      <div className="space-y-2">
        <h3
          className="text-xs font-medium uppercase tracking-wider"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Feedback Sources
        </h3>
        <NangoConnectorCard
          provider="slack"
          title="Slack"
          description="Auto-ingest feedback from Slack channels. Internal team discussions become evidence."
          connected={!!slack?.connected}
          status={slack?.status ?? null}
          lastSyncedAt={slack?.lastSyncedAt ?? null}
          configured={providersQ.data?.slack?.configured ?? false}
          allowed={providersQ.data?.slack?.allowed ?? false}
        />
      </div>

      <div className="space-y-2">
        <h3
          className="text-xs font-medium uppercase tracking-wider"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Export Destinations
        </h3>
        <LinearCard
          connected={!!linear?.connected}
          config={linear?.config ?? null}
          status={linear?.status ?? null}
          configured={providersQ.data?.linear.configured ?? true}
        />

        <NotionCard
          connected={!!notion?.connected}
          config={notion?.config ?? null}
          status={notion?.status ?? null}
          configured={providersQ.data?.notion.configured ?? true}
        />
      </div>
    </main>
  );
}

interface LinearConfig {
  workspaceId?: string;
  workspaceName?: string;
  defaultTeamId?: string;
  defaultTeamName?: string;
  defaultTeamKey?: string;
}

function LinearCard({
  connected,
  config,
  status,
  configured,
}: {
  connected: boolean;
  config: LinearConfig | null;
  status: string | null;
  /**
   * Whether the server has Linear OAuth credentials wired. When false,
   * the Connect button is hidden and replaced with a "coming soon"
   * notice. We default to `true` while the providers query is in-flight
   * to avoid flashing the fallback on every page load.
   */
  configured: boolean;
}): React.JSX.Element {
  const utils = trpc.useUtils();
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: async () => {
      setDisconnectError(null);
      await utils.integrations.list.invalidate();
      await utils.integrations.list.refetch();
    },
    onError: (err) => {
      console.error("Linear disconnect failed:", err);
      setDisconnectError(
        err.message || "Couldn't disconnect Linear. Try again.",
      );
    },
  });

  const onDisconnect = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDisconnectError(null);
    disconnect.mutate({ provider: "linear" });
  };

  return (
    <section
      className="rounded-lg border p-6"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <h2
            className="text-lg font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            Linear
          </h2>
          <p
            className="text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Push specs as Linear issues with title, description, and
            acceptance criteria already filled in.
          </p>
          {connected && config?.workspaceName ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Workspace:{" "}
              <span style={{ color: "var(--color-text-primary)" }}>
                {config.workspaceName}
              </span>
            </p>
          ) : null}
          {status === "token_invalid" ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-danger)" }}
            >
              Token revoked. Reconnect to continue.
            </p>
          ) : null}
          {disconnectError ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-danger)" }}
              role="alert"
            >
              {disconnectError}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!configured ? (
            // OAuth creds aren't wired on this deployment. Showing a live
            // Connect button would dead-end the user on /api/oauth/linear/start.
            // Match the tone of LinearTeamPicker's PRECONDITION_FAILED path.
            <span
              className="rounded-md border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--color-border-subtle)",
                color: "var(--color-text-tertiary)",
              }}
            >
              Coming soon
            </span>
          ) : connected ? (
            <>
              <a
                href="/api/oauth/linear/start"
                className="rounded-md border px-3 py-2 text-sm"
                style={{
                  borderColor: "var(--color-border-subtle)",
                  color: "var(--color-text-primary)",
                }}
              >
                Reconnect
              </a>
              <button
                type="button"
                onClick={onDisconnect}
                disabled={disconnect.isPending}
                className="rounded-md px-3 py-2 text-sm"
                style={{
                  color: "var(--color-danger)",
                }}
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </button>
            </>
          ) : (
            <a
              href="/api/oauth/linear/start"
              className="rounded-md px-4 py-2 text-sm font-medium"
              style={{
                background: "var(--color-brand-accent)",
                color: "var(--color-text-inverse)",
              }}
            >
              Connect Linear
            </a>
          )}
        </div>
      </div>

      {connected ? (
        <div className="mt-6 border-t pt-6" style={{ borderColor: "var(--color-border-subtle)" }}>
          <LinearTeamPicker current={config?.defaultTeamId ?? null} />
        </div>
      ) : null}
    </section>
  );
}

function LinearTeamPicker({ current }: { current: string | null }): React.JSX.Element {
  const utils = trpc.useUtils();
  const teamsQ = trpc.integrations.linearTeams.useQuery(undefined, {
    retry: false,
  });
  const setTeam = trpc.integrations.setLinearDefaultTeam.useMutation({
    onSuccess: () => utils.integrations.list.invalidate(),
  });
  const [pickedId, setPickedId] = useState<string>(current ?? "");

  useEffect(() => {
    if (current) setPickedId(current);
  }, [current]);

  if (teamsQ.isLoading) return <SkeletonList count={1} />;

  if (teamsQ.isError) {
    // Distinguish server-misconfig (PRECONDITION_FAILED) from a
    // user-actionable failure. Telling a PM "Linear OAuth is not
    // configured on this server" next to a live Reconnect button is
    // contradictory; neutralize to a support-directed message so
    // they don't keep clicking Reconnect and waste their time.
    const isServerMisconfig =
      teamsQ.error?.data?.code === "PRECONDITION_FAILED";
    return (
      <p
        className="text-sm"
        style={{
          color: isServerMisconfig
            ? "var(--color-text-secondary)"
            : "var(--color-danger)",
        }}
      >
        {isServerMisconfig
          ? "Linear push is temporarily unavailable — our side. Contact support if this persists."
          : `Couldn't load teams: ${teamsQ.error?.message ?? "try reconnecting."}`}
      </p>
    );
  }

  const teams = teamsQ.data?.teams ?? [];
  if (teams.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        No teams visible to this token.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <label
        htmlFor="linear-default-team"
        className="block text-sm font-medium"
        style={{ color: "var(--color-text-primary)" }}
      >
        Default team
      </label>
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Specs push as issues into this team.
      </p>
      <div className="flex gap-3">
        <select
          id="linear-default-team"
          value={pickedId}
          onChange={(e) => setPickedId(e.target.value)}
          className="flex-1 rounded-md border px-3 py-2 text-sm"
          style={{
            borderColor: "var(--color-border-subtle)",
            background: "var(--color-surface-app)",
            color: "var(--color-text-primary)",
          }}
        >
          <option value="" disabled>
            Pick a team…
          </option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.key})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!pickedId || setTeam.isPending}
          onClick={() => {
            if (!pickedId) return;
            setTeam.mutate({ teamId: pickedId });
          }}
          className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{
            background: "var(--color-brand-accent)",
            color: "var(--color-text-inverse)",
          }}
        >
          {setTeam.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      {setTeam.isSuccess ? (
        <p className="text-xs" style={{ color: "var(--color-success)" }}>
          Saved.
        </p>
      ) : null}
    </div>
  );
}

interface NotionConfig {
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string | null;
  defaultDatabaseId?: string;
  defaultDatabaseName?: string;
  setupReason?: "no_writable_page" | "provision_failed";
}

function NotionCard({
  connected,
  config,
  status,
  configured,
}: {
  connected: boolean;
  config: NotionConfig | Record<string, unknown> | null;
  status: string | null;
  configured: boolean;
}): React.JSX.Element {
  const utils = trpc.useUtils();
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: async () => {
      setDisconnectError(null);
      await utils.integrations.list.invalidate();
      await utils.integrations.list.refetch();
    },
    onError: (err) => {
      console.error("Notion disconnect failed:", err);
      setDisconnectError(
        err.message || "Couldn't disconnect Notion. Try again.",
      );
    },
  });

  const onDisconnect = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDisconnectError(null);
    disconnect.mutate({ provider: "notion" });
  };

  // Narrow the config shape via duck-typing. The router returns a
  // Record<string, unknown> because the JSONB column is provider-agnostic;
  // here we read only fields we know Notion writes.
  const cfg: NotionConfig = (config ?? {}) as NotionConfig;
  const needsSetup = !!cfg.setupReason;

  return (
    <section
      className="rounded-lg border p-6"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <h2
            className="text-lg font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            Notion
          </h2>
          <p
            className="text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Push specs as pages in an auto-created &ldquo;Rogation Specs&rdquo;
            database inside your workspace.
          </p>
          {connected && cfg.workspaceName ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Workspace:{" "}
              <span style={{ color: "var(--color-text-primary)" }}>
                {cfg.workspaceName}
              </span>
            </p>
          ) : null}
          {connected && cfg.defaultDatabaseName ? (
            <p
              className="text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Database:{" "}
              <span style={{ color: "var(--color-text-primary)" }}>
                {cfg.defaultDatabaseName}
              </span>
            </p>
          ) : null}
          {connected && needsSetup ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-danger)" }}
            >
              {cfg.setupReason === "no_writable_page"
                ? "No page was shared with Rogation. Reconnect and grant access to at least one page so we can create the spec database."
                : "Couldn't create the spec database. Reconnect and retry."}
            </p>
          ) : null}
          {status === "token_invalid" ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-danger)" }}
            >
              Token revoked. Reconnect to continue.
            </p>
          ) : null}
          {disconnectError ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-danger)" }}
              role="alert"
            >
              {disconnectError}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!configured ? (
            <span
              className="rounded-md border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--color-border-subtle)",
                color: "var(--color-text-tertiary)",
              }}
            >
              Coming soon
            </span>
          ) : connected ? (
            <>
              <a
                href="/api/oauth/notion/start"
                className="rounded-md border px-3 py-2 text-sm"
                style={{
                  borderColor: needsSetup
                    ? "var(--color-brand-accent)"
                    : "var(--color-border-subtle)",
                  color: needsSetup
                    ? "var(--color-brand-accent)"
                    : "var(--color-text-primary)",
                }}
              >
                {needsSetup ? "Reconnect with page access" : "Reconnect"}
              </a>
              <button
                type="button"
                onClick={onDisconnect}
                disabled={disconnect.isPending}
                className="rounded-md px-3 py-2 text-sm"
                style={{ color: "var(--color-danger)" }}
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </button>
            </>
          ) : (
            <a
              href="/api/oauth/notion/start"
              className="rounded-md px-4 py-2 text-sm font-medium"
              style={{
                background: "var(--color-brand-accent)",
                color: "var(--color-text-inverse)",
              }}
            >
              Connect Notion
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function NangoConnectorCard({
  provider,
  title,
  description,
  connected,
  status,
  lastSyncedAt,
  configured,
  allowed,
}: {
  provider: "slack" | "hotjar";
  title: string;
  description: string;
  connected: boolean;
  status: string | null;
  lastSyncedAt: Date | string | null;
  configured: boolean;
  allowed: boolean;
}): React.JSX.Element {
  const utils = trpc.useUtils();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const connectMutation = trpc.integrations.connectNango.useMutation({
    onSuccess: () => {
      setConnectError(null);
      utils.integrations.list.invalidate();
    },
    onError: (err) => {
      setConnectError(err.message);
    },
  });

  const getTokenMutation = trpc.integrations.nangoConnectToken.useMutation();

  const disconnectMutation = trpc.integrations.disconnectNango.useMutation({
    onSuccess: () => {
      utils.integrations.list.invalidate();
    },
    onError: (err) => {
      setConnectError(err.message);
    },
  });

  const onConnect = useCallback(async () => {
    setIsConnecting(true);
    setConnectError(null);

    try {
      const { token } = await getTokenMutation.mutateAsync();
      const nango = new Nango({ connectSessionToken: token });
      const result = await nango.auth(provider);
      if (result.connectionId) {
        connectMutation.mutate({
          provider,
          connectionId: result.connectionId,
        });
      }
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Connection failed. Try again.",
      );
    } finally {
      setIsConnecting(false);
    }
  }, [provider, connectMutation, getTokenMutation]);

  const syncTime = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleString()
    : null;

  return (
    <section
      className="rounded-lg border p-6"
      style={{
        borderColor: "var(--color-border-subtle)",
        background: "var(--color-surface-raised)",
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <h2
            className="text-lg font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            {title}
          </h2>
          <p
            className="text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {description}
          </p>
          {connected && syncTime ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Last sync:{" "}
              <span style={{ color: "var(--color-text-primary)" }}>
                {syncTime}
              </span>
            </p>
          ) : null}
          {connected && provider === "slack" ? (
            <SelectedChannelsDisplay />
          ) : null}
          {status === "token_invalid" ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-danger)" }}
            >
              Connection lost. Reconnect to resume syncing.
            </p>
          ) : null}
          {connectError ? (
            <p
              className="pt-2 text-sm"
              style={{ color: "var(--color-danger)" }}
              role="alert"
            >
              {connectError}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!configured ? (
            <span
              className="rounded-md border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--color-border-subtle)",
                color: "var(--color-text-tertiary)",
              }}
            >
              Coming soon
            </span>
          ) : !allowed ? (
            <span
              className="rounded-md border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--color-border-subtle)",
                color: "var(--color-text-tertiary)",
              }}
            >
              Upgrade to connect
            </span>
          ) : connected ? (
            <>
              <button
                type="button"
                onClick={onConnect}
                disabled={isConnecting}
                className="rounded-md border px-3 py-2 text-sm"
                style={{
                  borderColor: "var(--color-border-subtle)",
                  color: "var(--color-text-primary)",
                }}
              >
                {isConnecting ? "Connecting..." : "Reconnect"}
              </button>
              <button
                type="button"
                onClick={() => disconnectMutation.mutate({ provider })}
                disabled={disconnectMutation.isPending}
                className="rounded-md px-3 py-2 text-sm"
                style={{ color: "var(--color-danger)" }}
              >
                {disconnectMutation.isPending
                  ? "Disconnecting..."
                  : "Disconnect"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              disabled={isConnecting}
              className="rounded-md px-4 py-2 text-sm font-medium"
              style={{
                background: "var(--color-brand-accent)",
                color: "var(--color-text-inverse)",
              }}
            >
              {isConnecting ? "Connecting..." : `Connect ${title}`}
            </button>
          )}
        </div>
      </div>

      {connected && provider === "slack" ? (
        <div
          className="mt-6 border-t pt-6"
          style={{ borderColor: "var(--color-border-subtle)" }}
        >
          <SlackChannelPicker />
        </div>
      ) : null}
    </section>
  );
}

function SelectedChannelsDisplay(): React.JSX.Element | null {
  const channelsQ = trpc.integrations.slackChannels.useQuery(undefined, {
    retry: false,
  });

  const selected = channelsQ.data?.selectedChannels ?? [];
  if (selected.length === 0) return null;

  return (
    <p
      className="pt-2 text-sm"
      style={{ color: "var(--color-text-secondary)" }}
    >
      Channels:{" "}
      <span style={{ color: "var(--color-text-primary)" }}>
        {selected.map((c) => `#${c.name}`).join(", ")}
      </span>
    </p>
  );
}

function SlackChannelPicker(): React.JSX.Element {
  const utils = trpc.useUtils();
  const channelsQ = trpc.integrations.slackChannels.useQuery(undefined, {
    retry: false,
  });
  const setChannels = trpc.integrations.setSlackChannels.useMutation({
    onSuccess: () => utils.integrations.slackChannels.invalidate(),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (channelsQ.data?.selectedChannels) {
      setSelected(new Set(channelsQ.data.selectedChannels.map((c) => c.id)));
    }
  }, [channelsQ.data?.selectedChannels]);

  if (channelsQ.isLoading) return <SkeletonList count={1} />;

  if (channelsQ.isError) {
    return (
      <p className="text-sm" style={{ color: "var(--color-danger)" }}>
        {channelsQ.error?.message ?? "Couldn't load channels."}
      </p>
    );
  }

  const channels = channelsQ.data?.channels ?? [];

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 5) {
        next.add(id);
      }
      return next;
    });
  };

  const onSave = () => {
    const picked = channels
      .filter((c) => selected.has(c.id))
      .map((c) => ({ id: c.id, name: c.name }));
    if (picked.length > 0) {
      setChannels.mutate({ channels: picked });
    }
  };

  return (
    <div className="space-y-3">
      <label
        className="block text-sm font-medium"
        style={{ color: "var(--color-text-primary)" }}
      >
        Channels to monitor (max 5)
      </label>
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Messages from these channels become evidence for clustering.
      </p>
      <div
        className="max-h-48 overflow-y-auto rounded-md border p-2 space-y-1"
        style={{
          borderColor: "var(--color-border-subtle)",
          background: "var(--color-surface-app)",
        }}
      >
        {channels.length === 0 ? (
          <p
            className="text-sm p-2"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No channels visible to the Slack bot.
          </p>
        ) : (
          channels.map((c) => (
            <label
              key={c.id}
              className="flex items-center gap-2 rounded px-2 py-1.5 cursor-pointer hover:bg-black/5"
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                disabled={!selected.has(c.id) && selected.size >= 5}
                className="rounded"
              />
              <span
                className="text-sm"
                style={{ color: "var(--color-text-primary)" }}
              >
                #{c.name}
              </span>
              <span
                className="text-xs ml-auto"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {c.memberCount} members
              </span>
            </label>
          ))
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={selected.size === 0 || setChannels.isPending}
          onClick={onSave}
          className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{
            background: "var(--color-brand-accent)",
            color: "var(--color-text-inverse)",
          }}
        >
          {setChannels.isPending ? "Saving..." : "Save channels"}
        </button>
        {setChannels.isSuccess ? (
          <p className="text-xs" style={{ color: "var(--color-success)" }}>
            Saved.
          </p>
        ) : null}
        {selected.size >= 5 ? (
          <p
            className="text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Maximum 5 channels reached.
          </p>
        ) : null}
      </div>
    </div>
  );
}
