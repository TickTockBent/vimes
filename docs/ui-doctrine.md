# UI doctrine — the visual + interaction constitution for agent-built UI

**Status: SIGNED, Wes 2026-08-13 (approved same day as authored, including the
four flagged judgment calls). Binding citation for every UI work order.**
Ratified as a prerequisite 2026-07-29 (AoE carry-over: required *before the
next substantial agent-built UI unit*); authored now because the tree UI slice
is next and its work orders must cite this.

**What this is:** a work-order input. Every UI work order cites this doc the
way core work orders cite `design-principles.md`. Its job is to keep N agents
from inventing N visual languages. It is not a style guide (no component
gallery, no pixel specs) — it is the set of calls an agent must not re-make.

**What this is NOT:** a substitute for the slice's own skeleton. Scope, data
shapes, and assertions stay in the work order; this doc is the standing layer
underneath them.

**Source-of-record note (#9):** the signed styleguide's token file
(`scratchpad/vimes-styleguide-TOKENS.md`, artifact `ddb2f26f`, signed with
slice 6b) no longer exists on disk — scratchpad is ephemeral and ate it. The
live tokens survive in `packages/ui/src/style.css`; **this doc is now the
durable record of the system those tokens implement.** Where the two disagree,
`style.css` is the shipped truth and the disagreement is a finding.

---

## §1. The identity thesis

**VIMES is a precision instrument panel / mission-control readout** — quiet,
engineered, high-signal. It is not a SaaS dashboard, not a chat app, not a
VSCode clone. The operator is reviewing and steering agents, usually with
partial attention, sometimes from a phone; every pixel is judged by whether it
helps them decide the next action faster.

The usage gauge is the worked example of the identity: the most important
number (the binding constraint) is a persistent instrument, not a settings
page. When in doubt, ask "what would the flight-deck version of this surface
show?" — a readout with the decisive number large and the context dense and
quiet, not a card grid with headroom.

## §2. Doctrine (numbered; U-prefixed to keep them distinct from design-principles #N)

- **U1 — Real estate to content, not chrome.** *(design-principles #11,
  verbatim territory.)* No file rails, tab strips, or panel furniture
  competing with the content. The terminal, the diff, the stream, the tree get
  the pixels. This is why VIMES beat code-server on a phone; it governs the
  desktop too — the multi-pane desktop view earns its panes by showing
  content, never by mimicking IDE furniture.

- **U2 — Density over chrome.** Density is respect for the operator's time:
  more decisions per screenful beats more whitespace per widget. The mono-
  heavy, small-type instrument look is a deliberate consequence. The check is
  legibility under REAL data density (slice 6b's kill criterion), never
  "does it look busy" on a screenshot with three rows.

- **U3 — Mobile is for DECIDING.** *(Pillar 5; the deliberate divergence from
  AoE, verbatim-worthy:)* **their "mobile is monitoring" versus VIMES's
  "mobile is for deciding."** A phone surface that only lets the operator
  *watch* has failed even if it renders beautifully. Every attention item must
  be decidable from its own card — answer, approve, dismiss, or deliberately
  defer — without drilling into a workspace first *(D-face queue refinement,
  2026-08-11)*. The phone shows one full-height frame at a time; the frame it
  shows must be actionable.

- **U4 — Engine chrome speaks engine vocabulary only.** *(#16/#17 at the
  face.)* Engine-owned surfaces render engine nouns: sessions, nodes,
  projects, gates, questions, attention, liveness. Workflow vocabulary —
  task, stage, review, chapter — reaches the UI **only** as `[[overlays]]`
  decorations and extension-contributed panes, and renders as decoration,
  never as a value in engine chrome. The canonical failing example: `review`
  drawn as a session state (TUI mockup, Conflict 2) — a session is running or
  it is not; "in review" is a property of the work. If a UI unit needs a word
  the engine's source may not contain (#16's grep), that word belongs to an
  extension surface.

- **U5 — Seen never reads as handled.** *(D83; D9 survives presentation.)*
  Rendering, glancing at, or scrolling past an attention item must not style
  it as resolved. Attention clears only by deliberate action. No auto-
  dismissing toasts for things that matter, no "mark all read" affordance on
  attention state, no unread-badge that zeroes on view.

- **U6 — One accent; semantic tones are not accents.** The instrument cyan
  (`--accent`) is the only accent, and it means *interactive or highlighted* —
  never state. State speaks through the gauge tones `--ok` / `--warn` /
  `--crit`, which are semantic and never decorative. A view that wants a
  second accent color is wrong; a view using `--crit` for emphasis on a
  non-critical thing is wrong in a worse way.

- **U7 — Never color-only state.** Every state distinction carries a second
  channel — a glyph, a label, a shape (the mockups' `*`/`!` activity glyphs
  are the pattern). This is accessibility, and it is also the instrument
  identity: readouts label their needles.

- **U8 — The UI derives nothing the daemon serves.** *(0.3 at the face.)*
  Severity, tree shape, short ids, rollups, attention — computed in core,
  served by the daemon, rendered by the client. A UI unit that re-derives a
  served fact client-side ("just a little sort", "just re-slice the id") is
  creating a second source of record and will drift. Corollary from S14-F1:
  short ids come from the estate-scoped `shortSessionIds`/`resolveShortSessionId`
  pair — never an ad-hoc `slice(0, n)`, because same-spelling derivations are
  not same-fact.

- **U9 — Live surfaces are pushed, not polled.** A home surface that only
  polls feels dead (ui-face-pass §2). Views subscribe to the WS stream and
  render deltas; polling is a fallback for degraded connections, not a design.
  The 502-resilience and hello-handshake machinery exist so that a UI unit
  never has to invent its own liveness story.

- **U10 — Escape hatches stay visible.** *(Pillar 7.)* Every structured
  surface keeps its raw sibling reachable: the PTY terminal beside the stream,
  raw JSON beside the rendered view where it matters. Polish must not wall off
  the hatch.

- **U11 — Permission footing renders honestly.** *(Conflict 4, ruled
  2026-07-24.)* Human-created sessions rest in Default; escalation is a
  deliberate, visible act. No surface may depict or default to
  bypass-permissions as the resting state.

## §3. Tokens (the pinned palette — source of record)

Twelve runtime tokens, defined in `packages/ui/src/style.css` as CSS custom
properties, minted as Tailwind utilities via `@theme inline` (`bg-panel`,
`text-ink`, `border-line`, …). **Views use the utilities, never raw hexes and
never the var() directly** (except non-DOM consumers, §7).

| Token | Role | Light | Dark |
|---|---|---|---|
| `ground` | page background | `#f7f8fa` | `#0a0e14` |
| `panel` | raised surface | `#ffffff` | `#10151d` |
| `panel-sunken` | recessed surface (wells, inputs) | `#eef1f5` | `#0d131b` |
| `ink` | primary text | `#0d1117` | `#e6edf3` |
| `ink-dim` | secondary text, labels | `#5b6673` | `#8b98a8` |
| `line` | borders, dividers | `#e3e7ec` | `#1c2530` |
| `accent` | interactive/highlight (the ONLY accent) | `#0891b2` | `#22d3ee` |
| `accent-fg` | text ON accent fills | `#ffffff` | `#04121c` |
| `track` | meter/gauge track | `#e3e7ec` | `#1c2530` |
| `ok` | semantic: healthy | `#16a34a` | `#22c55e` |
| `warn` | semantic: degraded | `#d97706` | `#f59e0b` |
| `crit` | semantic: critical | `#dc2626` | `#f87171` |

Signed deviations carried from the styleguide record: **tints via
`color-mix()`, no `*-soft` token variants**; fonts are self-hosted woff2,
Latin1 subsets (extend `unicode-range` if ever needed).

**Severity mapping for the tree era** (binds the tree UI to §3b of slice 14):
`working` → accent-family/activity treatment, `waiting_input` → `warn`,
`gate_fired` → its own loud treatment at warn-or-above prominence, `error` →
`crit`, `idle` → `ink-dim`. Exact glyphs are the tree slice's call; the tone
assignments are not.

## §4. Type

Two faces, strict roles:

- **IBM Plex Mono** — headings, uppercase labels, data, ids, numerals, code,
  terminal. The instrument voice. (Headings default to mono globally in
  `style.css`.)
- **IBM Plex Sans** — running prose and UI copy. The body voice.

The de facto scale, pinned as-built (census 2026-08-13 across all views):

| Step | Use |
|---|---|
| `text-sm` (14px) | the working size — body, controls, list rows |
| `text-xs` (12px) | dense data, metadata rows, table cells |
| `text-[11px]` / `text-[10px]` | micro-labels: uppercase mono section/field labels |
| `text-lg` | section headings |
| `text-base` | sparingly — prose-heavy panels only |
| `text-3xl` | reserved: hero numerals (the gauge class of readout) |

Rules: uppercase micro-labels are **mono + uppercase, no added tracking** —
the styleguide said "uppercase-tracked," the built views dropped the tracking
uniformly, and as-built wins (flagged at sign-off; if Wes wants tracking back
it's a one-token sweep, not a doctrine change). Aligned digit columns get
`tabular-nums`. New views introduce no new arbitrary sizes without a work-order
reason.

## §5. What we avoid (the explicit list)

- **IDE furniture** — file rails, tab strips, breadcrumb bars, minimaps (U1).
- **SaaS dashboard idioms** — card grids with drop-shadow depth, gradient
  heroes, marketing whitespace, illustration/empty-state mascots.
- **A second accent**, or accent-as-state / semantic-tone-as-emphasis (U6).
- **Color-only state** (U7).
- **Emoji as UI glyphs** in engine chrome — glyphs are typographic
  (`* ! ✓ ◐` class), not emoji.
- **Tenant vocabulary in engine chrome** (U4).
- **Auto-clearing attention** — toasts, glance-clears-badge (U5).
- **Client-side re-derivation** of served facts, including ad-hoc short ids
  (U8).
- **Polling-first liveness** on primary surfaces (U9).
- **Bypass-permissions as depicted resting state** (U11).
- **Spinners where a fact could show** — prefer the last-known value with a
  staleness treatment over a spinner that erases the readout.

## §6. Layout & frames

- **Panel-frame discipline** (slice 6b): every openable panel is an
  independent scroll frame; the app root is `h-[100dvh] overflow-hidden`;
  frames scroll internally. The page body NEVER scrolls horizontally.
- **Mobile:** one full-`dvh` frame at a time (panel-stack N=1). The frame
  shown must be decidable (U3). The keyboard-safe footer mechanism
  (`--keyboard-offset`) exists — use it for any bottom-anchored input.
- **Desktop:** sidebar collapse exists; panes earn their place with content
  (U1). Pane placement (`main`/`context`/`sidebar`/`overlay`) is the
  `[[panes]]` vocabulary; `main`-slot cardinality is engine-enforced with
  operator resolution (D75⇄D77) — the client honors placement, it does not
  invent a second placement scheme.
- **Wide content** (tables, diffs, code) scrolls inside its own
  `overflow-x-auto` container.

## §7. Theming mechanics (binding — this is where agents break things)

- The four-way pattern in `style.css` is load-bearing and must not be
  simplified: light on bare `:root` → OS-dark **only** under
  `:root:not([data-theme])` → explicit `[data-theme="light"|"dark"]` wins in
  both directions. Explicit-theme blocks are deliberately NOT `:root`-scoped
  so a **subtree** may pin its own theme (TerminalView is always-dark by
  design).
- The `dark:` custom variant mirrors the same two branches exactly. Style
  through tokens; never hang a color rule directly inside the media query.
- **Non-DOM theme consumers are the standing gotcha:** xterm's theme object
  and CodeMirror's theme extension don't read CSS variables — they are rebuilt
  from tokens and re-applied reactively on theme change. Any new canvas/
  WebGL/third-party-widget surface must budget the same wiring or it will
  ship single-theme by accident.
- Both themes get equal care. The gate for any visual unit is both themes ×
  three viewports, on real data.

## §8. Citation & gate rule

Every UI work order cites this doc by name and lists which U-numbers its unit
touches. The orchestrator's gate checks the diff against them. Process gates
(vue-tsc for `.vue` units, the sw.ts vite-build hole) live in `CLAUDE.md` and
apply on top.

---

*Sign-off note (2026-08-13): everything above is transcription from signed
sources (design-principles, slice-6b, ui-face-pass, the D-face queue,
style.css as shipped) except: the U-numbering itself, the §3 severity→tone
mapping, the §4 as-built no-tracking pin, and the §5 spinner/emoji lines —
those four are orchestrator judgment awaiting Wes's yes.*
