import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import type { Clock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventStore } from '../eventStore.js';
import {
  billingBucketObserved,
  claudeSessionMapped,
  correctionDelivered,
  correctionQueued,
  dispatchRefused,
  gateFired,
  hostStarted,
  lineQuarantined,
  livenessChanged,
  message,
  runCompleted,
  seen,
  sessionCreated,
  taskCreated,
  taskSessionAttached,
  taskTransitioned,
  taskTransitionRejected,
  usageBlock,
  watchdogStale,
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
//
// ⚠ EXTENDED IN SLICE 6 STEP 5b (D34) with the two new SESSION-record folds —
// `lastAppendAt` (transcript appends) and `staleEpisodes` (`watchdog_stale`) —
// because a fold the I6 fixture never exercises is a fold I6 does not cover.
// The story the added records tell is the watchdog's own: the run appends, goes
// silent, is reported stale twice, then appends again. Both folds therefore sit
// inside replay equivalence at every cut point, and `lastAppendAt` in particular
// is ORDER-DEPENDENT — it is the ts of the LAST append folded, so a cut point
// that reconstructs the sequence wrongly diverges from replay-from-empty.
//
// ⚠ It is also the fixture that would have caught take 1, had take 1 been able
// to use it: these events are all on the SESSION stream, which is the projection
// that folds them. The equivalent fold in the TASKS projection is cross-stream
// and is exactly what D34 forbids (architecture.md).
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
  // ── the D34 folds (step 5b) ───────────────────────────────────────────────
  // APP_1 appends, is reported stale TWICE (two episodes), then appends again —
  // so the counter accumulates across cut points and the heartbeat has to move
  // PAST the staleness reports, which do not advance it.
  store.append([message({ appSessionId: APP_1, role: 'assistant', content: 'working' })]);
  store.append([usageBlock({ appSessionId: APP_1, usage: { input_tokens: 12 } })]);
  // ── the turn boundary (D35) ───────────────────────────────────────────────
  // ⚠ EXTENDED AGAIN, for the third time and for the same reason: a fold the I6
  // fixture never exercises is a fold I6 does not cover. `turnInFlight` is SET by
  // the `message` above and CLEARED here, so both branches sit inside replay
  // equivalence and the field is order-dependent across cut points — a snapshot
  // taken between the two has to carry `true` forward and let the tail clear it.
  // `run_completed` is a transcript append AND an attention setter, so it is
  // placed BEFORE the staleness reports: the heartbeat still ends on the resume
  // mapping below, and the attention state still ends on 'stale', exactly as the
  // pre-D35 fixture asserted.
  store.append(withNotificationTrigger(runCompleted({ appSessionId: APP_1 })));
  store.append(withNotificationTrigger(watchdogStale({ appSessionId: APP_1, retryNumber: 1 })));
  store.append([seen({ appSessionId: APP_1 })]);
  store.append(withNotificationTrigger(watchdogStale({ appSessionId: APP_1, retryNumber: 2 })));
  // The run comes back to life: a real transcript append AFTER both reports.
  store.append([
    claudeSessionMapped({ appSessionId: APP_1, claudeSessionId: 'c-resumed', jsonlPath: '/p/c-resumed.jsonl' }),
  ]);
  // APP_2 appends once and is never reported stale — the fixture carries a
  // session with a heartbeat and NO episode count beside one that has both.
  store.append([lineQuarantined({ appSessionId: APP_2, raw: '{bad', reason: 'malformed-json' })]);
  // ── the course-correction fold (step 6a, D5/D30) ──────────────────────────
  // ⚠ EXTENDED AGAIN, for the same reason step 5b extended it: a fold the I6
  // fixture never exercises is a fold I6 does not cover. `pendingCorrectionAt`
  // is ORDER-DEPENDENT in both directions — it is SET by one event and CLEARED
  // by another — so a cut point that reconstructs the pair in the wrong order
  // diverges from replay-from-empty in a way no single-assignment field can.
  //
  // Both events are on the SESSION stream (D34 / architecture.md), which is what
  // makes this fold legal here at all.
  //
  // The story: APP_1 is steered and the steer is OBSERVED DELIVERED (cleared to
  // null). APP_2 first sees a delivery it never queued — a human typing into a
  // PTY, which must be a NO-OP and must not create the field — and only then is
  // steered, leaving a correction STILL PENDING at the head of the log. So the
  // fixture carries all three states of the field across every cut point:
  // never-set, set-and-cleared, and still-pending.
  store.append([
    correctionQueued({ appSessionId: APP_1, text: 'synthetic steer: prefer the smaller change' }),
  ]);
  store.append([
    correctionDelivered({
      appSessionId: APP_1,
      commandMode: 'prompt',
      originKind: 'human',
      enqueuedAt: '2026-07-13T12:00:09.000Z',
    }),
  ]);
  store.append([correctionDelivered({ appSessionId: APP_2, commandMode: 'prompt' })]);
  store.append([correctionQueued({ appSessionId: APP_2, text: 'synthetic steer: still queued' })]);
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
  // ⚠ GATED ON PURPOSE (slice 6 step 4b). `task_created` was widened with an
  // optional `gates`, and a fold outside the I6 fixture is a fold outside replay
  // equivalence — the non-vacuity guard below does NOT cover it (the fixture
  // already folds to a non-init state without any gate). BETA carries the gate
  // that its `dispatch_refused` below names, so the log tells one coherent story:
  // this task was gated on headroom, and the dispatcher refused it.
  store.append([
    taskCreated({
      taskId: TASK_BETA,
      projectRoot: '/home/user/b',
      createdBy: 'orchestrator',
      isolation: 'shared-dir',
      stage: 'backlog',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
    }),
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
  // GAMMA carries the OTHER gate field, so both halves of the widened shape are
  // inside the replayed log rather than only the one the dispatcher happens to
  // consume first. ALPHA deliberately stays UNGATED — an old-shape birth record,
  // proving the optional field still folds to `{}` across every cut point.
  store.append([
    taskCreated({
      taskId: TASK_GAMMA,
      projectRoot: '/home/user/c',
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'planning',
      gates: { deferUntilReset: 'window-5h' },
    }),
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

  it('the sessions I6 fixture folds BOTH D34 fields (step 5b)', () => {
    // ASSERTION 5's statement of what the I6 case above actually replays, so
    // "I6 covers the new folds" is asserted rather than claimed. `lastAppendAt`
    // must be the ts of the LAST transcript append (the resume mapping), NOT of
    // the `watchdog_stale` / `seen` bookkeeping that came before it — the
    // heartbeat a watchdog report refreshed would be a guard that disarms on use.
    const store = buildMultiStreamStore();
    const records = readAllStreamsGrouped(store);
    const state = replayFromEmpty(sessionsProjection, records);

    const lastAppendRecord = records.filter(
      (record) => record.stream === APP_1 && record.type === 'claude_session_mapped',
    );
    expect(lastAppendRecord).toHaveLength(1);
    expect(state.sessions[APP_1]!.lastAppendAt).toBe(lastAppendRecord[0]!.ts);
    expect(state.sessions[APP_1]!.staleEpisodes).toBe(2);

    // The other session: a heartbeat, and NO episode count at all.
    const app2AppendRecords = records.filter(
      (record) => record.stream === APP_2 && record.type === 'line_quarantined',
    );
    expect(app2AppendRecords).toHaveLength(1);
    expect(state.sessions[APP_2]!.lastAppendAt).toBe(app2AppendRecords[0]!.ts);
    expect(state.sessions[APP_2]!.staleEpisodes).toBeUndefined();
  });

  it('the sessions I6 fixture folds BOTH course-correction branches (step 6a)', () => {
    // ASSERTION 7. The explicit statement of what the I6 case above replays for
    // the step-6a fold, so "I6 covers the correction folds" is asserted rather
    // than claimed — the non-vacuity guard only proves the fixture moves the
    // projection AT ALL, and it already cleared that on the pre-6a events.
    const store = buildMultiStreamStore();
    const records = readAllStreamsGrouped(store);
    const state = replayFromEmpty(sessionsProjection, records);

    // APP_1: queued, then OBSERVED DELIVERED → cleared to null.
    expect(state.sessions[APP_1]!.pendingCorrectionAt).toBeNull();

    // APP_2: a delivery it never queued (a no-op), then a steer that is STILL
    // PENDING at the head of the log — so the field holds the queued event's ts.
    const app2QueuedRecords = records.filter(
      (record) => record.stream === APP_2 && record.type === 'correction_queued',
    );
    expect(app2QueuedRecords).toHaveLength(1);
    expect(state.sessions[APP_2]!.pendingCorrectionAt).toBe(app2QueuedRecords[0]!.ts);

    // ⚠ Neither event advanced the heartbeat: `lastAppendAt` still points at the
    // last REAL transcript append, not at the corrections that came after it.
    const app1LastAppend = records.filter(
      (record) => record.stream === APP_1 && record.type === 'claude_session_mapped',
    );
    expect(state.sessions[APP_1]!.lastAppendAt).toBe(app1LastAppend[0]!.ts);
  });

  it('the sessions I6 fixture folds BOTH turnInFlight branches (D35)', () => {
    // The explicit statement of what the I6 case above replays for the D35 fold,
    // so "I6 covers turnInFlight" is asserted rather than claimed — the
    // non-vacuity guard only proves the fixture moves the projection AT ALL, and
    // it already cleared that on every pre-D35 event.
    const store = buildMultiStreamStore();
    const records = readAllStreamsGrouped(store);
    const state = replayFromEmpty(sessionsProjection, records);

    // APP_1: a message set it, `run_completed` cleared it.
    expect(state.sessions[APP_1]!.turnInFlight).toBe(false);
    // ...and the cut point that lands between them really does hold `true`, so
    // the flag has to survive a snapshot boundary rather than being re-derived.
    const messageIndex = records.findIndex(
      (record) => record.stream === APP_1 && record.type === 'message',
    );
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    const midTurnState = replayFromEmpty(sessionsProjection, records.slice(0, messageIndex + 1));
    expect(midTurnState.sessions[APP_1]!.turnInFlight).toBe(true);

    // APP_2 was never prompted: the field is never invented.
    expect(state.sessions[APP_2]!.turnInFlight).toBeUndefined();

    // ⚠ The other four events in `run_completed`'s shared case group are still
    // attention-only: APP_1's final attention state is the watchdog's 'stale',
    // set AFTER the completion, exactly as the pre-D35 fixture folded it.
    expect(state.sessions[APP_1]!.needsAttention).toMatchObject({ reason: 'stale' });
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

  it('the tasks I6 fixture folds the GATES its birth records carry (step 4b)', () => {
    // Assertion 2. The statement of what the I6 case above replays for the NEWLY
    // widened field, so "I6 covers the gates fold" is asserted rather than
    // claimed. Both optional halves are present in the log (BETA: requireHeadroom,
    // GAMMA: deferUntilReset) and ALPHA is deliberately ungated, so the fixture
    // exercises present-and-absent at every cut point.
    const store = buildTaskStreamStore();
    const state = replayFromEmpty(tasksProjection, readAllStreamsGrouped(store));
    expect(state.tasks[TASK_ALPHA]!.gates).toEqual({});
    expect(state.tasks[TASK_BETA]!.gates).toEqual({
      requireHeadroom: { meterId: 'window-5h', pct: 40 },
    });
    expect(state.tasks[TASK_GAMMA]!.gates).toEqual({ deferUntilReset: 'window-5h' });
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
