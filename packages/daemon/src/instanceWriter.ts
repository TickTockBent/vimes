import {
  instanceCreated,
  instanceMoveRejected,
  instanceMoved,
  instancePayloadRevised,
  nextTaskForAcceptedTransition,
  // ⚠ ALIASED ON IMPORT, AND THE COLLISION IS REAL: this class's own move method
  // has been called `proposeMove` since S11·U2, and core's declaration-reading
  // adjudicator (S12·U1) carries the same name. The alias says which one the
  // call site means without renaming either.
  proposeMove as adjudicateAgainstDeclaration,
  type EventInput,
  type IdSource,
  type ParsedWorkflow,
  type TaskRecord,
  type TasksState,
  type TransitionProposal,
  type WorkflowRef,
} from '@vimes/core';

// ─── S11·U2 (D72 Move 2) — the SOLE WRITER of instance state (daemon I/O) ─────
//
// This file is `taskWriter.ts` RE-HOMED, not a rewrite: slice 6 step 4b built it,
// steps 1–3 built the decisions it delegates to, step 4a built the executor beside
// it, and S11 renames it into the store's own vocabulary (migration-map §1.8 —
// "the store already exists; it is spelled `task`"). Every behaviour below is the
// one that shipped; what changed is the SPELLING of the events it writes.
//
// This class is the ONE place an `instance_created`, an `instance_moved`, an
// `instance_move_rejected` or an `instance_payload_revised` is written. Everything
// else — the HTTP API, the watchdog, the MCP surface — is a CALLER of it.
//
// ⚠ WHY THIS IS NOT JUST "LOGIC IN THE ROUTE HANDLER".
// The watchdog must move an instance to `quarantined` IN-PROCESS, not over HTTP.
// If the propose→event logic lived inside an HTTP handler, the watchdog would
// either duplicate it (two writers — the principle-10 failure slice 6 names as a
// halting finding) or have to re-plumb it. One writer, many callers.
//
// ⚠ THIS CLASS IS A PROPOSER, NEVER A DECIDER (principle 10, I7).
// It NEVER computes a next node, NEVER consults a legality table, NEVER calls the
// adjudicator's internals and NEVER re-derives an edge. It asks the adjudicator
// and RECORDS WHAT CAME BACK. If you find yourself adding an `if` here that
// changes WHETHER a move is legal, it belongs in the DECLARATION — the only
// place legality lives since D72 Move 3. A second adjudicator is a second
// authority, and I7 stops being assertable headlessly the moment one exists.
//
// ─── S12·U2 (D72 Move 3) — THE ADJUDICATOR NOW READS THE DECLARATION ─────────
//
// What changed: the move path calls core's `proposeMove` against the BOOT-RESOLVED
// `ParsedWorkflow` (`shippedManifest.ts`, injected below) instead of the compiled
// machine and its compiled legality table. What did NOT change: where the call
// lives, what it decides, or that this class only RECORDS what came back. S12-A1
// proved the two agree across the full cross product; U3 then deleted the
// compiled one, and S12-A1 now runs against its behavior frozen as data.
//
// The declaration is INJECTED, never read here (rule 0.3): this class does no
// I/O, so a test hands it a workflow and the daemon hands it the shipped one.
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()`. Every method runs to
// completion inside the call that invoked it. The only clock this step reads is
// the injected one, and it is stamped in `app.ts` at the request boundary.

export interface InstanceWriterDeps {
  // The router's emit — the ONLY write path. Nothing here touches the store, a
  // snapshot or a projection object directly.
  emit: (events: EventInput[]) => void;
  // Projection reads, called FRESH on every call and never cached in a field.
  // A writer proposing against a stale board is a writer adjudicating an edge out
  // of a node the instance has already left (mirrors `TaskDispatcher.readTasks`).
  //
  // ⚠ STILL THE LEGACY `TasksState` VIEW AFTER MOVE 3, AND THAT IS NOW A NARROWER
  // LEFTOVER THAN IT WAS. The fold is the instances projection (S11·U1); this dep
  // takes the narrowing `legacyTasksViewOf` produces. The ADJUDICATION no longer
  // needs it — core's `proposeMove` takes a node id and a declaration, not a
  // `TaskRecord` — but the RECORD half still does: `nextTaskForAcceptedTransition`
  // computes the convergence flag off the task, and the writer's return type is
  // the `TaskRecord` its callers parse. Widening this is the de-tenanting move's,
  // not Move 3's; U3 settles what remains.
  readTasks: () => TasksState;
  // INJECTED (rule 0.3). The only source of new instanceIds; nothing here calls
  // randomUUID, so a test with a CountingIdSource gets byte-identical ids.
  ids: IdSource;
  // ── S12·U2 (D72 Move 3): the boot-resolved declaration and its identity ─────
  //
  // INJECTED, both of them (rule 0.3). This class never opens a file: `app.ts`
  // resolves the shipped manifest ONCE at construction (`loadShippedWorkflow`)
  // and hands the pair in, so a test supplies any declaration it likes and the
  // writer stays deterministic and headless.
  //
  // ⚠ ONE DECLARATION GOVERNS EVERY MOVE (F2). This is the workflow the
  // adjudicator reads for every instance — including instances born before Move 3
  // whose recorded ref is `null`. Per-move re-resolution against multiple stored
  // revisions waits until multiple revisions can exist.
  workflow: ParsedWorkflow;
  // Stamped onto every birth record (node-kit §1.7's identity), never re-derived
  // here: `{ extension, workflow, rev: the manifest's own version }` as
  // `loadShippedWorkflow` read it off the declaration.
  workflowRef: WorkflowRef;
}

