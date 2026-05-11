# Rogation — Design System

Source of truth for visual + interaction design. All screens, marketing and app, share one voice.

Direction set on **2026-05-11** via `/design-consultation`. Previous editorial-serif system (Tiempos + cream + warm red on dark) is retired. Decisions log at the bottom.

Reference mockup: `~/.gstack/projects/rogation-ai-rogation/designs/redesign-modern-20260511/variant-C.png` (approved).

---

## 0. Thesis

**AI that does the PM work, not chat.** The product should look like a workspace where Friday decisions get made, not a chat surface that happens to be AI. Every visual choice serves that: result-first composition, sidebar shell (real software, not marketing-shell), streaming inside the artifact (never in a separate chat panel), mono accents for data so the work feels measured.

## 1. Voice

Fast software, not magazine. Industrial / Utilitarian: function-first, data-dense, mono accents, muted neutrals. The cockpit a PM opens on Monday and lives in until Friday.

- **One sans family.** General Sans does display, UI, and body. No serif anywhere.
- **One mono family.** JetBrains Mono Display for data, IDs, timestamps, scores, citation chips.
- **One warm accent.** #D04B3F warm red, used only on active nav state, primary CTAs, and severity-critical dots. Never as a background fill. The discipline is the point.
- **Light by default.** Marketing and app both light-first. Paired dark mode via `prefers-color-scheme` + persisted user toggle.
- **No happy talk, no decoration.** Borders do the work shadows used to do. The product earns its weight from rhythm, not ornament.

## 2. Typography

Single sans family (display + UI + body) plus a single mono for data. Loaded from Fontshare (free CDN).

```html
<link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&f[]=jetbrains-mono@400,500&display=swap" rel="stylesheet">
```

| Role | Family (first \| fallback) | Weight | Tracking | Usage |
| ---- | ------------------------- | ------ | -------- | ----- |
| Display | General Sans \| ui-sans-serif | 600 | -0.015em | Marketing hero, screen-title H1, large numerics |
| Heading | General Sans \| ui-sans-serif | 600 | -0.01em | H2 (section), H3 (subsection) |
| Body | General Sans \| ui-sans-serif | 400 | 0 | All body, tables, metadata |
| UI | General Sans \| ui-sans-serif | 500 | 0 | Buttons, tags, labels, sidebar nav |
| Mono | JetBrains Mono \| ui-monospace | 400-500 | 0 | IDs, timestamps, scores, citation chips, code, terminal output, "12 mentions / 1.2k tokens" |

**Never** use Inter, Roboto, Geist, Space Grotesk, Helvetica, or `system-ui` as primary display or body. The Fontshare CDN is reliable; if it ever fails, the `ui-sans-serif` / `ui-monospace` fallbacks are acceptable degradation but not a target.

### Type scale (rem, base 16px — tighter than v0)

```text
11  0.6875  Eyebrow / micro-meta (timestamps in mono only)
12  0.75    Small caps labels, dense table meta, plan meter
13  0.8125  Sidebar nav, secondary UI
14  0.875   Metadata, table body, secondary text
16  1.00    Body (default)
18  1.125   Body-lead (intro paragraphs)
22  1.375   H4
28  1.75    H3
36  2.25    H2 / screen-title
56  3.50    H1 (landing hero only)
```

Line-height: `1.5` body, `1.4` table cells, `1.2` headings and display.

Body text floor: never below 14px on metadata, 16px on real reading content. Contrast floor: 4.5:1.

Numerics in tables, scores, frequencies, and version chips MUST use JetBrains Mono with `font-feature-settings: "tnum"`. Numbers that line up read as data; numbers that don't read as text.

## 3. Color

Light by default. Restrained: one accent on a cool-neutral canvas. The warm-red-on-cool-gray tension is the brand — keep it sparing.

