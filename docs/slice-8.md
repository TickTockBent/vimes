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

**✅ BUILT + ORCHESTRATOR-VERIFIED 2026-07-29** (deployed with S8·1, one
restart). **HUMAN EXIT PASSED 2026-08-04 (Wes, walk 1):** two tabs (johnny /
vimes) correctly scoped — boards and session lists independent; a
never-touched third project scoped clean (zero sessions); deep links land
scoped. Known-and-expected gaps confirmed live, already queued as the
incremental-adoption follow-ups: git / search / costs not yet scoped;
terminal shells don't default to the open project's root. D61 made real:
`shouldServeAppShell` (the extracted fallback rule — /api NEVER falls back, a
deliberate fix to the pre-existing extension-less fallback that served 200 HTML
for unknown API paths; asset detection by STATIC_CONTENT_TYPES membership so a
dotted project dir stays URL-addressable); `pathSegment`/`rootsBases` decorate
the projects list at read time; `lib/projectContext.ts` (path parsing hardened
against traversal, the `cwdWithinProject` MIRROR with the lockstep comment +
the vimes/vimes-2 trap pinned on both sides, display-name basename fallback,
layout memory with deep-link-wins); the picker (real `<a href>` rows,
declare-prefill mode, unreachable-registry retry); board + session list scoped,
spawn/create defaulting into the project. Suite 2766 → 2818 (+52). Agent
verified .vue types via vue-tsc + compiled all touched SFCs; two agent
sabotages + orchestrator's /api-exclusion removal (2 reds exact), all
snapshot-restored. Segment-less projects (base root declared as project)
render as honest non-link picker rows.

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

**✅ BUILT + ORCHESTRATOR-VERIFIED 2026-07-29. HUMAN EXIT PASSED 2026-08-04
(Wes, walk 2 — the kill-daemon walk):** founded via the S8·5 header button;
the orchestrator wrote a complete standing-notes file UNPROMPTED (identity,
orchestration rules, deploy realities incl. the recursion hazard, the banked
code word); daemon restarted mid-conversation; comeback resumed cleanly and
recalled the code word on request. Wes: PASS. Two findings from the walk,
neither blocking: **(a) tool confabulation** — the founding briefing never
states which VIMES verbs are granted (currently none), and the orchestrator
conflated the harness's built-in TaskList (its private session todo tool)
with board access, writing a wrong capability belief into its own notes →
folded into S8·6's doctrine briefing (a "your tools today" section + Wes's
naming lean: prefix VIMES-native tools or call out exact names). **(b) the
502 screen** — the instant the daemon died, the frontend showed Cloudflare's
Bad Gateway page until a manual reload after restart; the client must absorb
a daemon restart gracefully → recorded in design-directions ("hot reload"
entry, the client half). Note: recall rode the TRANSCRIPT (resume path,
SP8·2); the notes-carry path only exercises on a refound — the
kill-the-transcript variant remains an unrun optional walk.
Three skeleton calls locked: **lazy maintenance** (no boot respawn — the
record knows, ensure reconstructs on contact, refounding carries notes),
**file-based standing notes** (`~/.vimes/orchestrator-notes/<projectId>.md`,
written by the orchestrator's NATIVE file tools, read into every founding —
no Phase-B tool surface), **ensure-idempotent** (singleton by construction:
the handler is synchronous end-to-end, with the D54-reopening condition named
in a comment). The QUEUE'd `startProcess` options-object conversion landed
first, behavior-neutral (baseline 2818 untouched, no test edits). Widening:
`orchestratorForProjectId?` on the session record (presence IS the kind).
Composers pure + golden (founding: identity, notes contract with D56 stated
plainly, deterministic board summary, notes verbatim-or-omitted;
reorientation: interrupted-resume ONLY — a dormant resume has no restart
story, pinned). cwd spawned VERBATIM off the record — pinned with a SYMLINK
test (SP8·2). Ensure envelope: already-live (no turn) / resumed / founded
(+refounded) / spawn-refused / resume-refused + briefingDelivery (both agent
deviations ratified). Suite 2818 → 2871 (+53). Agent's four sabotages +
orchestrator's dead-adoption sabotage (2 reds exact, incl. the agent's own
"dead newest must not shadow resumable older" case), restored byte-identical.

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

