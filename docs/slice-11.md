# Slice 11 — the instance store, as the task store's own re-home (D72 Move 2)

Opened 2026-08-06 on slice 10's close. The riskiest step in the migration map
(§2.3), taken now deliberately: it is the only step that is *cheaper* while
the old implementation still stands beside it as the living reference — and
while the running daemon still serves the old code, which this slice uses as
a free comparison oracle (see the U1 gate note).

**The governing rule, verbatim from D72:** *the seam moves; the state does
not.* Never dual-write the spine. Each unit replaces one reader or one writer
and **deletes the code it replaced in the same unit**. A unit that leaves both
paths live is not finished.

## Scope

Generalise the three store files to q13's shape (node-kit §1.7):

- `packages/core/src/projections/tasks.ts` → `projections/instances.ts`
- `packages/daemon/src/taskWriter.ts` → `instanceWriter.ts`
- `packages/daemon/src/taskApi.ts` → `instanceApi.ts`

plus the three artifacts the move forces into existence:

1. **The generic event-kind family** (migration-map §1.2), emitted by the
   writer from this slice on:
   `instance_created`, `instance_moved`, `instance_move_rejected`,
   `instance_payload_revised`, `instance_run_attached`, `report_filed`
   (absorbing both `review_reported` and `completion_reported`, discriminated
   in the payload), and the engine capture event `capture_recorded`
   (absorbing `plan_submitted`; `capture = ["plan"]` is the catalogue's one
   entry).
2. **The versioned alias table** (q21 — a PERMANENT artifact): each retired
   kind maps to its generic sibling; the instances reducer resolves incoming
   kinds through it, so recorded history replays without being rewritten.
   `DEPRECATED_EVENT_KINDS` in `manifest.ts` (the mechanism slice 10 built
   empty and injection-tested) is populated from the same table, so a
   manifest subscribing to a retired kind warns exactly as it would for an
   unknown one.
3. **The legacy task view** — a pure derivation
   `legacyTasksViewOf(instancesState)` that reconstructs today's
   `TasksState` shape byte-for-byte. It has exactly two consumers: the
   fixture exit gate, and the `/api/projections/tasks` alias route. When the
   aliases die, the view dies with them; the fixture test then pins the
   *instances* serialization instead (its own future unit).

### The record split (q13 applied — this slice's central design)

The instance record is **core fields + opaque payload + transitional core**,
and the doc is explicit about all three because the middle era is where
carve-outs hide:

- **Core (q13's list, the exhaustive bound):** `instanceId` (=taskId),
  `project` (=projectRoot), `workflow` ref *(reserved shape
  `{extension, workflow, rev} | null` — stamped `null` this slice: no pinned
  workflow definition governs adjudication until Move 3, and stamping an
  identity nothing pinned would be declared truth over observed, 0.7)*,
  `currentNode` (=stage), `nodeHistory` (NEW — accumulates
  `{node, proposedBy, ts}` per move; foldable from legacy
  `task_transitioned` payloads, which already carry `proposedBy`),
  `edgeTraversalCounts` (NEW — Move 3's `max_traversals` needs it),
  `attemptsPerNode` (NEW — folded as entries-into-node),
  `payloadRev` (=workOrderRev), `attachedSessions` (=sessionRefs),
  `createdBy`.
- **Payload (opaque, tenant-shaped):** `title`, `scope`, `explicitlyOut`,
  `acceptanceCriteria`, `killCriterion` — stored under a single `payload`
  key, validated on write against today's compiled schema (the JSON-Schema
  re-home is the extension package's move, not this one). The engine never
  reads a payload field to decide anything (§1.7).
- **Transitional core — each field named WITH the move that retires it,**
  because the engine still reads these to decide, and the payload-opacity
  rule therefore forbids putting them in the payload:
  `isolation` (→ node-kind declaration), `gates` (→ dispatch gates
  declaration), `manualReviewRequired` (→ workflow data, Move 3),
  `planArtifactHash` (→ the capture record), `lastReview`/`lastCompletion`
  (→ the acceptance/report store), `lastHeartbeatAt`/`staleRetries`
  (→ watchdog custody split). A transitional field with no named
  retirement move is a carve-out (principle 16); this list is the fence.

### Decisions taken in this skeleton (flagged for Wes, leans applied)

- **The persisted stream stays `'tasks'`.** The stream name is persisted
  state; (stream, seq) contiguity and the deployed UI's re-read trigger
  ("an event arrived on the 'tasks' stream") both live on it. Generic kinds
  append to the SAME stream. Per-workflow stream naming is deferred to its
  own decision when a second workflow first exists.
- **Alias-window ordering (q24, made operational):** this slice's deploy
  serves generic routes AND `/api/tasks/*` + `/api/projections/tasks`
  aliases; the deployed UI keeps working untouched. A LATER UI unit switches
  the client to generic routes (self-deploys via ci-gate — safe only
  *because* the daemon already serves them); the daemon deploy after that
  drops the aliases. Exactly one deploy of overlap, as decided.
- **`/api/tasks/stage-edges` and `/api/tasks/work-order-schema` move
  verbatim** (same handlers, same bytes, served by instanceApi under the old
  paths). Their generalisation to declaration introspection is q25's and
  needs pinned declarations — Move 3+, not here.

## Explicitly OUT

- **Adjudication (Move 3).** `proposeTransition` still reads
  `TASK_STAGE_EDGES`; the writer still calls the compiled machine. Nothing
  about legality changes.
- **The entire UI** — not one file in `packages/ui`. Hard line: ci-gate
  ships the UI as a side effect, so a UI that learned the new vocabulary
  would deploy itself ahead of the daemon (the D37 failure class).
- **Alias removal** (the deploy after the UI migrates).
- `task_worktree_created`, `task_quarantined`, `dispatch_refused` — not
  folded by this reducer today, not renamed today. Their generic siblings
  arrive with the E2 tree store and the watchdog/dispatcher splits.
- The `ext-tasks` package (q29), the extension host, activation, grant
  enforcement, `schemas.ts` task-shape re-home, Book Genesis.
- Stream renaming; snapshot-store schema changes (old `'tasks'` snapshot
  rows are dead but harmless — noted, not cleaned).

## Assertions (on top of all prior — 0.4)

- **S11-A1 (the exit-gate centerpiece):** the frozen fixture's 111 events →
  instances reducer → `legacyTasksViewOf` → byte-identical to the frozen
  `tasks-state.json`, twice, deterministically. The fixture files are
  FROZEN — never regenerated to make this pass.
- **S11-A2 (alias equivalence):** a retired kind and its generic sibling
  with equivalent payloads fold to identical records; a mixed-era stream
  (legacy prefix + generic tail — exactly what production becomes) folds to
  the same state as either pure spelling.
- **S11-A3 (the table is total and warns):** every kind the old reducer
  folded has an alias row; `DEPRECATED_EVENT_KINDS` is populated from the
  table; a manifest subscribing to `task_transitioned` parses with a
  deprecation warning naming the generic sibling.
- **S11-A4 (alias parity):** `/api/projections/tasks` serves bytes equal to
  `legacyTasksViewOf` of the instances projection; each `/api/tasks/*` alias
  route and its generic twin produce identical events and responses for
  identical requests.
- **S11-A5 (replay equivalence for the NEW state):** InstancesState honors
  the I6 family — snapshot-cut replay equivalence, deterministic
  serialization, total fold (unknown kinds/instances/malformed payloads are
  no-ops, nothing throws).
- **S11-A6 (single spelling on the write path):** after this slice no
  production code emits a `task_*` kind — grep-assertable and tested; the
  writer emits generic kinds only. (The constructors for retired kinds
  survive ONLY for tests/fixtures, moved or marked accordingly.)

## Exit gate (machine)

`npm run typecheck` + full suite green **twice** with byte-identical
serialization; S11-A1..A6 present and green; prior 3276 stay green; control-
byte census 0 on every touched file; grep shows no `task_*` emission from
production code paths.

**Plus the live-oracle check (orchestrator, U1 gate):** replay the
production DB (READONLY) through the new reducer + legacy view and diff
against `GET /api/projections/tasks` from the still-running old-code daemon.
The running daemon is the reference implementation serving its final answer —
free, no restart, and it covers the production kinds the fixture era lacks.

## Kill criteria

- **The legacy view cannot be derived byte-identically** from the
  generalised state — the core/payload split lost information q13's field
  list was supposed to carry. That is a finding about the SIGNED abstraction,
  not a bug: rule 0.1, halt, back to the pass.
- **Any step needs a dual-write** (both spellings of one fact on the spine)
  to stay green — the sequencing is wrong: halt, decision record.

## Build order

Three units, sequential, each compiling and green, each deleting what it
replaces:

- **U1 (core + the projection seam, `opus`):** generic kinds + alias table
  in `events.ts`; `projections/instances.ts` + `legacyTasksViewOf`;
  `DEPRECATED_EVENT_KINDS` populated; fixture replay test rewritten to run
  through the new reducer; daemon's `bootFromSnapshot(tasksProjection, …)`
  reads re-pointed through instances + view so taskWriter/taskApi consume
  unchanged shapes; core barrel + harness re-pointed;
  **`projections/tasks.ts` deleted.**
- **U2 (the writer, `opus`):** `instanceWriter.ts` emitting generic kinds;
  dispatcher/watchdog/createTaskTool/sessionHost/projectWriter/app
  re-pointed (tenant semantics retained — their own moves come later);
  **`taskWriter.ts` deleted.**
- **U3 (the routes, `opus` — contract-bearing):** `instanceApi.ts` generic
  routes + the alias set + app wiring; **`taskApi.ts` deleted.** Exit gate
  after U3.

My gate per unit: diff read, suite green, census, and (U1) the live-oracle
check. No ⟨tune⟩s anywhere in this slice — no Gate-D pause needed.

## Notes

- First boot after this slice's deploy replays the instances projection from
  seq 1 (no snapshot under the new id) — the tasks stream is a few hundred
  events; negligible.
- Deploying this slice changes what the daemon WRITES to the spine (generic
  kinds). Rule 0: the deploy itself waits on Wes's sign-off of the slice,
  like every behavior-shaping change.
- The live daemon keeps serving old code until that deploy — which is what
  makes the live-oracle check possible. Do not restart mid-slice.
