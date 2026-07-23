import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  type EventInput,
  type MeterRecord,
  type MetersState,
  type TaskRecord,
  type TasksState,
} from '@vimes/core';
import type { ResumeResult, SendResult, SpawnResult } from './sessionHost.js';
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
// The session that AUTHORED the work — the one a fix resumes and a review must
// never touch.
const HOT_AUTHOR_SESSION_ID = 'cccccccc-0000-4000-8000-000000000003';
const SECOND_HOT_AUTHOR_SESSION_ID = 'cccccccc-0000-4000-8000-000000000004';
const FIXED_NOW = '2026-07-22T12:00:00.000Z';
// The meter staleness band, named by the caller (rule 0.2 — no default here).
const STALE_AFTER_MS = 90_000;

// A session host that RECORDS instead of spawning. Structurally satisfies
// `Pick<SessionHost, 'spawnSession' | 'isLive' | 'resumeSession' | 'sendMessage'>`;
// the real class is never constructed and never imported at runtime (the result-type
// imports above are type-only).
class RecordingSessionHost {
  readonly spawnCalls: Array<{ channel: 'sdk' | 'pty'; cwd: string; name?: string }> = [];
  // Step 7's instruments. `resumeCalls` is what proves a fix went to the hot
  // author; `spawnCalls.length === 0` alongside it is what proves no stranger was
  // hired as well — and on the review path the two swap roles.
  readonly resumeCalls: string[] = [];
  readonly sendCalls: Array<{ appSessionId: string; text: string }> = [];
  private nextSpawnResult: SpawnResult = { appSessionId: SPAWNED_SESSION_ID };
  private nextResumeResult: ResumeResult | null = null;
  private nextSendResult: SendResult = { ok: true };
  private spawnThrows: Error | null = null;
  private resumeThrows: Error | null = null;
  private sendThrows: Error | null = null;
  private readonly liveSessionIds = new Set<string>();

  spawnSession(options: { channel: 'sdk' | 'pty'; cwd: string; name?: string }): SpawnResult {
    this.spawnCalls.push(options);
    if (this.spawnThrows !== null) {
      throw this.spawnThrows;
    }
    return this.nextSpawnResult;
  }

  // The real host hands back the SAME appSessionId (no new id, no fork — I3), and
  // the fake must not be more generous than the thing it stands in for.
  resumeSession(appSessionId: string): ResumeResult {
    this.resumeCalls.push(appSessionId);
    if (this.resumeThrows !== null) {
      throw this.resumeThrows;
    }
    return this.nextResumeResult ?? { appSessionId };
  }

  sendMessage(appSessionId: string, text: string): SendResult {
    this.sendCalls.push({ appSessionId, text });
    if (this.sendThrows !== null) {
      throw this.sendThrows;
    }
    return this.nextSendResult;
  }

  isLive(appSessionId: string): boolean {
    return this.liveSessionIds.has(appSessionId);
  }

  refuseNextSpawn(reason: string): void {
    this.nextSpawnResult = { refused: true, reason };
  }

  refuseNextResume(reason: string): void {
    this.nextResumeResult = { refused: true, reason };
  }

  refuseNextSend(reason: string): void {
    this.nextSendResult = { refused: true, reason };
  }

  throwOnSpawn(error: Error): void {
    this.spawnThrows = error;
  }

  throwOnResume(error: Error): void {
    this.resumeThrows = error;
  }

