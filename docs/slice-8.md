# Slice 8 — Project-centric VIMES + the standing orchestrator (D56/D57)

*(Opened 2026-07-29. This slice IS slice 7's phase two, re-framed by the D56
design pass: the orchestrator is a standing per-project entity the daemon
maintains, not a session with a role flag — which makes D42's build (project
registry + picker + global pointer) a prerequisite rather than a parallel
track. Slice 7 closes with its behind-gate machinery complete and phase two
superseded by this document. Gate-2's authorship trial and its ~10-task pivot
criterion carry forward unchanged.)*

**North star check (design-directions):** this slice is the one that makes
"using VIMES to build VIMES through the orchestrator" possible — the recursion
the project aims at. Build accordingly: every unit here gets used against the
VIMES repo itself as soon as it lands.

## Shape: three phases, strictly ordered, one gate each

```
Phase A — D42 build (project registry, picker, global pointer)
Phase B — the standing-orchestrator foundation (entity, lifecycle, surface)
Phase C — the author grant (create_task) → GATE 2 TRIAL OPENS
```

Phase A before B because a standing per-project entity needs "project" to be
first-class (D56). Phase B before C because verbs are grants on a standing
thing — landing the author verb on a disposable session would rebuild it.

## Spikes (front-loaded, before Phase B builds on the answers — D57 names them)

- **SP8·1 — PreCompact-hook observed behavior** — ✅ **RUN 2026-07-29** (findings:
  `scratchpad/spike-sp8-1-precompact-FINDINGS.md`, CLI 2.1.220, all seven
  questions OBSERVED). Headlines: the hook is a **real veto — exit code 2 ONLY**
  (JSON `decision:"block"`/`continue:false` are accepted and silently IGNORED;
  no `additionalContext` channel exists for PreCompact); a blocked auto-compact
  is **re-offered every turn** (5× observed, across separate processes); the
  hook runs to completion **before** summarization with no observed time cap
  (capture-then-compact is mechanically supported without the veto in the
  common case); `trigger` distinguishes auto/manual; `DISABLE_AUTO_COMPACT=1`
  suppresses auto-compaction entirely; the transcript is **append-only** across
  compaction (`compact_boundary` + `isCompactSummary` records, with OBSERVED
  `preTokens`/`postTokens`). Bonus finding: **compaction is currently invisible
  to VIMES** (both ingestion paths drop `compact_boundary`; the summary lands
  as an ordinary user message) → new unit S8·4a below. Four risk-register rows
  added (blocking semantics per CLI bump; circuit-breaker strings in the
  binary — single-process sustained deferral UNVERIFIED; env knobs read as test
  hooks; summary fidelity on real state).
- **SP8·2 — Resume-across-restart fidelity** — ✅ **RUN 2026-07-29** (findings:
  `scratchpad/spike-sp8-2-resume-FINDINGS.md`, all six questions OBSERVED).
  Headlines: **perfect planted-fact recall through every kill shape** (early/
  mid-stream SIGTERM, repeated cycles, SIGKILL, post-compaction — 8/8 every
  time); the CLI **auto-normalizes dead turns on resume** (synthetic "Continue
  from where you left off" pair, fires for marked SIGTERM and markerless
  SIGKILL deaths alike — S8·3 must NOT reinvent this); **`--resume` requires an
  EXACT cwd match** (wrong cwd = hard failure, no fallback, no override flag);
  the model spontaneously and correctly reads its own interrupted-turn wreckage.
  Consequence: the re-anchor briefing's real job is "a restart just happened —
  check for in-flight dispatched work", not fact-recall insurance.

## Phase A — D42 build (project-centric VIMES, minimal-first)

### S8·1 — Project registry (core + daemon) — `opus` *(schema-shaping)*
- **Scope:** `project_declared` / `project_removed` (or rename—design in the
  WO) events + projection (the registry: id, root directory, display name,
  declaredAt) + REST surface (list/declare/remove) + validation against
  `VIMES_PROJECT_ROOTS`. Event-sourced per D42: declared, never inferred.
- **Assertions:** I6 replay; declare/remove round-trip; a root outside the
  allowlist is refused and evented as a refusal (or 4xx-no-event — WO decides
  with the taskWriter unknown-task precedent); registry projection total over
  hostile payloads (I8 posture).
- **Exit:** core+daemon green, double-run identical. **Kill:** the registry
  needs identity semantics the event log can't give (rename/merge of roots) →
  halt, decision record.

**✅ BUILT + ORCHESTRATOR-VERIFIED 2026-07-29** (deploys with S8·2 in one
restart). The `'projects'` stream lands whole: created/updated/archived + the
RESERVED `project_initialized` (no emitter, D42's onboarding hook); the
stream-local fold (archive flags, never deletes — history stays attributable);
`projectForCwd` as the SOLE attribution authority (longest-prefix, segment-
boundary-aware — `vimes` never swallows `vimes-2`; archived excluded; ties
unrepresentable because the writer refuses exact-duplicate live roots);
`ProjectWriter` (refusals emit nothing; archived roots reusable → NEW minted
id); routes validating against the STATIC config roots (D60 — the route
comment names the worktree-cwd escalation this prevents). Suite 2682 → 2766
(+84). Verification: agent's four sabotages (bare-startsWith, archived-skip,
fence-widening, validation-order) + orchestrator's independent
shallowest-wins inversion — each reddened exactly its measuring tests,
snapshot-restored byte-identical. Root is deliberately NOT patchable (a
different directory is a different project).

