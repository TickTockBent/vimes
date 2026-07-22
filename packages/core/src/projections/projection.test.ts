import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import type { Clock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventStore } from '../eventStore.js';
import {
  billingBucketObserved,
  dispatchRefused,
  gateFired,
  hostStarted,
  livenessChanged,
  seen,
  sessionCreated,
  taskCreated,
  taskSessionAttached,
  taskTransitioned,
  taskTransitionRejected,
  withNotificationTrigger,
} from '../events.js';
import type { MeterRecord } from '../schemas.js';
import {
  MemorySnapshotStore,
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
  type Projection,
} from './projection.js';
import { sessionsProjection } from './sessions.js';
import { metersProjection, meterSample } from './meters.js';
import { tasksProjection } from './tasks.js';

const APP_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const APP_2 = 'aaaaaaaa-0000-4000-8000-000000000002';

function meter(meterId: string, used: number): MeterRecord {
  return {
    meterId,
    kind: 'rolling-window',
    scope: 'all-models',
    modelFamily: null,
    used,
    limit: null,
    unit: 'tokens',
    resetsAt: null,
    source: 'jsonl',
    observedAt: '2026-01-01T00:00:00.000Z',
    stale: false,
  };
}

// A synthetic multi-stream log across three streams: two app sessions, 'usage',
// and 'system'.
function buildMultiStreamStore(): MemoryEventStore {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  store.append([
    sessionCreated({ appSessionId: APP_1, channel: 'sdk', cwd: '/home/user/a', name: null, forkedFrom: null, taskRef: null }),
  ]);
  store.append([meterSample(meter('window-5h', 100))]);
  store.append([livenessChanged({ appSessionId: APP_1, to: 'running', cause: 'spawned' })]);
  store.append([hostStarted()]);
  store.append(withNotificationTrigger(gateFired({ appSessionId: APP_1, prompt: 'approve?' })));
  store.append([meterSample(meter('window-5h', 250))]); // upsert same meterId
  store.append([seen({ appSessionId: APP_1 })]);
  store.append([
    sessionCreated({ appSessionId: APP_2, channel: 'pty', cwd: '/home/user/b', name: 'second', forkedFrom: null, taskRef: null }),
  ]);
  store.append([billingBucketObserved({ appSessionId: APP_1, bucket: 'interactive' })]);
  store.append([meterSample(meter('weekly-cap', 42))]);
  return store;
}

// A multi-stream log that ACTUALLY MOVES THE TASK BOARD: three tasks, born at
// different stages, walked through several transitions each (including the
// `→ done` convergence edge), interleaved with the non-folded task events and
// with session/usage traffic on other streams. This is what makes the tasks I6
// case a real test — cutting this log at any point leaves tasks mid-journey, so
// a snapshot+tail boot has to reconstruct genuine state rather than nothing.
//
// ⚠ EXTENDED IN SLICE 6 STEP 4a with `task_session_attached`, because a fold the
// I6 fixture never exercises is a fold I6 does not cover: the non-vacuity guard
// below only proves the fixture moves the projection AT ALL, and the pre-4a
// fixture already cleared it on stages alone. `sessionRefs` is the one field of
// the record that ACCUMULATES rather than being overwritten, so it is the one
// field whose fold depends on ORDER and on PRIOR CONTENT — a cut point that
// reconstructs the array in the wrong order, or from the wrong starting point,
// diverges from replay-from-empty in a way no `stage` assignment ever can. So the
// fixture carries all three of the fold's branches across cut points: normal
// appends, a DUPLICATE attach, and an attach for an unknown task.
//
// ⚠ Truthfully scoped (checked by breaking the guard): the DUPLICATE is here so
// the idempotence branch is inside the replayed span, NOT because I6 can detect a
// duplicate append — it cannot. Both paths fold the same records, so a fold that
// appends twice appends twice on both sides and equivalence still holds. The
// dedicated idempotence case in tasks.test.ts holds that line; this fixture holds
// the ORDER line.
const TASK_ALPHA = 'task-alpha-0001';
const TASK_BETA = 'task-beta-0002';
const TASK_GAMMA = 'task-gamma-0003';
// The stage runs. APP_1 is the session created at the top of the fixture whose
// `taskRef` already names TASK_ALPHA/implementing, so the attach record and the
// session's own birth record agree about the same run.
const ALPHA_PLANNING_SESSION = 'bbbbbbbb-0000-4000-8000-000000000011';
const ALPHA_IMPLEMENTING_SESSION = APP_1;
const BETA_PLANNING_SESSION = 'bbbbbbbb-0000-4000-8000-000000000012';

