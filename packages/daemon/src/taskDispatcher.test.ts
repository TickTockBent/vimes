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
import type { GitRunResult, GitRunner } from './gitAdapter.js';
import { loadConfigFromEnv } from './config.js';
import { WorktreeManager } from './worktreeManager.js';
import {
  TaskDispatcher,
  projectRootWorkingDirectory,
  type DispatchAttemptResult,
  type TaskDispatcherDeps,
} from './taskDispatcher.js';

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
// Step 8. The worktree root a harness-built manager uses, and the derived names —
// restated as literals so this file pins the CONTRACT rather than re-running core's
// derivation. Nothing under this path is ever created; the git runner is a fake.
const WORKTREE_ROOT = '/var/lib/vimes-worktrees';
const WORKTREE_PATH = `${WORKTREE_ROOT}/task-task-dispatch-0001`;
const WORKTREE_BRANCH = 'vimes/task-task-dispatch-0001';
// The stepping clock's step, so `setupMs` is a known number rather than a race.
const WORKTREE_SETUP_STEP_MS = 250;
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
  // Step 8's instruments. `worktreeCalls` is what proves the manager was consulted;
  // `gitCalls` is the stronger claim underneath it — that no git SUBPROCESS was
  // reached at all, which is the assertable form of "byte-identical to before".
  worktreeCalls: () => string[];
  gitCalls: () => string[][];
}

