import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput, EventRecord, TaskRecord } from '../schemas.js';
import { taskRecordSchema } from '../schemas.js';
import {
  dispatchRefused,
  taskCreated,
  taskQuarantined,
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
