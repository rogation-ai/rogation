# Rogation — Design System

Source of truth for visual + interaction design. All screens, marketing and app, share one voice.

Generated during `/plan-design-review` on 2026-04-17. Revisit after v1 ships or when adding a net-new screen type.

---

## 1. Voice

One typographic voice, one accent color, one product. Marketing (landing) and app surfaces share the same primitives. "YC-flavored, bold primary, minimal" is kept but concretized below.

- Display: editorial serif. Strong presence, tight tracking, generous line-height.
- Body: confident neo-grotesque sans.
- Accent: one warm non-purple color (red/terracotta).
- Tone: serious craft. Short words. No happy talk. No generic SaaS mood.

## 2. Typography

| Role | Family (first choice \| fallback) | Weight | Tracking | Usage |
| ---- | ------------------------------- | ------ | -------- | ----- |
| Display | Tiempos Headline \| Fraunces | 600 | -0.015em | Marketing hero, screen-title H1 |
| Heading | Tiempos Headline \| Fraunces | 500 | -0.01em | H2 (section), H3 (subsection) |
| Body | Söhne \| Inter | 400 | 0 | All body, tables, metadata |
| UI | Söhne \| Inter | 500 | 0 | Buttons, tags, small caps labels |
| Mono | Söhne Mono \| IBM Plex Mono | 400 | 0 | Code, IDs, terminal output |

Type scale (rem, base 16px):

```text
12  0.75    Eyebrow, small caps labels, table meta
14  0.875   Metadata, secondary UI
16  1.00    Body (default)
18  1.125   Body-lead (intro paragraphs)
20  1.25    H4
24  1.50    H3
32  2.00    H2
48  3.00    H1 (section on app)
64  4.00    Display (landing hero)
```

Line-height: 1.5 for body, 1.15 for display, 1.25 for headings.

Body text floor: never below 16px. Contrast floor: 4.5:1.

## 3. Color

One bold non-purple accent. No purple/violet/indigo. No bright blue-to-purple gradients. Editorial cream background on marketing, clean white on app, single shared accent.

```css
/* Brand */
--color-brand-accent:    #D04B3F   /* warm red, primary actions + brand */
--color-brand-accent-ink: #A03027  /* hover / active on accent */

/* Surface */
--color-surface-marketing: #F8F1E6   /* warm cream, landing + auth shells */
--color-surface-app:       #FFFFFF   /* app canvas */
--color-surface-raised:    #FBFAF7   /* raised cards on cream */
--color-surface-sunken:    #F5F2EC   /* sunken panels on cream */
--color-surface-inverse:   #1A1815   /* dark footers, modals */

/* Text */
--color-text-primary:    #1A1815    /* near-black warm */
--color-text-secondary:  #5C5651    /* body secondary */
--color-text-tertiary:   #8A847E    /* metadata */
--color-text-inverse:    #F8F1E6    /* on dark */

/* Border */
--color-border-subtle:   #EAE5DC
--color-border-default:  #D9D3C7
--color-border-strong:   #1A1815

/* Semantic */
--color-success:         #2F7A4F
--color-warning:         #B4701E
--color-danger:          #B93A2E
--color-info:            #4A6B84     /* muted; not for CTAs */

/* Severity scale (insight clusters) */
--color-severity-low:    #8A847E
--color-severity-medium: #B4701E
--color-severity-high:   #B93A2E
--color-severity-critical: #5C1410
```

Rules: no hardcoded hex anywhere in shipped code. Every color goes through CSS variables.

### 3.1 Dark mode

Ships in v1. Paired via `prefers-color-scheme` + explicit toggle in user settings (persisted). All components use semantic token names (never raw colors) so the dark palette is a drop-in.

```css
/* Brand — stays mostly constant */
--color-brand-accent:    #E45D50   /* slightly lifted for dark surfaces */
--color-brand-accent-ink: #FF8274

/* Surface */
--color-surface-marketing: #14120F   /* deep warm near-black */
--color-surface-app:       #0E0D0B   /* app canvas */
--color-surface-raised:    #1E1B17   /* raised cards */
--color-surface-sunken:    #0A0907   /* sunken panels */
--color-surface-inverse:   #F8F1E6   /* inverse (rare) */

/* Text */
--color-text-primary:    #F1ECE2
--color-text-secondary:  #B4ADA2
--color-text-tertiary:   #7A746B
--color-text-inverse:    #1A1815

/* Border */
--color-border-subtle:   #2A2622
--color-border-default:  #3A3530
--color-border-strong:   #F1ECE2

/* Semantic (boosted for dark contrast) */
--color-success:         #4FA874
--color-warning:         #D89045
--color-danger:          #E56758
--color-info:            #8FB5CF

/* Severity */
--color-severity-low:    #7A746B
--color-severity-medium: #D89045
--color-severity-high:   #E56758
--color-severity-critical: #FF8274
```