```css
/* Brand — keep across modes */
--color-brand-accent:    #D04B3F   /* warm red, primary actions + active nav + critical dot */
--color-brand-accent-ink: #A03027  /* hover / pressed */

/* Surface (LIGHT — default) */
--color-surface-marketing: #FAF9F7   /* very subtle warm cream — only on marketing pages */
--color-surface-app:       #FFFFFF   /* app canvas */
--color-surface-raised:    #F7F7F8   /* cards, sidebar background, dropdowns */
--color-surface-sunken:    #ECECEE   /* sunken panels, code blocks */
--color-surface-inverse:   #0A0A0B   /* dark footers, popovers */

/* Text */
--color-text-primary:    #0A0A0B    /* near-black, slightly off true black */
--color-text-secondary:  #6E6E76    /* body secondary, metadata */
--color-text-tertiary:   #9C9CA4    /* timestamps, captions */
--color-text-inverse:    #FAFAFA    /* on dark surfaces */

/* Border — cool grays (the Linear discipline) */
--color-border-subtle:   #E8E8EB    /* hairline 1px between rows, panels */
--color-border-default:  #D4D4D9    /* default card border, input border */
--color-border-strong:   #1A1A1F    /* emphasis, focus rings on neutral */

/* Semantic */
--color-success:         #2F7A4F
--color-warning:         #B4701E
--color-danger:          #B93A2E
--color-info:            #4A6B84    /* muted; never primary CTA */

/* Severity scale (insight clusters) */
--color-severity-low:    #9C9CA4
--color-severity-medium: #B4701E
--color-severity-high:   #B93A2E
--color-severity-critical: #5C1410
```

### 3.1 Dark mode (paired)

True neutral, not warm-black. Red lifts slightly to stay readable.

```css
/* Brand */
--color-brand-accent:    #E45D50
--color-brand-accent-ink: #FF8274

/* Surface */
--color-surface-marketing: #0B0B0E
--color-surface-app:       #0B0B0E   /* unified canvas in dark */
--color-surface-raised:    #16161A
--color-surface-sunken:    #08080A
--color-surface-inverse:   #FAFAFA

/* Text */
--color-text-primary:    #FAFAFA
--color-text-secondary:  #A8A8B0
--color-text-tertiary:   #6A6A72
--color-text-inverse:    #0A0A0B

/* Border */
--color-border-subtle:   #1F1F25
--color-border-default:  #2A2A31
--color-border-strong:   #FAFAFA

/* Semantic (boosted) */
--color-success:         #4FA874
--color-warning:         #D89045
--color-danger:          #E56758
--color-info:            #7FA0BC

/* Severity */
--color-severity-low:    #6A6A72
--color-severity-medium: #D89045
--color-severity-high:   #E56758
--color-severity-critical: #FF8274
```

Dark-mode storybook stories required per component. Contrast AA in both modes.

### 3.2 Color rules

1. No hardcoded hex anywhere in shipped code. Every color goes through CSS variables.
2. Warm red is rare. Per screen: at most one persistent appearance (active nav OR primary CTA OR severity-critical dot — usually only the first). Toasts use semantic colors, not brand red.
3. No gradients on UI surfaces. No drop shadows on cards (one exception: modal overlay).
4. No purple / violet / indigo anywhere. Info color is muted slate, not blue-violet.
5. Color alone never communicates state — always paired with icon, label, or position.

## 4. Spacing

4px base. Density is **compact** by default — Linear / Vercel rhythm. The 12 and 24 do most of the work.

```css
--space-1   4px
--space-2   8px
--space-3   12px
--space-4   16px
--space-6   24px
--space-8   32px
--space-12  48px
--space-16  64px
--space-24  96px
--space-32  128px
```

- Sidebar nav item: 32px tall (`--space-8`), 12px horizontal padding.
- Top bar: 56px tall.
- Cluster list / table row: 56px tall.
- Card padding: `--space-4` (16px) for dense, `--space-6` (24px) for marketing.
- Gutter between sections: `--space-12` desktop, `--space-8` mobile.
- Form field vertical rhythm: `--space-3`.
- Page max content width (long-form): `720px`. App canvas: `1280px` max with sidebar.