function buildHarness(options: {
  tasks?: TaskRecord[];
  meters?: MetersState;
  nowIso?: string;
  resolveWorkingDirectory?: TaskDispatcherDeps['resolveWorkingDirectory'];
  composeStageInstruction?: TaskDispatcherDeps['composeStageInstruction'];
  // Step 8. BOTH default to the shipped default — no manager and the flag OFF — so
  // every case written before this step keeps exactly the behaviour it had.
  worktreeIsolationEnabled?: boolean;
  // When true the harness builds a REAL `WorktreeManager` over a RECORDING FAKE git
  // runner, so a case can assert on the actual arg-vectors. `worktreeFailure`
  // instead makes `git worktree list` fail, which is how the safety case gets a
  // failed worktree without a real filesystem.
  withWorktreeManager?: boolean;
  worktreeFailure?: GitRunResult;
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

  // ⚠ THE FAKE GIT RUNNER. **No real git command runs in this file and NO WORKTREE
  // IS EVER CREATED** — this suite runs inside the vimes checkout, and a dispatcher
  // test that really created one would leave it in the repo under development.
  // Recording the arg-vectors is also what makes "the flag off issues NO git command
  // at all" an assertion rather than a claim.
  const gitCalls: string[][] = [];
  const worktreeCalls: string[] = [];
  const recordingGitRunner: GitRunner = async (args) => {
    gitCalls.push([...args]);
    if (options.worktreeFailure !== undefined) {
      return options.worktreeFailure;
    }
    // An empty `worktree list` means "not created yet", so the manager proceeds to
    // `add`, which succeeds emptily.
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const realManager =
    options.withWorktreeManager === true || options.worktreeFailure !== undefined
      ? new WorktreeManager({
          runner: recordingGitRunner,
          worktreeRoot: WORKTREE_ROOT,
          // A stepping clock, so `setupMs` is deterministic (rule 0.3).
          nowMs: (() => {
            let clockReadCount = 0;
            return () => {
              const currentMs = 1_000_000 + clockReadCount * WORKTREE_SETUP_STEP_MS;
              clockReadCount += 1;
              return currentMs;
            };
          })(),
        })
      : undefined;
  const worktreeManager =
    realManager === undefined
      ? undefined
      : {
          ensureWorktree: (task: TaskRecord) => {
            worktreeCalls.push(task.taskId);
            return realManager.ensureWorktree(task);
          },
        };

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
    // ⚠ OMITTED unless a case names it — so the DEFAULT this file exercises
    // everywhere else is the shipped one: the flag off, no manager, every task in
    // `task.projectRoot`, and no git anywhere.
    ...(options.worktreeIsolationEnabled === undefined
      ? {}
      : { worktreeIsolationEnabled: options.worktreeIsolationEnabled }),
    ...(worktreeManager === undefined ? {} : { worktreeManager }),
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
    worktreeCalls: () => worktreeCalls,
    gitCalls: () => gitCalls,
  };
}

function eventTypes(events: EventInput[]): string[] {
  return events.map((event) => event.type);
}

// ─── the step-8 ASYNC RIPPLE, and the one place it needed thought ────────────
//
// `dispatchTask` became async in step 8 (creating a worktree is a subprocess), so
// every case here awaits it. That part is mechanical and NO EXPECTATION CHANGED.
//
// ⚠ The cases that used to read `expect(() => …dispatchTask(…)).not.toThrow()` could
// NOT be translated mechanically, because the naive translation is VACUOUS: calling
// an async function returns a REJECTED PROMISE rather than throwing, so
// `expect(asyncFn).not.toThrow()` passes no matter how badly the dispatcher fails.
// A rejected promise IS the async form of a throw, so `.resolves` is what asserts
// it did not happen — and the claim being made is the same one step 4a made: a
// dispatcher that throws is a dispatcher that has silently stopped.
async function dispatchWithoutRejecting(
  dispatcher: TaskDispatcher,
  taskId: string,
): Promise<DispatchAttemptResult> {
  const attempt = dispatcher.dispatchTask(taskId);
  await expect(
    attempt,
    'dispatchTask must never reject — a dispatcher that throws has silently stopped',
  ).resolves.toBeDefined();
  return attempt;
}

describe('TaskDispatcher — the spawn path', () => {
  it('spawns exactly once in the resolved cwd and emits exactly one task_session_attached', async () => {
    // Assertion 5.
    const harness = buildHarness();
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

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

  it('a passing headroom gate still spawns — the gate refuses, it does not block everything', async () => {
    // The other direction of I10: the guard must not be a blanket "never spawn
    // when a gate exists". 90% headroom against a 20% requirement passes.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 20 } } })],
      meters: metersStateWith(meterRecord({ percent: 10 })),
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

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

  it('headroom-insufficient: zero spawn calls, one dispatch_refused', async () => {
    // Assertion 6a. 40% used → 60 headroom, against a 75% requirement → fail.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } } })],
      meters: metersStateWith(meterRecord({ percent: 40 })),
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

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

  it('headroom-unknown (meter never observed): zero spawn calls, one dispatch_refused', async () => {
    // Assertion 6b. The pillar-4 case: we CANNOT SEE headroom, which is not the
    // same fact as being out of it — and the recorded reason must not say it is.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'never-observed', pct: 10 } } })],
      meters: metersStateWith(meterRecord({ percent: 1 })),
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]!.type).toBe(EVENT_TYPES.dispatchRefused);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'headroom-unknown' });
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'headroom-unknown' });
  });

  it('headroom-unknown (observation gone stale): zero spawn calls, one dispatch_refused', async () => {
    // Assertion 6b, second route into 'unknown'. The meter EXISTS and reads 1%
    // used — a number that would sail through the gate — but it was observed
    // long before `nowIso`, so a stale number is never served as current.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 10 } } })],
      meters: metersStateWith(
        meterRecord({ percent: 1, observedAt: '2026-07-22T10:00:00.000Z' }),
      ),
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'headroom-unknown' });
    expect(result.outcome).toBe('refused');
  });

  it('a non-dispatchable stage refuses without reaching the session host', async () => {
    // The same shape for the third refusal reason: `done` never spawns.
    const harness = buildHarness({ tasks: [taskRecord({ stage: 'done' })] });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted[0]!.payload).toEqual({
      taskId: TASK_ID,
      reason: 'stage-not-dispatchable',
    });
    expect(result.outcome).toBe('refused');
  });

  it('already-running: a task with a LIVE stage run is never double-spawned', async () => {
    // The `hasLiveRun` seam is answered from the task's own sessionRefs against
    // the host's live registry — the same liveness the rest of the daemon reads.
    const harness = buildHarness({
      tasks: [
        taskRecord({ sessionRefs: [{ stage: 'implementing', appSessionId: EXISTING_SESSION_ID }] }),
      ],
    });
    harness.sessionHost.markLive(EXISTING_SESSION_ID);
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'already-running' });
    expect(result.outcome).toBe('refused');
  });

  it('a task whose past stage run is NO LONGER live spawns again', async () => {
    // The other direction, so `already-running` cannot degrade into "a task that
    // ever ran can never run again".
    const harness = buildHarness({
      tasks: [
        taskRecord({ sessionRefs: [{ stage: 'planning', appSessionId: EXISTING_SESSION_ID }] }),
      ],
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(result.outcome).toBe('spawned');
  });
});