**✅ BUILT + ORCHESTRATOR-VERIFIED 2026-07-29** (deploys with Phase B's one
restart). Built across the usage-window boundary: first agent stopped clean in
context-gathering at wind-down (checkpoint banked its fixture parse); the
wake-up run's fresh agent completed the implementation but was killed by the
headless wrapper's 600s background ceiling before reporting — the orchestrator
gated the left-behind tree directly (diff-as-testimony: green at 2901, +30).
`compaction_observed` witnessed from BOTH paths with the CLI's own casing
inconsistency observed-not-normalized (transcript camelCase vs SDK snake_case,
each cited to its spike fixture line); recognizer placed per the
`queued_command` precedent; boundary-is-the-fact degradation (missing metadata
still events); `isCompactSummary` read as a SIBLING of `message` (per the
fixture, where a nested guess would have silently never matched);
`latestCompaction` latest-wins on cacheObservability; no-double-ingest cited
to the tailer's SDK-file skip. Orchestrator sabotage: recognizer dropped →
exactly the 5 fixture tests reddened; restored byte-identical.

### S8·4 — The transcript lifecycle (D57) — `opus` *(spike answered; mechanism below awaits Wes's sign-off)*
- **Scope:** capture-then-compact per D57: threshold ⟨tune⟩ (~250–300k
  tokens), escalating nudges, the orchestrator's delay agency, precompaction
  capture into standing notes before any compaction. Bands (<40% general /
  ~60% rolling) recorded as design bands — NOT pinned as FAIL-able assertions
  (Gate-D).
- **⟸ Gate-D pause — ✅ SIGNED OFF 2026-08-04 (Wes, "as written") → decisions.md D64.
  The mechanism, as signed:**
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

