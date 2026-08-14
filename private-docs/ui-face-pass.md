# The D70 face — design pass

**Status: OPEN, 2026-08-11. Orchestrator-authored framing; awaiting Wes.**
This is the design pass that precedes the UI era. It produces three things: a
signed home-surface decision, the **UI doctrine doc** (a stated prerequisite,
still unwritten), and a dispatchable slice order. It builds nothing.

> **Read §1 first.** Two design entries in this repo name two DIFFERENT home
> surfaces, both written as settled, thirteen days apart. Everything else in
> the pass is downstream of which one wins.

---

## §1. THE CENTRAL CONFLICT — two home surfaces, both "settled"

**Entry A — "the board IS the sidebar" (design-directions, Wes 2026-07-23).**
The left sidebar becomes the vertical kanban; the right panels become the work
(orchestration chat, the session running a card, task-creation, breakouts,
terminals). Sessions **demote to a work panel opened from a card**. Its own
closing line: *"Do not swap the sidebar to the board until the board's role as
home is deliberately decided — it is the 'sessions should not be the landing
page' call, finally actionable, and it is Wes's to make."*

**Entry B — "the session tree is the home surface" (the v2 mockups, Wes
2026-08-05, listed as settled-by-discussion item #1).** Repo → user-defined
grouping → sessions named by intent, with live status glyphs. Stated
explicitly: *"the tree of work replaces both today's session list **and the
board** as the landing surface."*

**These are not compatible, and the difference is not cosmetic.** A kanban home
organises work by **stage** — the axis is *what needs attention next*, and it is
the shape of the verification loop. A tree home organises work by **place** —
the axis is *where in the codebase this lives*, and it is the shape of the
session estate. They imply different answers to "what do I look at first," and
they imply different secondary surfaces: a board home makes the tree a
navigator; a tree home makes the board a filter or a pane.

## §1-RESOLVED (2026-08-11) — not a conflict; Entry A is pre-D70 and superseded

**Wes, 2026-08-11:** *"It's now becoming a session management engine with
exposed surfaces for extensions, rather than being a bespoke orchestration
engine… the task management portion will become an extension, and it will also
allow other workflow extensions such as my book genesis workflow."*

**That is D70, signed 2026-08-05** — "VIMES is a pure session engine; all
workflow is extension content… the engine makes **zero assumptions about how
people work**." Entry A predates it by thirteen days and belongs to the
bespoke-orchestration era. **There was never a live disagreement to settle; the
pass found a stale entry and mistook it for an open question.** Recorded plainly
because the same mistake is cheap to repeat: `design-directions.md` is a living
doc of planned and parked systems, and an entry in it can be quietly outlived by
a decision without anyone editing it.

**The tree wins for a stronger reason than "it is newer."** A kanban home would
be **the engine holding a tenant's shape at the most visible surface in the
product.** Book Genesis has no backlog, no review gate, no promotion — it has
chapters. A board landing surface would encode one tenant's workflow as the
engine's idea of what work looks like, which is precisely what D70 forbids and
what principle #16 makes grep-assertable. The tree is the only home structure
that is tenant-blind: repo → grouping → sessions and nodes, which is engine
vocabulary (E2) and nothing else.

**And the mitigation I was about to propose already exists, signed.**
`extension-model.md` §2.5 defines `[[overlays]]` — *"extension state painted on
engine objects… the engine object knows nothing about tasks. An overlay is a
declared, closed decoration — the engine stores and fans it out, and never
interprets it."* `migration-map.md` already maps the mockups' stage glyph to it
verbatim: `target = "session"`, `type = "enum"`, declared attention rank, with
the worked example `session.overlays["ext.vimes-tasks.stage"] = { value:
"review", attention: … }`. So "the tree shows workflow state without the engine
knowing what a stage is" is not a design question — it is a built-out slot
waiting for its first producer.

**What remains genuinely open** is not the home surface but its consequences,
which move to §5 and §7: what the board *becomes* (an extension-contributed
pane), how prominent an enabled extension's surfaces are allowed to be, and
whether the tree can render instances of a workflow nobody has written yet.

## §2. The dependency that sets the build order

**The tree home surface has no API.** E2's node store is projected in core
(`projections/nodes.ts`, `nodeRollup.ts`) but the daemon serves **nothing** —
no `/api/nodes`, no `/api/tree` (verified 2026-08-11). So the mockups' item #1
cannot be built by any UI agent today.

**Consequence: the first BUILD after this pass is a daemon slice, not a UI
slice** — serve the tree (read model + routes + the WS delta shape, since a home
surface that only polls will feel dead). Any plan that opens with UI work is
planning against a surface that does not exist.

## §3. The finding that reframes slice 13

The AoE carry-over (ratified 2026-07-29) is standing input for every board and
redesign unit: **the differentiators go on screen first** — provenance chips
(orchestrator-authored vs hand-made), per-criterion verdict state, **attempt/
bounce history**, and the work-order as the card's face. Its argument: *"if the
board reads as a nicer session list, VIMES gets compared to AoE as a session
list — and loses."*

**Those differentiators are precisely the fields the legacy view hides.**
`legacyTasksViewOf` deliberately drops `nodeHistory`, `edgeTraversalCounts`,
`attemptsPerNode` and `workflow` — i.e. bounce history, attempt counts, and
provenance. So the UI **cannot render its own differentiator today**, and the
reason is the alias, not the design.

**Therefore slice 13 is not merely plumbing — it is the prerequisite for the
differentiation strategy**, and its §2 "explicitly out" (do not surface the four
unlocked fields in slice 13) is the right call precisely because those fields
deserve a designed home in this pass rather than an improvised column.

## §4. The prerequisite deliverable — the UI doctrine doc

**WRITTEN 2026-08-13 → `ui-doctrine.md` (orchestrator-authored, awaiting Wes's
sign-off).** Ratified 2026-07-29 as required *before the next substantial
agent-built UI unit*. Under this era's plan the UI is largely agent-built, so
it is the thing that keeps N agents from inventing N visual languages. It is a
**work-order input**, cited in every UI WO the way `design-principles.md` is
cited in core WOs — not a style guide.

Contents, already specified across the entries: numbered principles (including
*"real estate to content, not chrome"* and *"density over chrome"*), the type
scale, the named tokens already in use (`ink` / `panel` / `line` / `accent` /
`warn`), an explicit **"what we avoid"** list, and — verbatim-worthy — the
divergence from AoE: **their "mobile is monitoring" versus VIMES's "mobile is
for DECIDING"** (pillar 5). That sentence is what stops a UI agent optimising
the phone for watching.

## §5. The other calls this pass must land

- **Subprojects** (raw, mockups). The tree's middle layer: a label, or a
  directory-scoped entity that carries its own context/rules/docs/workflow?
  Interacts with per-project extension loading, D21 roots, and worktree nodes
  (is a worktree child a subproject?). Engine-vs-extension placement undecided.
  **This is the largest raw item and it shapes the tree's data model** — it
  cannot be deferred past the daemon slice in §2.
- **How prominent may an ENABLED extension's surfaces be?** *(Relocated here
  from §7 Conflict 1 when D70 dissolved it.)* The engine's home is tenant-blind
  by design, but the AoE strategic input still binds: if the verification loop
  is invisible, VIMES is compared to a session manager and loses. Under D70 the
  question sharpens into something answerable: **when the tasks extension is
  enabled, do its contributed surfaces get first-class placement** (a pane
  `placement` the extension declares and the client honours, up to and including
  the primary slot) **or are extension surfaces structurally secondary chrome?**
  The `[[panes]]` `placement` field (`main` / `context` / `sidebar` / `overlay`)
  already exists — so this is a question about what the client is *obliged* to
  honour, not about inventing a mechanism. It is the difference between "VIMES
  ships with a great task extension" and "VIMES has a task tab."