  throwOnSend(error: Error): void {
    this.sendThrows = error;
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
  composeStageInstruction?: TaskDispatcherDeps['composeStageInstruction'];
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
    // Omitted unless a case asks for one — so every OTHER case in this file runs
    // against the real default (`() => null`, send nothing), which is the
    // behaviour app.ts ships.
    ...(options.composeStageInstruction === undefined
      ? {}
      : { composeStageInstruction: options.composeStageInstruction }),
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

// ─── slice 6 step 7 — review vs fix, executed ────────────────────────────────
//
// The pure rule lives in `packages/core/src/tasks/stageRunner.ts` and is
// enumerated in its own test. What these cases hold is the EXECUTION half: that
// the dispatcher makes the call the plan asked for and makes NO OTHER — because
// "resumed the author" and "also spawned a stranger" would both satisfy a test
// that only checked `resumeCalls`.

function implementingRef(appSessionId: string): TaskRecord['sessionRefs'][number] {
  return { stage: 'implementing', appSessionId };
}

describe('TaskDispatcher — the FIX LOOP resumes the hot author', () => {
  it('resumes the author, calls spawnSession ZERO times, and attaches the session to the new stage', () => {
    // Assertion 7. The task went implementing → review → implementing, so the
    // work already has an author; resuming it avoids the new-agent cache miss
    // (D6: the prompt cache is scoped to machine+directory, and a resume lands in
    // the same directory).
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
        }),
      ],
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.resumeCalls).toEqual([HOT_AUTHOR_SESSION_ID]);
    // ⚠ THE OTHER HALF OF THE CLAIM. A dispatcher that resumed the author AND
    // spawned a fresh session would pass the line above while paying for exactly
    // the cache miss the fix loop exists to avoid — and would leave two agents on
    // one task.
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);

    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]!.type).toBe(EVENT_TYPES.taskSessionAttached);
    expect(harness.emitted[0]!.stream).toBe('tasks');
    expect(harness.emitted[0]!.payload).toEqual({
      taskId: TASK_ID,
      stage: 'implementing',
      // The id the HOST returned from the resume — the same session, not a new one.
      appSessionId: HOT_AUTHOR_SESSION_ID,
    });
    expect(result).toEqual({
      outcome: 'resumed',
      taskId: TASK_ID,
      stage: 'implementing',
      appSessionId: HOT_AUTHOR_SESSION_ID,
    });
  });

  it('resumes the MOST RECENT author when the task has been round the loop twice', () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [
            implementingRef(HOT_AUTHOR_SESSION_ID),
            { stage: 'review', appSessionId: EXISTING_SESSION_ID },
            implementingRef(SECOND_HOT_AUTHOR_SESSION_ID),
          ],
        }),
      ],
    });
    harness.dispatcher.dispatchTask(TASK_ID);
    expect(harness.sessionHost.resumeCalls).toEqual([SECOND_HOT_AUTHOR_SESSION_ID]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
  });

  it('a FIRST-PASS implementing task still spawns — the resume is not unconditional', () => {
    // The other direction, so the fix loop cannot degrade into "implementing never
    // spawns". A planning ref is not an author.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [{ stage: 'planning', appSessionId: EXISTING_SESSION_ID }],
        }),
      ],
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result.outcome).toBe('spawned');
  });

  it('does NOT resolve a working directory for a resume — the author keeps its own cwd', () => {
    // `resumeSession` takes no cwd (I3 resumes from the RECORDED one), and that is
    // the directory the author's prompt cache is scoped to (D6). A resolver that
    // ran here would imply a move the host cannot perform.
    const resolverCalls: TaskRecord[] = [];
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
      resolveWorkingDirectory: (task) => {
        resolverCalls.push(task);
        return '/var/lib/vimes/worktrees/should-not-be-used';
      },
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(resolverCalls).toEqual([]);
    expect(result).not.toHaveProperty('cwd');
  });
});

describe('TaskDispatcher — THE INDEPENDENCE RULE, executed', () => {
  it('a review spawns a session that is NOT any implementing session on the task', () => {
    // Assertion 8. The invariant is not "spawnSession was called" — it is that the
    // session which reviews the work is NOT the session that wrote it. So the
    // difference between the resulting appSessionId and every implementing ref is
    // asserted directly, ref by ref; the call count is only the mechanism.
    const implementingSessionIds = [HOT_AUTHOR_SESSION_ID, SECOND_HOT_AUTHOR_SESSION_ID];
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'review',
          sessionRefs: [
            ...implementingSessionIds.map(implementingRef),
            { stage: 'planning', appSessionId: EXISTING_SESSION_ID },
          ],
        }),
      ],
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result.outcome).toBe('spawned');

    const reviewingSessionId = (result as { appSessionId: string }).appSessionId;
    for (const authorSessionId of implementingSessionIds) {
      expect(reviewingSessionId, `review must not run in author ${authorSessionId}`).not.toBe(
        authorSessionId,
      );
    }
    // And the attach records the REVIEW stage against the new session, so the
    // board shows two distinct sessions on the task rather than one wearing both
    // hats.
    expect(harness.emitted[0]!.payload).toEqual({
      taskId: TASK_ID,
      stage: 'review',
      appSessionId: reviewingSessionId,
    });
  });

  it('never resumes for a review even when the author is the ONLY session on the task', () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'review', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'spawned', stage: 'review' });
  });
});

