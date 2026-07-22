import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  type EventInput,
  type MeterRecord,
  type MetersState,
  type TaskRecord,
  type TasksState,
} from '@vimes/core';
import type { SpawnResult } from './sessionHost.js';
import { TaskDispatcher, projectRootWorkingDirectory, type TaskDispatcherDeps } from './taskDispatcher.js';

// ─── slice 6 step 4a — the dispatcher EXECUTOR ───────────────────────────────
//
// ⚠ EVERY case here drives a FAKE session host. Nothing in this file spawns a
// real Claude process, opens a PTY, or touches the filesystem: the executor's
// entire job is (pure decision) → (one call, or deliberately none) → (the right
// events), and all three are observable through the fake.
//
// The `spawnCalls` array is the load-bearing instrument. For I10 it is not enough
// to assert that a `dispatch_refused` was emitted — an implementation that
// spawned a session AND THEN emitted a refusal would pass that check while
// violating the invariant outright. So the refusal cases assert
// `spawnCalls.length === 0`: the proof is that the session host was NEVER REACHED.

const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';
const TASK_ID = 'task-dispatch-0001';
const SPAWNED_SESSION_ID = 'cccccccc-0000-4000-8000-000000000001';
const EXISTING_SESSION_ID = 'cccccccc-0000-4000-8000-000000000002';
const FIXED_NOW = '2026-07-22T12:00:00.000Z';
// The meter staleness band, named by the caller (rule 0.2 — no default here).
const STALE_AFTER_MS = 90_000;

// A session host that RECORDS instead of spawning. Structurally satisfies
// `Pick<SessionHost, 'spawnSession' | 'isLive'>`; the real class is never
// constructed and never imported at runtime (the SpawnResult import above is
// type-only).
class RecordingSessionHost {
  readonly spawnCalls: Array<{ channel: 'sdk' | 'pty'; cwd: string; name?: string }> = [];
  private nextSpawnResult: SpawnResult = { appSessionId: SPAWNED_SESSION_ID };
  private spawnThrows: Error | null = null;
  private readonly liveSessionIds = new Set<string>();

  spawnSession(options: { channel: 'sdk' | 'pty'; cwd: string; name?: string }): SpawnResult {
    this.spawnCalls.push(options);
    if (this.spawnThrows !== null) {
      throw this.spawnThrows;
    }
    return this.nextSpawnResult;
  }

  isLive(appSessionId: string): boolean {
    return this.liveSessionIds.has(appSessionId);
  }

  refuseNextSpawn(reason: string): void {
    this.nextSpawnResult = { refused: true, reason };
  }

  throwOnSpawn(error: Error): void {
    this.spawnThrows = error;
  }

  markLive(appSessionId: string): void {
    this.liveSessionIds.add(appSessionId);
  }
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    projectRoot: PROJECT_ROOT,
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

function meterRecord(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    meterId: 'window-5h',
    kind: 'rolling-window',
    scope: 'all-models',
    percent: 10,
    source: 'endpoint',
    observedAt: FIXED_NOW,
    ...overrides,
  } as MeterRecord;
}

function metersStateWith(...meters: MeterRecord[]): MetersState {
  const byId: Record<string, MeterRecord> = {};
  for (const meter of meters) {
    byId[meter.meterId] = meter;
  }
  return { meters: byId, history: {} };
}

interface Harness {
  dispatcher: TaskDispatcher;
  sessionHost: RecordingSessionHost;
  emitted: EventInput[];
  nowIsoCallCount: () => number;
}

function buildHarness(options: {
  tasks?: TaskRecord[];
  meters?: MetersState;
  nowIso?: string;
  resolveWorkingDirectory?: TaskDispatcherDeps['resolveWorkingDirectory'];
} = {}): Harness {
  const sessionHost = new RecordingSessionHost();
  const emitted: EventInput[] = [];
  const tasksById: Record<string, TaskRecord> = {};
  for (const task of options.tasks ?? [taskRecord()]) {
    tasksById[task.taskId] = task;
  }
  const tasksState: TasksState = { tasks: tasksById };
  const metersState = options.meters ?? metersStateWith(meterRecord());
  let nowIsoCallCount = 0;

  const deps: TaskDispatcherDeps = {
    sessionHost,
    emit: (events) => {
      emitted.push(...events);
    },
    readTasks: () => tasksState,
    readMeters: () => metersState,
    nowIso: () => {
      nowIsoCallCount += 1;
      return options.nowIso ?? FIXED_NOW;
    },
    staleAfterMs: STALE_AFTER_MS,
    ...(options.resolveWorkingDirectory === undefined
      ? {}
      : { resolveWorkingDirectory: options.resolveWorkingDirectory }),
  };
  return {
    dispatcher: new TaskDispatcher(deps),
    sessionHost,
    emitted,
    nowIsoCallCount: () => nowIsoCallCount,
  };
}

