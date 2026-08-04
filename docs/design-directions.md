# Design directions — planned/parked systems not yet scheduled into a slice

Spun up 2026-07-19 (first tenant arrived via the decomposition series). Each
entry is parked deliberately; scheduling one into a slice is a decision.

## The product shape: an IDE platform, orchestration as an extension layer

*(Wes, 2026-07-20 — vision articulated for the record; not a schedule change.)*

**The destination.** The human stays at the top and does not delve. Create a
task, attach files, write a description, drop it into review; the project's
PM agent picks it up, expands it (asking any clarifying questions it needs
answered), and shuffles it through work phases. The PM agent creates its own
tasks to track its work. The human drags the folder — the mechanism handles
the bytes (the Windows-copy analogy: you don't enumerate files and submit a
copy list).

**The architecture that gets there.** The agent-native human-IDE is the
**platform**; the kanban / workflow / orchestration is a **layer that bolts
on top of it, the way VSCode extensions bolt onto VSCode.** Consequences that
bind slice design from here:
- Replacing code-server (slices 0–3, the MVP line) is not a means to rush
  past — it is the platform the whole product stands on. It stays first.
- Every layer stays solid and directly usable (principles 7 & 8): all
  sessions are AVAILABLE to inspect and manage directly; orchestration is
  where you *live*, but the IDE is the floor you land on when you tunnel
  down, and it must hold weight.
- The IDE surface — mobile-friendly, terminal-accessible, project-scoped
  chats with the orchestrator, agent-session inspection with full context —
  exposes clean seams the orchestration layer *consumes as an extension*,
  never woven into the core (reinforces rule 0.3 and principle 10; slice 0's
  reserved task/kanban schema is the seam already in place).