- **Can the tree render a workflow nobody has written yet?** The real test of
  D70 at the UI layer. A tree node belonging to a Book Genesis `chapter`
  instance, with an extension VIMES did not design, must render legibly using
  only overlays + declared node kinds. If rendering it requires the client to
  know the workflow, the carve-out test has failed at the face — and that is
  worth an explicit assertion in the tree slice, not an assumption.
- **vmx** (raw). TUI binary name / resident agent short name. Naming only;
  parkable without blocking anything.
- **What becomes of the board** under the §1 answer — pane, filtered tree view,
  or retained surface. Downstream of §1, but it decides whether `TaskBoardView`
  survives slice 13's shape migration or is rewritten.
- **The phone's degenerate case.** The panel entry's premise is that the phone
  attends to exactly one thing and the desktop's value is *simultaneity*. A tree
  home on a phone is a navigator, not a workspace — confirm the phone lands
  somewhere useful rather than on a tree it must immediately drill out of.
- **The companion panel's delivery etiquette** — *"inject at turn boundaries?
  queue until the current tool round drains?"* **This is the same question as
  jcode's cache-safe admission timing** (ratified 2026-08-11, folding into the
  sessionguard/InputLease skeleton). One answer should serve briefings, the
  companion's injected notes, and human writes into a running session; three
  answers would be three etiquettes for one choke point.