function eventTypes(events: EventInput[]): string[] {
  return events.map((event) => event.type);
}

describe('TaskDispatcher — the spawn path', () => {
  it('spawns exactly once in the resolved cwd and emits exactly one task_session_attached', () => {
    // Assertion 5.
    const harness = buildHarness();
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
    expect(harness.emitted).toHaveLength(1);
    const attachEvent = harness.emitted[0]!;
    expect(attachEvent.type).toBe(EVENT_TYPES.taskSessionAttached);
    expect(attachEvent.stream).toBe('tasks');
    expect(attachEvent.payload).toEqual({
      taskId: TASK_ID,
      stage: 'implementing',
      // The appSessionId the HOST returned — never one the dispatcher invented.
      appSessionId: SPAWNED_SESSION_ID,
    });
    expect(result).toEqual({
      outcome: 'spawned',
      taskId: TASK_ID,
      stage: 'implementing',
      appSessionId: SPAWNED_SESSION_ID,
      cwd: PROJECT_ROOT,
    });
  });

  it('a passing headroom gate still spawns — the gate refuses, it does not block everything', () => {
    // The other direction of I10: the guard must not be a blanket "never spawn
    // when a gate exists". 90% headroom against a 20% requirement passes.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 20 } } })],
      meters: metersStateWith(meterRecord({ percent: 10 })),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(result.outcome).toBe('spawned');
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.taskSessionAttached]);
  });
});

describe('TaskDispatcher — I10 end-to-end: a failed gate NEVER REACHES the session host', () => {
  // Both cases assert the SAME two things, and the first one is the invariant:
  //   1. `spawnCalls` is EMPTY — the refusal happened before any I/O, so there is
  //      no window in which a session existed and was then disowned.
  //   2. exactly one `dispatch_refused` carrying the DECISION's reason — I10 is
  //      not satisfied by refusing, it is satisfied by refusing AND RECORDING IT.
  // Asserting only (2) would pass for an implementation that spawned first and
  // evented afterwards, which is precisely the violation.

  it('headroom-insufficient: zero spawn calls, one dispatch_refused', () => {
    // Assertion 6a. 40% used → 60 headroom, against a 75% requirement → fail.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } } })],
      meters: metersStateWith(meterRecord({ percent: 40 })),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]!.type).toBe(EVENT_TYPES.dispatchRefused);
    expect(harness.emitted[0]!.stream).toBe('tasks');
    expect(harness.emitted[0]!.payload).toEqual({
      taskId: TASK_ID,
      reason: 'headroom-insufficient',
    });
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'headroom-insufficient' });
  });

  it('headroom-unknown (meter never observed): zero spawn calls, one dispatch_refused', () => {
    // Assertion 6b. The pillar-4 case: we CANNOT SEE headroom, which is not the
    // same fact as being out of it — and the recorded reason must not say it is.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'never-observed', pct: 10 } } })],
      meters: metersStateWith(meterRecord({ percent: 1 })),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]!.type).toBe(EVENT_TYPES.dispatchRefused);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'headroom-unknown' });
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'headroom-unknown' });
  });

  it('headroom-unknown (observation gone stale): zero spawn calls, one dispatch_refused', () => {
    // Assertion 6b, second route into 'unknown'. The meter EXISTS and reads 1%
    // used — a number that would sail through the gate — but it was observed
    // long before `nowIso`, so a stale number is never served as current.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 10 } } })],
      meters: metersStateWith(
        meterRecord({ percent: 1, observedAt: '2026-07-22T10:00:00.000Z' }),
      ),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'headroom-unknown' });
    expect(result.outcome).toBe('refused');
  });

  it('a non-dispatchable stage refuses without reaching the session host', () => {
    // The same shape for the third refusal reason: `done` never spawns.
    const harness = buildHarness({ tasks: [taskRecord({ stage: 'done' })] });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted[0]!.payload).toEqual({
      taskId: TASK_ID,
      reason: 'stage-not-dispatchable',
    });
    expect(result.outcome).toBe('refused');
  });

  it('already-running: a task with a LIVE stage run is never double-spawned', () => {
    // The `hasLiveRun` seam is answered from the task's own sessionRefs against
    // the host's live registry — the same liveness the rest of the daemon reads.
    const harness = buildHarness({
      tasks: [
        taskRecord({ sessionRefs: [{ stage: 'implementing', appSessionId: EXISTING_SESSION_ID }] }),
      ],
    });
    harness.sessionHost.markLive(EXISTING_SESSION_ID);
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'already-running' });
    expect(result.outcome).toBe('refused');
  });

  it('a task whose past stage run is NO LONGER live spawns again', () => {
    // The other direction, so `already-running` cannot degrade into "a task that
    // ever ran can never run again".
    const harness = buildHarness({
      tasks: [
        taskRecord({ sessionRefs: [{ stage: 'planning', appSessionId: EXISTING_SESSION_ID }] }),
      ],
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(result.outcome).toBe('spawned');
  });
});

