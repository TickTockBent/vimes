import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput, EventRecord, TaskRecord } from '../schemas.js';
import { taskRecordSchema } from '../schemas.js';
import {
  dispatchRefused,
  taskCreated,
  taskQuarantined,
  taskSessionAttached,
  taskTransitioned,
  taskTransitionRejected,
} from '../events.js';
import { readAllStreamsGrouped, replayFromEmpty } from './projection.js';
import { tasksProjection, type TasksState } from './tasks.js';

const TASK_A = 'task-aaaa-0001';
const TASK_B = 'task-bbbb-0002';
const STAGE_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function makeStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

// Fold a list of event batches through the projection exactly as boot would.
function stateFromLog(batches: EventInput[][]): TasksState {
  const store = makeStore();
  for (const batch of batches) {
    store.append(batch);
  }
  return replayFromEmpty(tasksProjection, readAllStreamsGrouped(store));
}

// A single recorded event, for the cases that need to apply one event to a
// hand-built state (purity, malformed payloads, unknown types).
function recordOf(input: EventInput): EventRecord {
  const store = makeStore();
  store.append([input]);
  return store.read(input.stream, 1)[0]!;
}

function createTaskA(): EventInput {
  return taskCreated({
    taskId: TASK_A,
    projectRoot: '/home/user/projects/vimes',
    createdBy: 'human',
    isolation: 'worktree',
    stage: 'backlog',
  });
}