### S8·2 — Picker + project-rooted URLs (UI + one daemon route) — `sonnet`/`opus` *(D61 — restart on deploy, NOT UI-only)*
- **Scope (widened by D61, 2026-07-29):**
  - **Daemon:** the SPA fallback route — any non-`/api`, non-asset GET serves
    `index.html` (Vite assets are absolute; auth wall unchanged).
  - **UI:** pathname → project resolution against the declared registry
    (bare `/` or unknown → picker; declared → root the panel stack there;
    within-roots-but-undeclared → picker with "declare this?" pre-filled);
    the picker itself (list + New Project, POST /api/projects); per-project
    **last-layout memory in localStorage** (no hash → restore; hash present →
    deep link wins); the BOARD and SESSION LIST scoped through `projectForCwd`
    (tasks by projectRoot, sessions by cwd — Wes's per-tab "separate task
    trees and session lists"); session-spawn defaults to the project root.
  - Cost / files / git / search adopt the scope incrementally later (small
    follow-up units, not this one).
- **Assertions:** path↔project resolution + last-layout keying + scope
  filtering logic in `lib/` tested; `.vue` manual; daemon fallback route
  tested (api/assets not shadowed; deep paths serve index).
- **Exit:** Wes opens two tabs on two projects from the phone; each shows its
  own board + session list; a pasted session deep-link lands scoped.
- **Kill:** scoping the board breaks the global view Wes still needs →
  design a both-views answer before proceeding.

## Phase B — the standing orchestrator (D56)

### S8·3 — The entity + maintenance lifecycle (daemon) — `opus` *(the heart)*
- **Scope:** orchestrator as a daemon-MAINTAINED singleton per project:
  its session record marked as orchestrator-kind (schema widening, rule 0.5
  discipline), excluded from ordinary session-list projections' default view;
  boot-time reconciliation (respawn/resume the orchestrator for each project
  that has one); the **standing-notes anchor** (artifact-store blob the
  orchestrator owns and updates — its automated HANDOFF); the re-anchoring
  briefing composer (core, pure — board state + doctrine pointers + standing
  notes). The QUEUE'd `startProcess` options-object conversion lands at the
  top of this unit (the spawn path grows again — the trigger the finding
  named).
- **Assertions:** singleton invariant (a second orchestrator spawn for the
  same project is refused + evented); restart reconciliation (fixture: daemon
  boot with a live-orchestrator record → resume attempted); re-anchor briefing
  composition golden; exclusion from default session list pinned.
- **SP8·2 consequences (build against these):** the orchestrator's **cwd is
  persisted verbatim and read back on every respawn, never re-derived** —
  `--resume` hard-fails from any other cwd, no fallback. Do NOT build
  interrupted-turn detection — the CLI auto-normalizes dead turns (SIGTERM and
  SIGKILL alike) with a synthetic recovery pair on the next resume. The
  re-anchor briefing's job is restart ORIENTATION ("check for in-flight
  dispatched work"), not fact recall — the transcript carries facts fine.
  SIGKILL needs no special handling for resume (only messier on disk).
- **Exit:** kill the daemon mid-conversation; on restart the orchestrator
  comes back re-anchored and the conversation continues sensibly (HUMAN
  half: Wes judges "continues sensibly"). **Kill:** SP8·2 shows resume cannot
  be made reliable across restarts → the lifecycle needs a redesign (fresh
  transcript + re-anchor every restart), decision record first.
  *(SP8·2 ran: resume is reliable in every scratch scenario tried — the kill
  criterion now guards the VIMES-context integration, not the CLI mechanics.)*

### S8·4a — Compaction visibility (core + daemon) — `sonnet` *(SP8·1 unprompted finding)*
- **Scope:** VIMES currently cannot see a compaction happen. Recognize the
  `compact_boundary` record in BOTH ingestion paths (transcript mapper's
  early-out drops any record without `message.role` — the `queued_command`
  recognizer is the placement precedent; the SDK path handles only
  `system/init`), and mark the `isCompactSummary: true` record so the summary
  stops masquerading as an ordinary 4KB user message. Fold what
  `compact_metadata` carries — **observed `preTokens`/`postTokens`** — into a
  projection the nudge policy (S8·4) and the UI can read.
- **Why it matters beyond hygiene:** observed `preTokens` at real compactions
  is the rule-0.7-clean answer to "how full is this model's window" — it makes
  the declared model→limit table (`contextFill.ts`'s known gap) unnecessary.
- **Assertions:** both paths emit the new event from fixture transcripts
  (capture real ones from the spike logs); summary record distinguishable; I6
  replay; existing transcripts without compactions fold byte-identically.
- **Exit:** a `/compact` in a live session shows up in VIMES's event log with
  its token metadata. **Kill:** the record shapes vary across CLI versions in
  ways a loose-zod recognizer can't absorb → risk-register escalation.

### S8·4 — The transcript lifecycle (D57) — `opus` *(spike answered; mechanism below awaits Wes's sign-off)*
- **Scope:** capture-then-compact per D57: threshold ⟨tune⟩ (~250–300k
  tokens), escalating nudges, the orchestrator's delay agency, precompaction
  capture into standing notes before any compaction. Bands (<40% general /
  ~60% rolling) recorded as design bands — NOT pinned as FAIL-able assertions
  (Gate-D).
- **⟸ Gate-D pause — the SP8·1-recommended mechanism shape (sign-off needed):**
  **the hook holds the door, the daemon nudges early.** The PreCompact hook
  vetoes via **exit 2 only** (never a JSON decision — observed to be silently
  ignored; risk-register row pins this per CLI bump) while state is unbanked,
  exits 0 once banked; because the hook also runs to completion BEFORE
  summarization, a synchronous file-level bank needs no veto at all — the veto
  covers banking that needs a MODEL turn. The daemon nudges the orchestrator
  at the ⟨tune⟩ thresholds using `latestContextTokens` (already folded in
  `cacheObservability`, per-turn granularity — fill is known between turns,
  never mid-turn), so the veto rarely fires. Banked state re-enters via the
  session's own notes or a `SessionStart:compact` hook (observed to fire) —
  PreCompact itself CANNOT inject context. Optional strongest form:
  `DISABLE_AUTO_COMPACT=1` + VIMES-driven deliberate `/compact` (env var is a
  rule-0.6 fragile surface — boot-time canary probe if adopted). One
  spike-row remains before relying on LONG deferral: sustained veto in a
  single long-lived process (breaker strings exist in the binary).
- **Exit:** an orchestrator driven past threshold captures, compacts, and
  demonstrably retains the banked state post-compaction (verify by asking it).
- **Kill:** neither hook-deferral nor VIMES-side nudging can sequence capture
  BEFORE compaction reliably → halt; lossy compaction without capture violates
  the D56 identity model.

### S8·5 — The orchestrator surface (UI) — `sonnet` *(UI-only)*
- **Scope:** the top-level chat surface bound to the global pointer — the
  design-directions "home" evolution in its minimal form: an Orchestrator tab/
  entry that opens THE project's orchestrator chat (spawn-on-first-open),
  reusing the stream view's message components. Full home-page reshuffle
  stays out (post-pivot investment).
- **Exit:** Wes talks to a project's orchestrator from the phone without
  touching the session list.

## Phase C — the author grant

### S8·6 — `create_task` exposure + doctrine briefing — `opus` *(opens Gate 2)*
- **Scope:** the surviving S7·9 skeleton material in the standing-entity
  frame: `createTaskToolPayloadSchema` (title/scope/explicitlyOut/criteria-
  text-only/kill — NO projectRoot/stage/isolation/gates, forced server-side),
  `buildCreateTaskSpec` on the D52 tool channel, exposure matrix pinned both
  directions (stage runs never see it; the orchestrator never sees report
  tools), in-run validation, acknowledgement naming the minted taskId +
  "promotion is Wes's, from the board"; the authoring-doctrine briefing
  section (checkable criteria, real kill conditions); `task_commented`
  reserved (D59); board provenance chip (orchestrator-authored vs hand-made —
  the pivot criterion needs it legible). D58 (permission mode) settled at
  this unit's Gate-D pause.
- **Assertions:** forced-field test (hostile payload naming another project/
  stage → forced values win); hostile-input set (malformed → in-run error,
  zero events); I7 (handler reaches the sole writer's create path only — can
  never transition/dispatch/amend); I6 fixture replay.
- **Exit (HUMAN — opens the trial, does not close it):** Wes converses with a
  project's standing orchestrator; it authors a real work-order; the task
  lands in backlog correctly shaped; Wes promotes; the loop runs it.
- **Kill:** exposure can't be granted without weakening D50's dispatched
  clamps or forcing one exposure mechanism to serve two doctrines → halt.

### ══ GATE 2 TRIAL ══ (runs AFTER S8·6, on real work — the pivot criterion)
~10 real tasks authored through the orchestrator. If authored work-orders need
substantial human rewrite MORE OFTEN THAN NOT → **stop expanding verbs; fix
schema or doctrine first** (slice-7 phase-two criterion, carried verbatim).
Drive verbs (promote/move/dispatch/amend — S8·7+) come only after the trial
passes, one individually-revertible grant at a time. Board-events-as-turns is
the far seam: reserved, unbuilt, undesigned.

## Explicitly OUT (slice-wide)

Drive verbs beyond author · `task_commented` emitter (D59) · board-events
delivered as orchestrator turns · full home-page reshuffle · surface-by-surface
pointer adoption beyond board+spawn (incremental follow-ups) · voice · desktop
bespoke layout · multi-project orchestration · orchestrator-initiated amend
(the `amendedBy: 'orchestrator'` wire waits for its grant decision).

## MVP line

S8·6. Everything after (drive verbs, events-as-turns, home reshuffle) must
survive the Gate-2 trial's contact with real use before it earns its build.
