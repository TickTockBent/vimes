import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord, TaskRecord } from '../schemas.js';
import type { Projection } from './projection.js';
import {
  EVENT_TYPES,
  taskCreatedPayloadSchema,
  taskSessionAttachedPayloadSchema,
  taskTransitionedPayloadSchema,
} from '../events.js';

// ─── slice 6 step 2 — the tasks projection (PURE, packages/core) ─────────────
//
// The task board's state, folded from the 'tasks' stream. No task state is
// written anywhere but the log (I12); this is the only place it is READ back
// into a shape a UI or a dispatcher can look at.
//
// ⚠ THE PROJECTION APPLIES WHAT WAS RECORDED — IT NEVER RE-DECIDES.
// `proposeTransition` is deliberately NOT called here, and must not be added.
// The dispatcher already decided each transition, and `task_transitioned` is
// the record of that decision. Re-validating a recorded transition on replay
// would make the projection a SECOND authority over task stage (principle 10),
// and the day `TASK_STAGE_EDGES` changes it would silently rewrite history —
// old, legitimately-accepted transitions would stop folding and the board would
// disagree with its own log. The log is truth; this fold obeys it.

export interface TasksState {
  tasks: Record<string, TaskRecord>;
}

// Immutably replace one task; a no-op when the task is unknown (log is truth,
// nothing throws — transitions for tasks we never saw created are ignored and
// never fabricate a record). Mirrors `withSession` in projections/sessions.ts.
function withTask(
  state: TasksState,
  taskId: string,
  update: (task: TaskRecord) => TaskRecord,
): TasksState {
  const existingTask = state.tasks[taskId];
  if (existingTask === undefined) {
    return state;
  }
  return {
    tasks: { ...state.tasks, [taskId]: update(existingTask) },
  };
}

export const tasksProjection: Projection<TasksState> = {
  id: 'tasks',

  init(): TasksState {
    return { tasks: {} };
  },

  // TOTAL: unknown event types are no-ops; events for unknown tasks are no-ops;
  // a malformed payload is a no-op. Nothing throws (I8's spirit — hostile input
  // must not crash a fold). PURE: `state` is never mutated, because snapshots
  // share references with live state and boot replays a snapshot forward.
  apply(state: TasksState, event: EventRecord): TasksState {
    switch (event.type) {
      case EVENT_TYPES.taskCreated: {
        const parsed = taskCreatedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        if (state.tasks[payload.taskId] !== undefined) {
          // Duplicate creation is a no-op — never clobber an existing record.
          // Replay safety: a re-delivered or re-appended birth record must not
          // reset a task that has since moved through several stages.
          return state;
        }
        // The birth record carries only what the creator NAMED (taskId,
        // projectRoot, createdBy, isolation, stage). Everything else is the
        // schema's documented starting value, filled in here rather than in the
        // event, so the event stays a statement of intent and the projection
        // owns the record shape.
        const bornTask: TaskRecord = {
          taskId: payload.taskId,
          projectRoot: payload.projectRoot,
          stage: payload.stage,
          manualReviewRequired: false,
          isolation: payload.isolation,
          gates: {},
          sessionRefs: [],
          createdBy: payload.createdBy,
          lastHeartbeatAt: null,
          staleRetries: 0,
        };
        return { tasks: { ...state.tasks, [payload.taskId]: bornTask } };
      }

      case EVENT_TYPES.taskTransitioned: {
        const parsed = taskTransitionedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Applied TOTALLY — the edge was already adjudicated by the state
        // machine before this event was written (see the header note). Note the
        // payload's `fromStage` is deliberately NOT checked against the record:
        // that would be re-deciding, and a mismatch is a dispatcher bug to be
        // found in the log, not a divergence to be papered over here.
        return withTask(state, payload.taskId, (task) => ({
          ...task,
          stage: payload.toStage,
          // The RESULTING convergence flag as the machine decided it (only the
          // `→ done` edge can turn it on; every other edge carries the task's
          // existing value through, which the emitter already recorded).
          manualReviewRequired: payload.manualReviewRequired,
        }));
      }

      case EVENT_TYPES.taskSessionAttached: {
        const parsed = taskSessionAttachedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Unknown task → no-op, exactly like `task_transitioned` above: a ref for
        // a task we never saw created must never fabricate a record.
        return withTask(state, payload.taskId, (task) => {
          // IDEMPOTENT ON REPLAY, keyed on `appSessionId`. `sessionRefs` is the
          // only field of a TaskRecord that ACCUMULATES rather than being
          // overwritten, so it is the only one where folding the same fact twice
          // leaves a trace — every other case in this fold is naturally
          // idempotent (a stage assignment applied twice is the same stage).
          //
          // ⚠ Stated precisely, because the plausible version is wrong and was
          // checked by breaking this line: I6 does NOT catch a duplicate append.
          // Cut points replay the SAME record sequence either way, so a fold that
          // appends twice appends twice in both paths and replay equivalence
          // still holds. What this guard defends is the fold being handed the
          // same event MORE THAN ONCE — an at-least-once delivery, an overlapping
          // tail read, an operator re-appending a record — where the board would
          // sprout a phantom second stage run that never existed. The dedicated
          // idempotence test, not I6, is what holds this line.
          //
          // Keyed on `appSessionId` and deliberately NOT on stage: the same
          // session cannot run twice, while one task legitimately accumulates
          // several refs across stages AND several within one stage (a re-run
          // after a quarantine is a NEW session, and must be kept).
          if (task.sessionRefs.some((existingRef) => existingRef.appSessionId === payload.appSessionId)) {
            return task;
          }
          return {
            ...task,
            // APPEND, never sort: the refs are a chronological trail of which
            // sessions ran this task, and the log order is the only order that
            // means anything. New array, never a push onto the shared one —
            // snapshots share references with live state.
            sessionRefs: [
              ...task.sessionRefs,
              { stage: payload.stage, appSessionId: payload.appSessionId },
            ],
          };
        });
      }

      // ── deliberately NOT folded ────────────────────────────────────────────
      //
      // `task_transition_rejected` — a rejection changed NOTHING about task
      //   state; the task is still in `fromStage`. It is I7's *evidence*, and it
      //   lives in the log where a reviewer reads it. This projection is state,
      //   not audit; folding a non-change would invent one.
      //
      // `dispatch_refused` — I10's refusal record. The spawn did not happen and
      //   the task stayed exactly where it was. Same reason: nothing to fold.
      //
      // `task_quarantined` — lives on the SESSION stream and is a fact about a
      //   stage session (it raises `needsAttention` in projections/sessions.ts),
      //   NOT the authority for task stage. A task's move to `quarantined`
      //   arrives as an ordinary `task_transitioned` from the dispatcher.
      //   Principle 9, one source of record per fact: folding both would make
      //   the stage derivable from two places, and they would eventually
      //   disagree.
      //
      // ...along with every other event type, which does not change a TaskRecord.
      default:
        return state;
    }
  },

  serialize(state: TasksState): string {
    // canonicalJson sorts keys deeply, so the `tasks` Record's INSERTION order
    // cannot leak into the bytes. Never hand-roll the ordering here.
    return canonicalJson(state);
  },
};
