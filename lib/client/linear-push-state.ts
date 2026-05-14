import type { SpecIR } from "@/lib/spec/ir";

/*
  Pure presentation logic for the spec-page Linear push surface.
  Lives outside the React component so the branch logic is unit-
  testable without a React renderer. The component reads these
  return values and routes to the matching JSX path.
*/

export type LinearPushState =
  | "pushed"
  | "pushed-partial"
  | "refinement-gap"
  | "upgrade-required"
  | "not-connected"
  | "no-default-team"
  | "ready";

export interface LinearPushStateInput {
  spec: {
    ir: SpecIR;
    linearProjectUrl: string | null;
    linearProjectId: string | null;
    linearIssueMap: Record<
      string,
      { id: string; identifier: string; url: string }
    > | null;
  };
  plan: "free" | "solo" | "pro";
  /** From `canExport(plan, "linear")`. Inverted into the state cascade. */
  planAllowsLinearExport: boolean;
  linearIntegration:
    | {
        connected: boolean;
        config: { defaultTeamId?: unknown } | null;
      }
    | null
    | undefined;
  priorProject: { projectId: string; projectUrl: string } | null;
}

/*
  Resolve the visual state in priority order. The component renders
  exactly one of these branches.

  Priority is deliberate: "already pushed" takes precedence over
  every "not configured" branch because the URL link is still useful
  even when the integration was later disconnected. Partial-push is
  flagged inside the pushed branch via `isPartialPush()`.
*/
export function pickLinearPushState(
  input: LinearPushStateInput,
): LinearPushState {
  const { spec, planAllowsLinearExport, linearIntegration, priorProject } =
    input;

  if (spec.linearProjectUrl && spec.linearProjectId) {
    return isPartialPush(spec.linearIssueMap, spec.ir.userStories)
      ? "pushed-partial"
      : "pushed";
  }

  if (!planAllowsLinearExport) return "upgrade-required";
  if (!linearIntegration?.connected) return "not-connected";

  const defaultTeamId =
    typeof linearIntegration.config?.defaultTeamId === "string"
      ? linearIntegration.config.defaultTeamId
      : null;
  if (!defaultTeamId) return "no-default-team";

  // If the current spec has no project but a prior version did, the
  // UI demotes the push CTA visual weight + shows a linkback banner.
  return priorProject !== null ? "refinement-gap" : "ready";
}

/*
  True when fewer issues exist in the persisted issueMap than user
  stories in the current IR. Drives the partial-success retry banner.

  Edge cases pinned by tests:
    - empty map + stories     → true   (initial push partial-failed)
    - map size === story count → false (clean state)
    - map larger than stories  → false (refinement dropped stories,
                                        update mode will archive the
                                        extras on next push)
    - map smaller than stories → true  (new stories added since push)
*/
export function isPartialPush(
  issueMap: Record<string, unknown> | null | undefined,
  userStories: ReadonlyArray<{ id: string }>,
): boolean {
  const issueCount = issueMap ? Object.keys(issueMap).length : 0;
  return issueCount < userStories.length;
}

/*
  tRPC error → confirm-modal conflict shape. The push mutation throws
  TRPCError with cause containing the conflict envelope when an
  existing project blocks first-click submission. Pull the typed shape
  out so the component doesn't re-implement the type narrowing.
*/
export type LinearPushConflict = {
  kind: "linear-project-exists" | "linear-project-exists-but-empty";
  projectId: string;
  projectUrl: string;
  issueCount: number;
};

export function extractLinearConflictFromError(
  err: { data?: unknown } | null | undefined,
): LinearPushConflict | null {
  if (!err || typeof err.data !== "object" || err.data === null) return null;
  const cause = (err.data as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return null;
  const c = cause as {
    type?: unknown;
    projectId?: unknown;
    projectUrl?: unknown;
    issueCount?: unknown;
  };
  if (
    (c.type !== "linear-project-exists" &&
      c.type !== "linear-project-exists-but-empty") ||
    typeof c.projectId !== "string" ||
    typeof c.projectUrl !== "string" ||
    typeof c.issueCount !== "number"
  ) {
    return null;
  }
  return {
    kind: c.type,
    projectId: c.projectId,
    projectUrl: c.projectUrl,
    issueCount: c.issueCount,
  };
}