describe('tasks projection — task_created', () => {
  it('inserts a well-formed TaskRecord that the schema accepts', () => {
    const state = stateFromLog([[createTaskA()]]);
    const bornTask = state.tasks[TASK_A];
    expect(bornTask).toBeDefined();

    // Assertion 1: the projection can never produce a record the schema rejects.
    const validated = taskRecordSchema.safeParse(bornTask);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);

    expect(bornTask).toEqual({
      taskId: TASK_A,
      projectRoot: '/home/user/projects/vimes',
      stage: 'backlog',
      manualReviewRequired: false,
      isolation: 'worktree',
      gates: {},
      sessionRefs: [],
      createdBy: 'human',
      lastHeartbeatAt: null,
      staleRetries: 0,
    } satisfies TaskRecord);
  });

  it('honours the stage the birth record STATES rather than assuming backlog', () => {
    const state = stateFromLog([
      [
        taskCreated({
          taskId: TASK_B,
          projectRoot: '/home/user/projects/vimes',
          createdBy: 'orchestrator',
          isolation: 'shared-dir',
          stage: 'planning',
        }),
      ],
    ]);
    expect(state.tasks[TASK_B]!.stage).toBe('planning');
    expect(state.tasks[TASK_B]!.isolation).toBe('shared-dir');
    expect(state.tasks[TASK_B]!.createdBy).toBe('orchestrator');
  });

  it('folds the GATES the birth record carries (step 4b widening)', () => {
    // Assertion 1, first half. Until step 4b widened `task_created`, no event
    // could set `gates` at all — the field existed on the record, defaulted to
    // `{}`, and was unreachable, which made I10's whole refusal path test-only.
    // This is the fold that makes a gated task expressible in the log.
    const state = stateFromLog([
      [
        taskCreated({
          taskId: TASK_B,
          projectRoot: '/home/user/projects/vimes',
          createdBy: 'orchestrator',
          isolation: 'worktree',
          stage: 'backlog',
          gates: {
            requireHeadroom: { meterId: 'window-5h', pct: 40 },
            deferUntilReset: 'weekly-cap',
          },
        }),
      ],
    ]);
    const gatedTask = state.tasks[TASK_B];
    expect(gatedTask!.gates).toEqual({
      requireHeadroom: { meterId: 'window-5h', pct: 40 },
      deferUntilReset: 'weekly-cap',
    });
    // The widened record must still satisfy the slice-0 schema unchanged.
    const validated = taskRecordSchema.safeParse(gatedTask);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
  });

  it('a birth record with NO gates still folds {} — old events are unchanged', () => {
    // Assertion 1, second half, and the reason the widening is OPTIONAL-only: a
    // `task_created` written before the field existed must fold to exactly what
    // it folded to then, or I6 breaks over every log already on disk.
    const withoutGates = stateFromLog([[createTaskA()]]);
    expect(withoutGates.tasks[TASK_A]!.gates).toEqual({});

    // Stated as a BYTE comparison as well, because "equals {}" would also pass
    // for a record that grew an extra key alongside it.
    const explicitlyEmpty = stateFromLog([
      [
        taskCreated({
          taskId: TASK_A,
          projectRoot: '/home/user/projects/vimes',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
          gates: {},
        }),
      ],
    ]);
    expect(tasksProjection.serialize(withoutGates)).toBe(
      tasksProjection.serialize(explicitlyEmpty),
    );
  });

  it('folds the TITLE the birth record carries (step 9 widening)', () => {
    // ASSERTION 1, first half. A task had no human-readable name at all before
    // step 9, which is why the board could only be labelled by UUID.
    const state = stateFromLog([
      [
        taskCreated({
          taskId: TASK_B,
          projectRoot: '/home/user/projects/vimes',
          title: 'wire the kanban board to the tasks projection',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
        }),
      ],
    ]);
    const titledTask = state.tasks[TASK_B];
    expect(titledTask!.title).toBe('wire the kanban board to the tasks projection');
    // The widened record must still satisfy the record schema unchanged.
    const validated = taskRecordSchema.safeParse(titledTask);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
  });

  it('a birth record with NO title folds to a record with NO title key — never ""', () => {
    // ASSERTION 1, second half, and the reason the widening is OPTIONAL-only: a
    // `task_created` written before the field existed must fold to exactly what
    // it folded to then, or I6 breaks over every log already on disk.
    //
    // ⚠ Stated as a BYTE comparison against a hand-built pre-step-9 record and
    // not merely `toBeUndefined()`, because `title: undefined` written as a KEY
    // would also satisfy `toBeUndefined()` while changing what
    // `Object.keys`-based tooling sees — and `''` would satisfy neither but is
    // the tempting default. Absent stays absent.
    const untitled = stateFromLog([[createTaskA()]]);
    const bornTask = untitled.tasks[TASK_A]!;
    expect('title' in bornTask).toBe(false);
    expect(taskRecordSchema.safeParse(bornTask).success).toBe(true);

    // A birth record from a titled task, minus the title, serializes to exactly
    // the same bytes as the untitled one — the widening is invisible when unused.
    const explicitlyUntitled = stateFromLog([
      [
        taskCreated({
          taskId: TASK_A,
          projectRoot: '/home/user/projects/vimes',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
        }),
      ],
    ]);
    expect(tasksProjection.serialize(untitled)).toBe(
      tasksProjection.serialize(explicitlyUntitled),
    );
  });

  it('an EMPTY-STRING title is folded verbatim — it is a title someone chose', () => {
    // The converse of the rule above, and the reason the fold spreads rather
    // than coalescing: `''` is not "no title". The projection does not decide
    // which titles are worth keeping; the board decides what to RENDER, and it
    // falls back to a short taskId for anything blank (see lib/taskBoard.ts).
    const state = stateFromLog([
      [
        taskCreated({
          taskId: TASK_A,
          projectRoot: '/home/user/projects/vimes',
          title: '',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
        }),
      ],
    ]);
    expect(state.tasks[TASK_A]!.title).toBe('');
    expect('title' in state.tasks[TASK_A]!).toBe(true);
  });

  it('a PARTIAL gates object folds exactly what was named, inventing nothing', () => {
    // Both gate fields are independently optional on the record. A task that
    // names only `requireHeadroom` must not acquire a `deferUntilReset` it never
    // asked for — a fabricated gate would refuse work nobody gated.
    const state = stateFromLog([
      [
        taskCreated({
          taskId: TASK_A,
          projectRoot: '/home/user/projects/vimes',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
          gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } },
        }),
      ],
    ]);
    expect(state.tasks[TASK_A]!.gates).toEqual({
      requireHeadroom: { meterId: 'window-5h', pct: 75 },
    });
    expect(state.tasks[TASK_A]!.gates.deferUntilReset).toBeUndefined();
  });

  it('a duplicate task_created never clobbers the existing record (replay safety)', () => {
    // Assertion 2: the task has MOVED since it was born; re-delivering the birth
    // record must not reset it to `backlog`.
    const state = stateFromLog([
      [createTaskA()],
      [
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'backlog',
          toStage: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [createTaskA()],
    ]);
    expect(state.tasks[TASK_A]!.stage).toBe('planning');
    expect(Object.keys(state.tasks)).toEqual([TASK_A]);
  });
});

