# v2 mockup extraction notes (2026-08-11, structural read of both v2 JSXs)

Condensed inventory from the full-source read that fed `ui-face-pass.md` §7.
The JSXs are the authority; this is the navigable index of what they depict.
Conflicts/decisions already distilled: pass §7 + D74–D83. This file exists so
the doctrine doc and the tree-slice skeleton don't need a re-read of ~50KB of
JSX to know what data the drawings assume.

## Shared skeleton (both clients)

Left: session tree with a usage-window block pinned ABOVE it. Center:
transcript with per-turn metadata + structured diffs, input bar below. Right:
switchable context pane. Bottom: dense persistent status line. Fixed chrome
top (title/header) and bottom; only the tree, transcript, and context pane
scroll, independently.

## Data the drawings assume exists (the build-relevant list)

- **Usage block (both):** 5h-window countdown ("3h 12m left"), % used,
  running count, 7-day %. TUI adds **queued count** (→ D82's `queued`) and
  renders `█░` blocks; web renders a two-segment bar (sub-tier split).
- **Tree (web):** recursive workspace → group → subgroup → session; leaf
  status `active|idle|running|error` + optional manual color tag; running
  pulses. **Tree (TUI):** flat array, `kind: repo|dir|s`, five states
  `run|wait|review|fail|idle` with glyphs `● ◐ ◆ ✗ ○` — `review` is an
  overlay wearing a state costume (settled: D82/#17); `wait` → engine
  `queued`. TUI shows a **4-char short id on every row** (→ D79 derived).
- **Transcript meta (both):** CLI version, model + context size, effort,
  cwd. Web adds plan tier ("Claude Max"); TUI adds `channel=sdk`, inline
  window-remaining + event count, and **per-turn `8.2k in / 1.1k out`**
  (→ D80: desk surfaces only). Diffs: TUI carries the file path line; web
  draws the diff pathless.
- **Right pane (web):** Files (git-status letter badges per file) /
  Extensions (name, description, toggle; "Browse the extension library"
  affordance) / Info (event count, tunnel, "VIMES is building VIMES" badge)
  / Git (branch, staged). **Right pane (TUI):** files / extensions
  (`[x] name ver` + note, `:ext install|search` hints — post-D67-reopening
  functionality, drawn not built) / **tasks** (kanban counts + per-task
  `plan ✓ · implement ✓ · review ◐` checklist — web has NO task surface;
  settled as correct under D70, board = tasks-extension pane, D75/D77).
- **Status line (web):** session count + provider, branch, Perms, Notify,
  "✓ 1 Viewed" (→ D83, seen≠handled), "Background 1/16". **(TUI):**
  NORMAL/INSERT mode badge, branch, `perms · notify · bypass · spine:sqlite
  ok` (a live spine health check — web lacks it), bg ratio + cursor
  position. TUI header adds aggregate `22 sessions · 4 running · 3 fail`
  (web surfaces no fail count anywhere — D80 says aggregate counts go
  everywhere).
- **Window strips:** web = closable tabs + "+"; TUI = tmux windows with
  activity `*` / alert `!` suffix glyphs and `[vimes] tunnel↑`.

## TUI grammar (wired + aspirational)

Wired in the mock: `j/k`/arrows move (skips non-leaf rows), `1/2/3` context
pane, `i` INSERT, `Esc` NORMAL, click-to-cursor. Hinted only: `↵` attach,
`^b` tmux-style prefix layer, `:` command line, `?` help. Colon commands
shown in copy: `:promote review`, `:ext install <name>`, `:ext search
registry`. Web keyboard story is thin: "shift+tab cycles permissions"
(drawn as bypass-on — flagged, conflicts with the settled Default footing)
and "← for agents".

## Implied capabilities without a current backend (beyond the tree API)

Seen/unread read model (D83 — `seen` events exist, read model doesn't);
dispatch queue + queued count (D82); short ids (D79 — derivation, cheap);
extension install/registry (D67 reopening — drawn, deliberately not built);
per-file git-status in the file tree; spine health check in chrome; a
separate web "agents" section (breadcrumb `terminal / agents` — unexplored,
nobody has defined what it is); "breakout" extension in the TUI list
("tmux-style branching", v0.5.0 — name appears nowhere else in the repo).

## Loose observations

- `vmx` is the prompt handle in BOTH clients ("Message vmx…") — mild
  evidence the parked name has won.
- Web title bar duplicates a PanelRight icon (mock artifact, not intent).
- TUI depth handling is inconsistent between repos in the mock data
  (ml-pipeline/infra sessions skip the dir level) — illustrative variance,
  but a reminder D74's middle layer is OPTIONAL per node, not mandatory.
