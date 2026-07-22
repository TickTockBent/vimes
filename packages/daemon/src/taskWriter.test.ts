import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  readAllStreamsGrouped,
  replayFromEmpty,
  tasksProjection,
  type EventInput,
  type TaskRecord,
  type TasksState,
  type TransitionProposal,
  type TransitionRejectionReason,
} from '@vimes/core';
import { TaskWriter, type ProposeTransitionResult } from './taskWriter.js';

// ─── slice 6 step 4b — the SOLE task writer ──────────────────────────────────
//
// ⚠ THE INSTRUMENT THAT MATTERS HERE IS THE EVENT LOG, NOT THE RETURN VALUE.
// I7 is "a proposal that violates the state machine is rejected AND THE REJECTION
// IS EVENTED". A writer that returned the right reason and wrote nothing would
// satisfy every return-value assertion in this file while violating the invariant
// outright — so every rejection case asserts the EMITTED RECORD first and the
// returned reason second, and additionally asserts that NO `task_transitioned`
// rode along beside it.
//
// The harness folds the real `tasksProjection` over a real MemoryEventStore, so
// `readTasks` is a genuine fold of what was actually written — not a hand-held
// state object the writer could agree with by construction.

const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';

interface WriterHarness {
  writer: TaskWriter;
  // Every event the writer emitted, in order.
  emitted: EventInput[];
  // How many times the writer read the projection.
  readTasksCallCount: () => number;
  // The projection as folded from the store RIGHT NOW.
  currentTasks: () => TasksState;
}

function buildHarness(): WriterHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-07-22T12:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  const emitted: EventInput[] = [];
  let readTasksCallCount = 0;

  const currentTasks = (): TasksState =>
    replayFromEmpty(tasksProjection, readAllStreamsGrouped(store));

  const writer = new TaskWriter({
    emit: (events) => {
      emitted.push(...events);
      store.append(events);
    },
    readTasks: () => {
      readTasksCallCount += 1;
      return currentTasks();
    },
    // A COUNTING id source, injected (rule 0.3): taskIds are byte-identical run
    // to run, so nothing in this file depends on randomUUID.
    ids: new CountingIdSource(),
  });

  return {
    writer,
    emitted,
    readTasksCallCount: () => readTasksCallCount,
    currentTasks,
  };
}

function eventTypes(events: EventInput[]): string[] {
  return events.map((event) => event.type);
}

function proposal(overrides: Partial<TransitionProposal> = {}): TransitionProposal {
  return { toStage: 'planning', proposedBy: 'human', ...overrides };
}

// Walk a fresh task to a named stage through the writer, so the rejection cases
// below start from a REAL recorded history rather than a fabricated record. The
// returned harness has its `emitted` array cleared, so each test's assertions
// count only the events its own proposal produced.
function harnessWithTaskAt(stage: TaskRecord['stage']): {
  harness: WriterHarness;
  taskId: string;
} {
  const harness = buildHarness();
  const created = harness.writer.createTask({
    projectRoot: PROJECT_ROOT,
    createdBy: 'human',
    isolation: 'worktree',
    stage,
  });
  harness.emitted.length = 0;
  return { harness, taskId: created.taskId };
}

