# Slice 6b — UI foundation: panel-frames + design system + full re-skin

**Status: DESIGN SYSTEM APPROVED by Wes 2026-07-25** (styleguide artifact
`ddb2f26f`, "looks great"). **BUILDING** — unit sequence below; structural-before-
cosmetic, one unit per dispatch, human gate. Decision: `decisions.md` **D47**. Interstitial slice (precedent: `slice-5b-cost-ledger.md`), sequenced
between slice 6 and slice 7 (the task model). **UI-only — no daemon/core change**, so
it ships via the gate with no restart; its exit gate is **human**.

## Why this exists (D47)

Slice 7's new surfaces (authoring form, two-door choice, orchestrator conversation)
reuse shared components — buttons, inputs, modals, the usage gauge. Building those
against the current look then restyling later is building the UI twice (the standing
rule). And the panel-frame spike showed the scroll fix is small and contained. So the
UI foundation lands first, and the task model builds on it.

## Scope

- **Panel-frames** — every openable panel becomes an independent scroll frame.
- **Design system** — the elevated identity, pinned as tokens + shared component styles.
- **Full re-skin** — all 9 views migrated to the tokens.
- **Active usage gauge** — the persistent top-bar instrument (Wes's spec, below).

## Explicitly out

- The task model / dispatcher / MCP surface (that's slice 7 — builds on this).
- Any daemon/core/schema change (rule 0.3 — the core is untouched here).
- Multi-provider work; new product features. This slice changes how the UI *looks and
  scrolls*, not what it *does*.

## The design system (the pinned identity)

Thesis: **VIMES is a precision instrument panel / mission-control readout**, not a
SaaS dashboard — quiet, engineered, high-signal; the usage gauge is the hero.
- **Type:** IBM Plex Mono (headings, uppercase-tracked labels, data, code, terminal) +
  IBM Plex Sans (body/UI). Self-hosted woff2 in the real app (the styleguide inlines
  them as data-URI for CSP).
- **Color:** cool instrument neutrals + **one** instrument-cyan accent
  (`#0891b2` light / `#22d3ee` dark), with **distinct** green/amber/red semantic gauge
  tones. Full token set in `scratchpad/vimes-styleguide-TOKENS.md`.
- **Proposal artifact (sign-off vehicle):** the styleguide — palette, type, and the
  full component gallery incl. the active gauge, both themes. **On Wes's sign-off it
  becomes the pinned system and every view re-skins against it** (this is what makes
  it build-once). Deviations recorded in the TOKENS file (tints via `color-mix`, no
  `*-soft` tokens; Latin1 subsets — add `unicode-range` extensions if needed later).

## The active usage gauge (Wes's spec — first-class data)

- Persistent **top bar**, visible from **every** frame (not just the stream).
- Shows the **BINDING constraint** — whichever limit breaches first — with %, tone,
  reset, and a **pulldown** revealing all constraints (5-hour / weekly / context),
  each with its own meter + reset, plus **burn rate** and projected breach.
- **Two-tier split:** account usage lives in the top bar (always on screen); a
  session's own context/cache stays in the stream frame's strip.
- Wire to the existing `cache-observability` projection / usage endpoints — this is
  wiring existing data, not new plumbing.

## Build order (structural before cosmetic; each kept a separate diff)

1. **Frame mechanics** *(structural, verified-small).* `App.vue` root
   `min-h-screen`→`h-[100dvh] overflow-hidden`; the 9 view roots `min-h-screen`→
   `h-full` (the columns already carry `overflow-y-auto`); StreamView's two
   `window.scrollTo(documentElement…)` + the `shouldStick` read re-pointed to the
   frame's scroll container (pure `shouldStick` untouched); S6 vitals strip becomes the
   frame's fixed head. Mobile: one full-`dvh` frame at a time (panel-stack N=1).
   Desktop sidebar collapse. Land + verify BEFORE any repaint.
2. **Token layer + shared component styles** *(foundation).* The pinned tokens into the
   real app (the `:root` → `prefers-color-scheme` → `[data-theme]` pattern), the theme
   picker + store (tested lib logic), and the shared components (buttons/inputs/pills/
   cards/modal/tabs/meters) styled once.
3. **Active usage gauge** *(component).* Top-bar instrument + pulldown, wired to usage
   data; the two-tier split.
4. **Per-view re-skin sweep** *(cosmetic, incremental — one unit per view/group).* The
   heavy four (TaskBoard, SessionList, CostLedger, GitPanel) then the lighter five.
   Cost chart restyled (faint grid, toned bars, emphasized endpoint).
5. **Non-DOM theme wiring** *(the gotcha unit).* xterm's hardcoded dark-only theme
   object rebuilt from tokens + re-applied reactively on theme change; CodeMirror given
   a theme extension wired to the picker (it has no dark theme today).

## Exit gate (HUMAN) & kill criterion

- **Gate:** Wes clicks through **every view × 2 themes × 3 viewports**; the frame
  behaviours hold (independent scroll, pop-in-at-top, mobile one-frame, sidebar
  collapse); the usage gauge shows the correct binding constraint. `.vue` is not
  unit-tested (house rule) → verification is diff-read + eyeball per view; the theme
  store + gauge derivation are pure `lib/*.ts` and ARE tested.
- **Kill:** if the pinned identity doesn't survive real data density (mono-heavy look
  unreadable at scale, dark-mode contrast failing on a real view) → halt, revisit the
  design system, don't push the sweep through.

## Ties

- Consumes QUEUE **S6** (pinned vitals) + **S7** (panel-frame) + **S4** (stick-to-bottom
  becomes a container scroll).
- **Slice 7 (task model)** builds its UI on this foundation — that's the whole point.
- Frame-shape evidence: `scratchpad/spike-panel-frames-FINDINGS.md`; identity:
  `scratchpad/vimes-styleguide-TOKENS.md`.
