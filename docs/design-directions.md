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