// What a creator NAMES. Deliberately NOT a `TaskRecord`: the rest of the record
// (manualReviewRequired, sessionRefs, lastHeartbeatAt, staleRetries) is the
// projection's business, filled from the schema's documented starting values, and
// letting a caller supply them would let an API set a heartbeat on an instance that
// has never run.
//
// ⚠ THE INPUT SPELLING STAYS TASK-SHAPED (`projectRoot`, `stage`) THIS UNIT. Its
// callers are the HTTP create door and the `create_task` tool, whose request
// bodies are the deployed contract; the routes are U3's move and the tool is the
// tasks extension's. The mapping to the generic payload happens at the emit below,
// which is exactly where the alias adapter does it in the other direction.
export interface CreateInstanceInput {
  readonly projectRoot: string;
  // OPTIONAL, matching the widened birth payload (step 9). Absent → the
  // record carries no `title` at all (NOT `''`), exactly as every pre-step-9
  // birth record does. Set at creation only; there is no rename path.
  readonly title?: string;
  readonly createdBy: TaskRecord['createdBy'];
  readonly isolation: TaskRecord['isolation'];
  readonly stage: TaskRecord['stage'];
  // OPTIONAL, matching the widened birth payload. Absent → the projection folds
  // `{}` (an ungated instance), exactly as every pre-4b birth record did.
  readonly gates?: TaskRecord['gates'];
  // ── S7·2a: the four AUTHORED work-order fields ──────────────────────────────
  //
  // All OPTIONAL, matching the widened birth payload: absent → the birth record
  // carries no such key at all (NOT a default), so an unauthored creation stays
  // byte-identical to every pre-slice-7 one (I6).
  //
  // ⚠ `acceptanceCriteria` is the INPUT shape `{ text }[]` — TEXT ONLY, NO id.
  // This is DELIBERATELY DIFFERENT from the record/event criterion shape
  // (`{ id, text }`, the reserved `acceptanceCriterionSchema`) and the two must
  // NOT be unified: a criterion id is STABLE identity that `report_review` (S7·6)
  // keys per-criterion pass/fail to, it must be unique, and a human authoring form
  // (S7·3) must not hand-type it. So the id is MINTED SERVER-SIDE in
  // `createInstance` from the injected id source (the same source that mints the
  // instanceId), never supplied by the caller.
  readonly scope?: string;
  readonly explicitlyOut?: string[];
  readonly acceptanceCriteria?: { text: string }[];
  readonly killCriterion?: string;
}