describe('TaskDispatcher — a defer emits NOTHING', () => {
  it('does not spawn and writes no event at all', async () => {
    // Assertion 7. A defer is not a refusal: nothing was denied, nothing changed,
    // and any surface re-derives the identical defer from the same pure function.
    // Eventing here would write one record per attempt for as long as the window
    // stays shut.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt: '2026-07-22T13:00:00.000Z' })),
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'deferred',
      taskId: TASK_ID,
      reason: 'awaiting-meter-reset',
      meterId: 'window-5h',
    });
  });

  it('stays silent across REPEATED attempts — the log cannot fill with non-events', async () => {
    // The reason the silence matters, asserted rather than asserted-about: ten
    // attempts against a shut window produce zero records.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt: '2026-07-22T13:00:00.000Z' })),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await harness.dispatcher.dispatchTask(TASK_ID)).outcome).toBe('deferred');
    }
    expect(harness.emitted).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
  });

  it('a defer for an UNKNOWN reset time is equally silent', async () => {
    // 'reset-time-unknown' — the meter carries no `resetsAt`. Still a schedule
    // question, still not a refusal, still nothing written.
    const harness = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt: null })),
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

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
  it('emits no task_session_attached, does not throw, and reports the host reason', async () => {
    // Assertion 8. The session host already evented its OWN refusal
    // (transition_rejected / preflight-failed), so nothing is double-recorded
    // here — and no `dispatch_refused` is invented, because that enum is the
    // DECISION vocabulary and this decision was `spawn`.
    const harness = buildHarness();
    harness.sessionHost.refuseNextSpawn('preflight-failed');

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'spawn-failed',
      taskId: TASK_ID,
      reason: 'preflight-failed',
    });
  });

  it('survives a session host that THROWS', async () => {
    // A dispatcher that throws is a dispatcher that has silently stopped.
    const harness = buildHarness();
    harness.sessionHost.throwOnSpawn(new Error('adapter exploded'));

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

    expect(harness.emitted).toEqual([]);
    expect(result!.outcome).toBe('spawn-failed');
    expect(result).toMatchObject({ reason: 'spawn-threw:adapter exploded' });
  });
});

describe('TaskDispatcher — unknown task', () => {
  it('does not spawn, emits nothing, and never throws', async () => {
    // Assertion 9. No `dispatch_refused` either: writing one would introduce a
    // taskId to the tasks stream that no `task_created` ever introduced.
    const harness = buildHarness();
    const result = await dispatchWithoutRejecting(harness.dispatcher, 'task-that-does-not-exist');

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({ outcome: 'unknown-task', taskId: 'task-that-does-not-exist' });
  });
});

describe('TaskDispatcher — the isolation scope boundary (D32 vs step 8)', () => {
  it('DOCUMENTS THE GAP: an isolation:worktree task currently runs in projectRoot', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
    expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
  });

  it('resolves shared-dir to the same projectRoot — the two isolations are INDISTINGUISHABLE today', async () => {
    // The blunt statement of the gap: the field is read, carried through the
    // decision, and then changes nothing about where the worker runs.
    const sharedDirHarness = buildHarness({ tasks: [taskRecord({ isolation: 'shared-dir' })] });
    await sharedDirHarness.dispatcher.dispatchTask(TASK_ID);
    const worktreeHarness = buildHarness({ tasks: [taskRecord({ isolation: 'worktree' })] });
    await worktreeHarness.dispatcher.dispatchTask(TASK_ID);

    expect(worktreeHarness.sessionHost.spawnCalls).toEqual(sharedDirHarness.sessionHost.spawnCalls);
  });

  it('an injected resolveWorkingDirectory overrides the default — the step-8 seam', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]!.isolation).toBe('worktree');
    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: `/var/lib/vimes/worktrees/${TASK_ID}` },
    ]);
    expect(result).toMatchObject({ cwd: `/var/lib/vimes/worktrees/${TASK_ID}` });
  });
});