## §5-RESOLVED (2026-08-11) — the D70-face queue settled live

Every open call in §5/§7 was queued as **D74–D83**, walked live with Wes the
same day, and decided — full dated records in `decisions.md`, pointer stubs in
`open-questions.md`, and D82's rationale promoted to **design-principles #17**
("engine session states describe the PROCESS; overlays describe the WORK").
The refinements that bind the coming builds: subprojects are NODES (worktree ≠
subproject); `main`-slot cardinality is engine-enforced with operator
resolution (D75⇄D77 coupled — the board-as-pane is D75's first live test); the
D76 synthetic tenant must be deliberately alien and the face carve-out is a
bundle GREP; the phone's attention items must each be decidable from their own
card; short ids are derived prefixes, not issued; economics split by kind, not
client; the input choke point keeps lease and admission separable with queued
writes visible; seen never reads as handled (D9 survives presentation).

## §6. Proposed pass order

1. **Wes answers §1** (home surface) — everything else is downstream.
2. Orchestrator writes the **UI doctrine doc** (§4) — independent of §1, can
   start immediately.
3. **Subprojects decision** (§5) — required before the tree's data model.
4. Orchestrator writes the **daemon slice skeleton** (§2, serve the tree).
5. UI slices follow, each citing the doctrine doc.

---

## §7. What the mockups actually depict — and six conflicts

*(Source extraction 2026-08-11, both v2 mockups read in full. The mockups are
concept art: the skeleton is intent, labels are illustrative. What follows is
the part that needs a decision, not the inventory — the drawings are on disk and
cheap to re-read.)*

**Shared skeleton, and it is genuinely one architecture.** Both clients draw:
a session tree on the left with a usage-window block pinned above it, a
transcript in the centre with per-turn model/version/effort/cwd metadata and
inline structured diffs, a switchable context pane on the right, and a dense
persistent status line. Item #2 of the settled list ("same information
architecture, per-client grammar") is real in the drawings, not aspirational.
The TUI adds a modal NORMAL/INSERT grammar, a tmux window strip with
per-window activity (`*`) and alert (`!`) glyphs, a `:` command line, and a
permanent keybind legend.

**⚠ Conflicts 1 and 2 are RETRACTED (2026-08-11) — both dissolve under D70; see
§1-RESOLVED.** They are kept in full below rather than deleted, because the
retraction is the instructive part: both were artifacts of reading the mockups
against the pre-D70 product model, and an analysis that flags a signed design as
a defect is worth being able to recognise later. Conflicts 3–6 stand unchanged.

**Conflict 1 — the web mockup has NO board anywhere, and this is the big one.**
*(RETRACTED. Under D70 the web mockup has no board **correctly**: the board is a
`[[panes]]` contribution of the tasks extension, so it exists only where that
extension is enabled — an engine client showing no board is the engine working
as designed, not a hole. The AoE concern does not vanish, it **relocates**: the
risk is no longer "the home surface omits the board," it is "an ENABLED
extension's surfaces render as second-class chrome." That is a real constraint
and it moves to §5 as an open call.)*
The TUI has a third context pane (`[3]`) showing a real kanban: `backlog 6 ·
in progress 3 · review 2 · done 41`, plus a task's sub-stage checklist
(`plan ✓ · implement ✓ · review ◐`). **The web mockup has no equivalent
surface at all** — its right panel is Files / Extensions / Info / Git, and
"Tasks" appears only as *prose inside an extension's description*. So as drawn,
the web client renders VIMES as a session list with a nice transcript — which
is precisely the AoE failure mode §3 ratified against ("if the board reads as a
nicer session list, VIMES gets compared to AoE as a session list — and loses").
**This sharpens §1: the question is not only "tree or board as home," it is
"does the web client show the verification loop at all."**

**Conflict 2 — the two clients disagree on session state, and the TUI's version
leaks a tenant word.** *(RETRACTED as a conflict; the diagnosis was right and
the remedy was already signed. `[[overlays]]` (extension-model §2.5) is exactly
"workflow state decorates the node without the engine interpreting it," and
migration-map already maps the stage glyph to it. The TUI mockup is drawing an
overlay as though it were a session state — a rendering shorthand in concept
art, not a proposed data model. **The one thing worth carrying forward:** when
the tree is built, `review` must arrive as `session.overlays[…]`, never as a
value in the engine's session-status enum, and that is worth an assertion in the
tree slice rather than trust.)* Web sessions are `active | idle | running | error` (4).
TUI sessions are `run | wait | review | fail | idle` (5). **`review` is a tasks-
extension workflow node, not a session state** — a session is running or it is
not; "in review" is a property of the *work*, not of the process. Encoding it as
a session status puts a tenant's vocabulary into engine chrome, which is the
carve-out test failing at the UI layer (#16's territory). `wait` is a different
matter and probably legitimate — it maps to the "2 queued" figure the TUI shows,
i.e. a real dispatch-queue state the engine would own. **Recommend: engine
session states stay work-agnostic; workflow state reaches the tree as an
extension DECORATION on the node (mockup item #6), not as a session status
value.** That is the same mechanism as the §1 mitigation, and it resolves both.

**Conflict 3 — the TUI depicts an extension install path, which D67 says does
not exist.** It draws `:ext install <name>`, `:ext search registry`, and
per-extension semantic versions; the web draws "Browse the extension library."
**D67 (signed 2026-08-06) is explicit that v1 is first-party-only and that no
install path exists at all — "a property, not a policy" — and that D67 REOPENS
before any extension VIMES did not author is installed.** So both mockups draw
post-reopening functionality. Not a problem with the drawings (they are the
horizon), but it must be named: **the extension pane ships as
inspect/enable/disable over the installed set; the install and registry-search
affordances are drawn but not built, and building them is a D67 reopening, not
a UI unit.**

**Conflict 4 — the web mockup shows permissions in a footing Wes already ruled
against.** Its input hint reads *"bypass permissions on (shift+tab to cycle)"*.
The settled two-tier footing (⟨Wes⟩ 2026-07-24) is that **human-created sessions
start in Default**, with Allow-Edits and Auto as deliberate choices; dispatched
sessions start in Auto plus the PreToolUse hard-deny hook. A mockup that shows
bypass-on as the resting state would teach the wrong default if implemented
literally. Illustrative, almost certainly — but it is a security-shaped label
and worth correcting in the drawing rather than in review.

**Conflict 5 — economics are first-class in one client and absent in the
other.** The TUI shows per-turn token accounting (`8.2k in / 1.1k out`), a
queued count, an aggregate `3 fail`, event count and window-remaining inline in
the transcript, and a live spine health check (`spine:sqlite ok`). The web shows
none of those — it has elapsed time only (`Churned for 20s`), no fail count, and
buries the event count in an Info tab. **Pillar 4 says economics are visible;
per-turn tokens are the most operator-legible form of that, and the richer
client here is the terminal.** Whichever way §1 resolves, this asymmetry should
be a deliberate choice rather than an artifact of which mockup got more passes.

**Conflict 6 — session identity.** The TUI treats a 4-char short id (`a1f2`) as
first-class: on every tree row, in the transcript pane title, and implicitly as
the handle a `:` command would address. The web never shows an id anywhere.
**A command grammar needs addressable sessions; a pointer grammar does not** —
so this may be a legitimate per-client divergence rather than a conflict. Worth
confirming, because if short ids become real they want to be stable, unique, and
engine-issued, which is a data decision and not a rendering one.

**Two capabilities the drawings imply that do not exist yet**, beyond the tree
API already named in §2: a **seen/unread model** (the web's `✓ 1 Viewed`
counter — note `seen` events *do* already exist on the spine, so this is partly
real), and a **dispatch queue** with a queued count distinct from running. Both
are small, both are data decisions, and both should be settled in this pass
rather than invented by a UI agent.

**One naming note:** both mockups use `vmx` as the resident agent's handle in
the prompt (`Message vmx…`), which is the parked naming question from §5.
Consistent across both drawings, which is mild evidence it has already won.