// ── S7·2b: what a REVISER names (D43 — payloads are revisioned, not mutated) ───
//
// The patch half of `CreateInstanceInput`: the SAME four authored work-order
// fields, every one optional, plus the author. Deliberately NOT a
// `Partial<TaskRecord>` — `title`, `gates`, `isolation`, `projectRoot` and `stage`
// are not revisable through this door (a title is set at creation by documented
// decision; a node moves through I7's move choke and nowhere else), and a
// `Partial` would quietly offer all of them.
export interface RevisePayloadInput {
  // WHO decided this revision. Two values, never `dispatcher` — see the payload
  // schema's note in events.ts: a revision is a D53 DECISION, and the mechanics
  // have no business authoring one.
  //
  // ⚠ SPELLED `amendedBy` STILL, matching the deployed request body its one caller
  // parses; the emit below writes it as the payload's `revisedBy`.
  readonly amendedBy: 'human' | 'orchestrator';
  readonly scope?: string;
  readonly explicitlyOut?: string[];
  // ⚠ THE CRITERION SHAPE HERE IS `{ id?, text }`, AND THE OPTIONAL id IS THE
  // WHOLE DESIGN. WITH an id → this entry KEEPS/RESTATES an EXISTING criterion,
  // and the id must match one currently on the record; criterion ids are STABLE
  // IDENTITY that `report_review` (S7·6) keys per-criterion pass/fail to, so a
  // revision that reworded a criterion while silently re-minting its id would
  // orphan every verdict ever recorded against it. WITHOUT an id → a NEW
  // criterion, its id MINTED SERVER-SIDE from the injected source, exactly as
  // `createInstance` mints them: the caller never types an id that does not already
  // exist.
  //
  // The array is a REPLACEMENT LIST, not a delta — what it contains is what the
  // record will carry, so dropping an entry deletes that criterion and an
  // explicit `[]` clears them all.
  readonly acceptanceCriteria?: { id?: string; text: string }[];
  readonly killCriterion?: string;
}

// The outcome of ONE revision, in the same discriminated-union idiom as
// `ProposeMoveResult` below: callers must tell the cases apart WITHOUT
// inspecting HTTP semantics, because the MCP client has no status codes.
//
// ⚠ THE DISCRIMINANTS AND FIELD NAMES ARE UNCHANGED (`amended`, `unknown-task`,
// `task`, …): every consumer switches on them today and their tenant semantics
// retire with their own moves, not with this one.
export type RevisePayloadResult =
  | { readonly outcome: 'amended'; readonly task: TaskRecord }
  // Nothing emitted. Same reasoning as `ProposeMoveResult`'s case: there was
  // no instance to revise, and writing a revision for an id no birth record ever
  // introduced would put a phantom instance in the log.
  | { readonly outcome: 'unknown-task'; readonly taskId: string }
  // A supplied criterion id is not on the record's CURRENT acceptance list (a
  // record with no criteria at all has no valid ids). Nothing emitted — same "the
  // machine never saw it" posture as `unknown-task`, and refusing WHOLE means a
  // half-applied revision is not a state this class can produce.
  | { readonly outcome: 'unknown-criterion'; readonly criterionId: string }
  // All four patch fields absent. Nothing emitted: a rev bump that changes nothing
  // is log noise, not a revision, and it would invalidate every in-flight node
  // run's `payloadRev` for no recorded reason.
  | { readonly outcome: 'empty-amendment' };

// The outcome of ONE proposal. A discriminated union in the same idiom as
// `DispatchAttemptResult` (step 4a), because callers must be able to tell the
// three cases apart WITHOUT inspecting HTTP semantics — the MCP client has
// no status codes to branch on.
//
// ⚠ `unknown-task` is deliberately its own outcome and NOT a refusal reason. The
// machine never saw this proposal — there was no instance to propose against — so
// calling it a rejection would put a reason in the record that
// `instance_move_rejected` writes, and the log would then claim the state machine
// refused an edge it was never shown.
//
// S13·U1: `reason` is a `string`, not a closed enum, and the widening is the
// honest type rather than a loosening. Two channels feed it (slice-13 F1): the
// engine's four node-spelled refusals, and whatever string the pinned
// declaration's `forbidden` row names — a second tenant's vocabulary is not this
// daemon's to enumerate. See `packages/core/src/events.ts`'s
// `instanceMoveRejectedPayloadSchema` for the full reasoning.
export type ProposeMoveResult =
  | { readonly outcome: 'accepted'; readonly task: TaskRecord }
  | { readonly outcome: 'rejected'; readonly reason: string }
  | { readonly outcome: 'unknown-task'; readonly taskId: string };