describe('TaskDispatcher — the injected clock is the ONLY time source', () => {
  it('decides against nowIso, not the wall clock (the reset boundary proves it)', async () => {
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
    expect((await beforeReset.dispatcher.dispatchTask(TASK_ID)).outcome).toBe('deferred');

    const afterReset = buildHarness({
      tasks: [taskRecord({ gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt, observedAt: '2050-01-01T00:00:30.000Z' })),
      nowIso: '2050-01-01T00:01:00.000Z',
    });
    expect((await afterReset.dispatcher.dispatchTask(TASK_ID)).outcome).toBe('spawned');
  });

  it('reads the clock through the injected seam on every attempt', async () => {
    const harness = buildHarness();
    expect(harness.nowIsoCallCount()).toBe(0);
    await harness.dispatcher.dispatchTask(TASK_ID);
    expect(harness.nowIsoCallCount()).toBe(1);
  });

  it('is deterministic: the same inputs produce byte-identical results and events', async () => {
    // Assertion 11, second half. Two independently-built harnesses with the same
    // fixed clock produce the same decision and the same event payloads.
    const buildAndDispatch = async (): Promise<{ result: unknown; emitted: EventInput[] }> => {
      const harness = buildHarness({
        tasks: [taskRecord({ gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } } })],
        meters: metersStateWith(meterRecord({ percent: 40 })),
      });
      return { result: await harness.dispatcher.dispatchTask(TASK_ID), emitted: harness.emitted };
    };
    const firstRun = await buildAndDispatch();
    const secondRun = await buildAndDispatch();
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
  it('resumes the author, calls spawnSession ZERO times, and attaches the session to the new stage', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

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

  it('resumes the MOST RECENT author when the task has been round the loop twice', async () => {
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
    await harness.dispatcher.dispatchTask(TASK_ID);
    expect(harness.sessionHost.resumeCalls).toEqual([SECOND_HOT_AUTHOR_SESSION_ID]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
  });

  it('a FIRST-PASS implementing task still spawns — the resume is not unconditional', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result.outcome).toBe('spawned');
  });

  it('does NOT resolve a working directory for a resume — the author keeps its own cwd', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(resolverCalls).toEqual([]);
    expect(result).not.toHaveProperty('cwd');
  });
});

describe('TaskDispatcher — THE INDEPENDENCE RULE, executed', () => {
  it('a review spawns a session that is NOT any implementing session on the task', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

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

  it('never resumes for a review even when the author is the ONLY session on the task', async () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'review', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'spawned', stage: 'review' });
  });
});

describe('TaskDispatcher — a refused resume is an EXECUTION outcome, not a decision', () => {
  it('emits no task_session_attached, does not throw, and reports the host reason', async () => {
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

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

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

  it('I11 IS THE BACKSTOP: a host that refuses a live session is honoured even if the decision missed it', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result.outcome).toBe('resume-failed');
    expect(harness.emitted).toEqual([]);
  });

  it('survives a session host that THROWS on resume', async () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.throwOnResume(new Error('adapter exploded'));

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

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

  it('the DEFAULT composer sends nothing at all, on both the spawn and the resume path', async () => {
    // Assertion 10, first half — and this is the whole of today's behaviour.
    const spawnHarness = buildHarness();
    await spawnHarness.dispatcher.dispatchTask(TASK_ID);
    expect(spawnHarness.sessionHost.sendCalls).toEqual([]);

    const resumeHarness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    await resumeHarness.dispatcher.dispatchTask(TASK_ID);
    expect(resumeHarness.sessionHost.sendCalls).toEqual([]);
  });

  it('sends the composed string EXACTLY ONCE to the spawned session', async () => {
    const composerCalls: Array<{ taskId: string; mode: string }> = [];
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'review' })],
      composeStageInstruction: (task, plan) => {
        composerCalls.push({ taskId: task.taskId, mode: plan.mode });
        return STUB_INSTRUCTION;
      },
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(composerCalls).toEqual([{ taskId: TASK_ID, mode: 'spawn' }]);
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: STUB_INSTRUCTION },
    ]);
    expect(result).toMatchObject({ outcome: 'spawned', instructionDelivery: { status: 'sent' } });
  });

  it('sends the composed string EXACTLY ONCE to the RESUMED session', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(composerCalls).toEqual([`resume:${HOT_AUTHOR_SESSION_ID}`]);
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: HOT_AUTHOR_SESSION_ID, text: STUB_INSTRUCTION },
    ]);
    expect(result).toMatchObject({ outcome: 'resumed', instructionDelivery: { status: 'sent' } });
  });

  it('sends NOTHING when the composer returns null or an empty string', async () => {
    // An empty send would still cost a turn and would read to the agent as a
    // prompt, so empty and null are the same instruction: none.
    for (const composed of [null, ''] as const) {
      const harness = buildHarness({ composeStageInstruction: () => composed });
      const result = await harness.dispatcher.dispatchTask(TASK_ID);
      expect(harness.sessionHost.sendCalls).toEqual([]);
      // ...and the result carries no delivery field at all, so the default path's
      // envelope is byte-identical to step 4a's.
      expect(result).not.toHaveProperty('instructionDelivery');
    }
  });

  it('is never consulted at all when nothing runs — a refusal receives no brief', async () => {
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
    expect((await harness.dispatcher.dispatchTask(TASK_ID)).outcome).toBe('refused');
    expect(composerCallCount).toBe(0);
    expect(harness.sessionHost.sendCalls).toEqual([]);
  });

  it('a refused or throwing send is REPORTED, never swallowed — and never unwinds the dispatch', async () => {
    // A stage run that silently never received its brief looks like a working
    // dispatch and behaves like an idle agent. But the session exists and is
    // attached, so the dispatch itself still succeeded: un-attaching it would
    // leave a live session the task no longer references.
    const refusedHarness = buildHarness({ composeStageInstruction: () => STUB_INSTRUCTION });
    refusedHarness.sessionHost.refuseNextSend('session-dead');
    const refusedResult = await refusedHarness.dispatcher.dispatchTask(TASK_ID);
    expect(refusedResult).toMatchObject({
      outcome: 'spawned',
      instructionDelivery: { status: 'not-delivered', reason: 'session-dead' },
    });
    expect(eventTypes(refusedHarness.emitted)).toEqual([EVENT_TYPES.taskSessionAttached]);

    const throwingHarness = buildHarness({ composeStageInstruction: () => STUB_INSTRUCTION });
    throwingHarness.sessionHost.throwOnSend(new Error('transport gone'));
    const thrownResult = await dispatchWithoutRejecting(throwingHarness.dispatcher, TASK_ID);
    expect(thrownResult).toMatchObject({
      instructionDelivery: { status: 'not-delivered', reason: 'send-threw:transport gone' },
    });
  });

  it('a THROWING composer cannot take the dispatcher down', async () => {
    const harness = buildHarness({
      composeStageInstruction: () => {
        throw new Error('composer exploded');
      },
    });
    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);
    expect(harness.sessionHost.sendCalls).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'spawned',
      instructionDelivery: { status: 'not-delivered', reason: 'compose-threw:composer exploded' },
    });
  });
});

