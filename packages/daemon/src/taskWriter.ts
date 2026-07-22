import {
  proposeTransition,
  taskCreated,
  taskTransitioned,
  taskTransitionRejected,
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
  readonly createdBy: TaskRecord['createdBy'];
  readonly isolation: TaskRecord['isolation'];
  readonly stage: TaskRecord['stage'];
  // OPTIONAL, matching the widened `task_created` payload. Absent → the
  // projection folds `{}` (an ungated task), exactly as every pre-4b birth
  // record did.
  readonly gates?: TaskRecord['gates'];
}

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
    this.deps.emit([
      taskCreated({
        taskId,
        projectRoot: input.projectRoot,
        createdBy: input.createdBy,
        isolation: input.isolation,
        stage: input.stage,
        // Omitted rather than sent as `{}` when the creator named no gates, so an
        // ungated task's birth record is byte-identical to every pre-4b one.
        ...(input.gates === undefined ? {} : { gates: input.gates }),
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
}
