"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

export default function ScopesPage(): React.JSX.Element {
  const utils = trpc.useUtils();
  const { data: scopes, isLoading } = trpc.scopes.list.useQuery();
  const createMutation = trpc.scopes.create.useMutation({
    onSuccess: () => {
      utils.scopes.list.invalidate();
      setName("");
      setBrief("");
      setShowCreate(false);
    },
  });
  const deleteMutation = trpc.scopes.delete.useMutation({
    onSuccess: () => utils.scopes.list.invalidate(),
  });
  const updateMutation = trpc.scopes.update.useMutation({
    onSuccess: () => utils.scopes.list.invalidate(),
  });
  const previewMutation = trpc.scopes.preview.useMutation();
  const rerouteMutation = trpc.scopes.reroute.useMutation({
    onSuccess: () => utils.scopes.list.invalidate(),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBrief, setEditBrief] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  function handleCreate() {
    if (!name.trim() || !brief.trim()) return;
    createMutation.mutate({ name: name.trim(), brief: brief.trim() });
  }

  function handlePreview() {
    if (!brief.trim()) return;
    previewMutation.mutate({ brief: brief.trim() });
  }

  function startEdit(scope: { id: string; name: string; brief: string }) {
    setEditingId(scope.id);
    setEditName(scope.name);
    setEditBrief(scope.brief);
  }

  function handleUpdate() {
    if (!editingId || !editName.trim() || !editBrief.trim()) return;
    updateMutation.mutate(
      { id: editingId, name: editName.trim(), brief: editBrief.trim() },
      { onSuccess: () => setEditingId(null) },
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0 flex-1">
          <h1
            className="text-lg font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            Scopes
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Group evidence by domain. Evidence is routed to scopes by
            similarity to the scope brief.
          </p>
          {rerouteMutation.data && !rerouteMutation.isPending && (
            <p
              className="text-xs mt-2"
              style={{ color: "var(--color-success)" }}
            >
              Re-routed: {rerouteMutation.data.routed} attached,{" "}
              {rerouteMutation.data.unscoped} unscoped of{" "}
              {rerouteMutation.data.total} total.
            </p>
          )}
        </div>
        {!showCreate && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowCreate(true)}
              className="whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium text-white"
              style={{ background: "var(--color-brand-accent)" }}
            >
              New scope
            </button>
            {scopes && scopes.length > 0 && (
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="flex h-8 w-8 items-center justify-center rounded border"
                  style={{
                    borderColor: "var(--color-border-subtle)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="8" cy="3" r="1.4" />
                    <circle cx="8" cy="8" r="1.4" />
                    <circle cx="8" cy="13" r="1.4" />
                  </svg>
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 mt-1 w-48 rounded border py-1 text-sm shadow-lg z-10"
                    style={{
                      background: "var(--color-surface-raised)",
                      borderColor: "var(--color-border-default)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        rerouteMutation.mutate();
                      }}
                      disabled={rerouteMutation.isPending}
                      className="block w-full px-3 py-1.5 text-left disabled:opacity-50 hover:bg-[var(--color-surface-sunken)]"
                    >
                      {rerouteMutation.isPending
                        ? "Re-routing…"
                        : "Re-route all evidence"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {showCreate && (
        <div
          className="rounded border p-4 mb-6"
          style={{ borderColor: "var(--color-border-subtle)" }}
        >
          <div className="space-y-3">
            <div>
              <label
                className="block text-xs font-medium mb-1"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Onboarding, Mobile Performance"
                className="w-full rounded border px-3 py-2 text-sm outline-none"
                style={{
                  borderColor: "var(--color-border-subtle)",
                  background: "var(--color-surface-app)",
                  color: "var(--color-text-primary)",
                }}
                maxLength={128}
              />
            </div>
            <div>
              <label
                className="block text-xs font-medium mb-1"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Brief
              </label>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Describe the domain. Evidence with similar themes will be routed here."
                rows={3}
                className="w-full rounded border px-3 py-2 text-sm outline-none resize-none"
                style={{
                  borderColor: "var(--color-border-subtle)",
                  background: "var(--color-surface-app)",
                  color: "var(--color-text-primary)",
                }}
                maxLength={2000}
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleCreate}
                disabled={
                  !name.trim() || !brief.trim() || createMutation.isPending
                }
                className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-brand-accent)" }}
              >
                {createMutation.isPending ? "Creating..." : "Create scope"}
              </button>
              <button
                onClick={handlePreview}
                disabled={!brief.trim() || previewMutation.isPending}
                className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                style={{
                  borderColor: "var(--color-border-subtle)",
                  color: "var(--color-text-secondary)",
                }}
              >
                Preview matches
              </button>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setName("");
                  setBrief("");
                }}
                className="text-sm"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Cancel
              </button>
              {previewMutation.data && (
                <span
                  className="text-sm"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {previewMutation.data.matching} of{" "}
                  {previewMutation.data.total} evidence match
                </span>
              )}
            </div>
            {createMutation.isError && (
              <p className="text-sm text-[var(--color-severity-critical)]">
                {createMutation.error.message}
              </p>
            )}
          </div>
        </div>
      )}

      {isLoading && (
        <div
          className="text-sm"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Loading...
        </div>
      )}

      {scopes && scopes.length === 0 && !showCreate && (
        <div
          className="rounded border p-8 text-center"
          style={{ borderColor: "var(--color-border-subtle)" }}
        >
          <p
            className="text-sm mb-2"
            style={{ color: "var(--color-text-secondary)" }}
          >
            No scopes yet. Create one to start routing evidence by domain.
          </p>
        </div>
      )}

      {scopes && scopes.length > 0 && (
        <div className="space-y-3">
          {scopes.map((scope) =>
            editingId === scope.id ? (
              <div
                key={scope.id}
                className="rounded border p-4"
                style={{ borderColor: "var(--color-border-subtle)" }}
              >
                <div className="space-y-3">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded border px-3 py-2 text-sm outline-none"
                    style={{
                      borderColor: "var(--color-border-subtle)",
                      background: "var(--color-surface-app)",
                      color: "var(--color-text-primary)",
                    }}
                    maxLength={128}
                  />
                  <textarea
                    value={editBrief}
                    onChange={(e) => setEditBrief(e.target.value)}
                    rows={3}
                    className="w-full rounded border px-3 py-2 text-sm outline-none resize-none"
                    style={{
                      borderColor: "var(--color-border-subtle)",
                      background: "var(--color-surface-app)",
                      color: "var(--color-text-primary)",
                    }}
                    maxLength={2000}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleUpdate}
                      disabled={updateMutation.isPending}
                      className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      style={{ background: "var(--color-brand-accent)" }}
                    >
                      {updateMutation.isPending ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-sm"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                key={scope.id}
                className="rounded border p-4 flex items-start justify-between gap-4"
                style={{ borderColor: "var(--color-border-subtle)" }}
              >
                <div className="min-w-0">
                  <h3
                    className="text-sm font-medium"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {scope.name}
                  </h3>
                  <p
                    className="text-sm mt-1 line-clamp-2"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    {scope.brief}
                  </p>
                  <span
                    className="text-xs mt-2 inline-block"
                    style={{
                      color: "var(--color-text-tertiary)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {scope.evidenceCount} evidence
                  </span>
                  {scope.evidenceCount === 0 && (
                    <p
                      className="text-[13px] mt-2 max-w-md leading-snug"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      No matches yet — try widening the brief.
                    </p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => startEdit(scope)}
                    className="rounded border px-2 py-1 text-xs"
                    style={{
                      borderColor: "var(--color-border-subtle)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm("Delete this scope? Evidence will become unscoped.")) {
                        deleteMutation.mutate({ id: scope.id });
                      }
                    }}
                    className="rounded border px-2 py-1 text-xs"
                    style={{
                      borderColor: "var(--color-border-subtle)",
                      color: "var(--color-severity-critical)",
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