describe('TaskDispatcher — step 7 changes nothing about WHETHER a stage runs', () => {
  it('I10 STILL HOLDS AGAINST A RESUMABLE TASK: a failed gate reaches neither spawn NOR resume', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]!.payload).toEqual({ taskId: TASK_ID, reason: 'headroom-insufficient' });
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'headroom-insufficient' });
  });

  it('already-running still refuses a task whose author is LIVE — before any resume is attempted', async () => {
    // `decideDispatch`'s guard, unchanged: a live author is not a resume candidate,
    // it is an in-flight run. The host's I11 refusal would also catch this; the
    // point is that we never get that far.
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.markLive(HOT_AUTHOR_SESSION_ID);
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'already-running' });
  });

  it('a defer is still silent and still touches neither call', async () => {
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
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.emitted).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result.outcome).toBe('deferred');
  });

  it('a non-dispatchable stage still refuses, even holding an implementing ref', async () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'done', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'stage-not-dispatchable' });
  });

  it('the resume path is deterministic too — identical inputs, identical results and events', async () => {
    const buildAndDispatch = async (): Promise<{ result: unknown; emitted: EventInput[] }> => {
      const harness = buildHarness({
        tasks: [
          taskRecord({
            stage: 'implementing',
            sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
          }),
        ],
      });
      return { result: await harness.dispatcher.dispatchTask(TASK_ID), emitted: harness.emitted };
    };
    expect(JSON.stringify(await buildAndDispatch())).toBe(JSON.stringify(await buildAndDispatch()));
  });
});

// ─── slice 6 step 8 — isolation: BUILT, WIRED, AND SHIPPED OFF ───────────────
//
// ⚠ **NOT ONE REAL GIT COMMAND RUNS BELOW, AND NO WORKTREE IS EVER CREATED.** The
// harness builds a real `WorktreeManager` over a RECORDING FAKE git runner. This
// file lives inside the vimes checkout; a test that actually created a worktree
// would leave one in the repository being developed.
//
// The four cases in the first block are the shipping promise. The flag defaults to
// OFF, and with it off this dispatcher is byte-identical to step 7's — which is why
// the `describe` above ("the isolation scope boundary (D32 vs step 8)") still holds
// verbatim, with its expectations untouched.