**Sharpened 2026-08-04 (Wes, mid-Gate-2-trial): EVERYTHING becomes an optional
extension — even the task list.** The 2026-07-20 framing below ("orchestration
is a layer that bolts on") stopped one step short: in the end-state the
platform core is sessions + event spine + projections + panels + the daemon
API, and **the entire task machine — board, stages, dispatch, review — is
itself the FIRST extension**, the built-in one (D51's sketch already says
today's pipeline becomes the built-in `software` workflow; this generalizes
that from workflow-definitions-as-data to workflow-SYSTEMS-as-extensions).
Second tenant already named: **Wes's Book Genesis skill suite as a custom
extension** — its phases (foundation, prose, beta-reader evaluation,
editorial package) map onto D51's node kit (work/review/hold kinds), its
skills ARE the stage briefings, its scores/gates ARE the acceptance shapes.
Third element: **author a METHOD for developing extensions** — a documented,
versioned extension format + development doctrine (the software-orchestration
skill is the precedent: a method-as-artifact, proven on real projects before
generalized). Sequencing per define-at-first-instance/generalize-at-second:
(1) Gate-2 trial on the built-in pipeline → (2) slice-9 D51 design pass
extracts the node-kit with BOOKS as the second tenant → (3) the
extension-authoring method is written FROM those two worked examples, never
before them. The D62 ACP read and the client-kit extraction feed the same
seam: "what is the contract between the platform and ANY consumer."

**Mobile's final form** (Wes, 2026-07-20): short chat sessions with optional
voice synthesis; heavy text work happens on an actual computer. Phone
keyboards are good but mobile terminals/heavy editing stay rough on the eyes
and hands. **Effort-allocation consequence for slice 3 and the mobile UI:**
nail light-chat + notification + session inspection on the phone; treat heavy
mobile editing and the mobile terminal as escape hatches (pillar 7), not
daily-driver surfaces to gold-plate. The desktop is where the heavy IDE work
lives.

**The north star — the real "definition of done."** The unlock is using
VIMES to keep enhancing VIMES live, through the orchestrator, without this
remote CLI at all. Concretely: a project-scoped orchestrator chat on the
VIMES repo itself that can spawn and steer the work agents that *currently
run through the Claude Code CLI in this build*. That is slice 7 pointed at
VIMES's own repo — distinct from the MVP (replace code-server) and from the
usable-product milestone (the kanban loop). VIMES hosting the workflow that
builds VIMES is the recursion the whole project is aimed at.

## UI shape evolution (Wes notes 2026-07-20, live desktop+mobile use — parked, not scheduled)

**Standing stance (Wes, 2026-07-29): nothing is sacred in the UI space right
now — expect large redesigns as the product finds its shape** (the D61
project-rooted URLs, the picker landing, the coming orchestrator surface, the
D51 workflow graphs). Consequence for orchestration: don't over-defend current
layouts or argue for UI stability when a design conversation points at a
reshape; UI units are cheap to redo by construction (lib/ logic tested, .vue
manual, ships via the gate). The things that ARE sacred live below the UI:
the event spine, the invariants, the design principles.

- **Bespoke desktop and mobile layouts, not one responsive layout.** The
  current UI is mobile-coded and looks it on desktop (a widened phone view).
  Desktop should get its own layout that uses the width (multi-pane: session
  list + stream + editor/diff side by side), not a stretched mobile column.
  Consistent with the "mobile = light chat + voice; desktop = heavy work"
  final-form note above — the two form factors want genuinely different
  surfaces, not the same one scaled.
- **Sessions should not be the landing page.** As the orchestration layer
  arrives, the home screen should be the top-down project/orchestrator view
  (kanban, PM status), with the session list a drill-down — matching the
  "human stays at the top, tunnels down when needed" model (principle 8; the
  platform/extension vision above). Pillar 1 ("session list is the home
  screen") was the slice-0–3 framing; this is its post-MVP evolution as the
  extension layer lands. Revisit when slice 6/7 UI is designed.
- **Mobile terminal is inherently cramped — but vimes's ceiling beats
  code-server's** (Wes, 2026-07-20). Full TUIs don't fit a narrow phone even
  when rendered correctly. BUT code-server pays a chrome tax vimes doesn't:
  its activity bar + terminal-tab strip steal columns from the shell. Vimes
  has no file rail, no extension buttons, no multi-shell tabs — one row of
  header, the rest is terminal. So a correctly-sized vimes terminal renders
  MORE usable columns of content than code-server on the same phone. The
  2026-07-20 corruption was a real pty-sizing bug (fixed); once sized right,
  vimes is structurally *more* legible on mobile, not merely equal. Still an
  escape hatch (chat/voice is the real mobile surface) — don't gold-plate it —
  but the minimalism is a genuine advantage, not a compromise.
- **Design principle candidate — real estate to content, not chrome.** In an
  agentic dev environment the human reviews and steers; they don't need
  IDE furniture (file trees, tab strips, panels) competing for space. Give
  screen real estate to the content (terminal, diff, stream). Compounds
  hardest on mobile where columns are scarce ("not tmux-maxxing on a phone" —
  one shell, full width, no panes). Promote to design-principles.md if it
  holds up across the desktop-layout work.

## The dispatcher's review/fix loop + cache economics (slice 6–7 design input)

*(Wes, 2026-07-20 — articulating the intended orchestration workflow; refined
with Fable. Informs the slice-6 dispatcher and D5/D6.)*

The target loop, human at the top: a worker subagent completes work and checks
it in on a worktree (D6 isolation) → the orchestrator either **pulls the diff
to review itself** or **dispatches a review** → accept, or send the flaw back
to the **original, still-hot worker** for a cheap fix → re-review. The human
reviews diffs when they *want* to, not because they must — the orchestrator
owns the review work by default (principle 8: live at the top).

Load-bearing distinctions (the refinement):
- **Review wants independence; fixes want the hot author.** An agent reviewing
  its own work shares its own misunderstanding — a real blindspot. So the GATE
  review is the orchestrator or a fresh reviewer; self-review is a cheap first
  pass, never the gate. Fixes of orchestrator-found flaws go to the original
  hot-cache worker (cheap + context-rich).
- **Cache economics (Wes's point, correct):** resuming the hot worker for
  fixes avoids the big cache-miss of a new agent. Prompt cache is scoped to
  machine+directory (D6): a worktree worker is cold *relative to shared-dir
  workers* but hot *within its own worktree* on resume — so the loop is
  internally consistent; the miss avoided is the new-agent spin-up, at the
  cost of no cross-agent cache sharing in worktree mode.
- **Applies to the CURRENT orchestrator too:** Fable has been spawning fresh
  fix-agents where resuming the hot author would be cheaper (independence was
  already secured by the orchestrator finding the flaw). Adopt hot-resume for
  mechanical fixes of orchestrator-identified issues going forward.

This is D5 (course-correction into a live/resumed worker) + D6 (isolation) +
the slice-6 dispatcher, unified. Build the dispatcher's stage-runner so
"review" and "fix" are distinct dispatch verbs with the independence rule
baked in.

## Hot reload without destroying shells (zero-downtime deploy)

*(Wes, 2026-07-21, immediately after a deploy killed the vimes terminal he was
working in.)* "We're going to want a way to do hot reloads in the future without
destroying shells."

The problem: PTY terminals (and SDK session children) are processes owned by
`vimes.service`; `systemctl restart` kills the whole tree. Now that VIMES hosts
the work that builds VIMES (the north star), every daemon deploy costs the
operator their live shells — the bootstrap tax recorded in CLAUDE.md.

**Immediate mitigation (already true, worth exploiting):** the daemon serves the
UI from `packages/ui/dist` **read per request** — so a **UI-only change needs NO
restart at all**. Rebuild, hard-refresh, done; shells survive. Only changes to
daemon code require the restart. Splitting the deploy procedure into "UI-only
(rebuild)" vs "daemon (restart)" removes most of the pain for free. (Today's
deploy needed a restart only because it carried a new daemon endpoint.)

Candidate designs for the real thing, in rough order of cost:
- **Split the PTY host out of the daemon process.** Terminals owned by a small,
  rarely-changing supervisor process that outlives daemon restarts; the daemon
  reattaches to its pty fds on boot. Cleanest conceptually — the session/terminal
  lifetime stops being coupled to the code that changes most often. Biggest
  refactor; interacts with I9 ring buffers and the custody model (D10).
- **systemd socket activation + graceful handover** — the new process inherits
  the listening socket, old connections drain. Solves connection continuity, NOT
  child-process survival (the pty children still belong to the old unit unless
  they're re-parented). Partial fix only.
- **Re-exec in place preserving fds** — the daemon `execve`s the new build while
  holding pty master fds open. Keeps children alive without a second process, but
  demands strict fd hygiene and a state handoff; subtle failure modes.
- **Accept + soften:** keep restarting, but make reconnect seamless enough that a
  killed shell is cheap — terminals are already persistent + re-enterable across
  WS reconnects (D23); the gap is process death, which no reconnect can fix.
  Pairs with a "deploy will kill N shells — proceed?" pre-flight in the UI.
Parked; schedule when daemon-deploy frequency starts costing real work. Related:
the two-halves deploy pre-flight (sessions AND terminals) in CLAUDE.md.

**Observed live 2026-08-04 (walk-2 human gate, Wes): the CLIENT half is its own
gap, and it is cheaper than every option above.** The instant the daemon died,
the open PWA showed **Cloudflare's raw 502 Bad Gateway page** until a manual
reload after the restart completed. Wes: "the frontend needs to be restart
resilient." This is separable from child-process survival: whatever happens to
shells, the SHELL OF THE APP should never be replaced by an infrastructure
error page. The shape: service-worker-cached app shell (the PWA plumbing
already exists in `sw.ts`) so navigation/refresh during an outage renders
VIMES-with-a-banner instead of Cloudflare's page; a "daemon unreachable —
reconnecting" state driven off the existing WS close/backoff; auto-recover
when the socket returns (streams already resubscribe from lastSeq — I2 — so
continuity is free once connected). No daemon changes. Natural early unit of
the restart-resilience thread — buildable NOW, independent of the
handover/re-exec designs above.

## A simple "alert my phone" API — for callers outside VIMES

*(Wes, 2026-07-20.)* Right now the orchestrator buzzes Wes's phone via a
side-channel script (`buzz.mjs`: vimes's VAPID keys + his registered
subscription, sending JSON `{title, body, url}` straight to FCM — a "stunt
double" for the real path). Wes: "make an easier way to call the vimes mobile
alert — a simple API for the future so sessions **outside** of vimes can still
call it."

The shape: a small **authenticated daemon endpoint** — e.g. `POST /api/notify
{ title, body, url? }` → fans out to the operator's push subscriptions —
callable by any local process (a cron job, a build script, a non-VIMES Claude
session, another lab service). It generalizes the buzz stunt into a first-class
capability. Load-bearing distinctions:
- **This is the human-alert primitive; it is NOT the event spine.** It sends a
  push and returns — it does not write `notification_trigger` or touch the
  store (principle 10: don't become a second writer). The authed, evented
  orchestrator-MCP path (create_task/comment/etc.) remains slice 7's north
  star; this is the thin "just buzz me" utility beneath it.
- **Auth:** the product port is Access-gated (I14); a machine-to-machine caller
  can't carry an Access JWT. So this wants either a **loopback-only** bind (like
  the hook ingress on :4601 with a per-caller bearer secret, the D7 pattern
  already in place) or a dedicated local token. Reuse the hook-ingress posture,
  don't reinvent it.
- **Abuse bound:** rate-limit + a fixed subject; it can only reach the
  operator's own registered devices, never arbitrary endpoints.
Parked, not scheduled. Small enough to slot as an early add in a notification-
adjacent slice (or standalone) — Wes to place it. Connects to §3.8 and pillar 5
(attention is the scarce resource — make it trivially reachable).

## Event-log growth: the post-MVP D12 revisit, first option pre-selected

D12 (decided): message bodies inline, growth accepted, archival/compaction
revisited with real data post-MVP. **codor-decompose §2.4 supplies the shape
that revisit should evaluate first:** refs to **self-owned** JSONL blobs the
daemon writes itself under its own data dir (`events_ref`). This was the
third option finding C never weighed — it keeps replay self-contained (rule
0.6 satisfied; no dependence on Anthropic's files) while keeping the DB
small. Not a reopening of D12; it is the pre-filed first candidate for the
horizon item, recorded so the eventual revisit starts from a design, not a
blank page.

## Markdown rendering in the message stream — parse to a structure, never `v-html`

**Raised by Wes 2026-07-23, during the slice-6 live test plan: "the raw
unformatted markdown is hard to parse."** Not scheduled; sized and shaped here so
it can be slotted without re-deciding anything.

`StreamView.vue:336` renders `{{ block.text }}` inside `whitespace-pre-wrap`. Vue
escapes it, so a heavy assistant message (headings, bold, fenced code, lists)
arrives as literal `##` and `**`. Reading agent output is the single most common
thing a VIMES user does, so this is a daily-friction item, not a cosmetic one.

**The shape, decided in advance:** parse to a structured AST in
`packages/ui/src/lib/markdown.ts` and render it with Vue components. **No
`v-html` anywhere.** Two reasons, and the second is the load-bearing one:

- It lands in the existing pattern — pure logic in `src/lib/*.ts` with tests,
  `.vue` untested — exactly like `messageContent.ts`, whose `ContentBlockView`
  union this extends beneath `kind:'text'`.
- **`v-html` on model output is an HTML-injection surface on a publicly
  tunnelled daemon.** A library route (`marked` + `DOMPurify`, ~55 KB into the
  entry chunk) makes correctness depend on a sanitizer staying correct forever
  and earns a risk-register entry under 0.6. Parsing to a structure makes XSS
  impossible by construction, because Vue escapes text nodes — the guarantee is
  structural rather than maintained. Two supply-chain dependencies are not worth
  trading for that.

**v1 scope:** headings, bold/italic/inline code, fenced code blocks (plain `<pre>`
monospace — **not** CodeMirror; CM6 is lazily chunked and gated by
`check-build-manifest.mjs`, and pulling it in here would be a regression), bullet
and numbered lists with one nesting level, links (`rel="noopener noreferrer"`),
horizontal rules. **Out of v1:** tables, nested blockquotes, footnotes, images,
and HTML passthrough (never).

**Estimated one agent, one unit:** ~250–350 lines of parser plus 40–60 tests and
a small render component. Blast radius is UI-only — no core, no daemon, no
invariants; deploy is a static rebuild with **no daemon restart**, so it cannot
interrupt a live session. Messages arrive as complete blocks in the event log, so
there is no partial-parse-while-streaming problem to solve.

Natural slot: alongside or just before step 9 (the kanban board), which is the
next UI work either way.

**Widened 2026-07-23 (Wes): clickable file paths ride along.** A path an agent
mentions becomes a link opening the VIMES editor in a new tab, at the right line.
Folded into the same unit rather than taken separately, because the parser must
exist first and a second agent would only re-read the same file.

It is a small lift because three pieces already exist and none is rebuilt:
`App.vue:49` already routes `#/files?path=…&line=…` to the editor and
`EditorView.vue:77` already calls `goToLine`; `fileApi.ts` already answers **403
with zero product bytes** for anything outside `VIMES_PROJECT_ROOTS`, so the
allowlist stays a daemon fact the UI neither repeats nor can widen (principle 9);
and the session `cwd` needed to resolve a relative path is already on the session
record.

**Detection is CODE-SPAN ONLY, never prose** — free-text path detection is a
false-positive swamp (`and/or`, `application/json`) and agents wrap paths in
backticks anyway. A span qualifies only with a leading `/`, `./`, `../`, `~/` or
a recognised source extension; everything else stays an ordinary code node. The
fail-safe direction is "render as code": a missed link costs a click, a wrong one
is a confusing dead end. `file:line` is parsed because it is the convention agents
already use.

**No existence check in v1** — verifying would make a deliberately pure,
deterministic module async. A path the agent invented opens the editor and
reports not-found, which is honest. Revisit only if dead links prove common.

## PANELS — one shell, N panes, and the phone is the degenerate case

*Drafted 2026-07-23 at Wes's request. **Design only — nothing here is decided.**
The ⟨Wes⟩ decisions at the end gate a work order.*

*Supersedes an earlier sketch in this entry (a "primary + aside" two-slot route),
which Wes replaced with the panel model in the same session. The reasoning for
the swap is recorded below because it is the interesting part — the panel model
won on **fewer concepts**, not on flexibility.*

**This is the concrete design for "UI shape evolution" (2026-07-20) above.** That
note already called for *"bespoke desktop and mobile layouts, not one responsive
layout"* and *"multi-pane: session list + stream + editor/diff side by side"* —
this entry is that note, made buildable. Two threads from it land directly here:

- **"Real estate to content, not chrome"** (the design-principle candidate) is
  the strongest argument for panels over a conventional IDE shell: panels ARE
  content, and the only chrome added is one sidebar. If that candidate is
  promoted to `design-principles.md`, this design is what it will be checked
  against first.
- **"Sessions should not be the landing page"** — the home screen should be the
  top-down board with sessions as a drill-down. That note said *"revisit when
  slice 6/7 UI is designed"*, and **step 9 is that revisit**: once a board
  exists, the panel stack's initial state is the natural place to make the
  switch. ⟨Wes⟩ #3 below is the same question in its concrete form.

### The premise, and why "just make it wider" is the wrong instinct

Every view in VIMES today is phone-shaped, deliberately — the product premise is
a workday driven from a phone. But a phone imposes a specific discipline: **you
can attend to exactly one thing.** Every view is a destination you navigate to,
and the router enforces it.

The value of a desktop is not more pixels for the same view. It is
**simultaneity** — supervising several agents means holding more than one fact at
once, and the phone shell structurally forbids that.

The single best argument for building it: **read what an agent did next to the
file it changed.** That is the supervision loop, and on a phone it is two
navigations and a lost place.

### ⚠ The structural blocker

`App.vue` derives every view from a single `routePath`, and they are mutually
exclusive — `showFileTree`, `showSearch`, `showTerminal`, `showGit`, `showCost`,
`showMeters` are each `routePath === '/x'`, with `editorTarget` as `/files` plus
a `path` param. **The route model cannot express two things at once.**

This is the expensive-to-retrofit piece, and it is the same shape as the
layout-agnostic `lib/` constraint on step 9: cheap up front, a rewrite afterwards.

### The model: a PANEL STACK, rendered as many as fit

**The app's navigation state is a list of panels. Each panel holds one route.
The viewport renders as many trailing panels as fit. Back pops.**

| device | N | push | pop |
|---|---|---|---|
| phone | 1 | replaces what you see | back, exactly as today |
| tablet | 2 | appears beside | back |
| desktop | 3+ | appears beside | back |

The phone is not a special case — it is the **degenerate** case, `N = 1`. That is
the whole point of the model, and it is why today's behaviour survives untouched:
a single-panel stack rendered one-at-a-time *is* the current app.

Three consequences worth stating, because each deletes a problem the earlier
two-slot sketch had to solve:

1. **"Back" needs no new rule.** Pop the stack, on every device. The two-slot
   sketch had to decide whether back closed the aside or left the primary; that
   question no longer exists.
2. **No parameter namespacing.** Each panel owns its own params by construction.
   The two-slot sketch collided on `path` (an editor as primary *and* an editor
   in the aside) and needed an `asidePath=` hack. Gone.
3. **One shell, not two.** The earlier sketch needed a `PhoneShell` and a
   `DesktopShell` plus a written discipline rule to stop them drifting. Rules get
   broken; a single shell parameterised by N **cannot** drift. This is the same
   move the codebase makes everywhere else — structural escaping over a
   sanitizer, derived vocabularies over hand-listed ones. **Make it impossible,
   not forbidden.**

**Why this is not over-abstraction.** It looks like building a general system for
a two-pane need, and the docs' own guidance is *define at the first instance,
generalize at the second*. The guidance does not bite here because the panel
model has **fewer concepts** than the special case it replaces: one slot type
instead of two, one back rule instead of two, no param namespacing, one shell
instead of two. When the general form is *simpler* than the special form, that is
not generalization — it is finding the right model. If it were equal complexity
with more flexibility, this entry would argue the other way.

### The shell

- **Persistent left sidebar** (desktop only): nav, plus the session list with
  liveness dots and attention badges. The real change is that the session list
  stops being a destination and becomes **ambient**. Pillar 5 says attention is
  the scarce resource; a list you must navigate to is a list you check less often
  than you should.
- **A panel host** rendering the trailing N panels of the stack.
- **Meters** become persistent chrome rather than living inside
  `SessionListView`. There is room; there never was on a phone.

### Per-view treatment

| View | As a panel | Cost |
|---|---|---|
| **Stream** | the common primary; pushes file panels beside itself | high value |
| **Editor** | pushed by a path click or the tree | medium |
| **Board** | consumes step 9's layout-agnostic `lib/`; columns go horizontal when the panel is wide | medium |
| **Session list** | moves into the sidebar on desktop; stays a panel on phone | medium |
| **File tree** | a panel that pushes editor panels | low |
| **Cost ledger / meters** | already fine wider | trivial |
| **Terminal / git / search** | panels, unchanged | trivial |

### A payoff already banked, and a rule it collapses

The clickable file paths shipped in `61ea9cc` open the editor **in a new tab** —
the only option on a phone. Under panels, a path click **pushes a file panel**,
full stop. On a phone that fills the screen and back returns you; on desktop it
appears beside the message that mentioned it.

Note what happened: "new tab on phone, aside pane on desktop" was **one action
described twice.** The panel model collapses it to one rule with a
layout-dependent N. That is the model paying for itself before it is built.

### The discipline, now structural rather than written

Derived logic stays in `src/lib/*.ts` and leaf components (a task card, a session
row, a meter tile) are shared. Under the two-shell sketch this needed a rule.
Under panels there is only one shell, so **a behaviour cannot exist on one device
and not the other** — there is no second tree for it to live in.

### ⟨Wes⟩ — the decisions that gate a work order

1. **Adopt the panel stack?** *(Lean: yes. It is simpler than the alternative, it
   is the reason desktop is worth building, and retrofitting the router later is
   the rewrite.)*
2. **How is N chosen** — a width breakpoint, or an explicit user control?
   *(Lean: computed from width, with a manual override remembered per device.)*
3. **Does the sidebar session list replace `SessionListView` on desktop, or
   coexist?** *(Lean: replace. Two lists of the same thing is exactly the drift
   the model exists to prevent.)*
4. **The focus model.** With N panels, which one takes keyboard input and global
   actions? *(Lean: the last-interacted panel, with a visible focus ring. Needs
   deciding before the shell is built, not after.)*
5. **Scope of the first unit** — the shell alone with one panel pair as proof, or
   the shell plus every view's panel treatment? *(Lean: shell plus the
   stream→editor pair. That pair exercises push, pop, and focus end to end.)*

---

### The retrofit, scoped (2026-07-23)

**Two measurements decide the shape, and both are good news.**

**1. No view knows about routing.** `grep` for `location.hash` / `routePath` /
`URLSearchParams` across `views/` and `components/` returns **nothing**. Every
view is props-in / events-out; all routing lives in `App.vue` (204 lines). The
retrofit is **contained to one file plus a new lib** — it does not spread across
eight views, which is what would have made it expensive.

**2. That routing has ZERO test coverage.** It is inline in a `.vue`, and the
house rule is that `.vue` files are not tested here. So the module about to
change shape is the one module with no assertions on it. **Phase 1 is not desktop
prep — it is paying that down**, and it is worth doing even if panels are never
built.

#### Phase 1 — extract routing to a pure, tested lib. NO behaviour change.

`packages/ui/src/lib/route.ts`: `parseRoute(hash) → Route` and
`buildHash(route) → string`, round-trip tested. `App.vue` delegates and behaves
exactly as it does today.

⚠ **Three things a refactor must preserve, all currently implicit:**
- **The `v-if` / `v-else-if` chain is a PRECEDENCE ORDER, and it is load-bearing
  and undocumented.** `editorTarget` beats everything; `SessionListView` is the
  fallback. Make precedence an explicit, tested function — do not leave it
  encoded in template order, where a reordering silently changes behaviour.
- **Route → view is NOT 1:1.** `#/meters` and `#/` render the *same*
  `SessionListView`, differing only by the `expand-meters` prop. The model is
  **route → (view, props)**.
- `leaveEditor` / `decideEditorReturn` is an existing whitelist with real
  semantics; carry it verbatim.

*Lift: ~150 lines lib + ~50 tests. Low risk — a pure refactor whose tests are
written against today's behaviour before anything moves.*

#### Phase 2 — `Route` becomes `Panel[]`. Additive.

Every existing URL parses to a **single-element** stack and behaves
byte-identically. Encoding the stack in a hash is the one place panels are
*uglier* than the two-slot sketch — accept it, and keep single-panel URLs looking
exactly as they do now so the common case stays readable and pasteable.

*Lift: ~60 lines + tests. Low risk, additive.*

#### Phase 3 — the panel host, and making views panel-safe.

One shell: sidebar (desktop) + a host rendering the trailing N panels, with N
from `useLayoutMode()`.

⚠ **This is where the work actually is: every view currently assumes it owns the
viewport** — `@back` semantics, full-width layout, sticky headers. Each must
become correct as one of N. Eight views, mechanical but real, and more testable
than "design a second shell" was.

*Lift: ~350 lines of `.vue` + ~80 lines of lib/tests, plus the per-view audit.*

#### Phase 4 — the proof pair.

Stream pushing an editor panel, including the path-click rule above. Exercises
push, pop and focus end to end.

*Lift: ~100 lines.*

#### Total, and the honest sequencing

**Three agent units**: **(1+2) routing**, **(3) panel host + view audit**,
**(4) proof pair** — 3 and 4 can merge if the host's push/pop API is specified up
front, which is what phase 4 validates. The desktop **board** is a fourth, after
step 9, consuming its layout-agnostic `lib/` unchanged.

**Phases 1+2 are worth doing regardless of the panel decision.** They convert the
app's only untested logic into tested pure logic for about half a unit. If ⟨Wes⟩
#1 goes the other way, phase 1 still stands alone and phase 2 is skipped.

**The risk is concentrated in phase 3, and it is design risk plus a mechanical
audit** — which is the argument for settling ⟨Wes⟩ 1–5 before a work order rather
than during one. Compared with the superseded two-shell sketch, phase 3's design
risk is **lower** (one shell to get right, not two) and its mechanical share is
**higher** (the view audit), which is the better trade: mechanical work is
verifiable, design risk is not.

## Android home-screen surfaces — a meter, a gate, a status light

*(Wes, 2026-07-23: "Vimes widgets for android. A usage meter with whatever the
binding constraint is and estimated burn down/reset. A gate/permission popup or a
status indicator (working, waiting for input, completed)." **Captured, not
scheduled.**)*

The instinct is right and fits pillar 5 — attention is the scarce resource, and a
glanceable surface is the cheapest possible way to spend it. But the three asks
have **very different costs**, and the split is not where it looks.

### The finding: most of this is already built, and the split is DELIVERY

Every number these surfaces want is already derived, tested and shipping:
`formatBurnRate`, `formatProjectedExhaustion`, `formatResetCountdown`,
`meterFreshness`, `formatObservationAge` (`lib/meterDisplay.ts`), plus liveness
and `needsAttention` for the status light. **Nothing here needs new maths.**

The real question is *how the surface is delivered*, and that splits hard:

| Tier | Surface | Native code? | Cost |
|---|---|---|---|
| **0** | **Gate approve/deny from the push notification** | **No** | small |
| **1** | Persistent status notification (working / waiting / completed) | **No** | small–medium |
| **2** | Actual home-screen **widgets** (meter, status) | **YES** | large |

### Tier 0 — the one to build first, and it needs no widget at all

`sw.ts` already receives pushes and calls `showNotification(title, {body, tag,
data})`, with `notificationclick` deep-linking to the session. It does **not**
pass `actions`.

Adding `actions: [approve, deny]` and branching on `event.action` in
`notificationclick` gives a **gate you can answer from the lock screen** — the
literal thing Wes described as "a gate/permission popup" — with no native app, no
new credential, and no new transport. The service worker is same-origin, so a
`fetch` from it **already carries the Cloudflare Access session**; I14's choke
point is unchanged and no second auth path is invented.

This is the highest value-per-cost item in the whole entry: it closes the
attention loop (notified → decided) without ever opening the app, and D18's gate
contract already exists to answer against.

⚠ **It needs one careful decision:** a gate answered from a notification is a
**real permission grant made from a lock screen**, possibly with the phone
unlocked in a pocket. Whether *deny* is offered without confirmation but *approve*
requires opening the app is a product/safety call, not an implementation detail.

### Tier 1 — a status light without a widget

Android web push cannot create a truly "ongoing" notification, but a notification
with a **stable `tag`** is replaced rather than stacked, so a single VIMES
notification can be kept updated in the shade: *working → waiting for input →
completed*. Not a home-screen widget, but it delivers most of the glanceable
value and stays inside the existing push path.

### Tier 2 — real widgets, and the wall they hit

**A PWA cannot provide an Android home-screen widget.** The Web App Widgets spec
targets the Windows widgets board, not Android home screens. A real widget is an
`AppWidgetProvider` — native Kotlin — which means shipping a **native wrapper**
(a TWA hosting the existing PWA, plus native widget code beside it). That is a
new build target, a new toolchain, a Play Store identity, and a release process,
for a project that has none of those today.

⚠ **And the blocker is not the widget, it is AUTH.** A native widget has no
browser cookie jar, so it cannot ride the Cloudflare Access session that every
other VIMES client uses. It would need its own credential — an Access **service
token** — which is a materially different trust model: a long-lived secret on a
device, bypassing SSO and device posture. **A lost phone becomes daemon access.**
I14 says auth is a choke point; this would be a second door beside it, and that
is a decision for Wes, not a detail to solve in a work order.

### ⚠ Pillar 4 applies harder here than anywhere else

A widget is **a meter you glance at with no context**, on a screen you look at
fifty times a day. Every failure mode of a lying meter is amplified:

- It must show **freshness and observation age on its face**, not just the number.
  `meterFreshness` and `formatObservationAge` already exist; a widget that drops
  them for aesthetics is exactly the meter this project refuses to ship.
- A **stale** widget must SAY it is stale rather than confidently showing an old
  number. Android throttles widget refresh (≈30 min minimum via
  `updatePeriodMillis`), so *stale is the normal case*, not the exception.
- Never a fabricated projection. `formatProjectedExhaustion` already declines to
  guess when it cannot; the widget must render that decline, not hide it.

### The one piece of maths that IS missing — and is worth building anyway

Wes asked for "**whatever the binding constraint is**". `usageStripModel` returns
*all* meter rows; **nothing picks the one that will exhaust first.** That
derivation does not exist.

It is a small pure function in `lib/meterDisplay.ts` — and it is **useful in the
app today**, independent of any widget: the usage strip could lead with the
binding meter instead of making the operator compare rows. Like the routing
extraction in the panel entry, it is a piece of parked work that pays for itself
immediately, and it should be built when it is wanted in-app rather than waiting
on a widget decision.

⚠ Its honest edge: when no meter has a projection (unknown burn rate, or a meter
too fresh to project), there **is** no binding constraint, and the function must
say so rather than defaulting to "the highest percentage". A meter at 90% that is
not moving is not the constraint; one at 40% burning fast is.

### ⟨Wes⟩ — decisions, when this is revisited

1. **Tier 0 alone, or commit to the native wrapper?** *(Lean: tier 0 now, and
   treat tier 2 as a separate product decision. Tier 0 is days; tier 2 is a new
   build target and a new credential model.)*
2. **May a gate be APPROVED from a notification, or only denied/deferred?**
   *(Lean: deny and defer from the notification, approve requires opening the
   app. Asymmetric on purpose — the safe direction should be the cheap one.)*
3. **Is a long-lived Access service token on a phone acceptable at all?** This
   gates tier 2 entirely, and the answer may simply be no.

### Lift

- **Tier 0:** ~1 unit. `sw.ts` actions + a gate-answer path from the service
  worker + tests on the pure notification-view mapping.
- **Binding-constraint derivation:** ~half a unit, pure `lib/` with tests, and
  independently useful.
- **Tier 1:** ~1 unit, mostly push-payload and tag discipline.
- **Tier 2:** a **new project**, not a unit — native toolchain, release channel,
  and the credential decision above. Do not scope it further until ⟨Wes⟩ 3 is
  answered.

---

## Project onboarding — a standardized doc schema + an import workflow that reorganizes a project into it

*(Wes, 2026-07-23: "a standardized project documentation schema with a project
initialization workflow where we import a project into vimes and it runs a
workflow to reorganize the project files using agent calls. We're not near that
yet but it should be thought about." Captured, not scheduled.)*

**Now has a home (2026-07-24).** D42 declares an event-sourced project registry
with a **reserved `project_initialized` event** — that is exactly this workflow's
trigger. Importing/creating a project (D42's +New Project) is the entry point;
this init workflow is the skippable step that runs after it. See D42 and
"Project-centric VIMES" below.

**The idea.** Two coupled pieces:
1. **A standardized project-documentation schema** — a canonical shape for how a
   project records its own design and state.
2. **An import/init workflow** — bringing a project into VIMES kicks off a
   workflow that uses agent calls to read the existing project and **reorganize
   its files into the schema** (seed the docs, sort strays, write the index).

**This is not greenfield — the schema already exists in embryo, in this repo.**
The software-orchestration workflow's doc suite (`decisions.md`,
`open-questions.md`, `design-principles.md`, `calibration.md`, `architecture.md`,
`risk-register.md`, `design-directions.md`, `README.md` index) IS a standardized
project-documentation schema, and `vimes/docs/` is its worked exemplar. The
kickoff checklist in that skill is a **manual** version of the init workflow:
scaffold the suite, migrate the spec's live parts, preserve `D#` numbering. So
the novel work is (a) making the schema a **first-class, versioned VIMES
artifact** rather than a convention living in a skill, and (b) **automating the
init** as a dispatched workflow instead of a human running the checklist.

**Where it sits in the product.** This is a concrete instance of the top entry
("an IDE platform, orchestration as an extension layer") — the extension layer
doing structured work *on* a project, not just hosting sessions *in* it. And its
engine is the **slice-6/7 dispatcher**: a project-init workflow is a natural
first real *product* consumer of the task/workflow machinery, downstream of it
being stable. That ordering is the trigger (below).

**⚠ The tensions worth flagging now, while they're cheap to note:**
- **Reorganizing someone's files is a hard-to-reverse op on real work.** The
  operating principle is confirm-before-destructive; this must be **git-native
  and reversible** — run the reorg in a **worktree/branch (D32 already gives us
  worktree isolation), never touch the working tree or `main`**, present a diff,
  and land only on human sign-off. "Make it impossible, not forbidden": the reorg
  cannot clobber because it structurally has no path to the live tree. This is
  Rule-0.1 territory the day it's scoped.
- **Observed truth over declared (0.7).** The import must *read* the project's
  actual layout, never assume a conventional one — a classifier that infers "this
  is where the design docs live" is inference, and inference gets the same
  observed-not-declared discipline as everything else here (cf. D37's refusal to
  infer a project boundary from `.git`/`package.json`).
- **The schema needs versioning + migration**, the same way `calibration.md` pins
  bands with assumptions and `decisions.md` preserves numbering across splits. An
  imported project may carry an older schema version.
- **D21 project roots** bound what "import a project" can reach
  (`VIMES_PROJECT_ROOTS`); the reorg operates inside that fence.
- **Multi-tenancy.** The schema has to hold for projects that are NOT VIMES and
  NOT games — a service, a library, someone else's repo. The suite was designed
  to generalize (that's why the skill was renamed off "slice"), but the schema-
  as-artifact should be validated against a genuinely foreign project before it's
  declared standard (define at first instance, generalize at the second).

**Parked. Trigger:** after the dispatcher/workflow machinery (slice 6, and its
review/fix loop) is a proven, stable product, AND there is a real second project
to import as the first foreign test of the schema. Lean: this is downstream of
the dispatcher earning trust, and its first build should be **schema-first**
(pin the standardized shape and its versioning on one real import) before any
automated file-moving is turned on. Do not scope the reorg workflow before the
schema is validated against a non-VIMES project.

### ⟨Wes⟩ — decisions, when this is revisited
1. **Is the schema the software-orchestration doc suite promoted to an artifact,
   or a new shape?** *(Lean: promote what exists — it's proven on three projects.)*
2. **Does import ever write outside a worktree/branch?** *(Lean: no, ever. The
   reorg lands via reviewed diff + sign-off, never in place.)*
3. **Schema versioning + migration story** — mint it with the artifact, not after.

---

## Panel "back" / close semantics — what should a per-panel back button DO? ✅ DECIDED → D41

*✅ 2026-07-23: Wes chose **truncate-forward** (#1) + the **"close ×" on desktop
panels** affordance (#3). Recorded as D41 in `decisions.md`; the options and
reasoning below are kept for the record.*


*(Wes, 2026-07-23, testing the shell: clicked back on the FILES panel of
`[list, files, editor]` and the EDITOR closed, not files. His framing: "this is
more a question of how we want panels to operate, not the specific workflow."
So this is a MODEL decision, not a patch — captured, not yet decided.)*

**Why it's ambiguous.** Each view carries a `@back` from the single-view era,
where back meant "go up / home". In a stack of side-by-side panels that button's
meaning is no longer obvious: the shipped POC wires every panel's back to
`popPanel` (drop the TAIL), so back on a middle panel drops the wrong one — the
bug Wes hit. The real question is what the affordance means when panels coexist.

**The options:**
1. **Truncate-forward** — back on panel *i* closes *i* and everything after it
   (`closePanelAt(stack,i) = stack.slice(0, max(1,i))`). Consistent with how
   OPENING already works (`openPanelFrom` discards everything forward of *i*), so
   the stack stays a linear drill-path. The editor opened FROM a file closes WITH
   the file (no orphaned child). On a phone (only the tail is visible) this is
   identical to today — back on the tail == `popPanel`, so the phone path doesn't
   move. **Lean.**
2. **Splice / close-one** — close ONLY panel *i*; panels to its right slide left
   and re-parent. Matches "I closed the files panel, keep my editor," but breaks
   the linear drill model (the editor's parent silently changes) and disagrees
   with `openPanelFrom`'s forward-truncation.
3. **Re-label the affordance by layout (on top of #1)** — the ACTION is
   `closePanelAt` either way, but on a phone (N=1) the button reads/behaves as
   "back" (pop the one visible panel = go up), while on desktop a non-tail panel's
   button reads as "close this panel" (×). Same op, honest label per context.
4. **Global back** — one app-level "undo last navigation" (= pop tail), not a
   per-panel button. Rejected by the bug: users read the button as belonging to
   the panel it's on.

**Recommendation:** #1 (truncate-forward), optionally with #3's affordance
polish (call it "close ×" on a desktop non-tail panel, keep "back" on the phone).
It's the only option consistent with `openPanelFrom`, it fixes the reported
surprise, and it leaves the phone path byte-identical. #2 is the one to pick only
if "keep the downstream panel when I close an upstream one" turns out to be what
the interaction should feel like — a call only lived use can make.

**Ready to build the moment it's decided:** the fix is one pure op
(`closePanelAt`, tested) + a one-line `backFrom` change; work order drafted at
`scratchpad/unit-back-button-fix.md`. Held pending this decision — it is a
behaviour-shaping change, and the model is Wes's call.

### ⟨Wes⟩ — decide
- Which semantics (#1 truncate-forward / #2 splice)?
- Affordance: keep a single "back" everywhere, or "back" on phone + "close ×" on
  desktop panels (#3)?

---

## The end-state of the panel shell: the board IS the sidebar, orchestration IS the panels

*(Wes, 2026-07-23, seeing the sidebar POC: "the sidebar would instead become the
vertical kanban with the right panels becoming the orchestration chat and work
panels — sessions, task creation, breakouts, terminals." Vision captured, not
scheduled — this is where the panel shell is HEADING, and it reframes what the
current pieces are FOR.)*

**The claim.** The panel shell (D39/D40) is not an IDE layout — it is the
substrate for the orchestration-first product. In the end-state:
- **The left sidebar is the vertical KANBAN** (step 9's board), not the session
  list. It is the ambient, always-visible view of all work moving through stages —
  the thing you live in.
- **The right panels are the WORK**: the orchestration chat (the conversation with
  the orchestrator about a card), the session running it, task-creation forms,
  breakout sub-sessions, terminals. You click a card in the board and its work
  opens beside the board.

**This is the convergence point of three threads already in this repo:**
- **"Sessions should not be the landing page"** (2026-07-20) and **"the human
  stays at the top and does not delve"** (the product-shape entry at the top of
  this file) → the BOARD is the landing, and it is the sidebar. Sessions become a
  work panel you open FROM a card, not the home surface.
- **"An IDE platform, orchestration as an extension layer"** → the right panels
  ARE that extension layer, made concrete: chat + work surfaces hung off the
  board.
- **D39/D40 (the panel stack) + step 9 (the board)** are the two mechanisms this
  needs, and both now exist. The panel model is what lets "click a card → its
  orchestration chat and session open beside the board" be one rule.

**What this reframes.** The current **session-list-as-sidebar (D39 #3) is
transitional** — it proved the sidebar *mechanism* (panel 0 rendered as fixed
chrome) against a surface that already existed. The target swaps that content:
the sidebar becomes the board, and the content panels grow new TYPES
(orchestration chat, task-creation, breakouts) beyond today's views. Nothing built
so far is wasted — the panel host, the layout-aware hash, the focus model, the
close-× affordance all carry over unchanged; only WHAT fills the slots changes.

**Sequencing implication (not a schedule).** The natural path from here:
1. the panel POC stabilises (back semantics, affordance — in progress);
2. a "board as the sidebar" swap (render the board where the session list is now —
   it is already a panel-hostable view);
3. new content-panel TYPES: the orchestration chat first (it is the missing core
   surface), then task-creation and breakouts as first-class panels;
4. sessions demote to a work panel opened from a card (this also answers Q2's
   "demote the session list" half — under this model the session list may not need
   to be a first-class surface at all).

**Parked. Trigger:** after the panel POC is signed off AND the orchestration chat
surface has a design. Do not swap the sidebar to the board until the board's
role as home is deliberately decided — it is the "sessions should not be the
landing page" call, finally actionable, and it is Wes's to make.

## Project-centric VIMES — the project as root scope, and the history it unlocks

*(Wes, 2026-07-24. The MODEL is decided in D42 — declared-boundary registry, no
inference, derived attribution. This entry is the SYSTEM around it: what the
reframe changes surface by surface, and the payoff Wes surfaced. Pairs with "The
end-state of the panel shell" above — sidebar=board/tasks — and "Project
onboarding" below, the init hook D42 reserves.)*

**The reframe.** VIMES stops being session-centric and becomes project-centric.
Landing = the project picker (D42). A selected project scopes every surface, so
the per-surface pickers dissolve:
- **Git** no longer asks which repo — it opens the project you are in.
- **Cost** scopes to the project, with a toggle/nav to the all-projects total —
  nearly free, the ledger is already directory-keyed; the all-projects view is the
  deliberate exception to scoping.
- **Terminals** open in the project, no path prompt.
- **Files / search** root at the project boundary.
- **Sessions demote to a panel** (answering Q2's demotion half and the 2026-07-20
  landing-page note), opened from within a project. The **session sidebar moves
  into a panel; tasks become the sidebar** with a **+New Task** rolldown, and
  tasks is ALSO available as a panel (mobile / wide-desktop typing room). This is
  the end-state entry's shape, now with the project axis beneath it.

Everything built for the panel shell carries over unchanged (D39/D40/D41): host,
layout-aware hash, focus model, close-✕. The project axis sits ABOVE the stack —
each project owns its panel stack; switching projects swaps the stack; the hash
gains a project segment (a D40 evolution, recorded in D42).

**⭐ The payoff Wes surfaced: point VIMES at an existing project and browse — or
RESUME — its entire history.** Because attribution is a cwd derivation (D42) and
the cost ledger already scans the whole `~/.claude/projects` corpus, declaring a
project retroactively lights up everything that ever ran under it — INCLUDING
sessions that never touched VIMES. Three tiers, increasing lift:

1. **Cost/usage history — already there, today. Zero build.** Declaring the
   boundary scopes the historical rows by cwd. The `<outside-project-roots>`
   bucket already proves the ledger holds non-VIMES sessions.
2. **A read-only "project history" of past sessions — a `costCorpus`-shaped
   build.** The transcripts are all on disk (full history), but D10 mirrors
   external sessions from **EOF, not replay** — so they are not live session
   objects. A NEW derived read-model over the corpus (same architecture as the
   cost ledger — recursive reader, injectable fake fs so tests never touch real
   `~/.claude`) can present "everything that ever ran in this project" scoped by
   boundary, WITHOUT replaying into the live log. **Additive to D10, never a
   reversal.** `costCorpus.ts` is the proven template.
3. **Resuming an old session — the differentiator.** Making one historical session
   live again is the existing adopt/resume path (`session_adopted` /
   resume-through-VIMES / `claude --resume`), one at a time. **This is a genuine
   edge over the bare harness: even Claude Code can't always resume an older
   session — VIMES, holding the corpus + the adoption path, can offer resume as a
   first-class action** from the history view. That is a real reason the project
   entity earns its keep: it is not cosmetic, it is the key to data you already
   have on disk.

**Discipline / boundaries.**
- Tier 1 is free; tiers 2–3 are post-MVP follow-ons. **Slice-7 MVP is picker +
  registry + derived scoping only** — do not swell the first cut into the history
  read-model.
- The history read-model MUST stay ADDITIVE to D10 (read the corpus into a scoped
  view; never replay history into the live event log) and respect corpus safety
  (injectable fs; tests never touch real `~/.claude`; live DBs READONLY).
- Resume is one-at-a-time adoption, not bulk hydration.
- Carries the worktree gap and the allow-list security sub-decision from D42.

**⟨Wes⟩ — decisions, when this is revisited.**
- The allow-list sub-decision (D42): declare-within-roots vs declare-anywhere
  (security). Gates the slice.
- All-projects cost view: toggle vs separate nav.
- Whether the history read-model ships in slice 7 or a later slice.
- **Trigger:** after slice 6 closes.

## Mined from the AgenC-core decomp — admission-kernel forward design, `vimes doctor`, pagination discipline

*(2026-07-24, `docs/decomposition/agenc-core-decompose.md` reviewed. AgenC is a
mature coding-agent harness that independently converged on VIMES's bones —
persist-before-publish = I13, rollout-authority = D12, per-spawner budgets. Worth
banking, with the orchestrator's caveats. The immediate cheap wins were folded into
their homes — pointers at the bottom.)*

**The load-bearing insight — observed-vs-owned budgets.** VIMES cannot reserve
against Anthropic's 5h/weekly counter (rule 0.7 — observational only), but the
**orchestration layer's internal allocations** — the software-orchestration spawn
budget the orchestrator hands each worker (the VIMES-builds-VIMES north star) — ARE
owned, and can take reserve→constrain→settle instead of I10's check-then-spawn.
That split is what makes the admission-kernel idea tractable rather than a rule-0.7
category error.

**Bank these fail-closed accounting RULES for the internal-allocation layer**
(slice-7 machinery; the rules are bankable now, rule 0.5):
- **`held_unknown`** — a missing/malformed usage block charges WORST CASE against
  the internal allocation, never zero (composes with the D17 `message.id`
  MAX-dedupe).
- **subtree cancellation** — a worker that blows its allocation takes its delegated
  children with it; the overrun is evented.
- **fail-closed spawn** — if the allocation can't propagate to a child process, the
  child does not run.
- **no mutation/reset RPC** for accounting — I12's spirit extended to allocations.

**⚠ Caveats (the gate's, not the decomp's):**
1. **Do NOT import AgenC's decision vocabulary wholesale.** VIMES already has a
   dispatch vocabulary (`DispatchRefuseReason`,
   `spawned/deferred/refused/spawn-failed/resumed/resume-failed`,
   `dispatch_refused`, the two-vocabularies-kept-apart discipline in
   `taskDispatcher.ts`). Adopt only the CONCEPTS VIMES lacks (`held_unknown`,
   `provider_overrun`, `reconciled/settled`) WHEN the machinery lands — not the
   enum, which would collide.
2. **Internal allocations do not exist yet** — I10 is check-then-spawn against
   OBSERVED headroom. This is reserved design, not backlog.
3. **Gate/budget unification (AgenC's open Q2) — lean SEPARATE.** AgenC folds
   `approval_required` and budget denial into one decision set. A gate is a
   human-approval decision; a budget refusal is a resource constraint — convergent
   *surface* (both set `needsAttention`), not shared essence. Worth ONE design pass
   at T7-time; prior is they stay separate decisions with a shared surface.

**`vimes doctor` / self-audit — a real operator command (later, not now).**
Composes the series' scattered preflight items into one artifact: localhost-only
binding, Access JWT middleware self-probe (I14 against itself), secret-file perms,
hook-relay wiring, CLI version vs lockfile, authenticated-not-just-installed.
Dovetails with the deploy-preflight discipline in CLAUDE.md. AgenC's `security
audit --fix` / `doctor` is the reference.

**Immediate cheap wins — FOLDED 2026-07-24:**
- **Snapshot-verify-before-migrate → D11** (open-questions): snapshot → VERIFY the
  snapshot → migrate → keep the named `<db>.pre-<schema>.sqlite`. Hardens VIMES's
  `VACUUM INTO` gesture with "verified" + "named-by-schema-version."
- **Bounded/cursored control-plane reads → Q2** (QUEUE): pagination-by-design on
  list/replay/search is the STRUCTURAL fix for Q2's scroll cost — a phone over a
  tunnel needs it regardless of the retention call.
- **Self-enforcing toolchain pins** — add `packageManager` + `devEngines` to root
  `package.json` so the Node-24 pin is toolchain-enforced, not just `.nvmrc`/
  `engines` + the ci-gate check. Trivial config, next repo-config pass. (AgenC
  rides Node 25.9; VIMES keeps its LTS discipline — the self-enforcing *practice*
  is the lift, not the version.)

**Codebase map for dispatched agents — don't start blind (later, project-loop slice).**
Wes's idea (2026-07-26), evidenced live by the first clean Gate-1 planning run
(task `1c32e554`, game codebase `~/projects/games/1e9999`): the tools-clamped
planner spent **~4.8 min** running `ls`/`cat`/`grep` to build "a complete picture"
of the codebase entirely from scratch. Every dispatched task re-derives that map
blind — slow, token-heavy, and *inconsistent* (each agent forms its own mental
model). **Direction:** give the planning (and implementing) briefing a pointer to
a per-project layout doc — e.g. "start from `codebase_map.md` for the general
layout, then verify what you actually touch." Composes cleanly with what shipped
in S7·5c: it is just another conditional block in `composeStageInstruction`
(present → include the pointer; absent → today's behaviour), same I8 discipline as
the work-order sections. **Open sub-questions (for the project-loop slice):**
(a) *static maintained doc* (a human/agent keeps `codebase_map.md` current in the
target repo — cheapest, but drifts) vs *generated/refreshed* (VIMES regenerates it
on some cadence — accurate, but who pays the cost and when); (b) does it live IN
the target repo (versioned with the code, visible to non-VIMES use) or in VIMES
state; (c) staleness handling — a wrong map is worse than none (observed-truth
rule 0.7 tension: the map is *declared*, the code is *observed*, so the briefing
must tell the agent to trust the code over the map on conflict). **Trigger:** the
shift to the more project-oriented loop. **Lean:** static in-repo `codebase_map.md`
first (pointer-only, agent told to verify against live code), generation later if
drift proves painful. Relates to D43 (work-order as the machine-read spec) and the
S7·7a/S7·5c briefing seam.

**MCP to expose VIMES-native tools to the orchestrator + task layers (later slice).**
Wes's idea (2026-07-26, at the first end-to-end Gate-1 loop close): rather than
workers only having the generic built-in toolset, VIMES could run an **MCP server
that exposes its own tools** to (a) dispatched task/worker sessions and (b) the
orchestrator layer. Concrete candidates this unlocks: the **abort-and-flag** tool
the two-footing model needs (`docs/QUEUE.md` — a worker that hits a classifier
denial "raises a flag" via a tool call the orchestrator picks up), a
`submit_plan`/`report_review` surface, VIMES-state queries (task/board reads), etc.
— i.e. VIMES becomes a first-class tool provider to the sessions it drives, not just
a process host. **⚠ Interacts directly with the S7·5c D50 clamp** (observed-truth
note for whoever builds this): dispatched sessions run under a CLOSED `tools`
allowlist that deliberately EXCLUDES `ToolSearch` (the deferred/MCP-tool discovery
surface) and every spawn surface. MCP tools are typically surfaced via that deferred
mechanism, so exposing VIMES MCP tools to a clamped session will require explicitly
threading the MCP tool names into the allowlist (and characterising — rule 0.7 —
whether the SDK's MCP exposure honors or bypasses the `tools` allowlist, and whether
`ToolSearch` must be re-admitted, which would need its own re-clamp so it can't
become a spawn escape hatch). **Trigger:** the orchestrator-role / project-oriented
loop buildout (the abort-and-flag tool is the first genuine need). **Lean:** hold
until a concrete tool needs exposing (define-at-first-instance); the abort-and-flag
tool is the likely first customer. Relates to D50 (the clamp), the QUEUE two-footing
model, and D43/D44 (the work-order/plan seam).

**Skip, confirmed:** the harness itself (VIMES drives Claude Code, doesn't replace
it), the relay/ticket infra (tunnel + Access already solves single-operator reach),
channel gateway, browser/SSRF, OS sandbox — all horizon-only. The decomp's skip
list is well-reasoned.

## Mined from the agent-of-empires decomp — UI doctrine, and the differentiator made visible

*(2026-07-29, `docs/decomposition/agent-of-empires-decompose.md` reviewed and
ratified by Wes same day. AoE is the closest competitor in the series — same
lane (tmux-backed sessions, mobile PWA over a tunnel, push, diff review), ahead
on session-manager polish, with **no work-order/verdict machine anywhere in it**.
The operational carry-overs live in the decomposition README tracker; the two
UI-shaping consequences land here because they bind the redesign era.)*

**1. Write the UI design doctrine doc before the next substantial agent-built
UI unit.** AoE keeps `web/DESIGN.md` — a standalone written design system with a
product classifier, numbered principles, a full type table, named surface
tokens, and an explicit **"what we avoid"** list ("AI slop patterns: purple
gradients, 3-column icon grids, centered-everything"). VIMES has an architecture
constitution but nothing equivalent for the UI — and under the standing
nothing-is-sacred stance above, large agent-built redesigns are COMING. One page,
written once, is what keeps N agents' UI work coherent through a reshape: it is
a **work-order input** (cite it in every UI WO the way design-principles is
cited in core WOs), not a style guide. Contents when written: the principles
(including "real estate to content, not chrome" from the UI-shape entry above,
and AoE's "density over chrome" which VIMES shares), the type scale, the named
tokens already in use (ink/panel/line/accent/warn), and the avoid-list.

**The divergence to state in that doc, verbatim-worthy:** AoE's principle is
"mobile is monitoring" — on the phone you mostly *watch*. **VIMES's is the
opposite: mobile is for DECIDING** — pillar 5, answering a gate in one tap while
the cache is warm; watching is incidental. That difference is what justifies
every decide-in-one-tap interaction (tier-0 notification actions, the gate
cards) and it is the sentence that keeps a UI agent from optimizing the wrong
thing on the small screen.

**2. The verification loop must be VISIBLE in the UI, not just true in the
architecture** (aoe §7, the strategic consequence). AoE's structured view has
plan panels, tool-call cards, swipe-to-approve — the same visual language VIMES
is building. What it cannot render, because the concepts don't exist in it:
a work-order with acceptance criteria, a plan crossing an agent boundary as an
artifact, a fresh implementer, a criterion-keyed verdict, a bounce loop. **If
the board reads as a nicer session list, VIMES gets compared to AoE as a
session list — and loses.** Standing input for every board/redesign unit: the
differentiators go on screen FIRST — provenance chips (orchestrator-authored vs
hand-made, already required by the Gate-2 pivot criterion), per-criterion
verdict state, attempt/bounce history, the work-order itself as the card's
face. Per-tool-call approval is what AoE has; per-criterion verification is
what VIMES is — the screen should make that difference legible at a glance.

## One daemon, N faces — the VIMES CLI client

*(Wes, 2026-07-29, reading the AoE decomp: "this is a product that runs
entirely in a CLI window and I think we could have a version of that without
much trouble… a Vimes CLI terminal you can open to do work locally which is
also reflected in the website/app, sessions mirrored properly and alerts still
working via your phone." Ratified as a direction same day — "love the idea."
Captured, not scheduled.)*

**The thesis: the daemon is the product; every face is a client.** Rule 0.3
already made this true — the web UI talks only HTTP+WS, and nothing in the
daemon knows what renders. A terminal client is a THIRD face (web, push, CLI),
not a new architecture. AoE walked the same road in the opposite direction
(TUI first, web added); the lesson transfers: same daemon, multiple faces.

**What falls out free, verified against the current build (2026-07-29):**
- **Sessions mirror automatically** — subscribe semantics are already
  client-count-agnostic (two browser tabs prove it daily). A CLI attached to a
  session and a phone watching it are two subscribers on one stream.
- **Alerts keep working untouched** — push is daemon-side, driven by the
  attention model, independent of which client (if any) is connected.
- **The PTY story gets BETTER, not merely ported.** Rule 0.8 relays terminal
  bytes verbatim; the web needed xterm.js to reconstruct a terminal from those
  bytes — a real terminal IS the native renderer. `vimes attach <session>` is a
  thin WS client: stream to stdout, stdin upstream, SIGWINCH → the resize API.
  This is the killer feature and the cheapest one.
- **Project scoping from cwd** — the D61 symmetry: the web needed
  path-carries-project URLs; a CLI run inside a project directory scopes itself
  via `projectForCwd` (S8·1's core authority), no flag needed.
- **The recursion hazard does NOT worsen** — the CLI process is a *client*,
  not a daemon child. A daemon restart drops its connection (reconnect), not
  its existence; the claude process underneath is the same beat-7-recoverable
  session it is today.

**The three real gaps:**
1. **Auth — the only architectural one.** I14 is deliberately fail-closed with
   NO loopback exemption (verified in `auth.ts`; a local `curl` to :4600 401s
   today). **Wes 2026-07-29: not adding auth yet, but eventually.** → D63 in
   open-questions carries the lean: `cloudflared access` token through the
   public URL first (zero daemon changes, I14 stays a single choke point); a
   local credential path (unix socket, or loopback bearer per the hook-ingress
   posture — cf. the "alert my phone" entry above, same decision territory)
   only if tunnel latency annoys in practice.
2. **The client-kit extraction — "completing the separation," mostly
   mechanical.** The house rule already did the hard part: everything in
   `packages/ui/src/lib/` is pure, tested, framework-free (no Vue imports —
   why `.vue` carries no logic). Extract the shared surface (`types`,
   `sessionRow`, `dispatchFollow`, `orchestratorEntry`, `sessionListPartition`,
   `projectContext`, …) into a `packages/client-kit` both faces consume.
   Forcing-function bonus: anything that WON'T extract cleanly is web-coupling
   debt found early.
3. **The TUI itself — the real cost, and it tiers.** **Tier one: a thin
   command CLI** (`vimes ls / attach / board / orchestrator`) — cheap, high
   dogfood value, `attach` alone changes the daily workflow. **Tier two: a
   full-screen dashboard** — a genuine product surface that competes on AoE's
   home turf, which the aoe §7 read says not to do. If tier two is ever built,
   the visible-differentiator entry above applies in full: a TUI that is just
   session-switching is tmux with extra steps.

**Sequencing lean:** the client-kit extraction pairs naturally with the
slice-9 design pass (it is the same "what is the contract between the daemon
and ANY consumer" question the D62 ACP read informs); the tier-one CLI is an
early-slice-10 candidate after the Gate-2 trial. Nothing here preempts slice 8.
**Trigger:** Wes schedules it; D63 must be settled (or consciously deferred to
the public-URL path) before the first CLI unit.
