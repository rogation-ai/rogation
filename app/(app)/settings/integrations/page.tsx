"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
  const linearReason = search.get("reason");
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
        linearReason === "not_configured"
          ? "Linear integration isn't set up on this deployment yet. Contact support."
          : linearReason === "unauthorized"
            ? "Sign in first, then try again."
            : "Couldn't finish connecting Linear. Try again.";
      setBanner({ kind: "error", text });
    }
  }, [linearParam, linearReason]);

  const listQ = trpc.integrations.list.useQuery();
  const providersQ = trpc.integrations.providers.useQuery();

  const linear = useMemo(
    () => listQ.data?.find((r) => r.provider === "linear"),
    [listQ.data],
  );

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
          Connect where your team already works. Specs push as native issues.
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
            background:
              banner.kind === "ok"
                ? "var(--color-surface-raised)"
                : "var(--color-surface-raised)",
            color: "var(--color-text-primary)",
          }}
        >
          {banner.text}
        </div>
      ) : null}

      {listQ.isLoading ? <SkeletonList count={2} /> : null}

      <LinearCard
        connected={!!linear?.connected}
        config={linear?.config ?? null}
        status={linear?.status ?? null}
        configured={providersQ.data?.linear.configured ?? true}
      />
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
  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: () => utils.integrations.list.invalidate(),
  });

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
                onClick={() =>
                  disconnect.mutate({ provider: "linear" })
                }
                disabled={disconnect.isPending}
                className="rounded-md px-3 py-2 text-sm"
                style={{
                  color: "var(--color-danger)",
                }}
              >
                Disconnect
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