describe('TaskDispatcher — assertion 8: with the flag OFF, NOTHING changed', () => {
  it('a worktree task still resolves to projectRoot and issues NO GIT COMMAND AT ALL', () => {
    // ⚠ THE SECOND HALF IS THE LOAD-BEARING ONE. "It span up in projectRoot" would
    // also be true of an implementation that made a worktree and then ignored it, or
    // that consulted git and fell back. Zero git calls is the proof that the whole
    // isolation path is unreachable while the flag is off.
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      // A manager IS present — the same shape app.ts wires — and the flag is not
      // named, i.e. it takes its default.
      withWorktreeManager: true,
    });

    return harness.dispatcher.dispatchTask(TASK_ID).then((result) => {
      expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
      expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
      expect(harness.worktreeCalls()).toEqual([]);
      expect(harness.gitCalls()).toEqual([]);
      // And no worktree event, so the tasks stream is byte-identical too.
      expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.taskSessionAttached]);
    });
  });

  it('the flag set EXPLICITLY to false is the same world', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      withWorktreeManager: true,
      worktreeIsolationEnabled: false,
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
    expect(harness.gitCalls()).toEqual([]);
  });

  it('the DEFAULT resolver is still `projectRootWorkingDirectory`, unchanged', () => {
    // The function step 4a exported and pinned. Step 8 did not touch it, and the
    // flag-off world is entirely made of it.
    expect(projectRootWorkingDirectory(taskRecord({ isolation: 'worktree' }))).toBe(PROJECT_ROOT);
    expect(projectRootWorkingDirectory(taskRecord({ isolation: 'shared-dir' }))).toBe(PROJECT_ROOT);
  });

  it('WIRED AS app.ts WIRES IT, from a default env: still projectRoot, still no git', async () => {
    // ⚠ The link between the config default and the dispatcher, asserted rather than
    // assumed. The expression below is the SAME ONE app.ts evaluates
    // (`config.worktreeIsolation === 'on'`), fed by a default environment — so a
    // config default that flipped to `on` reddens HERE as well as in the config
    // test, and the two halves of the shipping promise cannot drift apart.
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      withWorktreeManager: true,
      worktreeIsolationEnabled: loadConfigFromEnv({}).worktreeIsolation === 'on',
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
    expect(harness.gitCalls()).toEqual([]);
    expect(harness.worktreeCalls()).toEqual([]);
  });

  it('an injected resolveWorkingDirectory still wins while the flag is off', async () => {
    // Step 4a's seam, still the only thing that decides the cwd in the off world.
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      withWorktreeManager: true,
      resolveWorkingDirectory: () => '/injected/elsewhere',
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toMatchObject({ cwd: '/injected/elsewhere' });
    expect(harness.gitCalls()).toEqual([]);
  });
});

describe('TaskDispatcher — assertion 9: flag ON + worktree isolation', () => {
  it('spawns in the WORKTREE and emits task_worktree_created BEFORE the spawn', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      withWorktreeManager: true,
      worktreeIsolationEnabled: true,
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    // The session runs in the worktree, not the project root.
    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: WORKTREE_PATH }]);
    expect(result).toMatchObject({ outcome: 'spawned', cwd: WORKTREE_PATH });

    // ⚠ ORDER IS THE ASSERTION, not merely presence. The directory exists before
    // the session does; recording it afterwards would leave a window in which an
    // agent is running somewhere the log has never mentioned.
    expect(eventTypes(harness.emitted)).toEqual([
      EVENT_TYPES.taskWorktreeCreated,
      EVENT_TYPES.taskSessionAttached,
    ]);
    const worktreeEvent = harness.emitted[0]!;
    expect(worktreeEvent.stream).toBe('tasks');
    expect(worktreeEvent.payload).toEqual({
      taskId: TASK_ID,
      path: WORKTREE_PATH,
      branch: WORKTREE_BRANCH,
      // D32's cost measurement, from the INJECTED clock — deterministic here.
      setupMs: WORKTREE_SETUP_STEP_MS,
    });

    // And the git the manager actually ran: list, then add with the `--` guard.
    expect(harness.gitCalls()).toEqual([
      ['worktree', 'list', '--porcelain'],
      ['worktree', 'add', '-b', WORKTREE_BRANCH, '--', WORKTREE_PATH],
    ]);
  });

  it('a RESUME still keeps the author’s own cwd — no worktree is resolved', async () => {
    // I3/D6, unchanged by isolation: `resumeSession` takes no cwd, and the author is
    // already sitting IN its worktree because that is where it was spawned. Resolving
    // one here would imply a move the host cannot perform.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          isolation: 'worktree',
          stage: 'implementing',
          sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
        }),
      ],
      withWorktreeManager: true,
      worktreeIsolationEnabled: true,
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toMatchObject({ outcome: 'resumed' });
    expect(result).not.toHaveProperty('cwd');
    expect(harness.worktreeCalls()).toEqual([]);
    expect(harness.gitCalls()).toEqual([]);
  });
});

