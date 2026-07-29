import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput, EventRecord, TaskRecord } from '../schemas.js';
import { taskRecordSchema } from '../schemas.js';
import {
  completionReported,
  dispatchRefused,
  planSubmitted,
  reviewReported,
  taskCreated,
  taskQuarantined,
  taskSessionAttached,
  taskTransitioned,
  taskTransitionRejected,
  workOrderAmended,
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

// ── I6 — absent stays absent over the S7·1 work-order widening ───────────────
//
// The load-bearing test for this unit. `taskRecordSchema` grew five new
// OPTIONAL fields (scope, explicitlyOut, acceptanceCriteria, killCriterion,
// workOrderRev) in schemas.ts, but THIS PROJECTION WAS DELIBERATELY NOT
// TOUCHED — no fold reads them, no default supplies them. A `task_created`
// that omits all five (every `task_created` written before slice 7, and every
// one this unit's own work-order API does not yet exist to write) must fold to
// a record with NONE of the new keys present, byte-identical to what it folded
// to before this widening landed.
describe('tasks projection — I6, the S7·1 work-order widening is invisible when unused', () => {
  it('a birth record omitting all work-order fields folds with NONE of the new keys present', () => {
    const state = stateFromLog([[createTaskA()]]);
    const bornTask = state.tasks[TASK_A]!;
    expect('scope' in bornTask).toBe(false);
    expect('explicitlyOut' in bornTask).toBe(false);
    expect('acceptanceCriteria' in bornTask).toBe(false);
    expect('killCriterion' in bornTask).toBe(false);
    expect('workOrderRev' in bornTask).toBe(false);
    expect(taskRecordSchema.safeParse(bornTask).success).toBe(true);
  });

  it('serializes byte-identically to the pre-S7·1 record shape (exactly the pre-existing keys)', () => {
    const state = stateFromLog([[createTaskA()]]);
    const bornTask = state.tasks[TASK_A]!;
    // The full pre-S7·1 key set, hand-enumerated so a silent extra key (a
    // default sneaking in) fails this comparison even if every individual
    // `in` check above were somehow satisfied.
    expect(Object.keys(bornTask).sort()).toEqual(
      [
        'taskId',
        'projectRoot',
        'stage',
        'manualReviewRequired',
        'isolation',
        'gates',
        'sessionRefs',
        'createdBy',
        'lastHeartbeatAt',
        'staleRetries',
      ].sort(),
    );
  });
});

// ── S7·2a — the work-order fields fold onto the birth record ─────────────────
//
// The forward path this unit turns on: a `task_created` that CARRIES the four
// authored work-order fields folds them onto the record VERBATIM. The absent case
// stays covered by the S7·1 describe above (deliberately unchanged — those tests
// still pass, proving absent-stays-absent), so these cases exercise only the
// PRESENT case and the I6 replay guarantee.
describe('tasks projection — S7·2a, a carrying task_created folds the work-order fields', () => {
  // A birth record carrying all four. `acceptanceCriteria` uses the FULL
  // `{id,text}` shape because the writer mints the ids and writes them INTO the
  // event — the fold reads them back, it never mints.
  const WORK_ORDER = {
    scope: 'carry the four authored work-order fields onto the born record',
    explicitlyOut: ['workOrderRev (S7·2b)', 'the two-door UI (S7·8)'],
    acceptanceCriteria: [
      { id: 'crit-id-alpha', text: 'the fold preserves criterion ids' },
      { id: 'crit-id-beta', text: 'absent stays absent' },
    ],
    killCriterion: 'a field cannot fold without a projection default',
  };

  function createTaskWithWorkOrder(): EventInput {
    return taskCreated({
      taskId: TASK_A,
      projectRoot: '/home/user/projects/vimes',
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
      ...WORK_ORDER,
    });
  }

  it('folds all four VERBATIM, ids preserved, and the record still satisfies the schema', () => {
    const state = stateFromLog([[createTaskWithWorkOrder()]]);
    const bornTask = state.tasks[TASK_A]!;

    expect(bornTask.scope).toBe(WORK_ORDER.scope);
    expect(bornTask.explicitlyOut).toEqual(WORK_ORDER.explicitlyOut);
    // The criterion ids are preserved exactly — nothing re-mints on fold.
    expect(bornTask.acceptanceCriteria).toEqual(WORK_ORDER.acceptanceCriteria);
    expect(bornTask.killCriterion).toBe(WORK_ORDER.killCriterion);

    const validated = taskRecordSchema.safeParse(bornTask);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
  });

  it('replay-equivalence (I6): folding the same carrying-log twice is byte-identical', () => {
    // The whole reason the ids are written INTO the event rather than re-minted on
    // fold. If any part of the fold re-derived a criterion id (or defaulted a
    // field), a second fold of the SAME log would produce different bytes. It does
    // not: `canonicalJson` of the record is identical across two independent folds.
    const firstFold = stateFromLog([[createTaskWithWorkOrder()]]);
    const secondFold = stateFromLog([[createTaskWithWorkOrder()]]);
    expect(tasksProjection.serialize(secondFold)).toBe(tasksProjection.serialize(firstFold));
  });
});

// ── S7·2b — an amendment PATCHES the work order (D43: revisioned, not mutated) ─
//
// The fold's job here is narrow and easy to get subtly wrong: a present field
// REPLACES, an absent field is LEFT ALONE, and the rev is RECORDED rather than
// counted. Every case below separates those three, because an implementation that
// spread the whole payload (turning omitted fields into `undefined` keys) or that
// incremented a rev of its own would still look right on the happy path.
describe('tasks projection — S7·2b, work_order_amended patches the record', () => {
  const AUTHORED_WORK_ORDER = {
    scope: 'the scope as first authored',
    explicitlyOut: ['the amend path', 'the two-door UI'],
    acceptanceCriteria: [
      { id: 'crit-id-alpha', text: 'the first criterion' },
      { id: 'crit-id-beta', text: 'the second criterion' },
    ],
    killCriterion: 'the kill criterion as first authored',
  };

  function createAuthoredTaskA(): EventInput {
    return taskCreated({
      taskId: TASK_A,
      projectRoot: '/home/user/projects/vimes',
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
      ...AUTHORED_WORK_ORDER,
    });
  }

  it('a scope-only amendment replaces scope, sets the rev, and touches NOTHING else', () => {
    const state = stateFromLog([
      [createAuthoredTaskA()],
      [
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 1,
          amendedBy: 'human',
          scope: 'the narrowed scope',
        }),
      ],
    ]);
    const amendedTask = state.tasks[TASK_A]!;

    expect(amendedTask.scope).toBe('the narrowed scope');
    expect(amendedTask.workOrderRev).toBe(1);
    // The three fields the amendment never mentioned are exactly as the birth
    // record left them — not cleared, and not present-but-`undefined`.
    expect(amendedTask.explicitlyOut).toEqual(AUTHORED_WORK_ORDER.explicitlyOut);
    expect(amendedTask.acceptanceCriteria).toEqual(AUTHORED_WORK_ORDER.acceptanceCriteria);
    expect(amendedTask.killCriterion).toBe(AUTHORED_WORK_ORDER.killCriterion);
    expect(taskRecordSchema.safeParse(amendedTask).success).toBe(true);
  });

  it('`amendedBy` stays on the EVENT — the record grows no such key', () => {
    // The record is current state; who authored a revision is audit, and it lives
    // in the log exactly as `task_transitioned`'s `proposedBy` does.
    const state = stateFromLog([
      [createAuthoredTaskA()],
      [
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 1,
          amendedBy: 'orchestrator',
          scope: 'amended by the orchestrator',
        }),
      ],
    ]);
    expect('amendedBy' in state.tasks[TASK_A]!).toBe(false);
  });

  it('two amendments: the LATEST rev and the LATEST value of each field win', () => {
    const state = stateFromLog([
      [createAuthoredTaskA()],
      [
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 1,
          amendedBy: 'human',
          scope: 'scope after the first amendment',
          killCriterion: 'kill criterion after the first amendment',
        }),
      ],
      [
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 2,
          amendedBy: 'orchestrator',
          scope: 'scope after the second amendment',
        }),
      ],
    ]);
    const amendedTask = state.tasks[TASK_A]!;

    expect(amendedTask.workOrderRev).toBe(2);
    expect(amendedTask.scope).toBe('scope after the second amendment');
    // ⚠ THE CASE THAT SEPARATES "PATCH" FROM "REPLACE THE WHOLE WORK ORDER": the
    // second amendment omitted `killCriterion`, so the FIRST amendment's value
    // survives. A fold that rebuilt the work order from each payload would have
    // dropped it back to the birth record's value (or to nothing).
    expect(amendedTask.killCriterion).toBe('kill criterion after the first amendment');
    expect(amendedTask.explicitlyOut).toEqual(AUTHORED_WORK_ORDER.explicitlyOut);
  });

  it('an EXPLICIT empty acceptanceCriteria CLEARS the list — distinct from omitting it', () => {
    // Clearing the criteria is a legal amendment (a work order that stops claiming
    // checkable outcomes). The two cases are asserted side by side, because they are
    // the pair a fold keyed on truthiness rather than presence would conflate.
    const cleared = stateFromLog([
      [createAuthoredTaskA()],
      [workOrderAmended({ taskId: TASK_A, workOrderRev: 1, amendedBy: 'human', acceptanceCriteria: [] })],
    ]);
    expect(cleared.tasks[TASK_A]!.acceptanceCriteria).toEqual([]);

    const untouched = stateFromLog([
      [createAuthoredTaskA()],
      [workOrderAmended({ taskId: TASK_A, workOrderRev: 1, amendedBy: 'human', scope: 'elsewhere' })],
    ]);
    expect(untouched.tasks[TASK_A]!.acceptanceCriteria).toEqual(
      AUTHORED_WORK_ORDER.acceptanceCriteria,
    );
  });

  it('amends a task that was created with NO work order at all', () => {
    // The absent-stays-absent birth record is where an amendment most plausibly
    // trips: there is nothing to patch over, so the amended fields appear for the
    // first time and the untouched ones must STILL be absent afterwards.
    const state = stateFromLog([
      [createTaskA()],
      [
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 1,
          amendedBy: 'human',
          scope: 'a scope the birth record never had',
        }),
      ],
    ]);
    const amendedTask = state.tasks[TASK_A]!;

    expect(amendedTask.scope).toBe('a scope the birth record never had');
    expect(amendedTask.workOrderRev).toBe(1);
    expect('explicitlyOut' in amendedTask).toBe(false);
    expect('acceptanceCriteria' in amendedTask).toBe(false);
    expect('killCriterion' in amendedTask).toBe(false);
  });

  it('RECORDS the rev the payload states — it never counts amendment events', () => {
    // A log whose revs are not 1,2,3… (a snapshot boot that starts mid-history is
    // the real-world shape). The fold must land on 7 because the event says 7; a
    // fold that counted amendments would say 1.
    const state = stateFromLog([
      [createAuthoredTaskA()],
      [workOrderAmended({ taskId: TASK_A, workOrderRev: 7, amendedBy: 'human', scope: 'rev seven' })],
    ]);
    expect(state.tasks[TASK_A]!.workOrderRev).toBe(7);
  });

  it('ignores an amendment for an unknown task — it never fabricates a record', () => {
    const state = stateFromLog([
      [createAuthoredTaskA()],
      [
        workOrderAmended({
          taskId: TASK_B,
          workOrderRev: 1,
          amendedBy: 'human',
          scope: 'an amendment for a task nobody created',
        }),
      ],
    ]);
    expect(state.tasks[TASK_B]).toBeUndefined();
    expect(Object.keys(state.tasks)).toEqual([TASK_A]);
    // ...and the task that DOES exist was not touched by it either.
    expect(state.tasks[TASK_A]!.scope).toBe(AUTHORED_WORK_ORDER.scope);
    expect('workOrderRev' in state.tasks[TASK_A]!).toBe(false);
  });

  it('a malformed work_order_amended payload is a no-op and never throws', () => {
    // I8's spirit: a hostile or truncated payload must not crash a fold. A negative
    // rev fails `nonnegative()`, so the whole event is skipped and the record keeps
    // whatever it had.
    const priorState = stateFromLog([[createAuthoredTaskA()]]);
    const malformedRecord = recordOf({
      stream: 'tasks',
      type: 'work_order_amended',
      payload: { taskId: TASK_A, workOrderRev: -1, amendedBy: 'human', scope: 'nope' },
    });
    let nextState: TasksState | undefined;
    expect(() => {
      nextState = tasksProjection.apply(priorState, malformedRecord);
    }).not.toThrow();
    expect(nextState).toBe(priorState);
  });

  it('I6 replay-equivalence: creation + two amendments folds byte-identically twice', () => {
    // The determinism the whole design rests on: the rev and the criterion ids are
    // both STORED, never derived, so a second fold of the same log produces the same
    // bytes. If either were computed during the fold, this would drift.
    const amendmentLog: EventInput[][] = [
      [createAuthoredTaskA()],
      [
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 1,
          amendedBy: 'human',
          scope: 'scope after the first amendment',
          acceptanceCriteria: [
            { id: 'crit-id-alpha', text: 'the first criterion, reworded' },
            { id: 'crit-id-gamma', text: 'a criterion minted by the amendment' },
          ],
        }),
      ],
      [
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 2,
          amendedBy: 'orchestrator',
          explicitlyOut: [],
        }),
      ],
    ];
    const firstFold = stateFromLog(amendmentLog);
    const secondFold = stateFromLog(amendmentLog);
    expect(tasksProjection.serialize(secondFold)).toBe(tasksProjection.serialize(firstFold));
    // Not vacuous: the twice-folded record really carries the amended shape.
    expect(firstFold.tasks[TASK_A]!.workOrderRev).toBe(2);
    expect(firstFold.tasks[TASK_A]!.explicitlyOut).toEqual([]);
    expect(firstFold.tasks[TASK_A]!.acceptanceCriteria).toEqual([
      { id: 'crit-id-alpha', text: 'the first criterion, reworded' },
      { id: 'crit-id-gamma', text: 'a criterion minted by the amendment' },
    ]);
  });

  it('does not mutate the state it was handed (I12)', () => {
    const priorState = stateFromLog([[createAuthoredTaskA()]]);
    const serializedBefore = tasksProjection.serialize(priorState);

    const nextState = tasksProjection.apply(
      priorState,
      recordOf(
        workOrderAmended({
          taskId: TASK_A,
          workOrderRev: 1,
          amendedBy: 'human',
          scope: 'a scope the prior state must never learn about',
        }),
      ),
    );

    expect(tasksProjection.serialize(priorState)).toBe(serializedBefore);
    expect(nextState).not.toBe(priorState);
    expect(nextState.tasks[TASK_A]).not.toBe(priorState.tasks[TASK_A]);
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

// ── S7·5a — plan_submitted AUGMENTS the record, exactly like task_session_
// attached above; it is NOT a transition ─────────────────────────────────────
//
// D48: the plan BLOB lives in the artifact store; the LOG carries only the
// reference (the hash), so this fold's whole job is keeping `planArtifactHash`
// current. The planning -> plan-ready move is a SEPARATE `task_transitioned`
// (the dispatcher's, S7·5b) — this event never touches `stage`.
function submitPlanForTaskA(planArtifactHash: string): EventInput {
  return planSubmitted({
    taskId: TASK_A,
    stage: 'planning',
    attempt: 1,
    workOrderRev: 0,
    planArtifactHash,
    plannerSessionRef: { appSessionId: STAGE_SESSION_ID },
  });
}

describe('tasks projection — plan_submitted', () => {
  it('folds planArtifactHash onto an existing task', () => {
    const state = stateFromLog([[createTaskA()], [submitPlanForTaskA('sha256:aaaa')]]);
    expect(state.tasks[TASK_A]!.planArtifactHash).toBe('sha256:aaaa');
    expect(taskRecordSchema.safeParse(state.tasks[TASK_A]).success).toBe(true);
  });

  it('LATEST-WINS: a second plan_submitted (a re-plan) overwrites the first', () => {
    // Unlike sessionRefs' accumulation, this field is a plain overwrite: the
    // board and the handoff (S7·7a) want the CURRENT plan, never a history of
    // every plan ever drafted.
    const state = stateFromLog([
      [createTaskA()],
      [submitPlanForTaskA('sha256:aaaa')],
      [submitPlanForTaskA('sha256:bbbb')],
    ]);
    expect(state.tasks[TASK_A]!.planArtifactHash).toBe('sha256:bbbb');
  });

  it('ignores a plan_submitted for an unknown task — it never fabricates a record', () => {
    const state = stateFromLog([
      [createTaskA()],
      [
        planSubmitted({
          taskId: TASK_B,
          stage: 'planning',
          attempt: 1,
          workOrderRev: 0,
          planArtifactHash: 'sha256:cccc',
          plannerSessionRef: { appSessionId: STAGE_SESSION_ID },
        }),
      ],
    ]);
    expect(state.tasks[TASK_B]).toBeUndefined();
    expect('planArtifactHash' in state.tasks[TASK_A]!).toBe(false);
  });

  // The load-bearing I6 case for this unit: a task that never received a
  // plan_submitted must carry NO planArtifactHash key at all — absent stays
  // absent, mirroring the S7·1/S7·2a work-order fields' own discipline. See
  // the verify-by-breaking note in the S7·5a checkpoint: adding a projection
  // default here (e.g. `planArtifactHash: task.planArtifactHash ?? ''`) reddens
  // exactly this assertion.
  it("I6 absent-stays-absent: a task with no plan_submitted has NO planArtifactHash key", () => {
    const state = stateFromLog([[createTaskA()]]);
    expect('planArtifactHash' in state.tasks[TASK_A]!).toBe(false);
  });

  it('I6 replay-equivalence: folding a carrying-log twice is byte-identical', () => {
    const log = [[createTaskA()], [submitPlanForTaskA('sha256:aaaa')]];
    const firstFold = stateFromLog(log);
    const secondFold = stateFromLog(log);
    expect(tasksProjection.serialize(secondFold)).toBe(tasksProjection.serialize(firstFold));
  });

  it('is idempotent: folding the SAME plan_submitted twice leaves a single hash (an overwrite, no trace)', () => {
    // Unlike task_session_attached's `sessionRefs`, this needs no dedicated
    // dedup guard: an overwrite of the same value with itself IS the same
    // value, so there is nothing here for a duplicate-delivery guard to catch.
    const state = stateFromLog([
      [createTaskA()],
      [submitPlanForTaskA('sha256:aaaa')],
      [submitPlanForTaskA('sha256:aaaa')],
    ]);
    expect(state.tasks[TASK_A]!.planArtifactHash).toBe('sha256:aaaa');
  });

  it('a malformed plan_submitted payload is a no-op and never throws', () => {
    const before = stateFromLog([[createTaskA()]]);
    const serializedBefore = tasksProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(submitPlanForTaskA('sha256:aaaa')),
      payload: { taskId: TASK_A },
    } as unknown as EventRecord;
    let after: TasksState | undefined;
    expect(() => {
      after = tasksProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(tasksProjection.serialize(before)).toBe(serializedBefore);
  });
});

// ── S7·7b — the two FIX-SEED folds (D46): review_reported → lastReview,
// completion_reported → lastCompletion ───────────────────────────────────────
//
// Both AUGMENT the record exactly like `plan_submitted` above and never touch
// `stage` (the moves are separate `task_transitioned` events — D53's taxonomy:
// reports are OUTCOMES, the transition they imply is proposed through the I7
// choke). The cases below mirror the plan_submitted block one for one: folds,
// latest-wins, unknown-task ignored, absent-stays-absent, replay-equivalence,
// idempotence, malformed-is-a-no-op.
//
// ⚠ Until S7·6a these two events had NO fold at all (the deferral is recorded in
// D52 finding 1 — `lastReview` could not be typed without the schemas.ts hoist).
// The `three deliberately NON-folded events` describe above is unaffected: it
// covers `task_transition_rejected`, `dispatch_refused` and `task_quarantined`,
// none of which changed.
function reportReviewForTaskA(
  criteria: Array<{ criterionId: string; verdict: 'pass' | 'fail'; note?: string }>,
): EventInput {
  return reviewReported({
    taskId: TASK_A,
    stage: 'review',
    attempt: 1,
    workOrderRev: 0,
    criteria,
  });
}

function reportCompletionForTaskA(decisionsMade: string[], pathsRejected: string[]): EventInput {
  return completionReported({
    taskId: TASK_A,
    stage: 'implementing',
    attempt: 1,
    workOrderRev: 0,
    worklog: { decisionsMade, pathsRejected },
  });
}

describe('tasks projection — review_reported → lastReview (S7·7b)', () => {
  it('folds the WHOLE payload onto an existing task', () => {
    const state = stateFromLog([
      [createTaskA()],
      [reportReviewForTaskA([{ criterionId: 'ac-1', verdict: 'fail', note: 'still stalls' }])],
    ]);
    // The whole payload, not just `criteria`: the (taskId, stage, attempt,
    // workOrderRev) prefix is what makes the feedback attributable to a run.
    expect(state.tasks[TASK_A]!.lastReview).toEqual({
      taskId: TASK_A,
      stage: 'review',
      attempt: 1,
      workOrderRev: 0,
      criteria: [{ criterionId: 'ac-1', verdict: 'fail', note: 'still stalls' }],
    });
    expect(taskRecordSchema.safeParse(state.tasks[TASK_A]).success).toBe(true);
    // AUGMENT, not a transition — the stage is untouched by the report itself.
    expect(state.tasks[TASK_A]!.stage).toBe('backlog');
  });

  it('LATEST-WINS: a second review_reported overwrites the first', () => {
    // The log keeps both (that is the audit trail); the RECORD keeps the newest,
    // because the fix-seed a fresh implementer needs is the review that JUST
    // failed it, never a history of every lap round the loop.
    const state = stateFromLog([
      [createTaskA()],
      [reportReviewForTaskA([{ criterionId: 'ac-1', verdict: 'fail', note: 'first' }])],
      [reportReviewForTaskA([{ criterionId: 'ac-1', verdict: 'pass', note: 'second' }])],
    ]);
    expect(state.tasks[TASK_A]!.lastReview!.criteria).toEqual([
      { criterionId: 'ac-1', verdict: 'pass', note: 'second' },
    ]);
  });

  it('ignores a review_reported for an unknown task — it never fabricates a record (I8)', () => {
    const state = stateFromLog([
      [createTaskA()],
      [
        reviewReported({
          taskId: TASK_B,
          stage: 'review',
          attempt: 1,
          workOrderRev: 0,
          criteria: [{ criterionId: 'ac-1', verdict: 'pass' }],
        }),
      ],
    ]);
    expect(state.tasks[TASK_B]).toBeUndefined();
    expect('lastReview' in state.tasks[TASK_A]!).toBe(false);
  });

  it('is idempotent: folding the SAME review_reported twice leaves one value', () => {
    const state = stateFromLog([
      [createTaskA()],
      [reportReviewForTaskA([{ criterionId: 'ac-1', verdict: 'pass' }])],
      [reportReviewForTaskA([{ criterionId: 'ac-1', verdict: 'pass' }])],
    ]);
    expect(state.tasks[TASK_A]!.lastReview!.criteria).toHaveLength(1);
  });

  it('a malformed review_reported payload is a no-op and never throws', () => {
    const before = stateFromLog([[createTaskA()]]);
    const serializedBefore = tasksProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(reportReviewForTaskA([])),
      payload: { taskId: TASK_A, criteria: 'not-an-array' },
    } as unknown as EventRecord;
    let after: TasksState | undefined;
    expect(() => {
      after = tasksProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(tasksProjection.serialize(before)).toBe(serializedBefore);
  });
});

describe('tasks projection — completion_reported → lastCompletion (S7·7b)', () => {
  it('folds the WHOLE payload onto an existing task', () => {
    const state = stateFromLog([
      [createTaskA()],
      [reportCompletionForTaskA(['used the existing helper'], ['a bespoke parser — too slow'])],
    ]);
    expect(state.tasks[TASK_A]!.lastCompletion).toEqual({
      taskId: TASK_A,
      stage: 'implementing',
      attempt: 1,
      workOrderRev: 0,
      worklog: {
        decisionsMade: ['used the existing helper'],
        pathsRejected: ['a bespoke parser — too slow'],
      },
    });
    expect(taskRecordSchema.safeParse(state.tasks[TASK_A]).success).toBe(true);
    // D53: the implementing -> review move is a SEPARATE task_transitioned; the
    // report itself never moves the stage.
    expect(state.tasks[TASK_A]!.stage).toBe('backlog');
  });

  it('LATEST-WINS: a second completion_reported overwrites the first', () => {
    const state = stateFromLog([
      [createTaskA()],
      [reportCompletionForTaskA(['first decision'], ['first dead end'])],
      [reportCompletionForTaskA(['second decision'], ['second dead end'])],
    ]);
    expect(state.tasks[TASK_A]!.lastCompletion!.worklog).toEqual({
      decisionsMade: ['second decision'],
      pathsRejected: ['second dead end'],
    });
  });

  it('ignores a completion_reported for an unknown task — it never fabricates a record (I8)', () => {
    const state = stateFromLog([
      [createTaskA()],
      [
        completionReported({
          taskId: TASK_B,
          stage: 'implementing',
          attempt: 1,
          workOrderRev: 0,
          worklog: { decisionsMade: [], pathsRejected: [] },
        }),
      ],
    ]);
    expect(state.tasks[TASK_B]).toBeUndefined();
    expect('lastCompletion' in state.tasks[TASK_A]!).toBe(false);
  });

  it('a malformed completion_reported payload is a no-op and never throws', () => {
    const before = stateFromLog([[createTaskA()]]);
    const serializedBefore = tasksProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(reportCompletionForTaskA([], [])),
      payload: { taskId: TASK_A, worklog: { decisionsMade: 'nope' } },
    } as unknown as EventRecord;
    let after: TasksState | undefined;
    expect(() => {
      after = tasksProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(tasksProjection.serialize(before)).toBe(serializedBefore);
  });
});

describe('tasks projection — S7·7b I6: the fix-seed widening is invisible when unused', () => {
  // The load-bearing I6 case for this unit, and the one the verify-by-breaking
  // step targets: a log with NEITHER report folds to a record carrying NEITHER
  // key — never `undefined`-present, which would change the serialized bytes of
  // every task_created already on disk. (The hand-enumerated key-set assertion in
  // the S7·1 describe above is the second, independent guard on the same fact.)
  it('a task with no review/completion report has NEITHER key present', () => {
    const state = stateFromLog([[createTaskA()]]);
    const bornTask = state.tasks[TASK_A]!;
    expect('lastReview' in bornTask).toBe(false);
    expect('lastCompletion' in bornTask).toBe(false);
  });

  it('a no-report log serializes byte-identically to a hand-built pre-S7·7b record', () => {
    // Byte-identity against an INDEPENDENTLY constructed expectation, not against
    // another run of the same code: a default sneaking into the fold would show up
    // here even if both sides changed together.
    const state = stateFromLog([[createTaskA()]]);
    const preS7bShape: TasksState = {
      tasks: {
        [TASK_A]: {
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
        },
      },
    };
    expect(tasksProjection.serialize(state)).toBe(tasksProjection.serialize(preS7bShape));
  });

  it('I6 replay-equivalence: folding a carrying-log twice is byte-identical', () => {
    const log = [
      [createTaskA()],
      [reportReviewForTaskA([{ criterionId: 'ac-1', verdict: 'fail', note: 'n' }])],
      [reportCompletionForTaskA(['d'], ['p'])],
    ];
    const firstFold = stateFromLog(log);
    const secondFold = stateFromLog(log);
    expect(tasksProjection.serialize(secondFold)).toBe(tasksProjection.serialize(firstFold));
    // And the fold really did carry both — a vacuous double-run would pass above.
    expect(firstFold.tasks[TASK_A]!.lastReview).toBeDefined();
    expect(firstFold.tasks[TASK_A]!.lastCompletion).toBeDefined();
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
