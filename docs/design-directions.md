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
- **Mobile terminal is inherently cramped — accepted.** Full TUIs (Claude
  Code's own included) don't fit a narrow phone even when rendered correctly;
  code-server's "readable but cluttered" is the realistic ceiling. The
  2026-07-20 corruption was a real pty-sizing bug (fixed to reach that
  ceiling), but the strategic answer to "TUIs on mobile are bad" is NOT a
  better mobile terminal — it's the escape-hatch posture + chat/voice as the
  real mobile surface (mobile-final-form note above). Do not invest in making
  the mobile terminal a daily driver.

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