## 5. Layout & shell

### App shell

Persistent **240px left sidebar** + **56px top bar** + **canvas**. The sidebar is the navigation home — top bar is reserved for breadcrumb + global commands (⌘K placeholder for v1.1) + user menu. Top nav is for marketing only.

```
+-----------------------------------------------------------+
| 56px top bar: breadcrumb · ⌘K · UserButton                |
+-------+---------------------------------------------------+
|       |                                                   |
| 240px | canvas                                            |
| side  | (max 1280px, page padding 24px)                   |
| bar   |                                                   |
|       |                                                   |
+-------+---------------------------------------------------+
```

Sidebar anatomy (top → bottom):
1. **Workspace switcher** (24px tall, brand wordmark) — pinned top
2. **Nav items** (32px each, 12px padding, 13px UI weight 500):
   - Upload (`/app`)
   - Evidence (`/evidence`)
   - Insights (`/insights`)
   - Build (`/build`)
   - Specs (no dedicated page yet — placeholder for v1.1)
   - Settings (`/settings/context`)
3. **Spacer** (flex-1)
4. **PlanMeter** — full-width 4px bar at bottom showing usage / cap, label "7/10 plan". Warm red fill when ≥ 80%.

Active nav state: red left-border (3px, `--color-brand-accent`) + red text. No background fill, no pill — discipline.

### Marketing shell

Single-column, max-width 720px for prose, full-bleed for screenshots. Top nav (Pricing · Log in) is 80px tall with the wordmark left. Marketing surface uses `--color-surface-marketing` (subtle warm cream).

Hero leads with a real product screenshot or annotated cut, not a tagline floating in space.

### Layout decisions

- Sidebar collapses to a drawer below `md` (768px). Mobile drawer covers half the screen.
- Canvas grids: 12-col on desktop, single-column on mobile.
- Border radius: hierarchical.

```css
--radius-sm:  4px    /* inputs, tags, pills, sidebar items */
--radius-md:  6px    /* buttons, cards — tighter than v0 */
--radius-lg:  10px   /* modals */
--radius-xl:  16px   /* marketing hero panels — rare */
```

Elevation: borders + background contrast, not shadows. The litmus rule: "would the design feel premium with all decorative shadows removed?" must be yes. One permitted shadow: modal overlay (`0 24px 48px -16px rgba(10,10,11,0.18)` light, `0 24px 48px -16px rgba(0,0,0,0.6)` dark).

## 6. Component inventory

Shared primitives that recur across screens. Each gets a storybook story + visual spec.