describe('TaskDispatcher — assertion 10: flag ON + shared-dir is still projectRoot', () => {
  it('runs in projectRoot, consults no manager, and issues no git', async () => {
    // D32 kept the per-task override precisely so a cost surprise is a config change
    // rather than a redesign. `shared-dir` means what it says even with the flag on.
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'shared-dir' })],
      withWorktreeManager: true,
      worktreeIsolationEnabled: true,
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: PROJECT_ROOT }]);
    expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
    expect(harness.worktreeCalls()).toEqual([]);
    expect(harness.gitCalls()).toEqual([]);
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.taskSessionAttached]);
  });
});

describe('TaskDispatcher — ASSERTION 11, THE SAFETY ONE: a failed worktree runs NOTHING', () => {
  // ⚠ **THE POINT OF THIS ENTIRE STEP IS IN THIS BLOCK.** A failed worktree must
  // never fall back to `task.projectRoot`. The fallback is the tempting fix and it
  // is the bug: an isolated task quietly sharing the project directory with whatever
  // else is running there is exactly the concurrency hazard isolation exists to
  // remove, and the log would be indistinguishable from a healthy dispatch.
  //
  // Every case below therefore asserts the ABSENCE of the fallback directly —
  // `PROJECT_ROOT` must not appear in any spawn call, in any event, or in the result
  // — rather than only asserting that the outcome says `worktree-failed`.

  const WORKTREE_FAILURES: ReadonlyArray<{ name: string; response: GitRunResult }> = [
    { name: 'git missing', response: { stdout: '', stderr: 'spawn git ENOENT', exitCode: null } },
    {
      name: 'not a repo',
      response: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 },
    },
    {
      name: 'permission denied',
      response: { stdout: '', stderr: 'fatal: could not create directory: Permission denied', exitCode: 128 },
    },
  ];

  for (const { name, response } of WORKTREE_FAILURES) {
    it(`${name}: zero spawns, no attach, worktree-failed, and NEVER projectRoot`, async () => {
      const harness = buildHarness({
        tasks: [taskRecord({ isolation: 'worktree' })],
        worktreeIsolationEnabled: true,
        worktreeFailure: response,
      });
      const result = await harness.dispatcher.dispatchTask(TASK_ID);

      // 1. NOTHING RAN. Not in the worktree, not in the project root, not anywhere.
      expect(harness.sessionHost.spawnCalls).toHaveLength(0);
      expect(harness.sessionHost.resumeCalls).toEqual([]);
      // 2. NO `task_session_attached` — there is no session to attach — and no
      //    `task_worktree_created`, because nothing was created.
      expect(harness.emitted).toEqual([]);
      // 3. The outcome names what happened, in the EXECUTION vocabulary.
      expect(result.outcome).toBe('worktree-failed');
      expect(result).toMatchObject({ taskId: TASK_ID });
      // 4. ⚠ THE FALLBACK IS ABSENT, asserted three ways.
      for (const spawnCall of harness.sessionHost.spawnCalls) {
        expect(spawnCall.cwd).not.toBe(PROJECT_ROOT);
      }
      expect(result).not.toHaveProperty('cwd');
      expect(JSON.stringify(result)).not.toContain(PROJECT_ROOT);
    });
  }

  it('carries the manager’s classified reason AND git’s own words', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      worktreeIsolationEnabled: true,
      worktreeFailure: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 },
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toEqual({
      outcome: 'worktree-failed',
      taskId: TASK_ID,
      reason: 'not-a-repo:fatal: not a git repository',
    });
  });

  it('the flag ON with NO manager is a FAILURE, not a silent downgrade to projectRoot', async () => {
    // A daemon wired inconsistently must not quietly resolve "isolate this" plus "no
    // isolator" into "run it in the shared directory and say nothing".
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      worktreeIsolationEnabled: true,
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toEqual({
      outcome: 'worktree-failed',
      taskId: TASK_ID,
      reason: 'worktree-isolation-enabled-without-a-manager',
    });
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.emitted).toEqual([]);
  });

  it('survives a manager that THROWS, and still refuses to fall back', async () => {
    // The manager's contract is a returned result, but a dispatcher must survive its
    // adapters regardless — and surviving must not mean "carry on in projectRoot".
    const emitted: EventInput[] = [];
    const sessionHost = new RecordingSessionHost();
    const dispatcher = new TaskDispatcher({
      sessionHost,
      emit: (events) => {
        emitted.push(...events);
      },
      readTasks: () => ({ tasks: { [TASK_ID]: taskRecord({ isolation: 'worktree' }) } }),
      readMeters: () => metersStateWith(meterRecord()),
      nowIso: () => FIXED_NOW,
      staleAfterMs: STALE_AFTER_MS,
      worktreeIsolationEnabled: true,
      worktreeManager: {
        ensureWorktree: () => {
          throw new Error('manager exploded');
        },
      },
    });

    const result = await dispatchWithoutRejecting(dispatcher, TASK_ID);

    expect(result).toMatchObject({
      outcome: 'worktree-failed',
      reason: 'worktree-threw:manager exploded',
    });
    expect(sessionHost.spawnCalls).toHaveLength(0);
    expect(emitted).toEqual([]);
  });

  it('a REUSED worktree spawns normally and emits NO creation event', async () => {
    // Idempotence seen from the dispatcher. A re-dispatch finds the directory it
    // already has; `task_worktree_created` would be an untrue fact in an append-only
    // log, and a near-zero reading poisoning D32's setup-cost column.
    const existingWorktreeList = [
      `worktree ${PROJECT_ROOT}`,
      'HEAD 81ddf1600000000000000000000000000000000a',
      'branch refs/heads/master',
      '',
      `worktree ${WORKTREE_PATH}`,
      'HEAD 81ddf1600000000000000000000000000000000a',
      `branch refs/heads/${WORKTREE_BRANCH}`,
      '',
      '',
    ].join('\n');
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      worktreeIsolationEnabled: true,
      worktreeFailure: { stdout: existingWorktreeList, stderr: '', exitCode: 0 },
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toMatchObject({ outcome: 'spawned', cwd: WORKTREE_PATH });
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.taskSessionAttached]);
    // One command: the list. No second `add`.
    expect(harness.gitCalls()).toEqual([['worktree', 'list', '--porcelain']]);
  });
});

