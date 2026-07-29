import {
  proposeTransition,
  taskCreated,
  taskTransitioned,
  taskTransitionRejected,
  workOrderAmended,
  type EventInput,
  type IdSource,
  type TaskRecord,
  type TasksState,
  type TransitionProposal,
  type TransitionRejectionReason,
} from '@vimes/core';

// ─── slice 6 step 4b — the SOLE WRITER of task state (daemon I/O) ─────────────
//
// Steps 1–3 built the decisions; step 4a built the executor. This class is the
// ONE place a `task_created`, a `task_transitioned` or a `task_transition_rejected`
// is written. Everything else — the HTTP API in this step, the watchdog in step 5,
// slice 7's MCP surface — is a CALLER of it.
//
// ⚠ WHY THIS IS NOT JUST "LOGIC IN THE ROUTE HANDLER".
// Step 5's watchdog must move a task to `quarantined` IN-PROCESS, not over HTTP.
// If the propose→event logic lived inside an HTTP handler, step 5 would either
// duplicate it (two writers — the principle-10 failure slice 6 names as a halting
// finding) or have to re-plumb it. One writer, two callers, starting now.
//
// ⚠ THIS CLASS IS A PROPOSER, NEVER A DECIDER (principle 10, I7).
// It NEVER computes a next stage, NEVER consults `TASK_STAGE_EDGES`, NEVER calls
// the state machine's internals and NEVER re-derives an edge. It calls
// `proposeTransition` and RECORDS WHAT CAME BACK. If you find yourself adding an
// `if` here that changes WHETHER a transition is legal, it belongs in
// `taskStateMachine.ts` — a second adjudicator is a second authority, and I7 stops
// being assertable headlessly the moment one exists.
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()`. Every method runs to
// completion inside the call that invoked it. The only clock this step reads is
// the injected one, and it is stamped in `app.ts` at the request boundary.

export interface TaskWriterDeps {
  // The router's emit — the ONLY write path. Nothing here touches the store, a
  // snapshot or a projection object directly.
  emit: (events: EventInput[]) => void;
  // Projection reads, called FRESH on every call and never cached in a field.
  // A writer proposing against a stale board is a writer adjudicating an edge out
  // of a stage the task has already left (mirrors `TaskDispatcher.readTasks`).
  readTasks: () => TasksState;
  // INJECTED (rule 0.3). The only source of new taskIds; nothing here calls
  // randomUUID, so a test with a CountingIdSource gets byte-identical taskIds.
  ids: IdSource;
}

// What a creator NAMES. Deliberately NOT a `TaskRecord`: the rest of the record
// (manualReviewRequired, sessionRefs, lastHeartbeatAt, staleRetries) is the
// projection's business, filled from the schema's documented starting values, and
// letting a caller supply them would let an API set a heartbeat on a task that has
// never run.
export interface CreateTaskInput {
  readonly projectRoot: string;
  // OPTIONAL, matching the widened `task_created` payload (step 9). Absent → the
  // record carries no `title` at all (NOT `''`), exactly as every pre-step-9
  // birth record does. Set at creation only; there is no rename path.
  readonly title?: string;
  readonly createdBy: TaskRecord['createdBy'];
  readonly isolation: TaskRecord['isolation'];
  readonly stage: TaskRecord['stage'];
  // OPTIONAL, matching the widened `task_created` payload. Absent → the
  // projection folds `{}` (an ungated task), exactly as every pre-4b birth
  // record did.
  readonly gates?: TaskRecord['gates'];
  // ── S7·2a: the four AUTHORED work-order fields ──────────────────────────────
  //
  // All OPTIONAL, matching the widened `task_created` payload: absent → the birth
  // record carries no such key at all (NOT a default), so an unauthored creation
  // stays byte-identical to every pre-slice-7 one (I6).
  //
  // ⚠ `acceptanceCriteria` is the INPUT shape `{ text }[]` — TEXT ONLY, NO id.
  // This is DELIBERATELY DIFFERENT from the record/event criterion shape
  // (`{ id, text }`, the reserved `acceptanceCriterionSchema`) and the two must
  // NOT be unified: a criterion id is STABLE identity that `report_review` (S7·6)
  // keys per-criterion pass/fail to, it must be unique, and a human authoring form
  // (S7·3) must not hand-type it. So the id is MINTED SERVER-SIDE in `createTask`
  // from the injected id source (the same source that mints `taskId`), never
  // supplied by the caller.
  readonly scope?: string;
  readonly explicitlyOut?: string[];
  readonly acceptanceCriteria?: { text: string }[];
  readonly killCriterion?: string;
}

// ── S7·2b: what an AMENDER names (D43 — work orders are revisioned, not mutated)
//
// The patch half of `CreateTaskInput`: the SAME four authored work-order fields,
// every one optional, plus the author. Deliberately NOT a `Partial<TaskRecord>` —
// `title`, `gates`, `isolation`, `projectRoot` and `stage` are not amendable
// through this door (a title is set at creation by documented decision; a stage
// moves through I7's transition choke and nowhere else), and a `Partial` would
// quietly offer all of them.
export interface AmendWorkOrderInput {
  // WHO decided this amendment. Two values, never `dispatcher` — see the payload
  // schema's note in events.ts: an amendment is a D53 DECISION, and the mechanics
  // have no business authoring one.
  readonly amendedBy: 'human' | 'orchestrator';
  readonly scope?: string;
  readonly explicitlyOut?: string[];
  // ⚠ THE CRITERION SHAPE HERE IS `{ id?, text }`, AND THE OPTIONAL id IS THE
  // WHOLE DESIGN. WITH an id → this entry KEEPS/RESTATES an EXISTING criterion,
  // and the id must match one currently on the record; criterion ids are STABLE
  // IDENTITY that `report_review` (S7·6) keys per-criterion pass/fail to, so an
  // amendment that reworded a criterion while silently re-minting its id would
  // orphan every verdict ever recorded against it. WITHOUT an id → a NEW
  // criterion, its id MINTED SERVER-SIDE from the injected source, exactly as
  // `createTask` mints them: the caller never types an id that does not already
  // exist.
  //
  // The array is a REPLACEMENT LIST, not a delta — what it contains is what the
  // record will carry, so dropping an entry deletes that criterion and an
  // explicit `[]` clears them all.
  readonly acceptanceCriteria?: { id?: string; text: string }[];
  readonly killCriterion?: string;
}

// The outcome of ONE amendment, in the same discriminated-union idiom as
// `ProposeTransitionResult` below: callers must tell the cases apart WITHOUT
// inspecting HTTP semantics, because slice 7's MCP client has no status codes.
export type AmendWorkOrderResult =
  | { readonly outcome: 'amended'; readonly task: TaskRecord }
  // Nothing emitted. Same reasoning as `ProposeTransitionResult`'s case: there was
  // no task to amend, and writing an amendment for a taskId no `task_created` ever
  // introduced would put a phantom task in the log.
  | { readonly outcome: 'unknown-task'; readonly taskId: string }
  // A supplied criterion id is not on the record's CURRENT acceptance list (a
  // record with no criteria at all has no valid ids). Nothing emitted — same "the
  // machine never saw it" posture as `unknown-task`, and refusing WHOLE means a
  // half-applied amendment is not a state this class can produce.
  | { readonly outcome: 'unknown-criterion'; readonly criterionId: string }
  // All four patch fields absent. Nothing emitted: a rev bump that changes nothing
  // is log noise, not an amendment, and it would invalidate every in-flight stage
  // run's `workOrderRev` for no recorded reason.
  | { readonly outcome: 'empty-amendment' };

// The outcome of ONE proposal. A discriminated union in the same idiom as
// `DispatchAttemptResult` (step 4a), because callers must be able to tell the
// three cases apart WITHOUT inspecting HTTP semantics — slice 7's MCP client has
// no status codes to branch on.
//
// ⚠ `unknown-task` is deliberately its own outcome and NOT a
// `TransitionRejectionReason`. The machine never saw this proposal — there was no
// task to propose against — so calling it a rejection would put a reason in the
// enum that `task_transition_rejected` records, and the log would then claim the
// state machine refused an edge it was never shown.
export type ProposeTransitionResult =
  | { readonly outcome: 'accepted'; readonly task: TaskRecord }
  | { readonly outcome: 'rejected'; readonly reason: TransitionRejectionReason }
  | { readonly outcome: 'unknown-task'; readonly taskId: string };

// Thrown ONLY when the log and the projection disagree: an event was written and
// the fold did not produce the record it describes. That is a rule-0.1 finding
// (the log is the source of record, I12), not an input error — so it surfaces as
// a 500 with the finding in it rather than a plausible-looking 200. It is
// unreachable through any request shape; only a projection/event divergence
// produces it.
export class TaskProjectionDisagreementError extends Error {}

export class TaskWriter {
  private readonly deps: TaskWriterDeps;

  constructor(deps: TaskWriterDeps) {
    this.deps = deps;
  }

  /**
   * Create a task: mint an id, emit ONE `task_created`, and return the record
   * **as the projection folded it**.
   *
   * ⚠ The read-back is the point, not a formality. Returning a hand-built echo of
   * the input would make this method agree with itself by construction; reading
   * the fold proves the log is the source of record (I12) and turns any
   * projection/event disagreement into an immediate, loud failure instead of a
   * board that quietly disagrees with its own log.
   */
  createTask(input: CreateTaskInput): TaskRecord {
    const taskId = this.deps.ids.uuid();
    // ⚠ MINT ONE id PER acceptance criterion, SERVER-SIDE, from the SAME injected
    // source that minted `taskId` above (rule 0.3 — nothing here reaches for
    // randomUUID). The input criterion is `{ text }` (text only); the RECORD/event
    // criterion is `{ id, text }`, and this map is the ONE place the id comes into
    // existence. Writing the FULL `{ id, text }` into the `task_created` payload is
    // what makes replay deterministic: the fold reads the stored id back and never
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
      taskCreated({
        taskId,
        projectRoot: input.projectRoot,
        // Omitted rather than sent as `undefined`/`''` when the creator named no
        // title, so an untitled task's birth record is byte-identical to every
        // pre-step-9 one (I6). Same rule as `gates` below.
        ...(input.title === undefined ? {} : { title: input.title }),
        createdBy: input.createdBy,
        isolation: input.isolation,
        stage: input.stage,
        // Omitted rather than sent as `{}` when the creator named no gates, so an
        // ungated task's birth record is byte-identical to every pre-4b one.
        ...(input.gates === undefined ? {} : { gates: input.gates }),
        // The four AUTHORED work-order fields (S7·2a). Each omitted rather than
        // sent as `undefined` when the creator named nothing, so an unauthored
        // task's birth record is byte-identical to every pre-slice-7 one (I6) —
        // the same idiom as `title`/`gates` above. `acceptanceCriteria` carries
        // the MINTED `{ id, text }` entries computed above, never the raw input.
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.explicitlyOut === undefined ? {} : { explicitlyOut: input.explicitlyOut }),
        ...(mintedAcceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: mintedAcceptanceCriteria }),
        ...(input.killCriterion === undefined ? {} : { killCriterion: input.killCriterion }),
      }),
    ]);
    const bornTask = this.deps.readTasks().tasks[taskId];
    if (bornTask === undefined) {
      throw new TaskProjectionDisagreementError(
        `task_created was written for ${taskId} but the tasks projection did not fold it`,
      );
    }
    return bornTask;
  }

  /**
   * Propose ONE transition. **THIS IS I7's CHOKE POINT.**
   *
   * The invariant is not "the machine returned a rejection" — it is
   * **"the rejection was WRITTEN DOWN."** A rejection path that returns without
   * emitting is the exact bug this class exists to prevent, which is why the
   * emit sits on the refusal branch itself rather than anywhere a later edit
   * could route around it.
   *
   * TOTAL OVER ITS INPUT SPACE: **no (taskId, proposal) pair produces a throw**
   * (I8) — unknown ids, unknown stages, illegal edges and terminal stages all
   * return a result. Stated precisely because there IS one throw below, and it is
   * not input-driven: a projection that has stopped agreeing with the log is a
   * rule-0.1 finding, and hiding it behind a plausible return value is how a
   * board comes to disagree with its own history in silence.
   *
   * The three outcomes and what each one writes:
   *
   *   • unknown task → NOTHING is emitted. There is no task to have proposed
   *     against, and fabricating a rejection record for a taskId no `task_created`
   *     ever introduced would put a phantom task in the log — the same reasoning
   *     that keeps `TaskDispatcher` silent on an unknown task.
   *
   *   • REJECTED → ONE `task_transition_rejected` carrying the ATTEMPTED edge
   *     (both ends) and the machine's exact reason, then the reason is returned.
   *     Note `attemptedToStage` is written from the PROPOSAL, not from the record:
   *     no transition happened, so there is no "to" stage on the task to read.
   *
   *   • ACCEPTED → ONE `task_transitioned` carrying the machine's RESULTING
   *     `manualReviewRequired` — NOT the proposal's request. The machine only
   *     honours that flag into `done` (the convergence exit) and carries the
   *     task's existing value through everywhere else; recording the request
   *     instead would let a proposal set the flag on an edge the machine ignored
   *     it on, and the log and the projection would disagree. Then the next record
   *     is read back out of the projection, for the same I12 reason `createTask`
   *     reads its own.
   */
  proposeTaskTransition(taskId: string, proposal: TransitionProposal): ProposeTransitionResult {
    // Fresh read, every call. See `TaskWriterDeps.readTasks`.
    const task = this.deps.readTasks().tasks[taskId];
    if (task === undefined) {
      return { outcome: 'unknown-task', taskId };
    }

    // The ONLY adjudication in this file — delegated, never re-derived.
    const machineOutcome = proposeTransition(task, proposal);

    if (!machineOutcome.accepted) {
      this.deps.emit([
        taskTransitionRejected({
          taskId: task.taskId,
          fromStage: task.stage,
          // Both stage fields on this payload are `z.string()` by design (step 1),
          // precisely so an `unknown-stage` rejection stays recordable. Writing
          // the proposal's raw value is the whole point.
          attemptedToStage: proposal.toStage,
          reason: machineOutcome.reason,
          proposedBy: proposal.proposedBy,
        }),
      ]);
      return { outcome: 'rejected', reason: machineOutcome.reason };
    }

    this.deps.emit([
      taskTransitioned({
        taskId: task.taskId,
        fromStage: task.stage,
        // From the machine's OWN result, so the recorded edge is the edge the
        // machine accepted rather than the edge the caller asked for.
        toStage: machineOutcome.nextTask.stage,
        manualReviewRequired: machineOutcome.nextTask.manualReviewRequired,
        proposedBy: proposal.proposedBy,
        ...(proposal.note === undefined ? {} : { note: proposal.note }),
      }),
    ]);

    const movedTask = this.deps.readTasks().tasks[taskId];
    if (movedTask === undefined) {
      // Unreachable through any request shape (the task existed a moment ago and
      // nothing deletes tasks) — see TaskProjectionDisagreementError. Falling back
      // to the machine's `nextTask` here would hide exactly the divergence the
      // read-back exists to expose.
      throw new TaskProjectionDisagreementError(
        `task_transitioned was written for ${taskId} but the tasks projection no longer holds it`,
      );
    }
    return { outcome: 'accepted', task: movedTask };
  }

  /**
   * Amend a work order: emit ONE `work_order_amended` carrying only the fields the
   * amender named plus the rev the record will reflect afterwards, and return the
   * record **as the projection folded it** (same I12 read-back reasoning as
   * `createTask`).
   *
   * **THE REV IS COMPUTED HERE, AND ONLY HERE.** `(task.workOrderRev ?? 0) + 1` —
   * the payload states the rev AFTER the amendment and the fold records it
   * verbatim, so nothing downstream ever counts amendment events to derive one. A
   * second place that computed a rev would be a second authority over the identity
   * `(taskId, stage, attempt, workOrderRev)` that D43 and D46 both hang on.
   *
   * TOTAL OVER ITS INPUT SPACE, like `proposeTaskTransition`: no (taskId, input)
   * pair throws. The one throw below is not input-driven — it is the
   * projection/log divergence that is a rule-0.1 finding.
   *
   * ⚠ **NO STAGE ADJUDICATION, DELIBERATELY — THIS IS NOT A MISSING CHECK.** A
   * task in ANY stage may be amended, including `done`, `cancelled` and
   * `quarantined`. Amendments are RECORD FACTS, not transitions: the state machine
   * is never consulted, no edge is traversed, and `TASK_STAGE_EDGES` has nothing to
   * say about them (adding a guard here would be exactly the second adjudicator the
   * file header forbids). Correcting the written scope of finished work is a
   * legitimate act — the log keeps every revision — and nothing dangerous follows
   * from it, because dispatch is a separate decision and `decideDispatch` already
   * refuses a task whose stage does not run a worker.
   *
   * ⚠ **NO DISPATCH COUPLING.** An amendment never spawns, kills, resumes or steers
   * a session, and never proposes a transition. D53: the explicit dispatch IS the
   * decision, and D46's amend door is "a FRESH dispatch against a new
   * `workOrderRev`" — *fresh*, i.e. one somebody asks for afterwards. Whoever
   * amends decides separately whether the running attempt should be re-run.
   */
  amendWorkOrder(taskId: string, input: AmendWorkOrderInput): AmendWorkOrderResult {
    // Fresh read, every call. See `TaskWriterDeps.readTasks` — an amender working
    // from a stale board would compute its rev off a rev that has since moved.
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
    // deliberate: a refused amendment must consume no ids from the injected
    // source, so the id sequence a later successful amendment mints from is the
    // one it would have had if the bad request had never arrived (rule 0.3 —
    // determinism is the point of injecting the source at all).
    let resolvedAcceptanceCriteria: { id: string; text: string }[] | undefined;
    if (input.acceptanceCriteria !== undefined) {
      const currentCriterionIds = new Set(
        (task.acceptanceCriteria ?? []).map((criterion) => criterion.id),
      );
      for (const suppliedCriterion of input.acceptanceCriteria) {
        if (suppliedCriterion.id !== undefined && !currentCriterionIds.has(suppliedCriterion.id)) {
          // The FIRST unknown id refuses the WHOLE amendment and emits nothing;
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
      workOrderAmended({
        taskId: task.taskId,
        // The rev AFTER this amendment. Absent on the record until the first
        // amendment, so the first one writes rev 1 — matching the `?? 0` every
        // reader of an un-amended task already spells out.
        workOrderRev: (task.workOrderRev ?? 0) + 1,
        amendedBy: input.amendedBy,
        // Each field omitted rather than sent as `undefined` when the amender left
        // it alone — the same byte discipline `createTask` follows, and here it is
        // load-bearing rather than merely tidy: the FOLD reads presence to decide
        // what to replace, so an `undefined`-valued key would be the difference
        // between "leave scope as it was" and "clear it".
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.explicitlyOut === undefined ? {} : { explicitlyOut: input.explicitlyOut }),
        // The FULL `{ id, text }` replacement list (minted ids included), never the
        // `{ id?, text }` input shape — the fold reads the stored ids back and
        // never re-mints, which is what makes replay deterministic (I6).
        ...(resolvedAcceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: resolvedAcceptanceCriteria }),
        ...(input.killCriterion === undefined ? {} : { killCriterion: input.killCriterion }),
      }),
    ]);

    const amendedTask = this.deps.readTasks().tasks[taskId];
    if (amendedTask === undefined) {
      // Unreachable through any request shape (the task existed a moment ago and
      // nothing deletes tasks) — see TaskProjectionDisagreementError. Echoing a
      // hand-built record here would hide exactly the divergence the read-back
      // exists to expose.
      throw new TaskProjectionDisagreementError(
        `work_order_amended was written for ${taskId} but the tasks projection no longer holds it`,
      );
    }
    return { outcome: 'amended', task: amendedTask };
  }
}