function buildTaskStreamStore(): MemoryEventStore {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  // Other streams, so the per-stream tail logic in bootFromSnapshot is exercised
  // alongside the tasks stream rather than in isolation.
  store.append([
    sessionCreated({
      appSessionId: APP_1,
      channel: 'sdk',
      cwd: '/home/user/a',
      name: null,
      forkedFrom: null,
      taskRef: { taskId: TASK_ALPHA, stage: 'implementing' },
    }),
  ]);
  store.append([meterSample(meter('window-5h', 100))]);

  store.append([
    taskCreated({ taskId: TASK_ALPHA, projectRoot: '/home/user/a', createdBy: 'human', isolation: 'worktree', stage: 'backlog' }),
  ]);
  store.append([
    taskCreated({ taskId: TASK_BETA, projectRoot: '/home/user/b', createdBy: 'orchestrator', isolation: 'shared-dir', stage: 'backlog' }),
  ]);
  store.append([
    taskTransitioned({ taskId: TASK_ALPHA, fromStage: 'backlog', toStage: 'planning', manualReviewRequired: false, proposedBy: 'dispatcher' }),
  ]);
  // The dispatcher spawned the planning stage run (step 4a): the first ref.
  store.append([
    taskSessionAttached({ taskId: TASK_ALPHA, stage: 'planning', appSessionId: ALPHA_PLANNING_SESSION }),
  ]);
  store.append([livenessChanged({ appSessionId: APP_1, to: 'running', cause: 'spawned' })]);
  // I7's evidence, folded by nobody — the task stays in `planning`.
  store.append([
    taskTransitionRejected({ taskId: TASK_ALPHA, fromStage: 'planning', attemptedToStage: 'done', reason: 'illegal-edge', proposedBy: 'orchestrator' }),
  ]);
  store.append([
    taskTransitioned({ taskId: TASK_ALPHA, fromStage: 'planning', toStage: 'plan-ready', manualReviewRequired: false, proposedBy: 'dispatcher' }),
  ]);
  store.append([
    taskTransitioned({ taskId: TASK_BETA, fromStage: 'backlog', toStage: 'planning', manualReviewRequired: false, proposedBy: 'dispatcher' }),
  ]);
  store.append([
    taskSessionAttached({ taskId: TASK_BETA, stage: 'planning', appSessionId: BETA_PLANNING_SESSION }),
  ]);
  // A re-delivered attach — the same session, attached again. The fold is
  // idempotent on `appSessionId`, so this must add NOTHING; if it ever appended,
  // a snapshot taken after it and a replay across it would disagree.
  store.append([
    taskSessionAttached({ taskId: TASK_BETA, stage: 'planning', appSessionId: BETA_PLANNING_SESSION }),
  ]);
  // An attach for a task that was never created — ignored, never fabricated.
  store.append([
    taskSessionAttached({ taskId: 'task-never-created-9999', stage: 'implementing', appSessionId: APP_2 }),
  ]);
  // I10's refusal record, also folded by nobody.
  store.append([dispatchRefused({ taskId: TASK_BETA, reason: 'requireHeadroom gate failed' })]);
  store.append([
    taskTransitioned({ taskId: TASK_ALPHA, fromStage: 'plan-ready', toStage: 'implementing', manualReviewRequired: false, proposedBy: 'dispatcher' }),
  ]);
  // The second ref on ALPHA: a different stage, a different session. The one
  // field of the record that ACCUMULATES.
  store.append([
    taskSessionAttached({ taskId: TASK_ALPHA, stage: 'implementing', appSessionId: ALPHA_IMPLEMENTING_SESSION }),
  ]);
  store.append([
    taskCreated({ taskId: TASK_GAMMA, projectRoot: '/home/user/c', createdBy: 'human', isolation: 'worktree', stage: 'planning' }),
  ]);
  store.append([meterSample(meter('window-5h', 250))]);
  store.append([
    taskTransitioned({ taskId: TASK_BETA, fromStage: 'planning', toStage: 'quarantined', manualReviewRequired: false, proposedBy: 'dispatcher' }),
  ]);
  store.append([
    taskTransitioned({ taskId: TASK_ALPHA, fromStage: 'implementing', toStage: 'review', manualReviewRequired: false, proposedBy: 'dispatcher' }),
  ]);
  store.append([
    taskTransitioned({ taskId: TASK_GAMMA, fromStage: 'planning', toStage: 'blocked-external', manualReviewRequired: false, proposedBy: 'human' }),
  ]);
  // The convergence exit: done + manualReviewRequired.
  store.append([
    taskTransitioned({ taskId: TASK_ALPHA, fromStage: 'review', toStage: 'done', manualReviewRequired: true, proposedBy: 'dispatcher' }),
  ]);
  store.append([hostStarted()]);
  return store;
}