describe('TaskDispatcher — a refused resume is an EXECUTION outcome, not a decision', () => {
  it('emits no task_session_attached, does not throw, and reports the host reason', () => {
    // Assertion 9, the mirror of the `spawn-failed` case. The host already evented
    // its own refusal (I11's transition_rejected, or a preflight rejection), so
    // nothing is double-recorded — and no `dispatch_refused` is invented, because
    // that enum is the DECISION vocabulary and this decision was to run the stage.
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.refuseNextResume('session already has a live process');

    let result: ReturnType<TaskDispatcher['dispatchTask']> | undefined;
    expect(() => {
      result = harness.dispatcher.dispatchTask(TASK_ID);
    }).not.toThrow();

    expect(harness.sessionHost.resumeCalls).toEqual([HOT_AUTHOR_SESSION_ID]);
    // No fallback spawn. A refused resume must not silently become "hire a
    // stranger instead": the caller decides what to do about it.
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'resume-failed',
      taskId: TASK_ID,
      appSessionId: HOT_AUTHOR_SESSION_ID,
      reason: 'session already has a live process',
    });
  });

  it('I11 IS THE BACKSTOP: a host that refuses a live session is honoured even if the decision missed it', () => {
    // The two guards agree but are INDEPENDENT. `decideDispatch` refuses
    // `already-running` from the dispatcher's view of liveness; `resumeSession`
    // refuses from the host's own registry at the instant of the call. This case
    // is the race the second guard exists for — the dispatcher believed the author
    // was dormant, the host knew better — and the outcome is a refusal, never a
    // second live run.
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.refuseNextResume('session already has a live process');
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(result.outcome).toBe('resume-failed');
    expect(harness.emitted).toEqual([]);
  });

  it('survives a session host that THROWS on resume', () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.throwOnResume(new Error('adapter exploded'));

    let result: ReturnType<TaskDispatcher['dispatchTask']> | undefined;
    expect(() => {
      result = harness.dispatcher.dispatchTask(TASK_ID);
    }).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'resume-failed',
      reason: 'resume-threw:adapter exploded',
    });
  });
});

describe('TaskDispatcher — the instruction seam (MACHINERY; the words are deferred)', () => {
  // ⚠ NO PROMPT TEXT IS ASSERTED HERE BEYOND WHAT A TEST ITSELF SUPPLIES. What a
  // review or fix prompt should SAY is Wes's decision and is explicitly out of
  // this step; these cases prove only that a string handed to the seam arrives
  // verbatim, once, and that the DEFAULT is silence.
  const STUB_INSTRUCTION = 'test-only instruction text — not a product prompt';

  it('the DEFAULT composer sends nothing at all, on both the spawn and the resume path', () => {
    // Assertion 10, first half — and this is the whole of today's behaviour.
    const spawnHarness = buildHarness();
    spawnHarness.dispatcher.dispatchTask(TASK_ID);
    expect(spawnHarness.sessionHost.sendCalls).toEqual([]);

    const resumeHarness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    resumeHarness.dispatcher.dispatchTask(TASK_ID);
    expect(resumeHarness.sessionHost.sendCalls).toEqual([]);
  });

  it('sends the composed string EXACTLY ONCE to the spawned session', () => {
    const composerCalls: Array<{ taskId: string; mode: string }> = [];
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'review' })],
      composeStageInstruction: (task, plan) => {
        composerCalls.push({ taskId: task.taskId, mode: plan.mode });
        return STUB_INSTRUCTION;
      },
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(composerCalls).toEqual([{ taskId: TASK_ID, mode: 'spawn' }]);
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: STUB_INSTRUCTION },
    ]);
    expect(result).toMatchObject({ outcome: 'spawned', instructionDelivery: { status: 'sent' } });
  });

  it('sends the composed string EXACTLY ONCE to the RESUMED session', () => {
    // Assertion 10's other path. The composer sees `mode: 'resume'` — the only way
    // it can brief a returning author differently from a fresh one.
    const composerCalls: string[] = [];
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
      composeStageInstruction: (_task, plan) => {
        composerCalls.push(plan.mode === 'resume' ? `resume:${plan.appSessionId}` : 'spawn');
        return STUB_INSTRUCTION;
      },
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(composerCalls).toEqual([`resume:${HOT_AUTHOR_SESSION_ID}`]);
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: HOT_AUTHOR_SESSION_ID, text: STUB_INSTRUCTION },
    ]);
    expect(result).toMatchObject({ outcome: 'resumed', instructionDelivery: { status: 'sent' } });
  });

  it('sends NOTHING when the composer returns null or an empty string', () => {
    // An empty send would still cost a turn and would read to the agent as a
    // prompt, so empty and null are the same instruction: none.
    for (const composed of [null, ''] as const) {
      const harness = buildHarness({ composeStageInstruction: () => composed });
      const result = harness.dispatcher.dispatchTask(TASK_ID);
      expect(harness.sessionHost.sendCalls).toEqual([]);
      // ...and the result carries no delivery field at all, so the default path's
      // envelope is byte-identical to step 4a's.
      expect(result).not.toHaveProperty('instructionDelivery');
    }
  });

  it('is never consulted at all when nothing runs — a refusal receives no brief', () => {
    // The composer must not be a side-channel that fires on a path where no
    // session exists.
    let composerCallCount = 0;
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } } }),
      ],
      meters: metersStateWith(meterRecord({ percent: 40 })),
      composeStageInstruction: () => {
        composerCallCount += 1;
        return STUB_INSTRUCTION;
      },
    });
    expect(harness.dispatcher.dispatchTask(TASK_ID).outcome).toBe('refused');
    expect(composerCallCount).toBe(0);
    expect(harness.sessionHost.sendCalls).toEqual([]);
  });

  it('a refused or throwing send is REPORTED, never swallowed — and never unwinds the dispatch', () => {
    // A stage run that silently never received its brief looks like a working
    // dispatch and behaves like an idle agent. But the session exists and is
    // attached, so the dispatch itself still succeeded: un-attaching it would
    // leave a live session the task no longer references.
    const refusedHarness = buildHarness({ composeStageInstruction: () => STUB_INSTRUCTION });
    refusedHarness.sessionHost.refuseNextSend('session-dead');
    const refusedResult = refusedHarness.dispatcher.dispatchTask(TASK_ID);
    expect(refusedResult).toMatchObject({
      outcome: 'spawned',
      instructionDelivery: { status: 'not-delivered', reason: 'session-dead' },
    });
    expect(eventTypes(refusedHarness.emitted)).toEqual([EVENT_TYPES.taskSessionAttached]);

    const throwingHarness = buildHarness({ composeStageInstruction: () => STUB_INSTRUCTION });
    throwingHarness.sessionHost.throwOnSend(new Error('transport gone'));
    let thrownResult: ReturnType<TaskDispatcher['dispatchTask']> | undefined;
    expect(() => {
      thrownResult = throwingHarness.dispatcher.dispatchTask(TASK_ID);
    }).not.toThrow();
    expect(thrownResult).toMatchObject({
      instructionDelivery: { status: 'not-delivered', reason: 'send-threw:transport gone' },
    });
  });

  it('a THROWING composer cannot take the dispatcher down', () => {
    const harness = buildHarness({
      composeStageInstruction: () => {
        throw new Error('composer exploded');
      },
    });
    let result: ReturnType<TaskDispatcher['dispatchTask']> | undefined;
    expect(() => {
      result = harness.dispatcher.dispatchTask(TASK_ID);
    }).not.toThrow();
    expect(harness.sessionHost.sendCalls).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'spawned',
      instructionDelivery: { status: 'not-delivered', reason: 'compose-threw:composer exploded' },
    });
  });
});