describe('TaskDispatcher — assertion 13: I10 still holds through the ASYNC path', () => {
  it('a failed headroom gate reaches neither the worktree manager NOR the session host', async () => {
    // ⚠ The invariant that must survive every refactor. Making the path async moved
    // the working-directory resolution behind an `await`, and an implementation that
    // resolved the cwd (creating a worktree — a real directory on a real disk) BEFORE
    // consulting the decision would satisfy every other assertion in this file while
    // doing real work for a task the gate refused.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          isolation: 'worktree',
          gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } },
        }),
      ],
      meters: metersStateWith(meterRecord({ percent: 40 })),
      withWorktreeManager: true,
      worktreeIsolationEnabled: true,
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.worktreeCalls()).toEqual([]);
    expect(harness.gitCalls()).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.dispatchRefused]);
    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'headroom-insufficient' });
  });

  it('a DEFER is still silent and still makes no worktree', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree', gates: { deferUntilReset: 'window-5h' } })],
      meters: metersStateWith(meterRecord({ resetsAt: '2026-07-22T13:00:00.000Z' })),
      withWorktreeManager: true,
      worktreeIsolationEnabled: true,
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result.outcome).toBe('deferred');
    expect(harness.emitted).toEqual([]);
    expect(harness.gitCalls()).toEqual([]);
  });

  it('an UNKNOWN task makes no worktree either', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ isolation: 'worktree' })],
      withWorktreeManager: true,
      worktreeIsolationEnabled: true,
    });
    const result = await harness.dispatcher.dispatchTask('task-that-does-not-exist');

    expect(result).toEqual({ outcome: 'unknown-task', taskId: 'task-that-does-not-exist' });
    expect(harness.gitCalls()).toEqual([]);
  });

  it('already-running still refuses BEFORE any worktree is made', async () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({
          isolation: 'worktree',
          sessionRefs: [{ stage: 'planning', appSessionId: EXISTING_SESSION_ID }],
        }),
      ],
      withWorktreeManager: true,
      worktreeIsolationEnabled: true,
    });
    harness.sessionHost.markLive(EXISTING_SESSION_ID);
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toEqual({ outcome: 'refused', taskId: TASK_ID, reason: 'already-running' });
    expect(harness.gitCalls()).toEqual([]);
  });

  it('the isolated path is DETERMINISTIC — identical inputs, identical results and events', async () => {
    const buildAndDispatch = async (): Promise<{ result: unknown; emitted: EventInput[] }> => {
      const harness = buildHarness({
        tasks: [taskRecord({ isolation: 'worktree' })],
        withWorktreeManager: true,
        worktreeIsolationEnabled: true,
      });
      return { result: await harness.dispatcher.dispatchTask(TASK_ID), emitted: harness.emitted };
    };
    expect(JSON.stringify(await buildAndDispatch())).toBe(JSON.stringify(await buildAndDispatch()));
  });
});
