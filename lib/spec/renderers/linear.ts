import type { SpecIR } from "@/lib/spec/ir";

/*
  Linear renderer for a Spec IR.

  Second of three target renderers (Markdown shipped; Notion next).
  Honors CLAUDE.md's IR-first contract: every renderer is a pure
  function from SpecIR (+ context) to a typed payload. No DB reads,
  no API calls. Unit-testable as a value transform.

  Output: a LinearExportPlan describing the project payload and the
  list of reconcile actions (create / update / archive issues). The
  orchestrator owns side-effect ordering; this renderer owns content
  generation.

  Markdown sanitization is a security responsibility this renderer
  carries because SpecIR fields are LLM-generated from user-controlled
  evidence. Without sanitization, a malicious evidence corpus could
  inject @-mentions phishing engineers or rewrite links to attacker
  domains. The trust boundary lives at the LLM-output → external-tool
  crossing, which is exactly this file.
*/

const TITLE_MAX = 180;

// Defensive cap on the project description size. Linear's public
// limit is undocumented but ~100KB has historically worked. Cap at
// 64KB to leave headroom + give the UI a clear truncation marker
// instead of a cryptic Linear 400. Typical specs are well under 8KB.
const DESCRIPTION_MAX = 64 * 1024;
const TRUNCATION_MARKER =
  "\n\n_… description truncated to fit Linear's size limit. Full spec available in Rogation._";

export interface LinearProjectPayload {
  name: string;
  description: string;
}

export interface LinearIssuePayload {
  /** US id from the IR ("US1", "US2", ...). Used as map key. */
  usId: string;
  title: string;
  description: string;
}

export type LinearReconcileAction =
  | { kind: "create-issue"; payload: LinearIssuePayload }
  | {
      kind: "update-issue";
      issueId: string;
      payload: LinearIssuePayload;
    }
  | { kind: "archive-issue"; issueId: string; usId: string };

export interface LinearExportPlan {
  project: LinearProjectPayload;
  /**
   * Reconcile actions, ordered by the IR's userStories[] insertion
   * order for create/update and then any archives. The orchestrator
   * may execute creates+updates in parallel and archives sequentially
   * after — see lib/evidence/push-linear.ts.
   */
  actions: LinearReconcileAction[];
  /**
   * True when `prior` was passed but its issueMap is empty. The UI
   * uses this to swap the D3 modal copy to the "Continue first push"
   * third state instead of the default "Update existing project."
   */
  priorIssueMapEmpty: boolean;
}

export interface LinearExportPrior {
  projectId: string;
  issueMap: Record<string, { id: string; identifier: string; url: string }>;
}

/*
  Sanitize a user-controlled string for safe insertion into Linear
  markdown. Defends against:

    - @-mention phishing: prefix `@` is escaped so Linear renders it
      literally instead of notifying a real user.
    - Link rewriting: any [text](url) where url is outside the
      Rogation app origin is rewritten to `text (url)` so the URL
      shows but is NOT auto-hyperlinked. Lets readers see attacker
      domains without click-through risk.
    - Bare URLs: Linear auto-hyperlinks bare http(s) URLs. We insert
      a zero-width-joiner before the `://` for non-allowlist URLs to
      break auto-linking while keeping the URL readable.
    - Embedded code fences: backticks are doubled to neutralize a
      malicious payload trying to close-and-reopen a code block.
    - HTML: Linear strips HTML anyway, but we drop angle brackets
      defensively. Markdown doesn't need them.

  Implementation note: this is intentionally narrow. We're not trying
  to sanitize "all possibly-bad markdown" — that's a losing battle.
  We're trying to neutralize the specific vectors a malicious evidence
  payload could use to deceive an engineer reading the Linear issue.
*/
const APP_URL =
  process.env["NEXT_PUBLIC_APP_URL"] ?? "https://app.rogation.com";

const ALLOWED_HOSTS = new Set<string>([
  "app.rogation.com",
  // Best-effort parse of APP_URL's host for non-production deploys
  // (Vercel previews, staging). new URL() throws on garbage; we fall
  // back to the prod host on parse failure.
  (() => {
    try {
      return new URL(APP_URL).host;
    } catch {
      return "app.rogation.com";
    }
  })(),
]);

/*
  Allowlist URLs by parsed hostname, not string prefix. A
  startsWith("https://app.rogation.com") check is bypassed by
  "https://app.rogation.com.evil.com/x" — same prefix, attacker
  domain. URL parsing rules that out.

  Relative URLs (starting with "/") are also allowed: they can only
  resolve to whatever host renders them, and Linear renders them
  inside its own UI where they don't auto-link.
*/
function isAllowlistedUrl(url: string): boolean {
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url);
    return ALLOWED_HOSTS.has(parsed.host);
  } catch {
    return false;
  }
}