| Primitive | Where used | Anatomy |
| --------- | ---------- | ------- |
| `CitationChip` | Insights, Spec editor | Severity dot + JetBrains Mono cluster ID + truncated cluster title (60ch). Hover: popover with source quote + segment + date + "View evidence →" link. |
| `ConfidenceBadge` | Build, Insights | Pill with label (Low / Medium / High) + colored dot. Tooltip explains the underlying score. |
| `SeverityPill` | Insights detail header | Small pill, severity-color fill at 8% alpha + colored 1px border + label. |
| `SeverityDot` | Cluster list rows | 8px filled circle in severity color. Always paired with the cluster title — never alone. |
| `FrequencyBar` | Insights, Build | 60px wide, 4px tall horizontal bar with severity-tinted fill. Number to the right in JetBrains Mono. |
| `SourceIcon` | Evidence library, Insights | Monochrome 16px Lucide glyph per source type. |
| `SegmentTag` | Evidence, Insights | 1px outlined pill with segment name. Tap = filter. |
| `PlanMeter` | Sidebar bottom + paywall surfaces | Full-width 4px bar + "7/10 plan" label in JetBrains Mono. Warm red fill at ≥ 80%, otherwise `--color-text-tertiary` fill on `--color-surface-sunken` track. |
| `ReadinessGrade` | Spec editor sidebar | Letter A/B/C/D + 4-row checklist with ✓ / · glyphs. Letter color = grade (success / warning / danger). |
| `StreamingCursor` | Spec editor, in-doc refinement | Blinking 2px vertical bar after the last token. Mono color (`--color-text-primary`). Respects `prefers-reduced-motion`. |
| `EmptyState` | Every screen | Single-line Lucide glyph at 32px (no illustrations, no blobs) + headline + body + primary action + sample-data secondary. |
| `LoadingSkeleton` | Every list/table | Pulsing type-shaped bars at `--color-surface-sunken`. Never spinners. |
| `StaleBanner` | Insights | Top inline banner: "New evidence — refresh clusters" + Refresh button. Dismissible. |
| `ThinCorpusNudge` | Onboarding, Insights | Non-blocking inline note: "Add ~10 more pieces for stronger clusters." |
| `NumberedStepper` | Onboarding | 1 → 2 → 3 with ✓ on completed, filled-circle on current. JetBrains Mono numerals. |
| `IntegrationLogoButton` | Onboarding, Settings | 1px-outlined button (no shadow) with monochrome logo + one-word label. |
| `FeedbackThumbs` | Insights, Build, Spec | Up/Down icon-buttons with `aria-pressed`. Active = `--color-brand-accent` outline, never filled. |
| `DecisionTick` (new) | Score changes, count increments, cluster stale→fresh | 100ms mono-color pulse on the changed numeric. The product's signature motion. |

## 7. Interaction state matrix

Every screen specifies all 6 states. Missing a cell = implementer defaults to "No items found" + spinner. Not acceptable.

| Screen | Loading | Empty | Partial | Error | Success | Limit-hit |
| ------ | ------- | ----- | ------- | ----- | ------- | --------- |
| Evidence library | Skeleton rows | "No evidence yet" + upload CTA + sample-data fallback | Row shows "Parsing…" chip while embed runs | Row shows danger pill + "Retry" inline | Row appears, fade-in 240ms | PlanMeter goes warm-red; 11th upload blocked with paywall modal linking `/settings/billing` |
| Insights | Skeleton cluster list | "Need ~10 pieces for clusters" + upload CTA | Cluster row shows "Refreshing…" chip | Toast: "Cluster refresh failed — retry" | New cluster fades in from top of list | Pro-only features grey with lock icon + link to `/settings/billing` |
| Build | Skeleton ranked rows | "No opportunities yet — add evidence first" | Re-rank shows ghost positions during drag | Toast: "Scoring failed" + retry | New opportunity slides into rank; ghost of old rank fades 400ms | 2nd opportunity blocked; modal + upgrade CTA |
| Spec editor | `StreamingCursor` active in-doc, Stop button visible | Not applicable (opens on a chosen opportunity) | Refinement turn renders inside the spec as inline marker | Inline danger banner above spec body + "Regenerate" button | Fade from cursor to final content | 2nd spec blocked; modal + upgrade CTA |
| Outcomes (v1.1) | Skeleton chart | "Ship a spec and track its outcome" + link | Predicted shown without actual until measured | "PostHog pairing failed" inline | Actual appears with delta indicator | N/A |

## 8. Responsive posture

Ships **mobile-read, desktop-write**.

| Breakpoint | Width | What works |
| ---------- | ----- | ---------- |
| Mobile | 375–767px | Read-only: browse evidence, read clusters, read/share specs, Stripe checkout, accept share-link view, hit `/settings/billing` to upgrade |
| Tablet | 768–1023px | Graceful collapse to desktop-narrow — all desktop features work |
| Desktop | 1024px+ | Full write experience: upload, integrations setup, weight sliders, spec editor refinement |

Mobile-blocked write actions show "Switch to desktop to [action]" — never a broken form.