describe('tasks projection — task_transitioned', () => {
  it('updates the stage of the named task', () => {
    // Assertion 3a.
    const state = stateFromLog([
      [createTaskA()],
      [
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'backlog',
          toStage: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'planning',
          toStage: 'plan-ready',
          manualReviewRequired: false,
          proposedBy: 'orchestrator',
        }),
      ],
    ]);
    expect(state.tasks[TASK_A]!.stage).toBe('plan-ready');
    expect(state.tasks[TASK_A]!.manualReviewRequired).toBe(false);
  });

  it('carries the convergence flag on the → done edge', () => {
    // Assertion 3b — `done` + manualReviewRequired: the explicit hand-off.
    const state = stateFromLog([
      [createTaskA()],
      [
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'review',
          toStage: 'done',
          manualReviewRequired: true,
          proposedBy: 'dispatcher',
          note: 'auto-review stopped converging',
        }),
      ],
    ]);
    expect(state.tasks[TASK_A]!.stage).toBe('done');
    expect(state.tasks[TASK_A]!.manualReviewRequired).toBe(true);
  });

  it('ignores a transition for an unknown taskId — no task is fabricated', () => {
    // Assertion 4.
    const state = stateFromLog([
      [createTaskA()],
      [
        taskTransitioned({
          taskId: 'task-never-created',
          fromStage: 'backlog',
          toStage: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ]);
    expect(Object.keys(state.tasks)).toEqual([TASK_A]);
    expect(state.tasks[TASK_A]!.stage).toBe('backlog');
  });
});

describe('tasks projection — the three deliberately NON-folded events', () => {
  // Assertion 5. Each of these is recorded in the log for a documented reason
  // and must leave task state BYTE-IDENTICAL:
  //   • task_transition_rejected — I7's evidence; nothing about the task changed.
  //   • dispatch_refused         — I10's refusal; the task stayed put.
  //   • task_quarantined         — a SESSION-stream fact; principle 9 keeps the
  //                                task's stage sourced only from task_transitioned.
  const nonFoldedEvents: ReadonlyArray<readonly [string, EventInput]> = [
    [
      'task_transition_rejected',
      taskTransitionRejected({
        taskId: TASK_A,
        fromStage: 'planning',
        attemptedToStage: 'done',
        reason: 'illegal-edge',
        proposedBy: 'orchestrator',
      }),
    ],
    [
      'dispatch_refused',
      dispatchRefused({ taskId: TASK_A, reason: 'requireHeadroom gate failed' }),
    ],
    [
      'task_quarantined',
      taskQuarantined({ appSessionId: STAGE_SESSION_ID, taskId: TASK_A }),
    ],
  ];

  for (const [eventName, nonFoldedEvent] of nonFoldedEvents) {
    it(`${eventName} leaves the task board byte-identical`, () => {
      const before = stateFromLog([
        [createTaskA()],
        [
          taskTransitioned({
            taskId: TASK_A,
            fromStage: 'backlog',
            toStage: 'planning',
            manualReviewRequired: false,
            proposedBy: 'dispatcher',
          }),
        ],
      ]);
      const serializedBefore = tasksProjection.serialize(before);

      const after = tasksProjection.apply(before, recordOf(nonFoldedEvent));
      expect(tasksProjection.serialize(after)).toBe(serializedBefore);
      // Not merely equal bytes — nothing was rebuilt at all.
      expect(after).toBe(before);
    });
  }

  it('quarantine reaches the board only as an ordinary task_transitioned', () => {
    // The positive half of principle 9: the stage DOES move to `quarantined`,
    // but via the task stream's own transition record, never via the session
    // stream's `task_quarantined`.
    const state = stateFromLog([
      [createTaskA()],
      [
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'backlog',
          toStage: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [taskQuarantined({ appSessionId: STAGE_SESSION_ID, taskId: TASK_A })],
      [
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'planning',
          toStage: 'quarantined',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ]);
    expect(state.tasks[TASK_A]!.stage).toBe('quarantined');
  });
});

describe('tasks projection — hostile and unknown input', () => {
  // Assertion 6.
  const hostileEventRecords: ReadonlyArray<readonly [string, EventRecord]> = [
    [
      'an unknown event type',
      { ...recordOf(createTaskA()), type: 'no_such_event_type' } as EventRecord,
    ],
    [
      'task_created with a malformed payload',
      { ...recordOf(createTaskA()), payload: { taskId: 42 } } as unknown as EventRecord,
    ],
    [
      'task_created with a null payload',
      { ...recordOf(createTaskA()), payload: null } as unknown as EventRecord,
    ],
    [
      'task_created with a stage outside the enum',
      {
        ...recordOf(createTaskA()),
        payload: {
          taskId: 'task-hostile',
          projectRoot: '/x',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'not-a-stage',
        },
      } as unknown as EventRecord,
    ],
    [
      'task_transitioned with a missing taskId',
      {
        ...recordOf(
          taskTransitioned({
            taskId: TASK_A,
            fromStage: 'backlog',
            toStage: 'planning',
            manualReviewRequired: false,
            proposedBy: 'dispatcher',
          }),
        ),
        payload: { toStage: 'done' },
      } as unknown as EventRecord,
    ],
  ];

  for (const [caseName, hostileRecord] of hostileEventRecords) {
    it(`${caseName} leaves state unchanged and never throws`, () => {
      const before = stateFromLog([[createTaskA()]]);
      const serializedBefore = tasksProjection.serialize(before);
      let after: TasksState | undefined;
      expect(() => {
        after = tasksProjection.apply(before, hostileRecord);
      }).not.toThrow();
      expect(tasksProjection.serialize(after!)).toBe(serializedBefore);
      expect(after).toBe(before);
    });
  }
});

// ─── slice 6 step 4a — task_session_attached ────────────────────────────────
//
// A stage run IS an ordinary session (spec §3.5). `sessionRefs` was reserved in
// slice 0 and, until this event, NOTHING appended to it — so "open this task's
// session" had no data path. These are the step-4a assertions 1–3.
const STAGE_SESSION_B_ID = 'aaaaaaaa-0000-4000-8000-000000000002';

function attachSessionToTaskA(appSessionId: string, stage: string): EventInput {
  return taskSessionAttached({ taskId: TASK_A, stage, appSessionId });
}

describe('tasks projection — task_session_attached', () => {
  it('appends the ref to that task, in log order', () => {
    // Assertion 1. Two stage runs on one task accumulate; the order is the log's.
    const state = stateFromLog([
      [createTaskA()],
      [attachSessionToTaskA(STAGE_SESSION_ID, 'planning')],
      [attachSessionToTaskA(STAGE_SESSION_B_ID, 'implementing')],
    ]);
    expect(state.tasks[TASK_A]!.sessionRefs).toEqual([
      { stage: 'planning', appSessionId: STAGE_SESSION_ID },
      { stage: 'implementing', appSessionId: STAGE_SESSION_B_ID },
    ]);
    // The record the fold produces still satisfies the slice-0 schema.
    expect(taskRecordSchema.safeParse(state.tasks[TASK_A]).success).toBe(true);
  });

  it('ignores an attach for an unknown task — it never fabricates a record', () => {
    // Assertion 1 (second half), same rule as `task_transitioned`: the log is
    // truth, and a ref for a task nobody created is a ref to nothing.
    const state = stateFromLog([
      [createTaskA()],
      [taskSessionAttached({ taskId: TASK_B, stage: 'planning', appSessionId: STAGE_SESSION_ID })],
    ]);
    expect(state.tasks[TASK_B]).toBeUndefined();
    expect(state.tasks[TASK_A]!.sessionRefs).toEqual([]);
  });

  it('is IDEMPOTENT on replay — the same appSessionId is never appended twice', () => {
    // Assertion 2, and THIS test is the one holding the line — verified by
    // deleting the guard in tasks.ts and watching exactly this case and the I6
    // fixture-content case redden while the I6 cut-point case stayed green. A
    // duplicate append is deterministic, so replay equivalence cannot see it;
    // only an explicit assertion can.
    const state = stateFromLog([
      [createTaskA()],
      [attachSessionToTaskA(STAGE_SESSION_ID, 'planning')],
      [attachSessionToTaskA(STAGE_SESSION_ID, 'planning')],
      [attachSessionToTaskA(STAGE_SESSION_ID, 'planning')],
    ]);
    expect(state.tasks[TASK_A]!.sessionRefs).toEqual([
      { stage: 'planning', appSessionId: STAGE_SESSION_ID },
    ]);
  });

  it('keys idempotence on appSessionId, so a SECOND run of the same stage is kept', () => {
    // Assertion 2 (the other direction). Deduplicating on `stage` would silently
    // swallow a re-run after a quarantine — a different session doing the same
    // stage is a genuinely new ref, and the board must be able to show both.
    const state = stateFromLog([
      [createTaskA()],
      [attachSessionToTaskA(STAGE_SESSION_ID, 'implementing')],
      [attachSessionToTaskA(STAGE_SESSION_B_ID, 'implementing')],
    ]);
    expect(state.tasks[TASK_A]!.sessionRefs).toEqual([
      { stage: 'implementing', appSessionId: STAGE_SESSION_ID },
      { stage: 'implementing', appSessionId: STAGE_SESSION_B_ID },
    ]);
  });

  it('a malformed attach payload is a no-op and never throws', () => {
    // Same total-fold discipline as every other case (I8's spirit).
    const before = stateFromLog([[createTaskA()]]);
    const serializedBefore = tasksProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(attachSessionToTaskA(STAGE_SESSION_ID, 'planning')),
      payload: { taskId: TASK_A },
    } as unknown as EventRecord;
    let after: TasksState | undefined;
    expect(() => {
      after = tasksProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(tasksProjection.serialize(before)).toBe(serializedBefore);
  });

  it('does not mutate the input state or the existing sessionRefs array', () => {
    // Assertion 3. `sessionRefs` is the one field that ACCUMULATES, which makes
    // it the one an in-place `push` would corrupt across a shared snapshot.
    const frozenState = stateFromLog([
      [createTaskA()],
      [attachSessionToTaskA(STAGE_SESSION_ID, 'planning')],
    ]);
    Object.freeze(frozenState);
    Object.freeze(frozenState.tasks);
    Object.freeze(frozenState.tasks[TASK_A]);
    Object.freeze(frozenState.tasks[TASK_A]!.sessionRefs);
    const serializedBefore = tasksProjection.serialize(frozenState);

    const afterAttach = tasksProjection.apply(
      frozenState,
      recordOf(attachSessionToTaskA(STAGE_SESSION_B_ID, 'implementing')),
    );

    expect(afterAttach).not.toBe(frozenState);
    expect(afterAttach.tasks).not.toBe(frozenState.tasks);
    expect(afterAttach.tasks[TASK_A]).not.toBe(frozenState.tasks[TASK_A]);
    expect(afterAttach.tasks[TASK_A]!.sessionRefs).not.toBe(frozenState.tasks[TASK_A]!.sessionRefs);
    expect(afterAttach.tasks[TASK_A]!.sessionRefs).toHaveLength(2);
    // The frozen input is byte-for-byte what it was.
    expect(tasksProjection.serialize(frozenState)).toBe(serializedBefore);
    expect(frozenState.tasks[TASK_A]!.sessionRefs).toHaveLength(1);
  });
});

describe('tasks projection — purity', () => {
  it('never mutates the input state and returns a NEW object on a real change', () => {
    // Assertion 7. Snapshots share references with live state, so a mutating
    // fold would silently corrupt a saved snapshot.
    const frozenState = stateFromLog([[createTaskA()]]);
    Object.freeze(frozenState);
    Object.freeze(frozenState.tasks);
    Object.freeze(frozenState.tasks[TASK_A]);
    const serializedBefore = tasksProjection.serialize(frozenState);

    const afterTransition = tasksProjection.apply(
      frozenState,
      recordOf(
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'backlog',
          toStage: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ),
    );

    expect(afterTransition).not.toBe(frozenState);
    expect(afterTransition.tasks).not.toBe(frozenState.tasks);
    expect(afterTransition.tasks[TASK_A]).not.toBe(frozenState.tasks[TASK_A]);
    expect(afterTransition.tasks[TASK_A]!.stage).toBe('planning');
    // The frozen input is untouched — byte-for-byte what it was.
    expect(tasksProjection.serialize(frozenState)).toBe(serializedBefore);
    expect(frozenState.tasks[TASK_A]!.stage).toBe('backlog');

    const afterInsert = tasksProjection.apply(
      frozenState,
      recordOf(
        taskCreated({
          taskId: TASK_B,
          projectRoot: '/home/user/projects/vimes',
          createdBy: 'orchestrator',
          isolation: 'worktree',
          stage: 'backlog',
        }),
      ),
    );
    expect(afterInsert).not.toBe(frozenState);
    expect(tasksProjection.serialize(frozenState)).toBe(serializedBefore);
  });
});

describe('tasks projection — determinism', () => {
  it('the same event sequence always serializes byte-identically', () => {
    // Assertion 8a.
    const buildBatches = (): EventInput[][] => [
      [createTaskA()],
      [
        taskCreated({
          taskId: TASK_B,
          projectRoot: '/home/user/projects/other',
          createdBy: 'orchestrator',
          isolation: 'shared-dir',
          stage: 'backlog',
        }),
      ],
      [
        taskTransitioned({
          taskId: TASK_A,
          fromStage: 'backlog',
          toStage: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ];
    const firstRun = tasksProjection.serialize(stateFromLog(buildBatches()));
    const secondRun = tasksProjection.serialize(stateFromLog(buildBatches()));
    expect(secondRun).toBe(firstRun);
  });

  it('two tasks created in opposite orders serialize identically (key-sort proof)', () => {
    // Assertion 8b — canonicalJson sorts keys deeply, so Record insertion order
    // cannot leak into the bytes.
    const createB = taskCreated({
      taskId: TASK_B,
      projectRoot: '/home/user/projects/other',
      createdBy: 'orchestrator',
      isolation: 'shared-dir',
      stage: 'backlog',
    });
    const aThenB = tasksProjection.serialize(stateFromLog([[createTaskA()], [createB]]));
    const bThenA = tasksProjection.serialize(stateFromLog([[createB], [createTaskA()]]));
    expect(bThenA).toBe(aThenB);
  });
});