// Thrown ONLY when the log and the projection disagree: an event was written and
// the fold did not produce the record it describes. That is a rule-0.1 finding
// (the log is the source of record, I12), not an input error — so it surfaces as
// a 500 with the finding in it rather than a plausible-looking 200. It is
// unreachable through any request shape; only a projection/event divergence
// produces it.
export class InstanceProjectionDisagreementError extends Error {}

export class InstanceWriter {
  private readonly deps: InstanceWriterDeps;

  constructor(deps: InstanceWriterDeps) {
    this.deps = deps;
  }

  /**
   * Create an instance: mint an id, emit ONE `instance_created`, and return the
   * record **as the projection folded it**.
   *
   * ⚠ The read-back is the point, not a formality. Returning a hand-built echo of
   * the input would make this method agree with itself by construction; reading
   * the fold proves the log is the source of record (I12) and turns any
   * projection/event disagreement into an immediate, loud failure instead of a
   * board that quietly disagrees with its own log.
   */
  createInstance(input: CreateInstanceInput): TaskRecord {
    const instanceId = this.deps.ids.uuid();
    // ⚠ MINT ONE id PER acceptance criterion, SERVER-SIDE, from the SAME injected
    // source that minted `instanceId` above (rule 0.3 — nothing here reaches for
    // randomUUID). The input criterion is `{ text }` (text only); the RECORD/event
    // criterion is `{ id, text }`, and this map is the ONE place the id comes into
    // existence. Writing the FULL `{ id, text }` into the birth payload is what
    // makes replay deterministic: the fold reads the stored id back and never
    // re-mints, so the same carrying-log folds to a byte-identical record every
    // time (I6). `undefined` in → `undefined` out, so the conditional-spread below
    // omits the key entirely and an unauthored creation stays byte-identical to a
    // pre-slice-7 birth record.
    const mintedAcceptanceCriteria =
      input.acceptanceCriteria === undefined
        ? undefined
        : input.acceptanceCriteria.map((criterion) => ({
            id: this.deps.ids.uuid(),
            text: criterion.text,
          }));
    this.deps.emit([
      // ⚠ THIS IS THE ALIAS ADAPTER'S `task_created` MAPPING, WRITTEN FORWARD.
      // `RETIRED_EVENT_KINDS[task_created].adapt` in events.ts turns a recorded
      // legacy birth record into exactly this shape; the writer now produces it
      // directly. Read the two together — a divergence between them is a
      // mixed-era stream that folds two ways (S11-A2).
      instanceCreated({
        instanceId,
        project: input.projectRoot,
        // The node the instance starts on — carried, never re-derived.
        node: input.stage,
        createdBy: input.createdBy,
        // ⚠ THE PINNED REF — S12·U2 (D72 Move 3), replacing the `null` stamp.
        // Slice 11 wrote `null` because rule 0.7 forbade claiming an identity
        // nothing pinned: no workflow definition governed adjudication then. That
        // condition ENDED with this unit — the boot-resolved declaration above IS
        // what decides every move now — so the honest stamp is the declaration's
        // own `{ extension, workflow, rev }`, read off the manifest and carried,
        // never re-derived.
        //
        // ⚠ `null` DID NOT DIE, IT STOPPED BEING WRITTEN HERE. It remains what the
        // ALIAS ADAPTER writes when it folds a RECORDED legacy `task_created`
        // (`RETIRED_EVENT_KINDS` in events.ts — recorded truth, and not this
        // unit's to touch), and what every pre-Move-3 birth record already
        // carries. So the field stays nullable, the fold still accepts both, and a
        // mixed-era stream folds one way (S11-A2 / S12-A6).
        workflow: this.deps.workflowRef,
        // TRANSITIONAL core, both of them (slice-11.md's fence): the engine still
        // reads these to decide, so neither may live under `payload`.
        isolation: input.isolation,
        // Omitted rather than sent as `{}` when the creator named no gates, so an
        // ungated instance's birth record keeps the absent-vs-empty discipline the
        // fold's one defaulting rule (`gates ?? {}`) depends on.
        ...(input.gates === undefined ? {} : { gates: input.gates }),
        // ── the OPAQUE payload (q13's split) ───────────────────────────────────
        //
        // The five AUTHORED fields, under one key. Each omitted rather than sent
        // as `undefined` when the creator named nothing — ABSENT STAYS ABSENT, the
        // same idiom `task_created` used field-by-field and the alias adapter
        // preserves entry-by-entry, so an unauthored creation stays byte-identical
        // to every pre-slice-7 one (I6). `acceptanceCriteria` carries the MINTED
        // `{ id, text }` entries computed above, never the raw input.
        payload: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.explicitlyOut === undefined ? {} : { explicitlyOut: input.explicitlyOut }),
          ...(mintedAcceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: mintedAcceptanceCriteria }),
          ...(input.killCriterion === undefined ? {} : { killCriterion: input.killCriterion }),
        },
      }),
    ]);
    const bornTask = this.deps.readTasks().tasks[instanceId];
    if (bornTask === undefined) {
      throw new InstanceProjectionDisagreementError(
        `instance_created was written for ${instanceId} but the instances projection did not fold it`,
      );
    }
    return bornTask;
  }

  /**
   * Propose ONE move. **THIS IS I7's CHOKE POINT.**
   *
   * The invariant is not "the machine returned a rejection" — it is
   * **"the rejection was WRITTEN DOWN."** A rejection path that returns without
   * emitting is the exact bug this class exists to prevent, which is why the
   * emit sits on the refusal branch itself rather than anywhere a later edit
   * could route around it.
   *
   * TOTAL OVER ITS INPUT SPACE: **no (instanceId, proposal) pair produces a throw**
   * (I8) — unknown ids, unknown nodes, illegal edges and terminal nodes all
   * return a result. Stated precisely because there IS one throw below, and it is
   * not input-driven: a projection that has stopped agreeing with the log is a
   * rule-0.1 finding, and hiding it behind a plausible return value is how a
   * board comes to disagree with its own history in silence.
   *
   * The three outcomes and what each one writes:
   *
   *   • unknown instance → NOTHING is emitted. There is no instance to have
   *     proposed against, and fabricating a rejection record for an id no birth
   *     record ever introduced would put a phantom instance in the log — the same
   *     reasoning that keeps `TaskDispatcher` silent on an unknown task.
   *
   *   • REJECTED → ONE `instance_move_rejected` carrying the ATTEMPTED edge
   *     (both ends) and the machine's exact reason, then the reason is returned.
   *     Note `attemptedToNode` is written from the PROPOSAL, not from the record:
   *     no move happened, so there is no "to" node on the instance to read.
   *
   *   • ACCEPTED → ONE `instance_moved` carrying the machine's RESULTING
   *     `manualReviewRequired` — NOT the proposal's request. The machine only
   *     honours that flag into `done` (the convergence exit) and carries the
   *     instance's existing value through everywhere else; recording the request
   *     instead would let a proposal set the flag on an edge the machine ignored
   *     it on, and the log and the projection would disagree. Then the next record
   *     is read back out of the projection, for the same I12 reason
   *     `createInstance` reads its own.
   */
  proposeMove(taskId: string, proposal: TransitionProposal): ProposeMoveResult {
    // Fresh read, every call. See `InstanceWriterDeps.readTasks`.
    const task = this.deps.readTasks().tasks[taskId];
    if (task === undefined) {
      return { outcome: 'unknown-task', taskId };
    }

    // ── THE ONLY ADJUDICATION IN THIS FILE (S12·U2, D72 Move 3) ───────────────
    //
    // Delegated, never re-derived — and what it READS moved, while where it lives
    // did not: core's declaration-reading `proposeMove` against the boot-resolved
    // workflow, in place of the compiled machine deleted in S12·U3. Same
    // decisions, by construction and by proof (S12-A1's full cross product).
    //
    // ⚠ F2, THE MINIMAL HONEST VERSION: adjudication consults the BOOT
    // declaration, full stop — never a per-instance re-resolution. A defensive
    // ref-identity check (the instance's pinned `extension`/`workflow` against the
    // boot ref's, a disagreement-error if they differ; a `rev` DIFFERENCE is not a
    // mismatch, because one boot declaration governs) is deliberately NOT plumbed
    // here: the record at this site is the LEGACY `TaskRecord` narrowing, which
    // carries no ref field at all, and inventing a read to check it would be new
    // plumbing for a case no reachable path produces (this daemon stamps every ref
    // from this same declaration, and `null` means pre-Move-3). The check lands
    // with the widened view, not before it.
    const decision = adjudicateAgainstDeclaration(
      task.stage,
      { toNode: proposal.toStage, proposedBy: proposal.proposedBy },
      this.deps.workflow,
    );

    if (!decision.accepted) {
      // S13·U1: two-channel vocabulary per slice-13 F1 — the engine's refusals are
      // a closed enum BY AUTHORSHIP (only `proposeMove.ts` writes them), declared
      // refusals arrive BY PROVENANCE from the pinned declaration's forbidden row.
      // Recorded verbatim, never enumerated here. The parse this replaced was the
      // debt its own comment scheduled for the alias-death deploy; it is paid.
      const reason: string = decision.reason;
      this.deps.emit([
        instanceMoveRejected({
          instanceId: task.taskId,
          fromNode: task.stage,
          // Both node fields on this payload are `z.string()` by design (step 1,
          // carried into the generic schema), precisely so an unknown-node
          // rejection stays recordable. Writing the proposal's raw value is the
          // whole point.
          attemptedToNode: proposal.toStage,
          reason,
          proposedBy: proposal.proposedBy,
        }),
      ]);
      return { outcome: 'rejected', reason };
    }

    // The RECORD an accepted move produces, from core's own helper (F5): the
    // adjudicator returns a DECISION ONLY — no next record, no derived flag —
    // because computing one needs this tenant's vocabulary (`done` is the
    // convergence exit), which the declaration-reading adjudicator must not
    // contain. So the node write and the flag rule stay in
    // `nextTaskForAcceptedTransition`, beside that vocabulary, and this writer
    // still RECORDS WHAT CAME BACK rather than deciding anything.
    const acceptedNextTask: TaskRecord = nextTaskForAcceptedTransition(task, proposal);

    this.deps.emit([
      instanceMoved({
        instanceId: task.taskId,
        fromNode: task.stage,
        // From the ACCEPTED RECORD, so the recorded edge is the edge the
        // adjudicator accepted rather than the edge the caller asked for.
        toNode: acceptedNextTask.stage,
        manualReviewRequired: acceptedNextTask.manualReviewRequired,
        proposedBy: proposal.proposedBy,
        ...(proposal.note === undefined ? {} : { note: proposal.note }),
      }),
    ]);

    const movedTask = this.deps.readTasks().tasks[taskId];
    if (movedTask === undefined) {
      // Unreachable through any request shape (the instance existed a moment ago
      // and nothing deletes instances) — see InstanceProjectionDisagreementError.
      // Falling back to the machine's `nextTask` here would hide exactly the
      // divergence the read-back exists to expose.
      throw new InstanceProjectionDisagreementError(
        `instance_moved was written for ${taskId} but the instances projection no longer holds it`,
      );
    }
    return { outcome: 'accepted', task: movedTask };
  }

  /**
   * Revise an instance payload: emit ONE `instance_payload_revised` carrying only
   * the fields the reviser named plus the rev the record will reflect afterwards,
   * and return the record **as the projection folded it** (same I12 read-back
   * reasoning as `createInstance`).
   *
   * **THE REV IS COMPUTED HERE, AND ONLY HERE.** `(task.workOrderRev ?? 0) + 1` —
   * the payload states the rev AFTER the revision and the fold records it
   * verbatim, so nothing downstream ever counts revision events to derive one. A
   * second place that computed a rev would be a second authority over the identity
   * `(instanceId, node, attempt, payloadRev)` that D43 and D46 both hang on.
   *
   * TOTAL OVER ITS INPUT SPACE, like `proposeMove`: no (instanceId, input)
   * pair throws. The one throw below is not input-driven — it is the
   * projection/log divergence that is a rule-0.1 finding.
   *
   * ⚠ **NO NODE ADJUDICATION, DELIBERATELY — THIS IS NOT A MISSING CHECK.** An
   * instance on ANY node may be revised, including `done`, `cancelled` and
   * `quarantined`. Revisions are RECORD FACTS, not moves: the adjudicator
   * is never consulted, no edge is traversed, and the declared legality table has
   * nothing to say about them (adding a guard here would be exactly the second
   * adjudicator the file header forbids). Correcting the written scope of finished work is a
   * legitimate act — the log keeps every revision — and nothing dangerous follows
   * from it, because dispatch is a separate decision and `decideDispatch` already
   * refuses a task whose stage does not run a worker.
   *
   * ⚠ **NO DISPATCH COUPLING.** A revision never spawns, kills, resumes or steers
   * a session, and never proposes a move. D53: the explicit dispatch IS the
   * decision, and D46's amend door is "a FRESH dispatch against a new
   * `payloadRev`" — *fresh*, i.e. one somebody asks for afterwards. Whoever
   * revises decides separately whether the running attempt should be re-run.
   */
  revisePayload(taskId: string, input: RevisePayloadInput): RevisePayloadResult {
    // Fresh read, every call. See `InstanceWriterDeps.readTasks` — a reviser
    // working from a stale board would compute its rev off a rev that has since
    // moved.
    const task = this.deps.readTasks().tasks[taskId];
    if (task === undefined) {
      return { outcome: 'unknown-task', taskId };
    }

    // The empty case is checked BEFORE any id is minted or validated, so a caller
    // that named nothing at all burns nothing and writes nothing.
    if (
      input.scope === undefined &&
      input.explicitlyOut === undefined &&
      input.acceptanceCriteria === undefined &&
      input.killCriterion === undefined
    ) {
      return { outcome: 'empty-amendment' };
    }

    // ── the criterion pass, in two halves, VALIDATE-THEN-MINT ─────────────────
    //
    // Every supplied id is checked against the record's CURRENT list FIRST, and
    // only then are ids minted for the entries that carry none. The order is
    // deliberate: a refused revision must consume no ids from the injected
    // source, so the id sequence a later successful revision mints from is the
    // one it would have had if the bad request had never arrived (rule 0.3 —
    // determinism is the point of injecting the source at all).
    let resolvedAcceptanceCriteria: { id: string; text: string }[] | undefined;
    if (input.acceptanceCriteria !== undefined) {
      const currentCriterionIds = new Set(
        (task.acceptanceCriteria ?? []).map((criterion) => criterion.id),
      );
      for (const suppliedCriterion of input.acceptanceCriteria) {
        if (suppliedCriterion.id !== undefined && !currentCriterionIds.has(suppliedCriterion.id)) {
          // The FIRST unknown id refuses the WHOLE revision and emits nothing;
          // a partially-applied criteria list is not a state this class can
          // produce.
          return { outcome: 'unknown-criterion', criterionId: suppliedCriterion.id };
        }
      }
      resolvedAcceptanceCriteria = input.acceptanceCriteria.map((criterion) =>
        criterion.id === undefined
          ? { id: this.deps.ids.uuid(), text: criterion.text }
          : { id: criterion.id, text: criterion.text },
      );
    }

    this.deps.emit([
      instancePayloadRevised({
        instanceId: task.taskId,
        // The rev AFTER this revision. Absent on the record until the first
        // revision, so the first one writes rev 1 — matching the `?? 0` every
        // reader of an un-revised instance already spells out.
        payloadRev: (task.workOrderRev ?? 0) + 1,
        revisedBy: input.amendedBy,
        // ⚠ PATCH SEMANTICS, PRESERVED EXACTLY (and this is the alias adapter's
        // `work_order_amended` mapping written forward). Each field omitted rather
        // than sent as `undefined` when the reviser left it alone — the same byte
        // discipline `createInstance` follows, and here it is load-bearing rather
        // than merely tidy: the FOLD reads presence to decide what to replace, so
        // an `undefined`-valued key would be the difference between "leave scope as
        // it was" and "clear it". An explicit `[]` RIDES THROUGH as a replacement.
        patch: {
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.explicitlyOut === undefined ? {} : { explicitlyOut: input.explicitlyOut }),
          // The FULL `{ id, text }` replacement list (minted ids included), never
          // the `{ id?, text }` input shape — the fold reads the stored ids back
          // and never re-mints, which is what makes replay deterministic (I6).
          ...(resolvedAcceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: resolvedAcceptanceCriteria }),
          ...(input.killCriterion === undefined ? {} : { killCriterion: input.killCriterion }),
        },
      }),
    ]);

    const amendedTask = this.deps.readTasks().tasks[taskId];
    if (amendedTask === undefined) {
      // Unreachable through any request shape (the instance existed a moment ago
      // and nothing deletes instances) — see InstanceProjectionDisagreementError.
      // Echoing a hand-built record here would hide exactly the divergence the
      // read-back exists to expose.
      throw new InstanceProjectionDisagreementError(
        `instance_payload_revised was written for ${taskId} but the instances projection no longer holds it`,
      );
    }
    return { outcome: 'amended', task: amendedTask };
  }
}
