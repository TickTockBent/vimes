# The migration map + the client contract (S9·5)

**DRAFT — proposed, awaiting pass sign-off (S9·6).**

Written 2026-08-05 as the S9·5 deliverable of the slice-9 extension-engine
design pass (D70). It answers pass scope questions 6 (the migration map and
its sequencing decision) and 8 (the client contract). Scope 7 — the drive-verb
drop-in spec — is a sibling unit and is referenced, not restated.

It consumes four settled-or-proposed inputs and adds nothing to them:

- **architecture.md** E1 (the engine inventory and its five walked decisions),
  E2 (the session tree), E3 (subprojects), E4 (what the engine API must
  carry), E5 (the migration-map seed table this document elaborates row by
  row).
- **extension-model.md** §1 (Proposed D66 — two tiers, one vocabulary), §2
  (the reserved manifest), §5 (Proposed D67 — trust and the capability
  taxonomy), §4.2 (open questions 1–12).
- **node-kit.md** §1 (the kit), §4 (the verdict — **the kill criterion is not
  tripped**; both tenants map), §5.2 (open questions 13–20). Two of its
  results bind this document directly: **q13** (the engine gains a
  workflow-instance store with engine-owned core fields — placed as an engine
  module in §1.8) and **q14** (`offered_when` is retired; exposure is
  node-declared `tools` plus entity grants — which is the exposure story §3
  uses, with no predicate anywhere).
- **The S9·0a ACP read** (§2 concept map, §5 recommendation 2). Its lean is
  settled research and is carried, not relitigated: **private protocol on both
  faces; ACP as validated external vocabulary.** Every borrowing in §3.3 is
  marked as vocabulary, never as protocol adoption.

**Nothing here builds anything.** Every placement is a proposal; every
sequencing claim is an argument for Wes to accept, reject or reorder in S9·6.
Code is cited by path and line so that the map can be checked against the
repository rather than believed.

---

## §1. The migration map

### 1.1 How to read it

Four destinations and three verbs. Both vocabularies are small on purpose: a
row whose destination needs a sentence is a row that has not been decided.

**Destinations**

| Token | Meaning |
|---|---|
| **ENGINE** | stays inside the engine (possibly renamed, possibly generalised), reachable by every extension through the public API |
| **TASKS EXT** | becomes content of the `vimes-tasks` extension (Tier 1 per D66 §1.3) |
| **SPLIT** | the file's contents divide across the boundary; the split is named at function level below |
| **CLIENT** | a client concern (engine client) or **EXT CONTRIBUTION** (a client surface an extension declares) |

**Verbs**

- **MOVES** — the code relocates with its tests; behaviour is expected
  byte-similar. Cheap, reviewable by diff.
- **REWRITTEN** — the *behaviour* survives, the code is re-expressed against a
  new vocabulary (the clearest case: `TASK_STAGE_EDGES` becomes manifest data
  adjudicated by a generic engine function). Expensive, and the place every
  regression will come from.
- **DISSOLVES** — the code disappears because a generic mechanism absorbs its
  reason for existing. Cheapest of all and the easiest to get wrong: a
  dissolving guard must be shown to be *unreachable*, not merely unused.

One rule governs every row, carried from D70 §0 and repeated because it is what
the map is for:

> **Extensions propose, the engine's deterministic core decides.**

A row that moves *adjudication* out of the engine is wrong even when it moves
the right file. The commonest instance in the whole map: the stage-edge table
moves; `proposeTransition` does not.

### 1.2 `packages/core` — the spine and the state machine

**ENGINE, unchanged in kind** (no row needed per file; named as groups so
absences are visible):

`events.ts`, `eventStore.ts`, `memoryEventStore.ts`, `sessionMachine.ts`,
`sessionIdentity.ts`, `ids.ts`, `router.ts`, `ringBuffer.ts`,
`canonicalJson.ts`, `usageBackoff.ts`, `cacheClassification.ts`,
`meterDerivations.ts`, `projections/{projection,sessions,projects,meters,
cacheObservability}.ts`, `pricing/*`, `transcript/*`, `testing/
storeConformance.ts`, `harness/*` (see the one orphan in §1.7).