**✅ BUILT + ORCHESTRATOR-VERIFIED 2026-08-04** (D64 mechanism verbatim; the
LIVE exit — drive a real orchestrator past threshold, verify capture→compact→
recall — still owed after deploy). **Step 0 first:** exit-2 semantics
RE-VERIFIED on CLI 2.1.221 with SP8·1's own rig (exit 2 blocks; JSON
decision:"block" still accepted-and-ignored; PreCompact hookSpecificOutput
still schema-rejected) — the risk-register row held across the bump. Core:
`orchestrator/compactionSteward.ts` — ⟨tune⟩ v0 config (250k/275k nudges,
300k hold — NO test asserts these values, Gate-D), `sumContextTokens` (one
rule; UI's contextFill.ts noted for collapse on next touch), epoch-resetting
memory fold (`compaction_observed` re-arms the ladder), edge-triggered
LOWEST-unsent-rung escalation (deliberate opposite of meterAlerts' collapse —
L2 must never arrive un-preceded), the fail-open door with its one non-
exception (absent notes file = positive evidence of never-banked → HOLDS;
agent-caught contradiction in the WO, ratified), pinned composers (L1
gentle/delay-agency, L2 names the door; post-compaction pointer says trust-
notes-over-summary). Events: `compaction_nudge_sent` (= DELIVERED, emitted
only after sendMessage accepts — the event IS the memory), `compaction_held`
(holds only; allows already witnessed), `hook_pre_compact` (the SIXTH hook —
required-by-code deviation: PreCompact wasn't registered at all). Daemon:
per-event relay (PreCompact carries `RESPONSE=$(curl…); [ hold ] && exit 2`,
curl-fail exits 0 — fail-open at the shell too; other five commands pinned
byte-identical), ingress ANSWERS PreCompact (bare-word body, no jq in the
hook path) + SessionStart:compact (additionalContext envelope, orchestrator
only), `CompactionNudgeLedger` + steward on meterAlerts' architecture
(bounded-read rule verbatim; watch-per-orchestrator-stream off usage_block).
Suite 2934 → 3023 (+89). Agent's three sabotages + orchestrator's epoch-reset
sabotage (exactly the 5 measuring tests reddened, incl. the daemon ledger's),
restored byte-identical. Remaining ratified deviations: sumContextTokens in
core (principle 9); router-subscription trigger (PushPipeline precedent);
`compaction_held` emitted from decideGate.

### S8·5 — The orchestrator surface (UI) — `sonnet` *(UI-only)*
- **Scope:** the top-level chat surface bound to the global pointer — the
  design-directions "home" evolution in its minimal form: an Orchestrator tab/
  entry that opens THE project's orchestrator chat (spawn-on-first-open),
  reusing the stream view's message components. Full home-page reshuffle
  stays out (post-pivot investment).
- **Exit:** Wes talks to a project's orchestrator from the phone without
  touching the session list.

**✅ BUILT + ORCHESTRATOR-VERIFIED 2026-07-29** (deploys with Phase B's one
restart; human exit — the phone walk — pending that deploy). Ships the DOOR,
not a bespoke chat (nothing-sacred stance): a header Orchestrator button beside
the scope chip (project-gated, busy-guarded) that calls S8·3's ensure endpoint
and opens the ordinary stream panel on the returned session. `packages/ui`
only, zero daemon/core. `lib/orchestratorEntry.ts` is the dispatchFollow
sibling asked of the ensure envelope — `sessionToOpenAfterEnsure` (outcome
gate decides, never id-presence) + `describeEnsureOutcome` (pinned strings:
founded/refounded info, refusals + undelivered-briefing warn; plain
already-live/dormant-resume say NOTHING — opening the chat is the feedback);
loose mirror, hostile shapes degrade, never throw. Store `ensureOrchestrator`
is the THIRD mint-path (subscribe + refresh glue, twin of dispatch/transition).
Session list excludes marked rows in both scoped and unscoped cases —
`isOrchestratorSession` FAILS OPEN TO VISIBLE (only a well-typed non-empty
string excludes; both directions pinned); stream view verified decoupled from
the partition (opens by id). +33 tests (2934 total). Orchestrator sabotage:
fail-open guard widened to key-presence → exactly the 2 fail-open tests
reddened, orchestratorEntry's stayed green; restored byte-identical, re-green.

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
  this unit's Gate-D pause. **Added from the 2026-08-04 walk-2 finding:** the
  briefing gains a **"your tools today"** section stating exactly which VIMES
  verbs are granted and that the harness's built-in task tools are private
  scratch, never the board (the founded orchestrator confabulated board
  access from its harness TaskList). Naming lean (Wes): prefix VIMES-native
  tools (e.g. `vimes_*`) or enumerate exact names in the briefing — decide at
  this unit's design pass.
- **Assertions:** forced-field test (hostile payload naming another project/
  stage → forced values win); hostile-input set (malformed → in-run error,
  zero events); I7 (handler reaches the sole writer's create path only — can
  never transition/dispatch/amend); I6 fixture replay.
- **Exit (HUMAN — opens the trial, does not close it):** Wes converses with a
  project's standing orchestrator; it authors a real work-order; the task
  lands in backlog correctly shaped; Wes promotes; the loop runs it.
- **Kill:** exposure can't be granted without weakening D50's dispatched
  clamps or forcing one exposure mechanism to serve two doctrines → halt.

**✅ BUILT + ORCHESTRATOR-VERIFIED 2026-08-04** (human exit — the trial-opening
walk — pending deploy). **Kill criterion NOT triggered, with the argument on
the record:** the grant is the MOUNT (`mcpServers`, D52-proven orthogonal to
the `tools` clamp); an orchestrator sets no clamp keys; D65's per-family
servers keep the two doctrines structurally separate — pinned both directions
(every dispatched stage sees no `vimes_board`; the orchestrator sees no report
tools). Core: `createTaskToolPayloadSchema` strict-rejects (alien key = named
in-run error, zero events), doctrine in the schema (title/scope/criteria/kill
all required); founding gains "Your tools today" (exact wire name
`mcp__vimes_board__create_task`, nothing-else-granted, harness-tools-are-
private-scratch — the walk-2 finding answered) + the authoring doctrine
(independently-checkable criteria, real kill conditions, promotion-is-Wes's).
Daemon: `createTaskTool.ts` (I7 by construction — closure holds ONLY
`createTask`; forced backlog/orchestrator/worktree/fresh-root; pinned acks
naming the minted taskId; zod v3/v4 two-way drift bind); spec contract widened
additively (`acknowledgement?` handler return, `server?` — absent =
byte-identical vimes_report mount); **footing derived at `startProcess` from
the session RECORD, not the ensure call sites** (agent-caught leak, ratified:
`sendMessage` auto-resumes dormant sessions and every SDK turn ends dormant,
so call-site threading would silently strip tools+'auto' on the first typed
turn — the record is the entity, D56's own framing); D58 lands as
`permissionMode ?? 'auto'` (explicit caller wins). UI: provenance chip,
fails to no-chip. Suite 3023 → 3104 (+81). Agent's five sabotages +
orchestrator's forced-provenance sabotage (exactly the 3 measuring tests
reddened), all restored byte-identical. Noted follow-up (Wes's call): no
length caps on the model door's payload text (the human door has
MAX_WORK_ORDER_TEXT) — flagged, not built, outside the WO field set.

### S8·6b — Work-order inspection on the board card (UI-only) — `sonnet` *(trial finding, same day)*

**✅ BUILT + ORCHESTRATOR-VERIFIED + DEPLOYED 2026-08-04.** Found minutes
into the Gate-2 trial (Wes): clicking a task showed title+id+stage only —
the ONLY surface rendering scope/explicitly-out/criteria/kill was the amend
FORM, and an inspection surface that is secretly an edit form is not one;
the trial requires grading authored work-orders from the board.
`lib/workOrderDisplay.ts`: pure derivation, null = unauthored (honest
one-line note, never an empty skeleton; bare workOrderRev is NOT authorship),
per-field absence (em-dash for text fields, omitted for lists, empties never
fabricated), criterion ids rendered dim (the identity verdicts key against —
legible from day one), untrimmed text preserved for pre-wrap. Read-only
section above the doors; amend door untouched; provenance footer reuses the
S8·6 chip derivation. +15 tests (3119). Orchestrator sabotage: null-rule
condition inverted → exactly the measuring file reddened (7); restored
byte-identical. UI-only → shipped via ci-gate, NO restart, live sessions
untouched.

### ══ GATE 2 TRIAL ══ (runs AFTER S8·6, on real work — the pivot criterion)
~10 real tasks authored through the orchestrator. If authored work-orders need
substantial human rewrite MORE OFTEN THAN NOT → **stop expanding verbs; fix
schema or doctrine first** (slice-7 phase-two criterion, carried verbatim).
Drive verbs (promote/move/dispatch/amend — S8·7+) come only after the trial
passes, one individually-revertible grant at a time. Board-events-as-turns is
the far seam: reserved, unbuilt, undesigned.

**TRIAL LOG (append per task):**

**Task 1 — `0dc79a84` searchMany() on johnny (2026-08-04).** Authored by
johnny's orchestrator on its FIRST founding (new S8·6 briefing): grounded in
the code unprompted, one-shot `create_task` call, zero validation bounces.
Orchestrator grade (Fable): **no rewrite needed** — 8 independently-checkable
criteria (incl. spy-counted single-embedding-call), 7 real explicitly-out
fences (found and fenced `searchAcross()`), genuine kill criterion. Wes
promoted as-is. Planner answered the kill criterion explicitly before
planning ("stop-condition check → Proceed"); implementer re-checked it
independently (CONTINUE), implemented per plan, ran the real integration
suite against a docker-compose test Postgres AND tore it down after, and
fenced the foreign uncommitted count() work in its worklog ("predates this
task, unrelated, left as-is"). Review dispatched by Wes (session `c95d0166`):
**8/8 PASS, attempt 1** — every verdict carries file:line evidence (e.g.
"MemoryService.ts:300 single generateEmbeddings call; integration test line
605 spies toHaveBeenCalledTimes(1)"), the reviewer RE-RAN the suites (140
unit + integration against the real pgvector DB) rather than trusting the
implementer's word, and the parity criterion was checked against actual
`toEqual(search(...))` assertions under active filters. Dispatcher routed
review→done (seq 87). **Task 1 complete end-to-end: authored → promoted →
planned → implemented → reviewed → done, zero human rewrites at any stage.
Rewrite tally: 0/1.**

**Task 2 — `ad148cd0` extract shared vector-search core on johnny
(2026-08-05, authoring grade — graded BLIND per protocol: Wes withheld his
intent).** The messier category on purpose: a refactor, in the deliberately
dirty tree. Authored one-shot (seq 88, zero bounces). Orchestrator grade
(Fable): **no rewrite needed** — verified against johnny's source: the two
duplicated blocks are real and named precisely (order-expression at
MemoryService.ts:232/320/397 verbatim-identical; row-mapper duplicated with
the namespace variant correctly called out), the `buildFilterConditions`
precedent cited is real, error-label preservation criterion matches the
actual three labels, and the explicitly-out list fences the classic refactor
failure modes (signature drift, perf scope-creep into UNION rework, test
loosening, mock touching). The kill criterion is the best authored yet: it
names the three REAL differences a shared core must absorb (single vs
per-query loop, `=` vs `IN`, namespace projection), sets a readability
stop-condition, and prescribes the correct partial fallback (extract only
the genuinely identical helpers, leave the shells duplicated). Two
annotation-level flaws, neither promotion-blocking: (a) criterion 1's
grep-check says `exp(ln(2)` "appears exactly once" but a comment at line 230
also contains the string — a literal count lands at 2 post-refactor; spirit
is unambiguous, a careful reviewer applies it to code occurrences; (b) the
order declares `isolation: worktree` for code that exists ONLY as
uncommitted work — see finding 5. **Rewrite tally: 0/2.**

*Task 2 full-loop outcome (same day):* promoted → planned → implemented →
reviewed **6/6 PASS, attempt 1** → done (seq 89–99, dispatcher-routed).
The plan (artifact `814e4c3f`) made the kill criterion's prescribed partial
fallback its opening move — a "Seam decision (already made)" section judged
the three query shells genuinely different, declined the work order's
optional full consolidation, and extracted only the two identical parts
(`buildOrderExpression`, `toSearchResult`/`toCrossNamespaceResult`) — the
right engineering call, though it never cited the kill criterion BY NAME
(task 1's planner ran an explicit "stop-condition check → Proceed"; watch
item: whether explicit kill-criterion acknowledgment should be doctrine or
stays planner's discretion). Implementer resolved the authoring nit
unprompted (the line-230 decay comment was reworded, so the literal
`exp(ln(2)`-once grep-check passes clean — orchestrator-verified: one
occurrence, line 385). Reviewer re-ran both suites (140 unit + 76
integration against a fresh pgvector up/torn down), verified all six
criteria with file:line evidence, and correctly fenced the dirty-tree
sibling work AGAIN (types.ts/mock searchMany/count lines attributed to
sibling features, not this refactor). Mid-task, trial finding 6 surfaced
organically (AskUserQuestion flattened to accept/decline — the orchestrator
asked Wes which refactor to author, got "did not answer", and proceeded on
its own marked recommendation). **Task 2 complete end-to-end, zero human
rewrites at any stage. Tally stands: 0/2.**

**Trial scope sharpened (Wes, 2026-08-05, after task 2):** the vague-ask and
find-the-bug task categories are SKIPPED, deliberately. Reasoning: the
orchestrator runs the same model that already does that work well elsewhere —
grading it on fuzzy-prompt competence would test the MODEL, which is not in
question. The trial tests the HARNESS: can the task machine author, route,
and complete real work orders without human rewrites. Remaining trial tasks
are therefore whatever real work arises, not synthetic stressor categories.

**Trial findings so far (none halting):**
1. **Worktree isolation is RESERVED, NOT BUILT** — `isolation: 'worktree'`
   rides every task record but the dispatcher spawns in the PROJECT ROOT.
   Both the planner and implementer for task 1 ran in johnny's dirty main
   tree (Wes's deliberate dirty-repo experiment — the entanglement of
   searchMany with uncommitted count() in one tree is the observed cost).
   Consequence pair when isolation IS built: planning would ground on a
   DIFFERENT tree than the live one (plan/tree skew — plan-in-worktree or
   dirty-tree warning needed), and merge-back ownership is undesigned.
2. **Review does not auto-dispatch, BY DESIGN** (D53 anti-chaining;
   dispatchDecision.ts's fail-closed promoter match). Wes: fine for now;
   future = D51's per-node auto-dispatch flag, the extension author's choice.
3. Watch item: compound criteria (task 1's #8 bundles README+spec+roadmap+
   CHANGELOG) — if a reviewer stumbles, doctrine gains "one criterion, one
   check". *Task 1 outcome: the reviewer handled it cleanly, citing all four
   artifacts by file:line in one note. Watch stays open but no stumble yet.*
4. The dirty-tree handling was GOOD at every layer without being taught:
   orchestrator flagged it at founding and banked it in notes; implementer
   fenced it in pathsRejected. No layer clobbered or absorbed foreign work.
5. **(Task 2) `isolation: worktree` declared for code that is not in HEAD.**
   `searchMany()` exists only as uncommitted work in johnny's dirty tree —
   `git show HEAD:src/MemoryService.ts` has no such method. If worktree
   isolation were BUILT (finding 1), the dispatcher would check out HEAD and
   the task's subject would not exist: planner grounds on a tree missing a
   third of the refactor's targets. Inert today (the field rides unread), but
   it upgrades finding 1's consequence pair to a triple: when isolation
   lands, the dispatcher needs a **staleness guard** — task references paths/
   symbols absent at HEAD + worktree isolation → fail loud at dispatch, never
   plan against the wrong tree. The authoring orchestrator can't be blamed
   for this (the field is schema-boilerplate to it), which is exactly why the
   guard belongs in the dispatcher, not in authoring doctrine.
6. **(Task 2, mid-trial) AskUserQuestion has no attended surface** — johnny's
   orchestrator asked Wes a multi-option question; VIMES flattened it to the
   generic gate's accept/decline (prompt = 160-char JSON truncation), and
   "accept" resolves `allow` with the ORIGINAL input unchanged
   (sessionHost.ts respondInteraction) — no human choice is ever collected or
   returned. D50 auto-denies AskUserQuestion for dispatched sessions (no
   human); the attended half was never built. Full diagnosis + build shape in
   design-directions ("AskUserQuestion needs a first-class question
   surface"). Not halting (deny tells the orchestrator to proceed on
   judgment), but it degrades the orchestrator-as-design-partner loop the
   trial exists to exercise. *Postscript (2026-08-05): the orchestrator
   ADAPTED unprompted — its notes bank a "HARNESS LIMITATION" entry with the
   correct mechanism diagnosis ("Wes only sees accept/deny — my options
   never reach him"), a workaround (options in prose, or recommend +
   proceed), and an explicit un-park trigger ("UNTIL he confirms it's
   fixed: do NOT use AskUserQuestion"). The agent routed around the
   harness gap and left a dated tripwire to un-route when it closes —
   exactly the notes-discipline behavior D56's briefing was designed to
   produce.*

## Explicitly OUT (slice-wide)

Drive verbs beyond author · `task_commented` emitter (D59) · board-events
delivered as orchestrator turns · full home-page reshuffle · surface-by-surface
pointer adoption beyond board+spawn (incremental follow-ups) · voice · desktop
bespoke layout · multi-project orchestration · orchestrator-initiated amend
(the `amendedBy: 'orchestrator'` wire waits for its grant decision).

## MVP line

S8·6. Everything after (drive verbs, events-as-turns, home reshuffle) must
survive the Gate-2 trial's contact with real use before it earns its build.