## 9. Accessibility baseline

**WCAG 2.2 AA, enforced.**

- Keyboard: every interactive element reachable via Tab; Enter/Space activate; arrow keys for lists; Esc closes overlays.
- Screen readers: semantic HTML first, ARIA only when semantics run out. Landmarks per page (`header`, `nav`, `main`, `complementary`, `footer`).
- Contrast: body ≥ 4.5:1, UI borders ≥ 3:1, non-text indicators ≥ 3:1. Color alone never communicates state.
- Touch targets: 44px minimum (sidebar items meet this via hit-slop even at 32px visual).
- Reduced motion: honor `prefers-reduced-motion` — disable streaming cursor blink, decision tick, any transition over 240ms.
- Focus: visible 2px outline using `--color-brand-accent` with 2px offset.
- Form labels: always visible, never placeholder-as-label.
- Tooling: `eslint-plugin-jsx-a11y` in CI. Storybook `@storybook/addon-a11y`. Manual keyboard audit per screen before ship.

## 10. Motion

Restrained. Motion improves hierarchy, doesn't decorate.

| Role | Duration | Easing | Use |
| ---- | -------- | ------ | --- |
| Micro | 120ms | ease-out | Hover, focus ring, sidebar item highlight |
| Short | 240ms | ease-out | Fade-in on load, toast appearance, drawer open |
| Medium | 400ms | cubic-bezier(0.2, 0.8, 0.2, 1) | Modal open, ghost rank settle |
| Decision tick | 100ms | ease-out | The signature: score/count/state changes pulse once in mono color |

No parallax. No scroll-driven scenes. No autoplay video. No confetti. Respect `prefers-reduced-motion`.

## 11. Iconography

One family: **Lucide**. 16px / 20px / 24px. Stroke 1.5. Monochrome. No icon-in-circle treatments. No color-coded icon sets.

Source-type logos (Zoom, Fireflies, Grain, Zendesk, PostHog, Canny, Notion, Linear) match the same stroke weight and monochrome treatment.

## 12. Copy

- US English locale. "Summarize" not "Summarise".
- Utility over mood. Section headings state what the area does: "Clustered pain points" not "Discover your customer's truth."
- Button copy: verb-first, imperative. "Start free", "Turn into spec", "Add evidence", "Push to Linear". Never "Click here", "Learn more" without context, or "Submit".
- Empty states have warmth + a primary action + context. Never "No items found."
- If deleting 30% of a line still reads, keep deleting.

## 13. Design review checklist (pre-ship, per screen)

Before any screen merges to main:

1. All 6 states designed (loading, empty, partial, error, success, limit-hit).
2. Keyboard nav verified (Tab + Enter/Space + Esc + arrow keys).
3. axe-core zero violations.
4. Contrast verified on body + all semantic states.
5. Mobile layout checked at 375px.
6. No hardcoded hex; all colors via CSS variables.
7. No default font stacks (`system-ui`, Inter, Roboto, Geist, Space Grotesk) as primary.
8. Empty state has warmth, primary action, context.
9. Loading skeleton, never a spinner.
10. Cards earn their existence; lists used where appropriate.
11. Warm red appears at most once persistently on screen.
12. Numerics use JetBrains Mono with tabular-nums.

## 14. Decisions log

| Date | Decision | Rationale |
| ---- | -------- | --------- |
| 2026-04-17 | Initial editorial-serif system created | `/plan-design-review` set Tiempos Headline + Söhne + warm cream + #D04B3F red on dark canvas. |
| 2026-05-11 | Direction change to Industrial / Light / General Sans | `/design-consultation` Phase 3. User picked Linear-discipline + light-default + "AI that does the PM work" thesis. Approved mockup: `~/.gstack/projects/rogation-ai-rogation/designs/redesign-modern-20260511/variant-C.png`. Keeps the warm red brand-accent (#D04B3F) — only personality retained from v0. |
