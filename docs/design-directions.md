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