Dark-mode storybook stories required per component. Contrast requirements (AA) apply to both modes.

## 4. Spacing

4px base. Use multiples.

```css
space-1   4px
space-2   8px
space-3   12px
space-4   16px
space-6   24px
space-8   32px
space-12  48px
space-16  64px
space-24  96px
space-32  128px
```

Gutter between sections: `space-16` desktop, `space-12` mobile.
Padding inside cards/panels: `space-6`.
Form field vertical rhythm: `space-4`.

## 5. Radius + elevation

```css
--radius-sm:  4px    /* inputs, tags */
--radius-md:  8px    /* buttons, cards */
--radius-lg:  12px   /* modals, large cards */
--radius-xl:  24px   /* marketing hero panels */
```

Elevation: use borders + background contrast instead of shadows. The litmus rule: "would the design feel premium with all decorative shadows removed?" must be yes. One permitted shadow: modal overlay (`0 24px 48px -16px rgba(26,24,21,0.22)`).

## 6. Component inventory

Shared primitives that recur across screens. Each gets a storybook story + visual spec before wk 1 implementation.

| Primitive | Where used | Anatomy |
| --------- | ---------- | ------- |
| `CitationChip` | Insights, Spec editor | Inline superscript numeral. Hover: popover with source quote (80-char preview), segment, date, "View evidence →" link. Click on mobile = popover. |
| `ConfidenceBadge` | What to build, Insights | Pill with label (Low / Medium / High) + colored dot + optional tooltip explaining the underlying score. |
| `SeverityPill` | Insights, Evidence library | Small pill using `--color-severity-*`. Labels: Low / Medium / High / Critical. |
| `FrequencyBar` | Insights, What to build | Single horizontal 3-stop indicator. No chart. Plain number next to it. |
| `SourceIcon` | Evidence library, Insights | Monochrome 16px glyph per source type (Zoom, Fireflies, Grain, Zendesk, PostHog, Canny, Text, PDF, CSV). |
| `SegmentTag` | Evidence, Insights, quotes | Small outlined pill with segment name. Tap = filter by segment. |
| `PlanMeter` | Every gated surface | Inline "Evidence 7/10" with `--color-warning` at 80%, `--color-danger` at 100%, with upgrade CTA. |
| `ReadinessGrade` | Spec editor | Large letter A/B/C/D + subtext checklist + LLM notes collapsible. Letter uses `--color-success` (A), warning (B), danger (C/D). |
| `StreamingCursor` | Spec editor, Insights | Blinking vertical bar after the last token. Stop button visible while streaming. |
| `EmptyState` | Every screen | Warm illustration (single line-art, no 3D, no blobs) + headline + primary action + "sample data" secondary. |
| `LoadingSkeleton` | Every list/table | Pulsing type-shaped bars using `--color-surface-sunken`. Not spinners. |
| `StaleBanner` | Insights | Top toast: "New evidence added — refresh clusters to include" + Refresh button. Dismissible. |
| `ThinCorpusNudge` | Onboarding upload, Insights (dismissible toast) | Non-blocking toast: "Add ~10 more pieces for stronger clusters" + upload CTA. |
| `FirstSpecMoment` | Post-first-export | Success screen: the spec + "Share with your team" CTA + subtle confetti + tip teaser. |
| `NumberedStepper` | Onboarding | 1 → 2 → 3 with check marks on completed steps. Filled circle on current. |
| `IntegrationLogoButton` | Onboarding, Settings | Outlined button (no shadow) with monochrome logo + one-word label. Not a card. |

## 7. Interaction state matrix

Every screen specifies behavior for every state. Missing a cell = implementer defaults to "No items found" + spinner. Not acceptable.