describe('TaskWriter — createTask', () => {
  it('emits exactly one task_created and returns the record AS FOLDED, not an echo', () => {
    // Assertion 3. The returned record is compared field-by-field against the
    // projection's own fold of the log, so an implementation that hand-built the
    // return value would have to hand-build it identically to the projection —
    // and a projection/event disagreement shows up here immediately.
    const harness = buildHarness();
    const created = harness.writer.createTask({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.taskCreated]);
    expect(harness.emitted[0]!.stream).toBe('tasks');
    expect(harness.emitted[0]!.payload).toEqual({
      taskId: created.taskId,
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });

    const foldedTask = harness.currentTasks().tasks[created.taskId];
    expect(created).toEqual(foldedTask);
    expect(created).toEqual({
      taskId: created.taskId,
      projectRoot: PROJECT_ROOT,
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

  it('mints the taskId from the INJECTED id source', () => {
    // Rule 0.3: nothing here reaches for randomUUID. A CountingIdSource makes the
    // id deterministic, which is what lets the fixtures above compare bytes.
    const harness = buildHarness();
    const first = harness.writer.createTask({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    const second = harness.writer.createTask({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    expect(first.taskId).toBe('00000000-0000-4000-8000-000000000001');
    expect(second.taskId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('round-trips GATES through the log into the folded record', () => {
    // The step-4b widening, exercised through the writer rather than the fold: a
    // gated task is only expressible in production because `task_created` now
    // carries the field.
    const harness = buildHarness();
    const created = harness.writer.createTask({
      projectRoot: PROJECT_ROOT,
      createdBy: 'orchestrator',
      isolation: 'shared-dir',
      stage: 'backlog',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
    });

    expect(harness.emitted[0]!.payload).toMatchObject({
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
    });
    expect(created.gates).toEqual({ requireHeadroom: { meterId: 'window-5h', pct: 40 } });
    expect(created).toEqual(harness.currentTasks().tasks[created.taskId]);
  });

  it('omits `gates` from the birth record entirely when none were named', () => {
    // An ungated task's `task_created` must stay byte-identical to every one
    // written before the field existed — the widening is optional-only.
    const harness = buildHarness();
    harness.writer.createTask({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    expect(Object.keys(harness.emitted[0]!.payload as object).sort()).toEqual(
      ['createdBy', 'isolation', 'projectRoot', 'stage', 'taskId'],
    );
  });
});

describe('TaskWriter — an ACCEPTED transition', () => {
  it('emits exactly one task_transitioned and returns the record read back', () => {
    // Assertion 4.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    const result = harness.writer.proposeTaskTransition(
      taskId,
      proposal({ toStage: 'planning', proposedBy: 'dispatcher', note: 'kickoff' }),
    );

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.taskTransitioned]);
    expect(harness.emitted[0]!.payload).toEqual({
      taskId,
      fromStage: 'backlog',
      toStage: 'planning',
      manualReviewRequired: false,
      proposedBy: 'dispatcher',
      note: 'kickoff',
    });
    expect(result).toEqual({
      outcome: 'accepted',
      task: harness.currentTasks().tasks[taskId]!,
    } satisfies ProposeTransitionResult);
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('planning');
  });

  it('records the MACHINE\'S RESULTING manualReviewRequired on the → done edge', () => {
    // Assertion 4, the load-bearing half. The convergence exit is the ONE edge
    // where the machine honours the proposal's flag.
    const { harness, taskId } = harnessWithTaskAt('review');
    const result = harness.writer.proposeTaskTransition(
      taskId,
      proposal({ toStage: 'done', manualReviewRequired: true, proposedBy: 'dispatcher' }),
    );

    expect(harness.emitted[0]!.payload).toMatchObject({
      toStage: 'done',
      manualReviewRequired: true,
    });
    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(harness.currentTasks().tasks[taskId]!.manualReviewRequired).toBe(true);
  });

  it('records the MACHINE\'S flag, NOT the proposal\'s, on every other edge', () => {
    // The half that proves the writer is recording a RESULT rather than echoing a
    // REQUEST. The machine ignores `manualReviewRequired` off the `→ done` edge
    // and carries the task's existing value through; a writer that copied the
    // proposal would write `true` here, the projection would fold `true`, and the
    // board would claim a manual review nobody decided on.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    harness.writer.proposeTaskTransition(
      taskId,
      proposal({ toStage: 'planning', manualReviewRequired: true, proposedBy: 'human' }),
    );

    expect(harness.emitted[0]!.payload).toMatchObject({ manualReviewRequired: false });
    expect(harness.currentTasks().tasks[taskId]!.manualReviewRequired).toBe(false);
  });

  it('omits `note` from the record when the proposal carried none', () => {
    const { harness, taskId } = harnessWithTaskAt('backlog');
    harness.writer.proposeTaskTransition(taskId, proposal({ toStage: 'planning' }));
    expect(Object.keys(harness.emitted[0]!.payload as object)).not.toContain('note');
  });
});

describe('TaskWriter — I7: a REJECTED proposal is EVENTED, never merely returned', () => {
  // Assertion 5, the load-bearing one. Each row is a DISTINCT refusal reason, so
  // the invariant is established across the machine's whole vocabulary rather than
  // on one convenient branch.
  //
  // Every case asserts three things, and the FIRST is the invariant:
  //   1. exactly one `task_transition_rejected` is in the log, carrying the
  //      attempted edge and the exact reason;
  //   2. NO `task_transitioned` rode along beside it — a writer that emitted both
  //      would move the board while claiming it refused;
  //   3. the returned reason matches, and the task DID NOT MOVE.
  const rejectionCases: Array<{
    caseName: string;
    startingStage: TaskRecord['stage'];
    attemptedToStage: string;
    expectedReason: TransitionRejectionReason;
  }> = [
    {
      caseName: 'illegal-edge (backlog → review is not in the table)',
      startingStage: 'backlog',
      attemptedToStage: 'review',
      expectedReason: 'illegal-edge',
    },
    {
      caseName: 'terminal-stage (nothing leaves done — reopening mints a new task)',
      startingStage: 'done',
      attemptedToStage: 'implementing',
      expectedReason: 'terminal-stage',
    },
    {
      caseName: 'same-stage (a no-op proposal is still recorded as refused)',
      startingStage: 'planning',
      attemptedToStage: 'planning',
      expectedReason: 'same-stage',
    },
    {
      caseName: 'quarantined-cannot-complete (the named safety refusal)',
      startingStage: 'quarantined',
      attemptedToStage: 'done',
      expectedReason: 'quarantined-cannot-complete',
    },
    {
      caseName: 'unknown-stage (a stage outside the enum — slice 7 hostile input)',
      startingStage: 'backlog',
      attemptedToStage: 'shipped-it-lol',
      expectedReason: 'unknown-stage',
    },
  ];

  for (const rejectionCase of rejectionCases) {
    it(`${rejectionCase.caseName} → one task_transition_rejected, no transition`, () => {
      const { harness, taskId } = harnessWithTaskAt(rejectionCase.startingStage);
      const result = harness.writer.proposeTaskTransition(taskId, {
        // ⚠ CAST ON PURPOSE. `TransitionProposal.toStage` is typed to the enum,
        // but the whole point of `unknown-stage` is that a value outside it
        // physically reaches the machine across an API boundary (step 1 says so in
        // as many words). TypeScript's guarantee stops at that boundary; the test
        // has to cross it to exercise the branch.
        toStage: rejectionCase.attemptedToStage as TransitionProposal['toStage'],
        proposedBy: 'orchestrator',
      });

      // 1. THE INVARIANT: the rejection is in the log.
      expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.taskTransitionRejected]);
      expect(harness.emitted[0]!.stream).toBe('tasks');
      expect(harness.emitted[0]!.payload).toEqual({
        taskId,
        fromStage: rejectionCase.startingStage,
        attemptedToStage: rejectionCase.attemptedToStage,
        reason: rejectionCase.expectedReason,
        proposedBy: 'orchestrator',
      });

      // 2. Nothing moved the board alongside it.
      expect(eventTypes(harness.emitted)).not.toContain(EVENT_TYPES.taskTransitioned);

      // 3. The reason came back, and the task is still where it was.
      expect(result).toEqual({
        outcome: 'rejected',
        reason: rejectionCase.expectedReason,
      } satisfies ProposeTransitionResult);
      expect(harness.currentTasks().tasks[taskId]!.stage).toBe(rejectionCase.startingStage);
    });
  }

  it('records EVERY rejection in a run of them — none is dropped after the first', () => {
    // A rejection that stops being recorded once a task has been refused before is
    // still an unrecorded rejection. Five proposals, five records, still `backlog`.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        harness.writer.proposeTaskTransition(taskId, proposal({ toStage: 'done' })).outcome,
      ).toBe('rejected');
    }
    expect(harness.emitted).toHaveLength(5);
    expect(new Set(eventTypes(harness.emitted))).toEqual(
      new Set([EVENT_TYPES.taskTransitionRejected]),
    );
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('backlog');
  });

  it('never throws on any of the rejection shapes (I8)', () => {
    const { harness, taskId } = harnessWithTaskAt('backlog');
    // Cast through `unknown` for the same reason the table above casts: these
    // stages are OUTSIDE the enum on purpose, which is exactly what a hostile
    // caller across the HTTP boundary can send.
    const hostileProposals = [
      { toStage: '', proposedBy: 'human' },
      { toStage: '../../etc/passwd', proposedBy: 'orchestrator' },
      { toStage: '__proto__', proposedBy: 'dispatcher' },
      { toStage: 'DONE', proposedBy: 'human' },
      { toStage: 'done ', proposedBy: 'human' },
    ] as unknown as TransitionProposal[];

    for (const hostileProposal of hostileProposals) {
      expect(() => harness.writer.proposeTaskTransition(taskId, hostileProposal)).not.toThrow();
    }
    // All five were REFUSED and all five were RECORDED — none silently accepted.
    expect(harness.emitted).toHaveLength(hostileProposals.length);
    expect(new Set(eventTypes(harness.emitted))).toEqual(
      new Set([EVENT_TYPES.taskTransitionRejected]),
    );
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('backlog');
  });
});

describe('TaskWriter — an unknown taskId', () => {
  it('emits NOTHING and never throws', () => {
    // Assertion 6. Deliberately not even a rejection: fabricating one would put a
    // taskId in the tasks stream that no `task_created` ever introduced, and the
    // board would grow a phantom.
    const harness = buildHarness();
    let result: ProposeTransitionResult | undefined;
    expect(() => {
      result = harness.writer.proposeTaskTransition('task-that-never-existed', proposal());
    }).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'unknown-task',
      taskId: 'task-that-never-existed',
    } satisfies ProposeTransitionResult);
    expect(Object.keys(harness.currentTasks().tasks)).toEqual([]);
  });
});

describe('TaskWriter — it reads the projection FRESH and never mutates it', () => {
  it('reads tasks on every call rather than caching a state object', () => {
    // Assertion 7, first half. A writer holding a cached board adjudicates edges
    // out of a stage the task has already left.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    const readsAfterCreate = harness.readTasksCallCount();

    harness.writer.proposeTaskTransition(taskId, proposal({ toStage: 'planning' }));
    expect(harness.readTasksCallCount()).toBeGreaterThan(readsAfterCreate);

    // And the SECOND proposal sees the stage the FIRST one wrote — which is only
    // possible if the board was re-read.
    const secondResult = harness.writer.proposeTaskTransition(
      taskId,
      proposal({ toStage: 'plan-ready' }),
    );
    expect(secondResult).toMatchObject({ outcome: 'accepted' });
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('plan-ready');
  });

  it('never mutates the state object the projection handed it', () => {
    // Assertion 7, second half. The writer receives a real projection state;
    // snapshots share references with live state, so a writer that mutated one
    // would corrupt a snapshot. Serialized before and after, byte-compared.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    const handedOutState = harness.currentTasks();
    const serializedBefore = tasksProjection.serialize(handedOutState);

    harness.writer.proposeTaskTransition(taskId, proposal({ toStage: 'planning' }));
    harness.writer.proposeTaskTransition(taskId, proposal({ toStage: 'nonsense' as TransitionProposal['toStage'] }));

    expect(tasksProjection.serialize(handedOutState)).toBe(serializedBefore);
    // ...while the store genuinely moved on, so the comparison above is not
    // vacuously true against a board that never changed.
    expect(tasksProjection.serialize(harness.currentTasks())).not.toBe(serializedBefore);
  });
});
