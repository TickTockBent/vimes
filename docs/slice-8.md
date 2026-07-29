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

- **SP8·1 — PreCompact-hook observed behavior** (rule 0.7): does the hook fire
  as documented; what does it see; can it defer/decline (the agency mechanism)?
  If deferral is impossible at the hook layer, the fallback is VIMES-side
  nudges (daemon watches context fill from stream events, messages the
  orchestrator) — acceptable, possibly preferable (policy stays in VIMES).
- **SP8·2 — Resume-across-restart fidelity**: the maintained-singleton respawn
  path leans on resume surviving a daemon restart; verify re-anchor + resume on
  a real long transcript before S8·4 builds the lifecycle.

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

### S8·2 — Picker + the global project pointer (UI) — `sonnet` *(UI-only)*
- **Scope:** the project picker (list + New Project) and a client-side global
  pointer (selected project) that the BOARD and SESSION-SPAWN surfaces adopt
  now; sessions list / cost / files / git / search adopt incrementally later
  (each adoption a small follow-up unit, not this one).
- **Assertions:** pointer derivation logic in `lib/` tested; `.vue` manual.
- **Exit:** Wes picks a project on the phone; board + new-session default to
  it. **Kill:** scoping the board breaks the global view Wes still needs →
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
- **Exit:** kill the daemon mid-conversation; on restart the orchestrator
  comes back re-anchored and the conversation continues sensibly (HUMAN
  half: Wes judges "continues sensibly"). **Kill:** SP8·2 shows resume cannot
  be made reliable across restarts → the lifecycle needs a redesign (fresh
  transcript + re-anchor every restart), decision record first.

### S8·4 — The transcript lifecycle (D57) — `opus` *(spike-gated)*
- **Scope:** capture-then-compact per D57 on whichever mechanism SP8·1
  validated: threshold ⟨tune⟩ (~250–300k tokens), escalating nudges, the
  orchestrator's delay agency, precompaction capture into standing notes
  before any compaction. Bands (<40% general / ~60% rolling) recorded as
  design bands — NOT pinned as FAIL-able assertions (Gate-D).
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