| Screen | Loading | Empty | Partial | Error | Success | Limit-hit |
| ------ | ------- | ----- | ------- | ----- | ------- | --------- |
| Evidence library | Skeleton rows + source-type filter chips visible | "No evidence yet" + upload CTA + sample-data fallback | Row shows "Parsing…" status chip while embed runs | Row shows `SeverityPill danger` + "Retry" button inline | Row appears, fade-in 240ms | `PlanMeter` in warning then danger; 11th upload blocked with modal |
| Insights | Skeleton cluster list | "Need ~10 pieces for clusters" + upload CTA | Cluster card shows "Refreshing…" chip during re-cluster | Toast: "Cluster refresh failed — retry" | New cluster fades in from top of rail | Pro-only features grey with lock icon + CTA |
| What to build | Skeleton ranked rows | "No opportunities yet — add evidence first" + link | Re-rank shows ghost positions during drag | Toast: "Scoring failed" + retry | New opportunity slides into rank; ghost of old rank fades 400ms | 2nd opportunity blocked; modal with export preview |
| Spec editor | `StreamingCursor` active; Stop button visible | Not applicable (opens on a chosen opportunity) | Chat message shows typing indicator during refinement | Inline error above spec body + "Regenerate" button | Fade from cursor to final content | 2nd spec blocked; modal with export preview |
| Outcomes | Skeleton chart | "Ship a spec and track its outcome" + link to What to build | Shows predicted without actual until measured | PostHog pairing failed: inline warning + "Pair manually" | Actual appears with delta indicator | N/A (not gated) |

## 8. Responsive posture

v1 ships **mobile-read, desktop-write**.

| Breakpoint | Width | What works |
| ---------- | ----- | ---------- |
| Mobile | 375–767px | Read-only: browse evidence, read clusters, read/share specs, Stripe checkout, accept share-link view |
| Tablet | 768–1023px | Graceful collapse to desktop-narrow — all desktop features work |
| Desktop | 1024px+ | Full write experience: upload, integrations setup, weight sliders, spec editor refinement |

Mobile-blocked write actions show a clear "Switch to desktop to [action]" message. No broken forms.

## 9. Accessibility baseline

**WCAG 2.2 AA, enforced.** No partial commitment.

- Keyboard: every interactive element reachable via Tab order matching visual order; Enter/Space activate; arrow keys for lists; Esc closes modals.
- Screen readers: semantic HTML first, ARIA only when semantics run out. Landmarks on every page (`header`, `nav`, `main`, `complementary`, `footer`).
- Contrast: body text ≥ 4.5:1. UI borders ≥ 3:1. Non-text indicators ≥ 3:1. Color alone never communicates state (always paired with icon or label).
- Touch targets: 44px minimum, including hit slop.
- Reduced motion: honor `prefers-reduced-motion` — disable confetti, streaming cursor blink, ghost rank transitions.
- Focus: visible 2px outline using `--color-brand-accent` with 4px offset.
- Form labels: always visible, never placeholder-as-label.
- Link states: visited links get `--color-text-secondary` so returning users don't re-click.
- Tooling: `eslint-plugin-jsx-a11y` in CI. Storybook `@storybook/addon-a11y`. Manual keyboard audit per screen before ship.

## 10. Motion

Restrained. Motion improves hierarchy, doesn't decorate.

| Role | Duration | Easing | Use |
| ---- | -------- | ------ | --- |
| Micro | 120ms | ease-out | Hover, focus ring |
| Short | 240ms | ease-out | Fade-in on load, toast appearance |
| Medium | 400ms | cubic-bezier(0.2, 0.8, 0.2, 1) | Ghost rank fade, modal open |
| Long | 600ms | same | First-spec confetti, page transitions |

No parallax. No carousels. No autoplay video. Respect `prefers-reduced-motion`.

## 11. Iconography

One family: Lucide. 16px / 20px / 24px. Stroke 1.5. Monochrome. No icon-in-circle treatments. No color-coded icon sets.

Logo set (source icons) gets the same stroke weight, monochrome.

## 12. Copy

- US English locale everywhere. "Summarize" not "Summarise".
- Utility over mood. Section headings state what the area does: "Clustered pain points" not "Discover your customer's truth."
- Button copy: verb-first, imperative. "Start free", "Turn into spec", "Add evidence", "Export to Linear". Never "Click here", "Learn more" without context, or "Submit".
- If deleting 30% of a line still makes sense, keep deleting.

## 13. Design review checklist (pre-ship, per screen)

Before any screen merges to main:

1. All 6 states designed (loading, empty, partial, error, success, limit-hit).
2. Keyboard nav verified (Tab + Enter/Space + Esc + arrow keys where relevant).
3. axe-core zero violations.
4. Contrast verified on body + all semantic states.
5. Mobile layout checked at 375px.
6. No hardcoded hex; all colors via CSS variables.
7. No default font stacks.
8. Empty state has warmth, primary action, context — not "No items found."
9. Loading skeleton, not spinner.
10. Cards earn their existence; lists used where appropriate.