// I6: at several cut points (start, mid, head), boot from snapshot + tail equals
// replay-from-empty, byte-identical.
//
// ⚠ NON-VACUITY GUARD (slice 6 step 2). Replay equivalence is TRIVIALLY true for
// a projection whose fold does nothing — an empty state equals an empty state at
// every cut, and the assertion below would sail through while testing exactly
// nothing. That is precisely the trap the tasks case sat in while
// `tasksProjection.apply` was a stub. So this helper first REFUSES a fixture
// that folds to the projection's own `init()` state: an I6 case must be given a
// store whose events actually move the projection, or it fails here rather than
// passing hollowly.
function assertBootEqualsReplayAtCuts<StateType>(
  projection: Projection<StateType>,
  store: EventStore,
  clock: Clock,
): void {
  const groupedRecords = readAllStreamsGrouped(store);
  const fullReplaySerialized = projection.serialize(replayFromEmpty(projection, groupedRecords));

  expect(
    fullReplaySerialized,
    `I6 fixture for ${projection.id} folds to init() — the replay assertion would be vacuous`,
  ).not.toBe(projection.serialize(projection.init()));

  const cutPoints = [0, Math.floor(groupedRecords.length / 2), groupedRecords.length];
  for (const cutPoint of cutPoints) {
    const snapshotStore = new MemorySnapshotStore();
    snapshotStore.save(snapshotAfter(projection, groupedRecords.slice(0, cutPoint), clock));
    const bootedSerialized = projection.serialize(bootFromSnapshot(projection, snapshotStore, store));
    expect(bootedSerialized, `cut ${cutPoint} for ${projection.id}`).toBe(fullReplaySerialized);
  }
}

describe('projection I6 — boot(snapshot+tail) equals replay-from-empty', () => {
  it('holds for the sessions projection at every cut point', () => {
    const store = buildMultiStreamStore();
    assertBootEqualsReplayAtCuts(sessionsProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
  });

  it('holds for the meters stub projection at every cut point', () => {
    const store = buildMultiStreamStore();
    assertBootEqualsReplayAtCuts(metersProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
  });

  it('holds for the tasks projection over REAL task events at every cut point', () => {
    // Was a vacuous case until slice 6 step 2: it replayed a store with no task
    // events against a projection that folded nothing. It now replays a log of
    // three tasks walking several stages each, and the helper's non-vacuity
    // guard fails the case outright if the fold ever goes hollow again.
    const store = buildTaskStreamStore();
    assertBootEqualsReplayAtCuts(tasksProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
  });

  it('the tasks I6 fixture folds three tasks to distinct, non-initial stages', () => {
    // The explicit statement of what the I6 case above is actually replaying.
    // If `apply` regressed to the stub, this reddens immediately — and so does
    // the non-vacuity guard inside assertBootEqualsReplayAtCuts.
    const store = buildTaskStreamStore();
    const state = replayFromEmpty(tasksProjection, readAllStreamsGrouped(store));
    expect(Object.keys(state.tasks).sort()).toEqual([TASK_ALPHA, TASK_BETA, TASK_GAMMA].sort());
    expect(state.tasks[TASK_ALPHA]!.stage).toBe('done');
    expect(state.tasks[TASK_ALPHA]!.manualReviewRequired).toBe(true);
    expect(state.tasks[TASK_BETA]!.stage).toBe('quarantined');
    expect(state.tasks[TASK_GAMMA]!.stage).toBe('blocked-external');
  });

  it('the tasks I6 fixture also folds task_session_attached into sessionRefs', () => {
    // Assertion 4 (step 4a). The statement of what the I6 case replays for the
    // NEW fold, so "I6 covers the attach fold" is an assertion rather than a
    // claim: two refs accumulate in log order on ALPHA, the duplicate attach on
    // BETA collapses to one, and the attach for a task that was never created
    // fabricated nothing.
    const store = buildTaskStreamStore();
    const state = replayFromEmpty(tasksProjection, readAllStreamsGrouped(store));
    expect(state.tasks[TASK_ALPHA]!.sessionRefs).toEqual([
      { stage: 'planning', appSessionId: ALPHA_PLANNING_SESSION },
      { stage: 'implementing', appSessionId: ALPHA_IMPLEMENTING_SESSION },
    ]);
    expect(state.tasks[TASK_BETA]!.sessionRefs).toEqual([
      { stage: 'planning', appSessionId: BETA_PLANNING_SESSION },
    ]);
    expect(state.tasks[TASK_GAMMA]!.sessionRefs).toEqual([]);
    expect(state.tasks['task-never-created-9999']).toBeUndefined();
  });

  it('the other projections still fold this task-bearing log identically', () => {
    // Rule 0.4: the new fixture must not disturb the projections that share the
    // event spine — sessions and meters ignore the 'tasks' stream entirely.
    const store = buildTaskStreamStore();
    assertBootEqualsReplayAtCuts(sessionsProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
    assertBootEqualsReplayAtCuts(metersProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
  });

  it('meters stub actually folds meter_sample (upsert by meterId)', () => {
    const store = buildMultiStreamStore();
    const state = replayFromEmpty(metersProjection, readAllStreamsGrouped(store));
    expect(state.meters['window-5h']!.used).toBe(250);
    expect(state.meters['weekly-cap']!.used).toBe(42);
  });

  it('a null snapshot boots identically to a from-empty replay', () => {
    const store = buildMultiStreamStore();
    const emptySnapshotStore = new MemorySnapshotStore();
    const booted = sessionsProjection.serialize(bootFromSnapshot(sessionsProjection, emptySnapshotStore, store));
    const replayed = sessionsProjection.serialize(replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store)));
    expect(booted).toBe(replayed);
  });
});