| Today | → | Verb | Notes |
|---|---|---|---|
| `artifactStore.ts` + `memoryArtifactStore.ts` | ENGINE | MOVES + REWRITTEN at the key | E1-b settled: engine blob service. The content-addressing logic moves untouched; what is rewritten is the **key namespace** — the engine derives `<ext-id>/<hash>` from the caller's identity, never from a payload field (manifest §2.9: "nothing for a manifest to declare and nothing for an extension to claim"). |
| `schemas.ts` — session/project/meter/event shapes | ENGINE | stays | |
| `schemas.ts:198-202` `acceptanceCriterionSchema`, `:223-234` `taskStageSchema`, `:258-298` report payloads, `:300-420` `taskRecordSchema` | TASKS EXT | REWRITTEN | These leave `@vimes/core` entirely and land as **JSON Schema files in the extension** (`record = "schemas/task-record.json"`, node-kit §1.3), not as zod in a shared package. The rewrite is the point: a tenant shape that keeps living in core is the carve-out the kill criterion forbids. |
| `events.ts` — the `task_*` kind family (`task_created`, `task_transitioned`, `task_transition_rejected`, `task_quarantined`, `task_session_attached`, `task_worktree_created`, `work_order_amended`, `plan_submitted`, `review_reported`, `completion_reported`) | SPLIT → ENGINE (generic siblings) | REWRITTEN | **The single largest hazard in the map**, and §4.2 q8's ("do event kinds constitute stable API?") first real bill. Each tenant kind has a generic sibling under q13's instance store: `task_created`→`instance_created`, `task_transitioned`→`instance_moved`, `task_transition_rejected`→`instance_move_rejected`, `work_order_amended`→`instance_payload_revised`, `task_session_attached`→`instance_run_attached`, `review_reported`/`completion_reported`→`report_filed` (validated against the node's declared acceptance shape), `plan_submitted`→the engine capture event (`capture = ["plan"]`, node-kit §1.8.3), `task_worktree_created`→E2's `node_created` with provenance, `task_quarantined`→ an ordinary `instance_moved` into a `hold` node. **The spine is append-only: history is never rewritten.** See open question 21. |
| `projections/tasks.ts` | SPLIT | REWRITTEN | The generic half — current node, node history with proposer + timestamp, attempt counters, edge traversal counts, attached sessions, payload rev — is exactly q13's engine core field list and becomes `projections/instances.ts` (ENGINE). The task-shaped derived fields (board grouping, stage glyph) become extension payload plus `[[overlays]]`. |
| `tasks/taskStateMachine.ts:86` `TASK_STAGE_EDGES` | TASKS EXT | REWRITTEN as data | Becomes `[[workflows.edges]]` in the manifest (node-kit §1.9, whose placement warning about bare keys under `[[workflows]]` is load-bearing). |
| `tasks/taskStateMachine.ts:222` `proposeTransition`, `:126` legality check, `:131-135` `moveOptionsFor` | **ENGINE** | REWRITTEN | ⚠ **Adjudication does not move.** It stops reading a compiled map and starts reading the instance's *pinned* workflow revision. This is node-kit §0's whole job stated as a migration row. |
| `tasks/taskStateMachine.ts:147` `transitionProposedBySchema` | ENGINE | REWRITTEN (widened) | Becomes the engine proposer vocabulary `human \| orchestrator \| dispatcher \| watchdog \| extension` (node-kit q17), still stamped from the channel, never from a payload (#13, manifest §2.4 rule 1). |
| `tasks/dispatchDecision.ts` (`:47` dispatchable subset, `:120` `shouldDispatchOnTransition`, `:137` `stage-not-dispatchable`, `:259` `decideDispatch`) | **ENGINE** | MOVES, minus the tenant words | node-kit §1.5: the refusal vocabulary (`already-running`, `headroom-insufficient`, `headroom-unknown`) is workflow-blind already. `:47`'s subset becomes `attaches_session`; `:120` becomes the `dispatch_on_entry.by` positive match; `:137` renames to `node-attaches-no-session`. `decideDispatch` "survives the migration almost verbatim". |
| `tasks/stageRunner.ts:103` `resolveStageRunner` | ENGINE | MOVES | One mode since D46 (always a fresh session). A second mode is deferred (node-kit §5.1). Keep the module split from `decideDispatch` — its header states why (two questions, two functions), and folding them during a migration is exactly the "free refactor" that stops being free. |
| `tasks/reviewOutcome.ts:22` `deriveReviewOutcome` | **ENGINE** | REWRITTEN | Becomes the generic **rubric acceptance evaluator** (node-kit §1.8.4(a)): criterion-keyed report, `coverage = "all-criteria-pass"`, `unlisted_ids` policy (bend A-17). The tenant's *criterion meaning* stays in the extension; the pass/fail derivation is engine because acceptance is kit vocabulary. |
| `tasks/watchdogDecision.ts` (`:354` `assessStageRun`, the governed-liveness and blocking-attention sets) | ENGINE | MOVES | The staleness assessment is custody reasoning. The **bands** become per-workflow ⟨tune⟩s clamped by engine bounds (node-kit q15, bend A-22) — unpinned, rule 0.2. |
| `tasks/workOrder.ts:44-65` stage-run identity (`taskId, stage, attempt, workOrderRev`) | SPLIT | REWRITTEN | The identity tuple generalises to `(instanceId, node, attempt, payloadRev)` — ENGINE (q18: every payload write mints a rev; runs pin the rev they were dispatched against). `submitPlanPayloadSchema` (`:88`) and `createTaskToolPayloadSchema` (`:163`) go to TASKS EXT as verb `input` schemas. |
| `tasks/worktreePaths.ts` (`TASK_WORKTREE_BRANCH_PREFIX`) | ENGINE | MOVES, prefix REWRITTEN | E2-c: the engine does git, the extension names an intent. The branch prefix stops being `vimes/task-` and becomes engine-derived from the instance (a tenant word in a branch name is a tenant word in the engine). |
| `tasks/stageInstruction.ts:163` `composeStageInstruction` | **TASKS EXT** | MOVES verbatim | ⚠ **Byte-stability is a migration requirement, not a nicety.** The prefixes and suffixes at `:74, :102, :125, :133, :141, :153` are maintained for prompt-cache hits; the fix-seed ordering is fixed so two dispatches of one task stay comparable. This file moves packages without a character changing, or the move has silently changed the product's economics and its comparability at once. |
| `orchestrator/founding.ts` | SPLIT | see §1.6 | |
| `orchestrator/compactionSteward.ts` | ENGINE | MOVES | Context-window arithmetic and the compaction gate reason about the engine's own facts. Its nudge *prose* reads like doctrine — see open question 28. |

### 1.3 `packages/daemon` — hosting, routes, dispatch

**ENGINE, unchanged in kind:** `auth.ts`, `wsHub.ts`, `hookIngress.ts`,
`tailer.ts`, `discovery.ts`, `runtimeChecks.ts`, `terminalHost.ts`,
`sessionSettings.ts`, `transcriptPaths.ts`, `filePaths.ts`, `fileApi.ts`,
`search.ts`, `gitApi.ts`, `gitAdapter.ts`, `worktreeManager.ts`,
`projectApi.ts`, `projectWriter.ts`, `cost*`, `usage*`, `meterAlerts.ts`,
`push*`, `sqlite*`, `config.ts`, `cli.ts`, `main.ts`, `index.ts`,
`compactionSteward.ts`, `prodIds.ts`.

| Today | → | Verb | Notes |
|---|---|---|---|
| `sessionHost.ts` (2220 lines) | ENGINE | MOVES, two extractions | (a) `SdkReportToolSpec`, `DEFAULT_TOOL_SERVER` (`:2065`), `buildReportMcpServers` (`:2067-2146`) become the generic **"mount declared tools into sessions"** capability (E1-c). What changes is only the INPUT: today the dispatcher hands specs down; under q14 the tools come from the node the session was dispatched into (`briefing.tools`) or from the entity's grants (D56). (b) The `ExitPlanMode` deny-and-harvest interception stays engine and becomes opt-in via `capture = ["plan"]`. Everything else — custody, adapters, clamps, gates, questions — is untouched engine. |
| `taskDispatcher.ts` (1145 lines) | **SPLIT** | see §1.5 | The E1-d cut, file-level. |
| `taskWatchdog.ts:144` `TaskWatchdog` | SPLIT | REWRITTEN | ENGINE: detect a stale run and **propose** a move stamped `watchdog`. TASKS EXT: which node a stale run lands in (`quarantined`) and what the operator is told. The watchdog keeps its own proposer class precisely so the board can tell a machine's move from a human's (q17). |
| `taskWriter.ts:165` `TaskWriter` (`createTask`, `proposeTransition`, `amendWorkOrder`) | SPLIT | REWRITTEN | ENGINE: the instance-store write path (create instance / propose move / revise payload), which is q13's store wearing today's code. TASKS EXT: nothing but the payload schema the writer validates against. **This file is the reason the migration is a generalisation and not a new build** — the store already exists; it is spelled `task`. |
| `taskApi.ts:383` `registerTaskApi` | SPLIT | REWRITTEN | `/api/tasks` → instance routes; `/api/tasks/:id/transitions` → the generic propose-move route; `/api/tasks/:id/dispatch` → the dispatch primitive; `/api/tasks/:id/amendments` → the payload-revision route. |
| `taskApi.ts` `/api/tasks/stage-edges` (`StageEdgesResponse:97`) and `/api/tasks/work-order-schema` (`:109`, `WORK_ORDER_FIELD_DESCRIPTORS:301`) | ENGINE | REWRITTEN as introspection | ⚠ **These two endpoints already ARE manifest introspection, wearing tenant names.** They serve "what moves are legal" and "what fields does the record have" to a client that must render without hardcoding — which is exactly what a client needs for an extension it has never seen. They generalise to declaration-introspection routes (open question 25) and they are the strongest existing evidence that the client contract of §3 is reachable. |
| `createTaskTool.ts:182` `buildCreateTaskSpec` (`:188-191` the D65 `vimes_board` family) | TASKS EXT | MOVES as a declaration | Becomes one `[[verbs]]` entry with two faces: agent `vimes_board.create_task`, human `:new`. The *family* name stays engine-owned (manifest §2.4: families are the exposure matrix's units). |
| `orchestratorApi.ts:107` `registerOrchestratorApi` | SPLIT | see §1.6 | |
| `app.ts` | ENGINE, one seam | REWRITTEN at one call | Engine route registration is unchanged. The single edit that matters: `registerTaskApi(app, …)` (`:560`) stops being a compiled call and becomes **the extension host mounting an activated extension's contributions**. Also at `:819` and `:825`, the two report-tool handler wirings become node-declared tools. |

### 1.4 `packages/ui` — the client split

The mockups (design-directions, "The base-VIMES mockups") say the home surface
becomes the session tree; that reshuffle is **explicitly out of slice 9**. This
row set records only where today's files land under D70, so the reshuffle has a
map to start from.

**ENGINE CLIENT:** `App.vue`, `SessionListView.vue`, `StreamView.vue`,
`TerminalView.vue`, `EditorView.vue`, `FileTreeView.vue`, `GitPanel.vue`,
`SearchPanel.vue`, `ProjectPickerView.vue`, `CostLedgerView.vue`,
`PanelHost.vue`, `GateCard.vue`, `UsageGauge.vue`, `MarkdownMessage.vue`,
`ThemePicker.vue`, `stores/vimesStore.ts`, `sw.ts`, and the matching `lib/`
derivations (`envelope`, `route`, `panelStack`, `sessionRow`, `sessionLabel`,
`sessionListPartition`, `terminal*`, `usage*`, `meterDisplay`, `costDisplay`,
`cache*`, `contextFill`, `gateCard`, `seenOnView`, `killConfirm`,
`refusalRecovery`, `reconnectDecision`, `navigationFallback`, `treeNode`,
`gitReview`, `saveConflict`, `search*`, `push*`, `theme`, `layoutMode`,
`markdown*`, `messageContent`, `composerKey`, `textareaGrow`, `stickToBottom`,
`duration`, `languageByExtension`, `codemirror-setup`, `xterm-setup`).

**EXT CONTRIBUTION (tasks):** `views/TaskBoardView.vue`, `lib/taskBoard.ts`,
`lib/workOrderDisplay.ts`, `lib/workOrderForm.ts`, `lib/correctionDoors.ts`,
`lib/correctionStatus.ts`.

**Two rows that are not obvious:**

- `lib/dispatchFollow.ts` → **ENGINE CLIENT**, REWRITTEN. Its job ("subscribe
  to the stream of the session a dispatch just minted") is a property of the
  dispatch primitive, not of tasks. Its own header already names two callers
  in two vocabularies; under the map there is one, and it is generic.
- `lib/orchestratorEntry.ts` → SPLIT. The chat entry point is the engine
  client's; the word *orchestrator* and its persona are extension content
  (§1.6).

### 1.5 The E1-d dispatcher split, at function level

`packages/daemon/src/taskDispatcher.ts`. E1-d's proposal, walked and accepted
2026-08-05: **the engine owns `dispatch(sessionSpec) → completion events`; the
extension owns everything that decides WHAT and WHEN.** Where exactly the cut
falls:

| Symbol (line) | → | Why |
|---|---|---|
| `projectRootWorkingDirectory` (`:94`) | ENGINE | Becomes `isolation = "shared"` resolved against the instance node's directory (E3-a's spawn default, which is *optional* — a label-only group scopes nothing). |
| `TaskDispatcherDeps` (`:98`) | SPLIT | Engine deps: session host, git adapter, meter reader, event store, instance store. Extension deps: the briefing composer, and nothing else. |
| `StageInstructionDelivery` (`:234`) | ENGINE | `sent` / `not-delivered{reason}` — the honesty rule it encodes ("a stage run that silently never received its brief would look like a working dispatch and behave like an idle agent") is workflow-blind and must survive verbatim. |
| `DispatchAttemptResult` (`:270`) | ENGINE | Both vocabularies stay apart: `refused` carries the DECISION reasons, `spawn-failed` carries the EXECUTION outcome with the host's own string. Merging them during a migration would put an execution failure into a decision enum that `dispatch_refused` records. |
| `TaskDispatcher.dispatchTask` (`:474`) | **THE CUT** | Engine keeps: the per-instance in-flight lock (`:387`, D54), isolation resolution **and its no-fallback rule** (`:474ff` — an isolated run that quietly executes in the shared root is the hazard isolation exists to remove), the meter/headroom gate, worktree creation through the one guarded GitAdapter path, spawn with the D50 clamps and the node's declared tools, the `requires_paths` staleness check (trial finding 5), and run-completion emission. Extension keeps: which instance, which node, which composer. Under the kit **most of the extension's half is declaration**, so what remains as extension *code* is the composer alone. |
| `recordPlan` (`:700`) | ENGINE | D48 deny-and-harvest is below the adapter line. Becomes the `capture = ["plan"]` opt-in, satisfying an `artifact` acceptance through `capture:plan`. |
| `recordReview` (`:792`) | SPLIT / partly DISSOLVES | ENGINE: validate the report against the node's declared acceptance shape, emit `report_filed`, derive the rubric verdict. The guards at `:781` ("THIS GUARD IS WHY EXPOSING `report_review` TO EVERY SESSION IS WRONG") **dissolve** — under q14 the tool is mounted only into the node that declared it, so the condition the guard defends against becomes unreachable. ⚠ A dissolving guard must be *proven* unreachable in its own unit, with the old test re-pointed at the new impossibility, never merely deleted. |
| `recordCompletion` (`:880`) | SPLIT / partly DISSOLVES | Identical shape, acceptance kind `report` (node-kit §1.8.4(e), D53's "outcomes are reports"). |
| `describeThrown` (`:1143`) | ENGINE | utility. |

**What the split does NOT make declarable** (node-kit §1.5, restated because
this is the file where it would be lost): the in-flight lock's existence and
granularity, and the no-fallback rule on failed isolation. An extension that
could switch either off could reintroduce a double-spawn or a silent
shared-tree run, and neither is a workflow opinion.

### 1.6 The E1-e persistent-chat split, at function level

E1-e's proposal, walked and accepted: **the persistent-chat primitive is
engine; the orchestrator persona, doctrine briefing and grants are extension
content.**

| Symbol | → | Why |
|---|---|---|
| `orchestratorApi.ts:107` `registerOrchestratorApi` — the ensure/attach path | ENGINE | "A project-scoped chat that persists, survives restarts, and can be reattached" is custody, not doctrine. Route generalises (`/api/projects/:id/chat`). |
| `orchestratorApi.ts:363` `deliverTurn`, `:304` `orchestratorSessionsFor` | ENGINE | Turn delivery and "which live session is this project's chat" are primitive mechanics. |
| `orchestratorApi.ts:320` `standingNotesPathFor`, `:332` `readStandingNotesFile` | ENGINE | Standing notes are the primitive's durable memory across compactions — the same class as the compaction steward, and useless to a chat that cannot survive one. |
| `orchestratorApi.ts:350` `orchestratorDisplayName` | TASKS EXT | A persona's name. |
| `core/orchestrator/founding.ts:228` `composeOrchestratorFounding`, `:317` `composeOrchestratorReorientation` | TASKS EXT | Doctrine prose. Same class as `stageInstruction.ts`, and it moves with the same byte-stability requirement. |
| `founding.ts:37/54/84/271` — `OrchestratorBoardTask`, `OrchestratorBoardSummary`, `summarizeBoardForOrchestrator`, `renderBoardBlock` | TASKS EXT | A board digest is a tenant view of tenant records. |
| The `vimes_board` grant on the founding spawn (`sessionHost.ts:309`, `:822`) | ENGINE mechanism / TASKS EXT content | D65's exposure matrix is engine; *which* family a chat is granted is the extension's declaration (D56: verbs are grants on the standing entity). |
| `core/orchestrator/compactionSteward.ts`, `daemon/compactionSteward.ts` | ENGINE | See open question 28 — the nudge prose is the only part that reads like doctrine. |

The consequence worth stating once: after this split, **a project with no
extensions activated still has a persistent chat** — it simply has no doctrine,
no board digest and no verbs. That is the correct test of whether E1-e cut in
the right place.

### 1.7 Orphans the E5 seed table did not name

Found by walking the three `src/` trees rather than the table. Each is a real
row, and each is here because a migration that discovers them late discovers
them as breakage.

1. `daemon/taskWatchdog.ts`, `daemon/taskWriter.ts`, `daemon/taskApi.ts`,
   `daemon/createTaskTool.ts` — four task-named daemon modules the seed's
   "`daemon/taskDispatcher.ts` SPLIT" row does not cover. Placed in §1.3.
2. `core/projections/tasks.ts` — the seed says "`packages/core` tasks/\*",
   which does not include the projection. It is the q13 instance store's
   ancestor and therefore the *most* load-bearing orphan.
3. `core/schemas.ts` task shapes and `core/events.ts` task kinds — the seed's
   first row ("events/projections/schemas … engine") is true of the session,
   gate, terminal and cost families and **false of the task family**. §1.2
   splits the row.
4. `core/tasks/worktreePaths.ts` — moves *toward* the engine, against the
   direction of every other file in its directory (E2-c: the engine does git).
5. `daemon/worktreeManager.ts` + `daemon/gitAdapter.ts` — engine already, but
   they acquire a second caller (the tree primitive) and their `create`-vs-
   `open` distinction becomes load-bearing (E2-c pin 1).
6. `core/harness/profiles/watchdogStale.ts` — a harness profile named for a
   task-machine behaviour. It generalises to a stale-run profile; a
   tenant-named profile in the engine's own harness is the same carve-out the
   kill criterion forbids, one level down.
7. The UI's six tasks files (§1.4) — the seed's "`ui` board/work-order
   surfaces" row, enumerated.
8. `/api/tasks/stage-edges` and `/api/tasks/work-order-schema` — introspection
   endpoints, not board surfaces; §1.3 and open question 25.

### 1.8 The new engine modules this map must PLACE

The map is not only re-homing. Eight engine modules do not exist today, and
where they live decides whether the deterministic core stays deterministic
(0.3). **Proposed placement — the parse/decide half in `packages/core`
(headless, injected clocks and I/O), the host/registry half in
`packages/daemon`:**

| Module | Proposed home | Source of the requirement |
|---|---|---|
| Manifest parser + validator (parse, list, refuse, **without executing extension code**) | `packages/core/src/extensions/manifest.ts` | manifest §0 consequence 1 |
| Extension registry (installed set, source provenance, enabled flag, re-parse-on-use cache) | `packages/daemon/src/extensionRegistry.ts` | manifest §2.8, §2.10 |
| Extension host — Tier-1 interface + Tier-2 worker/command supervisor | `packages/daemon/src/extensionHost.ts` | D66 §1.2 |
| Workflow definition store (pinned by manifest hash; `workflow_rev`) | `packages/core/src/extensions/workflow.ts` | node-kit §1.3, §5.1 |
| Generic transition adjudicator (`proposeTransition` against the pinned definition) | `packages/core/src/extensions/adjudicate.ts` | node-kit §0 |
| Acceptance evaluator (rubric / scalar / human-gate / artifact / report) | `packages/core/src/extensions/acceptance.ts` | node-kit §1.8.4 |
| **⚠ Workflow-instance store** (q13): engine core fields + opaque schema-declared payload, its spine event family, its projection, its API surface | reducer `packages/core/src/projections/instances.ts`; writer `packages/daemon/src/instanceWriter.ts`; routes `packages/daemon/src/instanceApi.ts` | **node-kit §1.7 + q13** |
| Capability grant store + per-extension credential | `packages/daemon/src/extensionGrants.ts` (credential mechanism stays with D63) | manifest §5.3, §4.2 q11 |

Two observations that shape §2:

- **The instance store is not greenfield.** Its three proposed files are
  `projections/tasks.ts`, `taskWriter.ts` and `taskApi.ts` generalised. That is
  why q13 — honestly "more engine than the manifest alone implied" — is
  nonetheless the *cheapest* new module on this list, and why it can be
  sequenced early against a live reference implementation.
- **The tree/node store (E2) is genuinely new** and is not in this table
  because it is S9·1's, not S9·5's. It is a prerequisite of `isolation =
  "worktree"` and of the client contract's item 1, and the sequencing in §2
  deliberately does not depend on it.

**DEFAULT TAKEN:** the tasks extension's code lands in its **own workspace
package** (`packages/ext-tasks/`) rather than staying inside `packages/core`
and `packages/daemon` behind a naming convention — even at Tier 1. It is the
cheapest available enforcement of §4.2 q2 ("a Tier-1 module imports the
extension-host interface, not engine internals"): a package boundary is
checked by the compiler, a convention is checked by whoever reads the diff.
See open question 29.

### 1.9 Manifest-section landing map

Where each migrating artifact ends up **as a declaration** (manifest §2,
node-kit §1). This is the table an implementer works from.

| Today's artifact | Manifest section |
|---|---|
| `TASK_STAGE_EDGES` (`taskStateMachine.ts:86`) | `[[workflows.edges]]` (+ `[[workflows.forbidden]]` for bend A-4's named refusals; wildcard rows for A-5's `cancelled`) |
| The nine stages (`schemas.ts:225-233`) | `[[workflows.nodes]]`, each naming a `[[node-kinds]]` bundle (`work` / `review` / `hold` — names the extension declares, not names the engine knows) |
| Dispatchable subset (`dispatchDecision.ts:47`) | `attaches_session = true` on the kind |
| `shouldDispatchOnTransition` (`dispatchDecision.ts:120`) + D53 anti-chaining | `dispatch_on_entry = { enabled, by = ["human","orchestrator"] }` — `dispatcher` absent *is* the no-chaining rule |
| `composeStageInstruction` (`stageInstruction.ts:163`) | `[workflows.nodes.briefing].composer` + the closed `inputs` allow-list |
| D55's per-stage tool matrix (`sessionHost.ts:850,874`) | `[workflows.nodes.briefing].tools` — **q14: no predicate, no `offered_when`** |
| D48 plan capture | `permission_mode = "plan"` + `capture = ["plan"]` (closed engine catalogue, one entry) |
| `deriveReviewOutcome` (`reviewOutcome.ts:22`) | `[workflows.nodes.acceptance] kind = "rubric"` with `criteria_from`, `coverage`, `unlisted_ids`, `on_pass`/`on_fail` |
| Completion reports (D53) | `[workflows.nodes.acceptance] kind = "report"` |
| Work-order field shape (`taskApi.ts:301`) | `record = "schemas/task-record.json"` on `[[workflows]]` |
| `create_task` (`createTaskTool.ts:182`) + the drive verbs (scope 7) | `[[verbs]]`, each with `[verbs.agent]` and `[verbs.human]`, one shared `input` schema |
| Stage glyph on a session row (mockups §6) | `[[overlays]]` `target = "session"`, `type = "enum"`, with a **declared** attention rank (E2-b) |
| The board | `[[panes]]` `scope = "project"`, `placement = "main"`, `kind = "blocks"`, `degrade = "…"` |
| Isolation (`taskDispatcher.ts:474ff`) | `isolation = "worktree" \| "shared" \| "inherit"` on the node kind |
| Watchdog bands (`watchdogDecision.ts`) | per-workflow `watchdog` ⟨tune⟩s, engine-clamped, **values unpinned** (rule 0.2) |
| Task events the extension itself reacts to | `[[events]]` with `deliver = "worker"` (Tier 1: handler) |
| "This project runs the task machine" | `<project>/.vimes/extensions.toml` |

---

## §2. Sequencing — seam-first vs migrate-last

### 2.1 The fact this is argued against

Wes-confirmed, and it is the whole reason the question has an answer:

> **The task machine's recorded behaviour is the migration fixture.** The
> Gate-2 trial's event log (the recorded stage runs and transitions of the
> trial tasks — slice-8.md, task 3's full loop landing at seq 101–111) plus
> the full test suite (3132 tests green at slice-8 close) define what the
> system does. **Refactors are free; behaviour is the test.**

Two consequences follow immediately and they pull in the same direction:

1. A fixture is only a fixture while something can be run against it. Its
   value decays exactly as fast as the number of unattributed changes between
   two green runs grows.
2. Everything in §1 marked **MOVES** is free under this fact. Everything
   marked **REWRITTEN** is not — and §1 has roughly a dozen rewrites, three of
   which (the event-kind family, the adjudicator, the instance store) touch
   persisted state.

### 2.2 The two orders, argued

**Migrate-last.** Build the engine's extension machinery to completion —
manifest, registry, host, workflow store, adjudicator, acceptance evaluator,
instance store — against a stub or a greenfield second tenant, leaving the task
machine untouched on its current code paths. Then cut it across in one move.

*For:* the seam is designed without a legacy consumer distorting it; the tasks
extension is written against a finished API rather than a half-built one; no
period exists in which two mechanisms coexist.

*Against, and this is decisive:* **the fixture is meaningless until the last
step.** Every rewrite lands unverified; at the cut, a divergence in the event
log is attributable to twelve changes at once, and the fixture degrades from a
test into a post-mortem. Worse, the "greenfield second tenant" it would be
built against is Book Genesis, which is a **Tier-2** tenant (manifest §1.3) —
so a migrate-last order designs the seam against the tier the first tenant does
not use, and discovers the Tier-1 host's shape last. It is a big-bang wearing a
planning schedule.

**Seam-first.** Land the extension machinery as real engine code while the task
machine keeps running, and migrate it across the seam one declaration at a
time, with the fixture green at every step.

*For:* every rewrite is checked the moment it lands, against a live reference
implementation that is still running (the trial produces more fixture while the
migration proceeds). Divergence is attributable to one step. And node-kit
§5.1's own list of what needs Wes's signature names the mechanism: *"the
migration carrying the declared-table-vs-`TASK_STAGE_EDGES` diff as a test
rather than as a reading."* **That differential test cannot exist unless the
parser exists before the migration.** Seam-first is not a preference here; it
is what that named test requires.

*Against, honestly:* for a window, two expressions of the same fact exist (the
compiled edge table and the declared one; the task store and the instance
store). Coexistence is its own hazard class. The mitigation is a rule, not
vigilance:

> **The seam moves; the state does not.** Never dual-write the spine. Each
> step replaces one reader or one writer and **deletes the code it replaced in
> the same unit**. A step that leaves both paths live is not finished, and a
> step that migrates persisted state is its own step with its own gate.

### 2.3 The recommendation

> **SEAM-FIRST. Proposed, for Wes.**
>
> One sentence: seam-first is the only order in which the recorded behaviour
> stays a *test* rather than becoming a *post-mortem*, and it is what the
> pass's own named migration proof (the declared-edges-vs-`TASK_STAGE_EDGES`
> differential) mechanically requires.

**Move 0 (before anything): freeze the fixture.** Export the trial's event log
and the projected state it produces into a repository fixture file. A fixture
that lives only in a mutable production database cannot fail a test in CI, and
the daemon it lives in is the daemon the migration is about to change. This is
cheap, it is reversible, and it is the precondition for every claim in §2.2.
(Open question 22.)

**Move 1 — the parser and registry, with zero consumers.**
Build `packages/core/src/extensions/manifest.ts` and
`packages/daemon/src/extensionRegistry.ts`: parse, validate, list, refuse;
resolve `<project>/.vimes/extensions.toml`; hold source provenance and the
enabled flag. Nothing activates; nothing loads; no route changes.
*Exit gate:* a `vimes-tasks` manifest describing **today's** behaviour parses,
and a differential test asserts the declared `[[workflows.edges]]` table is
edge-for-edge identical to `TASK_STAGE_EDGES`.
*Kill criterion:* if that manifest cannot be written without amending the kit
more than once, stop and take the finding back to the pass — before a single
line of behaviour has moved.

**Move 2 — the instance store, as the task store's own re-home.**
Generalise `projections/tasks.ts` → `projections/instances.ts`,
`taskWriter.ts` → `instanceWriter.ts`, `taskApi.ts` → `instanceApi.ts`
(q13's engine core fields; the task record becomes the opaque payload). Emit
the generic event kinds; carry a versioned **alias table** so retired kinds
replay into their generic siblings, and never rewrite history (open question
21). Keep `/api/tasks/*` alive as aliases for one deploy (open question 24).
*Exit gate:* the frozen fixture replays to byte-identical projected state
through the new reducer.
*Why second and not later:* it is the riskiest step in the map, and it is the
only one that is *cheaper* while the old implementation is still standing
beside it as the reference.

**Move 3 — adjudication reads the declaration.**
`proposeTransition` stops reading `TASK_STAGE_EDGES` and reads the instance's
pinned workflow revision; move 1's differential test becomes the guard that
the two agree, and then the compiled table is deleted.
*Exit gate:* fixture green, differential test green, `TASK_STAGE_EDGES` gone
from `packages/core`.

Everything after move 3 is per-declaration and each carries its own D-record
from the kit: briefings (`composer` + `inputs`), tool exposure (q14),
acceptance shapes, auto-dispatch (`by`), isolation, watchdog bands, verbs,
overlays, panes. Each is small, each is independently revertible, and — this
is the payoff of the order — each is checked against a fixture that is still
meaningful when it lands.

### 2.4 What stays UNTOUCHED until the pass signs

- **Every daemon route and the whole WS op vocabulary.** `/api/tasks/*`,
  `spawn`/`send`/`resume`/`kill`/`subscribe`/`gate_response`/`term_*` — a live
  contract with a running deployment.
- **The entire UI.** No board reshuffle, no tree home surface, no pane host.
  ⚠ The deployment mechanics make this a hard line rather than a preference:
  `scripts/ci-gate.sh` ships `packages/ui/dist` as a side effect of running the
  gate, so **UI changes deploy themselves while daemon changes do not**
  (CLAUDE.md, learned 2026-07-23). A UI that has learned the new vocabulary
  ahead of the daemon is the exact failure that rendered an honest-looking
  empty state over 23k rows of real data.
- **The MCP verb and family names.** `vimes_board.create_task`,
  `vimes_report.report_review`, `vimes_report.report_completion` — live
  sessions hold them; renaming them mid-trial breaks the thing generating the
  fixture.
- **The orchestrator's founding, briefing and standing notes (E1-e).** They
  are what drive the trial that produces more recorded behaviour. Split them
  after the store and the adjudicator, not before.
- **Book Genesis.** Tenant 2 is a paper mapping until tenant 1 is across the
  seam. Building the Tier-2 host against a tenant with no recorded behaviour
  would forfeit the one advantage this order buys.

---

## §3. The client contract (scope 8)

### 3.1 The principle

Settled by the mockups and their discussion (design-directions, "The
base-VIMES mockups", points 1–2):

> **Shared information architecture, per-client grammar.** Web and terminal
> render the SAME engine state and the SAME extension contributions. Each
> client owns only its grammar — panes vs splits, pointer vs modal keys, tabs
> vs a tmux window strip.

Stated as the negative, which is the half that gets forgotten: **there is no
shared widget library and no shared component code.** The shared artifacts are
(a) the state shape on the wire and (b) the declaration vocabulary. Two clients
must be free to disagree about rendering and forbidden to disagree about truth.

And the constraint that makes it enforceable, from D70 and #15: **a capability
reachable only through one client is a bug.** Every item below therefore has
both a web line and a TUI line, or it does not belong in the contract.

### 3.2 The E4 list, made concrete

The eight items of architecture.md E4, plus the ninth the node kit added
(q13). For each: the API surface, the manifest section that feeds it, and one
line per client. The mockups (`docs/mockups/vimes_terminal_v2.jsx`,
`vimes_tui_v2.jsx`) are the rendering reference.

**1. Tree CRUD + subscription.**
*API:* `GET /api/tree?project=`; WS `subscribe {stream:'tree'}`; ops to create
and close nodes and attach sessions; events `node_created`, `node_closed`,
`session_attached_to_node`. Provenance is write-once and there is **no
`node_moved` in v1** (E2-a) — the contract must not offer clients a move.
*Manifest:* none (engine); extensions read through `tree.read`.
*Web:* the left sidebar's collapsible tree with status dots — repo → grouping →
sessions named by intent (`TreeGroup`, mockup `:189`).
*TUI:* the left pane, `j/k` cursor, indentation plus a fixed glyph column
(`stateGlyph`, mockup `:47`).

**2. State overlays on engine objects.**
*API:* carried **on the object they decorate, in the same projection payload** —
`session.overlays["ext.vimes-tasks.stage"] = { value: "review", attention:
"…" }`. No second fetch: an overlay that requires a round trip is an overlay no
list can render.
*Manifest:* `[[overlays]]` (§2.5).
*Web:* a chip on the session row.
*TUI:* a word or glyph in the row's fixed status column.
*Contract rule:* a client that does not recognise an overlay key renders its
**value** and its **declared attention rank** anyway. The declaration carries
enough to render; an unknown overlay is never dropped, and an unknown attention
rank is a hard error at parse (§2.5) rather than a quiet mis-sort at render.

**3. Verb registration with two faces.**
*API:* agent face — MCP `mcp__<family>__<tool>`, mounted **either** because the
session was dispatched into a node whose `briefing.tools` names it **or**
because the standing entity holds a grant (D56). Human face — `POST
/api/verbs/<ext-id>.<verb-id>` validated against the one shared `input` schema.
*Manifest:* `[[verbs]]` (§2.4).
*Web:* command palette plus contextual buttons, filtered by `target`.
*TUI:* the `:` command line (`:promote review`), completion table generated
from the same declaration.
*Contract rules:* (a) **no client hardcodes a verb** — both the palette and the
`:` completion table are built from `GET /api/extensions`, which is what lets a
new extension appear without a client release; (b) `target` is
**engine-enforced at invocation** and *also* usable by clients for offering
(§4.2 q3, deliberately unlike herdr's advisory `contexts`); (c) **q14: there is
no exposure predicate.** Exposure is a node's declaration or an entity's grant,
both of which the engine already holds, so a client asking "may I offer this?"
is answered from stored facts, never from evaluating anything.

**4. Panes.**
*API:* `GET /api/panes?scope=&target=` lists the declared panes; `GET
/api/panes/<ext-id>.<pane-id>?target=` returns a block tree (`kind="blocks"`)
or a terminal handle (`kind="pty"`).
*Manifest:* `[[panes]]` — `scope`, `placement`, `degrade` (§2.6).
*Web:* `placement` maps to main → a center tab; context → the right panel stack
(D39); sidebar → a left-rail section; overlay → a modal.
*TUI:* main → a tmux-style window in the strip; context → the switchable right
pane (`1/2/3` in the mockup); sidebar → a section of the left pane; overlay →
a full-screen buffer.
*Degradation:* §3.4, stated in both directions.

**5. Per-project (and reserved per-node) activation.**
*API:* `GET /api/projects/:id/extensions` — the resolved join of
`<project>/.vimes/extensions.toml` against the installed registry, carrying id,
version, enabled, and any parse warning; `POST` to toggle.
*Manifest:* the project declaration file (§2.8); `nodeConfig` reserved.
*Web:* the extensions panel — name, version, toggle (`ExtensionToggle`, mockup
`:271`).
*TUI:* `[x] name ver` rows plus `:ext install` / `:ext search`.
*Contract rule:* extension management is itself **public-API surface** (the
herdr move, mockups point 3) — it is not a web-only settings screen. A broken
manifest appears in both clients as *listed-with-warning*, never as an absence
(§2.10).

**6. Blob / artifact service.**
*API:* `GET /api/blobs/:hash` (+ write under `blob.write`), namespace enforced
by the engine from the caller's identity — nothing to declare, nothing to claim
(§1.5 item 6).
*Manifest:* none.
*Web:* a rendered artifact panel (plan, review report, manuscript, evaluation).
*TUI:* a pager over the same bytes.
*Contract rule:* content-addressed means a client may cache by hash forever —
which is what makes an artifact panel cheap in both clients.

**7. Dispatch primitive.**
*API:* `POST /api/dispatch` (a proposal) → either a session attached under a
node, or a refusal carrying the engine's own vocabulary (`already-running`,
`headroom-insufficient`, `headroom-unknown`, `node-attaches-no-session`) plus
the `spawn-failed` execution outcome, kept in its own vocabulary.
*Manifest:* `dispatch_on_entry` on the node kind; invoked through `[[verbs]]`.
*Web:* a dispatch action on the instance or node, and a refusal banner.
*TUI:* `:dispatch`, and a refusal on the status line.
*Contract rule:* **refusals are rendered, never swallowed** — and a
`headroom-insufficient` refusal must be renderable *next to the meter that
produced it* (§3.5). A refusal that appears as a no-op is the failure mode
pillar 4 exists to prevent.

**8. Reserved: session-spec confinement.**
*API:* `confinement` on the dispatch spec — **v1 parses it, records it, and
enforces nothing** (§5.4).
*Manifest:* reserved.
*Web / TUI:* a badge on the session, identically worded in both, saying
*declared, not enforced.*
*Why it is in the contract at all:* naming the display now is what stops a
later client inventing its own — and a badge that overstates enforcement would
be worse than no badge.

**9. (The ninth item — node-kit q13) Workflow instances.**
*API:* `GET /api/instances?project=`, `GET /api/instances/:id`, plus an
instance stream. The response carries the **engine core** — instance id,
project, tree node, workflow (extension id, workflow id, rev), current node,
node history with proposer and timestamp, edge traversal counts, per-node
attempt counter, payload rev, attached sessions, `created_by`, terminal state —
and the **payload**, opaque and schema-declared.
*Manifest:* `record = "schemas/…json"` on `[[workflows]]`; the payload's
renderer is the extension's own `[[panes]]`.
*Web / TUI:* the core renders **generically in both clients** (a node history is
a list of moves with a proposer, in any grammar); the payload renders through
the extension's pane.
*The sentence that makes a board possible without the client knowing what a
task is:* **the client renders the core; the extension renders the payload.**
⚠ Flagged as loudly here as node-kit flags it: this is the one place the kit
makes the engine bigger, and it is E4's ninth item only if Wes says so.

### 3.3 The ACP vocabulary steals

Four borrowings, each **vocabulary, not protocol adoption** (S9·0a §5.2). The
transport stays the private HTTP+WS spine, whose semantics — seq-cursor replay,
persist-before-broadcast, multi-client fan-out, custody — ACP lacks even in its
v2 draft.

**(a) Gate options as an OPTION FAMILY.** *Vocabulary, not protocol.*
`gate_fired` carries `options: [{ optionId, name, kind }]`. v1 emits exactly
two kinds (`allow_once`, `reject_once`) — today's binary, spelled as a list.
`allow_always` / `reject_always` are **reserved kinds with no producer**.
*Why:* clients render the option list rather than two hardcoded buttons, so the
day a rule-persistence family lands, no client changes. *Honest limit:*
reserving the kinds does **not** reserve rule storage, which nobody has
designed. See open question 27. *Drift (0.6):* ACP v2 reshapes permission
requests (required `title`, extensible `subject`, decoupled from tool calls) —
we are borrowing the v1 shape knowingly.

**(b) Question forms — elicitation's restricted-schema discipline.**
*Vocabulary, not protocol.* D68's `questions` payload adopts the rule that a
question's answer space is a **flat, restricted schema: primitives and enums
only, never credentials.** *Why:* it bounds what a client must be able to
render, which is the precondition for a TUI form existing at all; and it
matches ACP's own validation that "a question is not a permission" (S9·0a §2 —
the concept is an exact match, the shape is not). VIMES keeps its stronger
half: the dispatched auto-deny ("no human available") is engine policy above
any protocol.

**(c) Tool-call taxonomy — `kind` / `status` / `locations`.**
*Vocabulary, not protocol.* Stream tool-call records carry `kind` ∈
`read|edit|delete|move|search|execute|think|fetch|other`, `status` ∈
`pending|in_progress|completed|failed`, and `locations`. *Why:* it is what lets
the TUI render a tool call as one dense line and the web render an expandable
block **from the same event**, and `locations` is what makes follow-along
possible in both clients rather than in the one that shipped it. *Bound by rule
0.8:* the kind is derived from the **structured** stream, never from output
text; a taxonomy inferred by regex would be exactly the screen-parsing the rule
forbids. *Drift (0.6):* our diff blocks are ACP's v1 `oldText`/`newText`; v2
replaces them with structured add/delete/modify/move/copy operations.

**(d) Capability negotiation, omitted = unsupported.**
*Vocabulary, not protocol.* The client's feature detection reads a **declared
capability set** at connect (a hello on the WS, mirrored on `GET /api/health`),
and **an omitted capability is UNSUPPORTED — never "assume yes."** *Why:* it is
the same philosophy `AdapterCapabilities` (D18) already applies at the provider
edge, moved to the client edge; without it, a TUI built against an older daemon
renders an empty pane instead of saying the truth. See open question 26.

### 3.4 Blocks and PTY, and how each degrades on the other client

Declarative host-rendered blocks (AoE's model) are the **pane default**; PTY
panes are the **terminal-first escape hatch** (pillar 7 — escape hatches beside
abstractions). Both directions, stated explicitly, because scope 8 asks for
"client-agnostic or gracefully degrading" and neither word means anything
unspecified:

| | on the **web** | on the **TUI** |
|---|---|---|
| **`kind = "blocks"`** | DOM: `section` → a titled panel region, `row` → a flex line, `action` → a button posting the verb, `callout` → a bordered note, `bar` → a rendered bar, `columns` → a grid | **rendered, not omitted**: `section` → a titled pane region, `row` → a line, `action` → a numbered entry also invocable by its `:` command, `callout` → a marked line, `bar` → `█░` blocks, `columns` → aligned fixed-width columns |
| **`kind = "pty"`** | **framed, not degraded**: an xterm.js frame in the panel stack — VIMES already ships this (`packages/ui/src/lib/xterm-setup.ts`, `views/TerminalView.vue`), so the fallback is existing code rather than a promise. What is genuinely lost: **placement** (a PTY wants a full panel, not a sidebar strip) and composition (it cannot participate in a `blocks` layout) | native — the pane *is* a real PTY pane (herdr's model) |

`degrade = "omit" \| "link"` is the declaration that makes this checkable: a
pane a client cannot render is either **not offered** (`omit`) or shown as a
**one-line entry naming the client that can** (`link`). Every declared pane
picks one; a pane that declares neither is a manifest error, because
"gracefully degrading" with no declared degradation is aspiration.

⚠ **The blocks vocabulary itself is reserved, not specified here** (§2.6 hands
it to S9·5, and S9·5 hands it to whoever builds the pane host). What this
document fixes is the *contract shape*: a pane declares which vocabulary it
speaks, and every element of that vocabulary must have a text rendering or it
does not belong in it. **DEFAULT TAKEN:** an element that cannot be rendered as
text is not admitted to the block vocabulary — the TUI is the constraint that
keeps the vocabulary honest, exactly as the TUI is what keeps rule 0.8 honest.

### 3.5 Usage meters as first-class chrome

Wes settled this at the v2 mockups: the 5h-window meter sits at the top of the
sessions pane, **"directly above the sessions it funds"** — window bar, percent
used, time remaining, running count, and the 7-day figure. The web renders a
split solid/faded bar; the TUI renders `█░` blocks. Same five facts, native
idiom, both clients, no dashboard.

In contract terms: the meter is fed by the **engine's** meter surface (the
`meters` projection, `meter_alert` events, `GET /api/usage/derived`, `GET
/api/cost/ledger`) — pillar 4's "budgets are readable by anything that
schedules work" made visible at the home surface, with E1-a's settled split
behind it (the ledger is engine, budget *policy* is the scheduler extension's).
Two rules follow, and both are contract, not decoration: **(1) the meter is
engine chrome, not an extension pane** — no extension may replace, hide, or
re-source it, because a meter an extension can lie about is worse than no meter
(pillar 4); and **(2) a dispatch refused for `headroom-insufficient` must be
renderable adjacent to the meter that produced it**, in both clients, so the
refusal and its cause are one glance apart rather than two screens.

### 3.6 What the contract does not promise

Named so that later disagreement is about the right thing:

- **Not** identical rendering. A pane may look nothing alike across clients;
  only its *truth* and its *declared degradation* are contractual.
- **Not** a shared component library. §3.1's negative, restated.
- **Not** client-specific verbs, panes, or overlays. There is no manifest field
  for "web only", and adding one is a D-record against #15, not a convenience.
- **Not** an ACP face. §3.3 borrows vocabulary; the ACP *protocol* face remains
  banked as a possible **Tier-2 extension** on a trigger (S9·0a §5.2, manifest
  §1.3) — an external process speaking ACP outward, so the engine never learns
  ACP at all.
- **Not** the mockups' full home-surface reshuffle. That is a build slice with
  its own gates; this contract is what it would be built against.

---

## §4. Closing

### 4.1 What this reserves vs what this builds

**Builds: nothing.** In rule 0.5's framing:

- **Reserved (shapes landed now):** the destination/verb vocabulary of §1.1;
  the generic event-kind siblings and their alias table (§1.2); the instance
  API surface and its core-vs-payload split as a *client* contract (§3.2 item
  9); the option-family shape on `gate_fired`; the restricted question-form
  discipline; the tool-call `kind`/`status`/`locations` triple; the client
  capability-hello; `placement` and `degrade` as the cross-client pane
  vocabulary; the meter's five facts as engine chrome.
- **Proposed (needs Wes's signature, S9·6):** the module-by-module destinations
  of §1.2–1.4; the E1-d cut at function level (§1.5); the E1-e cut at function
  level (§1.6); the placement of the eight new engine modules (§1.8), the
  instance store foremost; **the seam-first sequencing and its first three
  moves** (§2.3); the untouched list (§2.4); the client contract entire (§3).
- **Deferred by design:** the block vocabulary's element list; the home-surface
  reshuffle; the ACP face; rule persistence behind `allow_always`; per-node
  extension activation (`nodeConfig`, D11's first-consumer rule); Book
  Genesis's Tier-2 host until tenant 1 is across the seam.
- **Not built, and not to be built until the pass signs:** any parser, any
  registry, any instance store, any route rename, any UI change.

### 4.2 Open questions raised by this draft

Each carries the default this draft took, so the document is internally
consistent; each needs Wes (or a later unit) to confirm or overturn. Numbering
continues node-kit.md §5.2, which ends at 20.

21. **⚠ Do persisted event kinds get renamed, and how does history survive?**
    §1.2 renames the `task_*` family to generic instance kinds, and the spine
    is append-only with the trial's recorded behaviour inside it. **DEFAULT
    TAKEN:** the generic kinds are *new*; the reducer carries a **versioned
    alias table** mapping each retired kind to its generic sibling; **history
    is never rewritten.** Flagged loudly because it makes §4.2 q8 ("do engine
    event kinds constitute stable API?") concrete and expensive: the alias
    table is a permanent artifact, and it must warn on a deprecated kind
    exactly as it warns on an unknown one — the `meter_threshold_crossed`
    near-miss (`packages/core/src/events.ts:66-78`) is the standing evidence.
22. **Is the migration fixture the live spine or an exported file?** **DEFAULT
    TAKEN:** exported, before move 1 — the trial's event log and the projected
    state it produces are frozen into a repository fixture. A fixture living in
    a mutable production database cannot fail a test in CI, and that database
    belongs to the daemon the migration is changing. This is Move 0 in §2.3 and
    it is the cheapest item in the whole plan.
23. **Where do the new engine modules live?** **DEFAULT TAKEN:**
    `packages/core/src/extensions/` for everything deterministic (manifest
    parse, workflow definition, adjudicator, acceptance evaluator) and
    `packages/daemon/src/extensionHost.ts` + `extensionRegistry.ts` for the I/O
    half (0.3's split). Flagged because it decides whether `@vimes/core` grows
    a third top-level concept beside sessions and the spine.
24. **Does the tasks extension keep its route prefix?** **DEFAULT TAKEN:** the
    generic instance routes are the contract; `/api/tasks/*` survives as
    deprecated aliases for exactly one deploy, then dies. The reason is
    deployment mechanics, not politeness: ci-gate ships the UI ahead of the
    daemon (CLAUDE.md), so an alias window is the only thing that makes that
    ordering survivable.
25. **Do `stage-edges` and `work-order-schema` generalise into
    declaration-introspection endpoints?** **DEFAULT TAKEN:** yes — a route
    serving a pinned workflow definition and a route serving a payload schema,
    because both endpoints already *are* declaration introspection under tenant
    names, and both clients need the generic form to render an extension they
    have never seen. This is the smallest existing proof that §3 is reachable.
26. **Where does client capability negotiation live?** **DEFAULT TAKEN:** a
    declared capability set in a WS hello, mirrored on `GET /api/health`, with
    **omitted = unsupported**. Flagged because it turns `/api/health` — today a
    liveness check — into a contract surface with a compatibility story.
27. **Do gate option families ship reserved-but-unproduced?** **DEFAULT
    TAKEN:** yes — emit the option list with only the two v1 kinds and reserve
    `allow_always` / `reject_always` as *kinds* without reserving rule storage.
    Flagged because a reserved option kind that a client renders and the engine
    cannot honour would be worse than its absence; the reservation must be
    invisible to users until something produces it.
28. **Does the compaction steward go with the persistent-chat primitive?**
    **DEFAULT TAKEN:** yes, engine — it reasons about the engine's own
    context-window facts, not about workflow. Flagged because its nudge *prose*
    (`composeGentleNudge`, `composeFirmNudge`) reads like doctrine, and doctrine
    is extension content everywhere else in this map. If Wes reads those strings
    as doctrine, the mechanism stays engine and the strings become extension
    content — a smaller, sharper cut than moving the module.
29. **Does `packages/core/src/tasks/` die into its own package?** **DEFAULT
    TAKEN:** yes — the tasks extension lands in `packages/ext-tasks/` even at
    Tier 1, so that §4.2 q2's rule ("a Tier-1 module imports the
    extension-host interface, not engine internals") is enforced by the
    compiler instead of by review. Flagged because it changes the workspace
    layout and because it is the cheapest enforcement available for the one
    property that keeps #15 from eroding silently.

---

*Read next: `architecture.md` E1/E4/E5 (the settlements this elaborates),
`extension-model.md` §1.5 + §2 (the declaration homes every §1.9 row lands in),
`node-kit.md` §1.7 (the instance store §1.8 places) and §4 (the verdict that
lets this map exist at all).*