describe('TaskDispatcher — step 7 changes nothing about WHETHER a stage runs', () => {
  it('I10 STILL HOLDS AGAINST A RESUMABLE TASK: a failed gate reaches neither spawn NOR resume', () => {
    // Assertion 11, and the one worth stating loudest. The task has a hot author
    // sitting right there, which is exactly the shape a "just resume it, it is
    // cheap" shortcut would wave through — a resume is not free, it runs a real
    // agent against a real budget. The headroom refusal must precede the runner.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
          gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } },
        }),
      ],
      meters: metersStateWith(meterRecord({ percent: 40 })),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'headroom-insufficient' });
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'headroom-insufficient' });
  });

  it('already-running still refuses a task whose author is LIVE — before any resume is attempted', () => {
    // `decideDispatch`'s guard, unchanged: a live author is not a resume candidate,
    // it is an in-flight run. The host's I11 refusal would also catch this; the
    // point is that we never get that far.
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.markLive(HOT_AUTHOR_SESSION_ID);
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'already-running' });
  });

  it('a defer is still silent and still touches neither call', () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
          gates: { deferUntilReset: 'window-5h' },
        }),
      ],
      meters: metersStateWith(meterRecord({ resetsAt: '2026-07-22T13:00:00.000Z' })),
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.emitted).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result.outcome).toBe('deferred');
  });

  it('a non-dispatchable stage still refuses, even holding an implementing ref', () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'done', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    const result = harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'stage-not-dispatchable' });
  });

  it('the resume path is deterministic too — identical inputs, identical results and events', () => {
    const buildAndDispatch = (): { result: unknown; emitted: EventInput[] } => {
      const harness = buildHarness({
        tasks: [
          taskRecord({
            stage: 'implementing',
            sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
          }),
        ],
      });
      return { result: harness.dispatcher.dispatchTask(TASK_ID), emitted: harness.emitted };
    };
    expect(JSON.stringify(buildAndDispatch())).toBe(JSON.stringify(buildAndDispatch()));
  });
});