export function sanitizeForLinear(input: string): string {
  if (!input) return "";

  // 1. Drop angle brackets (Linear strips HTML; defensive against
  //    `<script>` and autolinks `<https://evil>`).
  let out = input.replace(/[<>]/g, "");

  // 2. Escape leading @-mentions in word position. `\b @ word` → `\@ word`.
  //    Word boundary is approximated by start-of-string or non-word
  //    char preceding the @.
  out = out.replace(/(^|[^\w])@(\w)/g, "$1\\@$2");

  // 3. Escape every `[` and `]` in the user-controlled string.
  //    Sanitizer inputs are *content*, not markup. After this pass:
  //      - Inline `[text](url)` markdown is impossible from user data.
  //      - Reference-style links (`[id]: url`, `[text][id]`) are
  //        impossible (brackets neutralized, definition won't parse).
  //      - Citation breakout (`note` injecting `]` to close the
  //        renderer's own citation link prematurely) is impossible.
  //    The renderer's *own* templates emit unescaped `[label](url)`
  //    with sanitized content inside, so links still render correctly.
  out = out.replace(/[[\]]/g, (m) => (m === "[" ? "\\[" : "\\]"));

  // 4. Bare http(s) URLs outside the allowlist: insert a zero-width
  //    joiner between the scheme and `://` to break Linear's
  //    auto-linking while keeping the URL readable. Allowlisted
  //    URLs (Rogation app origins) stay intact.
  out = out.replace(
    /(^|[^\w])(https?):\/\/([^\s)]+)/g,
    (match, before, scheme, rest) => {
      const fullUrl = `${scheme}://${rest}`;
      if (isAllowlistedUrl(fullUrl)) return match;
      return `${before}${scheme}‍://${rest}`;
    },
  );

  // 5. Neutralize fenced code blocks of any backtick length
  //    (CommonMark accepts fences of length ≥ 3, and 4+ backticks
  //    are valid for fences containing 3-backtick literals).
  //    Insert ZWSP between every backtick so no run of 3+ remains
  //    in the sanitized output.
  out = out.replace(/`{3,}/g, (run) => run.split("").join("​"));

  return out;
}

/*
  Build the issue title. Goal-only (persona prefix dropped — every
  title would otherwise be "[USn] As a PM at a 50-300 person SaaS, I
  want ..." which wraps and is unreadable).

  Truncation:
    - Soft: 180 chars at the last whitespace boundary.
    - Hard fallback: if word-boundary truncation yields an empty
      string (the goal is one 200-char run-on word), hard-slice. Never
      produce a title of just "[USn] " — Linear rejects empty titles.
*/
function buildIssueTitle(usId: string, goal: string): string {
  const cleaned = sanitizeForLinear(goal.trim());
  if (cleaned.length <= TITLE_MAX) return `[${usId}] ${cleaned}`;
  const wordBoundaryTruncated = cleaned
    .slice(0, TITLE_MAX)
    .replace(/\s+\S*$/, "");
  const truncated =
    wordBoundaryTruncated.length > 0
      ? wordBoundaryTruncated
      : cleaned.slice(0, TITLE_MAX);
  return `[${usId}] ${truncated}`;
}

/*
  Build the project description. Four sections in IR-order:

    ## Summary
    ## Non-functional requirements   (omitted if none)
    ## Edge cases                    (omitted if none)
    ## QA checklist                  (omitted if none)

  Followed by a Rogation footer. NFRs / edge cases / QA live here
  rather than as separate issues because they're cross-cutting
  concerns, not work units. PMs can promote any of them into Linear
  manually if their team prefers that shape.
*/
function buildProjectDescription(ir: SpecIR): string {
  const parts: string[] = [];

  parts.push("## Summary");
  parts.push("");
  parts.push(sanitizeForLinear(ir.summary));

  if (ir.nonFunctional.length > 0) {
    parts.push("");
    parts.push("## Non-functional requirements");
    parts.push("");
    for (const nf of ir.nonFunctional) {
      parts.push(
        `- **${nf.category}:** ${sanitizeForLinear(nf.requirement)}`,
      );
    }
  }

  if (ir.edgeCases.length > 0) {
    parts.push("");
    parts.push("## Edge cases");
    parts.push("");
    for (const ec of ir.edgeCases) {
      parts.push(
        `- ${sanitizeForLinear(ec.scenario)} → ${sanitizeForLinear(
          ec.expectedBehavior,
        )}`,
      );
    }
  }

  if (ir.qaChecklist.length > 0) {
    parts.push("");
    parts.push("## QA checklist");
    parts.push("");
    for (const q of ir.qaChecklist) {
      const tag =
        q.status === "passed"
          ? " _[passed]_"
          : q.status === "failed"
            ? " _[failed]_"
            : "";
      const box = q.status === "passed" ? "[x]" : "[ ]";
      parts.push(`- ${box} ${sanitizeForLinear(q.check)}${tag}`);
    }
  }

  parts.push("");
  parts.push("---");
  parts.push("_Generated by Rogation. AC checkbox state is rebuilt from the spec on every push._");

  const full = parts.join("\n");
  if (full.length <= DESCRIPTION_MAX) return full;
  // Hard-slice on the byte boundary then append the truncation marker.
  // The marker itself is small (~120 chars) so we slice slightly less
  // than DESCRIPTION_MAX to keep the total under the cap.
  return full.slice(0, DESCRIPTION_MAX - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/*
  Build a single issue description. Story metadata up top as a quoted
  block, then the acceptance criteria checklist, then citations.

  Empty acceptance criteria for a story → omit the AC section entirely
  rather than render an empty list. gradeSpec already pressures every
  story to carry ≥1 AC; this is defensive.

  Citations link to Rogation's in-app cluster view when NEXT_PUBLIC_APP_URL
  is set, fall back to a relative path otherwise (Linear won't auto-link
  relative URLs but they remain copy-paste valid for preview deploys).
*/
function buildIssueDescription(
  us: SpecIR["userStories"][number],
  acs: SpecIR["acceptanceCriteria"],
  citations: SpecIR["citations"],
): string {
  const parts: string[] = [];

  parts.push("> **Persona:** " + sanitizeForLinear(us.persona));
  parts.push(">");
  parts.push("> **Goal:** " + sanitizeForLinear(us.goal));
  parts.push(">");
  parts.push("> **Value:** " + sanitizeForLinear(us.value));

  if (acs.length > 0) {
    parts.push("");
    parts.push("## Acceptance criteria");
    parts.push("");
    for (const ac of acs) {
      parts.push(
        `- [ ] **Given** ${sanitizeForLinear(ac.given)} **When** ${sanitizeForLinear(ac.when)} **Then** ${sanitizeForLinear(ac.then)}`,
      );
    }
  }

  if (citations.length > 0) {
    parts.push("");
    parts.push("## Citations");
    parts.push("");
    for (const c of citations) {
      // Citations are written by the spec orchestrator from real
      // cluster ids, so they're not user-controlled in the same way
      // ir.summary is — but the note string IS LLM-generated, so it
      // gets sanitized. The path component is encodeURIComponent'd
      // defensively: clusterIds are server-validated UUIDs today, but
      // the renderer is a reusable pure function that should not
      // require its callers to pre-validate inputs to stay safe.
      parts.push(
        `- [${sanitizeForLinear(c.note)}](${APP_URL}/insights?cluster=${encodeURIComponent(c.clusterId)})`,
      );
    }
    parts.push("");
    parts.push(
      "_Citations link back to the cluster as it existed at spec generation time. Refinement may invalidate links._",
    );
  }

  return parts.join("\n");
}

/*
  Top-level renderer. Pure function. Same inputs always produce the
  same plan.

    - No prior: every user story produces a create-issue action.
    - With prior:
      - Each new IR story whose usId is already mapped → update-issue.
      - Each new IR story whose usId is NOT mapped     → create-issue.
      - Each prior map entry whose usId is NOT in the
        new IR → archive-issue.

  US ids ("US1", "US2") are LLM-generated and not guaranteed stable
  across regenerations. Renaming a story from US3 to US2 will produce
  an archive of the old US3 issue + a create of a new US2 issue. The
  design doc explicitly accepts this behavior; the D3 confirm modal
  surfaces "N issues will be archived" so the PM sees the consequence.

  Action ordering: stories in IR insertion order produce their
  create/update action first, then archives. The orchestrator may
  parallelize creates+updates; archives run sequentially after the
  parallel phase resolves.
*/
export function renderLinearExport(
  ir: SpecIR,
  opportunityTitle: string,
  prior?: LinearExportPrior,
): LinearExportPlan {
  const projectName =
    ir.title.trim().length > 0
      ? sanitizeForLinear(ir.title.trim())
      : sanitizeForLinear(opportunityTitle.trim());

  const project: LinearProjectPayload = {
    name: projectName,
    description: buildProjectDescription(ir),
  };

  // Group ACs by storyId once for O(N) lookup.
  const acsByStory = new Map<string, SpecIR["acceptanceCriteria"]>();
  for (const ac of ir.acceptanceCriteria) {
    const list = acsByStory.get(ac.storyId) ?? [];
    list.push(ac);
    acsByStory.set(ac.storyId, list);
  }

  const actions: LinearReconcileAction[] = [];
  const newUsIds = new Set<string>();

  // First pass: creates + updates in IR order.
  for (const us of ir.userStories) {
    newUsIds.add(us.id);
    const payload: LinearIssuePayload = {
      usId: us.id,
      title: buildIssueTitle(us.id, us.goal),
      description: buildIssueDescription(
        us,
        acsByStory.get(us.id) ?? [],
        ir.citations,
      ),
    };
    const priorEntry = prior?.issueMap[us.id];
    if (priorEntry) {
      actions.push({
        kind: "update-issue",
        issueId: priorEntry.id,
        payload,
      });
    } else {
      actions.push({ kind: "create-issue", payload });
    }
  }

  // Second pass: archives for prior entries no longer in the IR.
  if (prior) {
    for (const [usId, entry] of Object.entries(prior.issueMap)) {
      if (!newUsIds.has(usId)) {
        actions.push({
          kind: "archive-issue",
          issueId: entry.id,
          usId,
        });
      }
    }
  }

  const priorIssueMapEmpty =
    prior !== undefined && Object.keys(prior.issueMap).length === 0;

  return { project, actions, priorIssueMapEmpty };
}