describe('TaskDispatcher — a defer emits NOTHING', () => {
  it('does not spawn and writes no event at all', () => {
    // Assertion 7. A defer is not a refusal: nothing was denied, nothing changed,
    // and any surface re-derives the identical defer from the same pure function.
    // Eventing here would write one record per attempt for as long as the window
    // stays shut.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt: '2026-07-22T13:00:00.000Z' })),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'deferred',
      taskId: TASK_ID,
      reason: 'awaiting-meter-reset',
      meterId: 'window-5h',
    });
  });

  it('stays silent across REPEATED attempts — the log cannot fill with non-events', () => {
    // The reason the silence matters, asserted rather than asserted-about: ten
    // attempts against a shut window produce zero records.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt: '2026-07-22T13:00:00.000Z' })),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(harness.dispatcher.dispatchTask(TASK_ID).outcome).toBe('deferred');
    }
    expect(harness.emitted).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
  });

  it('a defer for an UNKNOWN reset time is equally silent', () => {
    // 'reset-time-unknown' — the meter carries no `resetsAt`. Still a schedule
    // question, still not a refusal, still nothing written.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt: null })),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.emitted).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(result).toEqual({
      outcome: 'deferred',
      taskId: TASK_ID,
      reason: 'reset-time-unknown',
      meterId: 'window-5h',
    });
  });
});

describe('TaskDispatcher — a failed spawn is an EXECUTION outcome, not a decision', () => {
  it('emits no task_session_attached, does not throw, and reports the host reason', () => {
    // Assertion 8. The session host already evented its OWN refusal
    // (transition_rejected / preflight-failed), so nothing is double-recorded
    // here — and no `dispatch_refused` is invented, because that enum is the
    // DECISION vocabulary and this decision was `spawn`.
    const harness = buildHarness();
    harness.sessionHost.refuseNextSpawn('preflight-failed');

    let result: ReturnType<TaskDispatcher['dispatchTask']> | undefined;
    expect(() => {
      result = harness.dispatcher.dispatchTask(TASK_ID);
    }).not.toThrow();

    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'spawn-failed',
      taskId: TASK_ID,
      reason: 'preflight-failed',
    });
  });

  it('survives a session host that THROWS', () => {
    // A dispatcher that throws is a dispatcher that has silently stopped.
    const harness = buildHarness();
    harness.sessionHost.throwOnSpawn(new Error('adapter exploded'));

    let result: ReturnType<TaskDispatcher['dispatchTask']> | undefined;
    expect(() => {
      result = harness.dispatcher.dispatchTask(TASK_ID);
    }).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(result!.outcome).toBe('spawn-failed');
    expect(result).toMatchObject({ reason: 'spawn-threw:adapter exploded' });
  });
});

describe('TaskDispatcher — unknown task', () => {
  it('does not spawn, emits nothing, and never throws', () => {
    // Assertion 9. No `dispatch_refused` either: writing one would introduce a
    // taskId to the tasks stream that no `task_created` ever introduced.
    const harness = buildHarness();
    let result: ReturnType<TaskDispatcher['dispatchTask']> | undefined;
    expect(() => {
      result = harness.dispatcher.dispatchTask('task-that-does-not-exist');
    }).not.toThrow();

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({ outcome: 'unknown-task', taskId: 'task-that-does-not-exist' });
  });
});

describe('TaskDispatcher — the isolation scope boundary (D32 vs step 8)', () => {
  it('DOCUMENTS THE GAP: an isolation:worktree task currently runs in projectRoot', () => {
    // Assertion 10. D32 pinned `worktree` as the default isolation, but worktree
    // CREATION is step 8 — so today every task, including this one, runs in
    // `task.projectRoot` and ISOLATION IS NOT HONOURED.
    //
    // ⚠ THIS ASSERTION IS DESIGNED TO REDDEN. When step 8 lands and the resolver
    // starts returning a worktree path, this case fails and forces the change to
    // be deliberate and reviewed rather than an accident nobody noticed. Do not
    // "fix" it by loosening the expectation; update it alongside step 8.
    const worktreeTask = taskRecord({ isolation: 'worktree' });
    expect(projectRootWorkingDirectory(worktreeTask)).toBe(PROJECT_ROOT);

    const harness = buildHarness({ tasks: [worktreeTask] });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
    expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
  });

  it('resolves shared-dir to the same projectRoot — the two isolations are INDISTINGUISHABLE today', () => {
    // The blunt statement of the gap: the field is read, carried through the
    // decision, and then changes nothing about where the worker runs.
    const sharedDirHarness = buildHarness({ tasks: [taskRecord({ isolation: 'shared-dir' })] });
    sharedDirHarness.dispatcher.dispatchTask(TASK_ID);
    const worktreeHarness = buildHarness({ tasks: [taskRecord({ isolation: 'worktree' })] });
    worktreeHarness.dispatcher.dispatchTask(TASK_ID);

    expect(worktreeHarness.sessionHost.spawnCalls).toEqual(sharedDirHarness.sessionHost.spawnCalls);
  });

  it('an injected resolveWorkingDirectory overrides the default — the step-8 seam', () => {
    // Assertion 10, second half: the seam step 8 will replace. It receives the
    // whole TaskRecord, so a worktree resolver can key on taskId AND isolation.
    const resolverCalls: TaskRecord[] = [];
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      resolveWorkingDirectory: (task) => {
        resolverCalls.push(task);
        return `/var/lib/vimes/worktrees/${task.taskId}`;
      },
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]!.isolation).toBe('worktree');
    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: `/var/lib/vimes/worktrees/${TASK_ID}` },
    ]);
    expect(result).toMatchObject({ cwd: `/var/lib/vimes/worktrees/${TASK_ID}` });
  });
});

describe('TaskDispatcher — the injected clock is the ONLY time source', () => {
  it('decides against nowIso, not the wall clock (the reset boundary proves it)', () => {
    // Assertion 11. The same task, the same meter, the same fixed reset time —
    // only the injected `nowIso` differs, and it alone flips the decision. A
    // dispatcher reading a real clock could not produce both answers, because the
    // reset time is in 2020 and 2099 respectively.
    const resetsAt = '2050-01-01T00:00:00.000Z';
    const beforeReset = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt, observedAt: '2049-12-31T23:59:00.000Z' })),
      nowIso: '2049-12-31T23:59:30.000Z',
    });
    expect(beforeReset.dispatcher.dispatchTask(TASK_ID).outcome).toBe('deferred');

    const afterReset = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt, observedAt: '2050-01-01T00:00:30.000Z' })),
      nowIso: '2050-01-01T00:01:00.000Z',
    });
    expect(afterReset.dispatcher.dispatchTask(TASK_ID).outcome).toBe('spawned');
  });

  it('reads the clock through the injected seam on every attempt', () => {
    const harness = buildHarness();
    expect(harness.nowIsoCallCount()).toBe(0);
    harness.dispatcher.dispatchTask(TASK_ID);
    expect(harness.nowIsoCallCount()).toBe(1);
  });

  it('is deterministic: the same inputs produce byte-identical results and events', () => {
    // Assertion 11, second half. Two independently-built harnesses with the same
    // fixed clock produce the same decision and the same event payloads.
    const buildAndDispatch = (): { result: unknown; emitted: EventInput[] } => {
      const harness = buildHarness({
        tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } } })],
        meters: metersStateWith(meterRecord({ percent: 40 })),
      });
      return { result: harness.dispatcher.dispatchTask(TASK_ID), emitted: harness.emitted };
    };
    const firstRun = buildAndDispatch();
    const secondRun = buildAndDispatch();
    expect(JSON.stringify(secondRun)).toBe(JSON.stringify(firstRun));
  });
});
