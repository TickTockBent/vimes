import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryArtifactStore,
  MemoryEventStore,
  RETIRED_EVENT_KINDS,
  SteppingClock,
  readAllStreamsGrouped,
  replayFromEmpty,
  // S11·U1 (D72 Move 2): the fold is the INSTANCE store now; every task-shaped
  // read below goes through `legacyTasksViewOf`, which is where the shape these
  // assertions speak lives. The subjects under test (writer/dispatcher/api/tool)
  // are untouched by the rename — that is what these unchanged assertions prove.
  canonicalJson,
  instancesProjection,
  legacyTasksViewOf,
  taskCreated,
  taskSessionAttached,
  type EventInput,
  type MeterRecord,
  type MetersState,
  type TaskRecord,
  type TasksState,
  type TaskStage,
  type TransitionProposal,
} from '@vimes/core';
import type { ResumeResult, SendResult, SpawnResult } from './sessionHost.js';
import { InstanceWriter, type ProposeMoveResult } from './instanceWriter.js';
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
// `Pick<SessionHost, 'spawnSession' | 'isLive' | 'sendMessage'>`; the real class is
// never constructed and never imported at runtime (the result-type imports above
// are type-only).
//
// ⚠ S7·7b (D46): the dispatcher's Pick no longer includes `resumeSession`, but this
// fake DELIBERATELY STILL IMPLEMENTS IT. It is now a TRIPWIRE rather than a
// collaborator: an extra method is harmless structurally, and `resumeCalls` staying
// empty across the whole suite is the assertable form of "the dispatcher cannot
// resume anything". Delete it and the inversion stops being provable.
class RecordingSessionHost {
  readonly spawnCalls: Array<{
    channel: 'sdk' | 'pty';
    cwd: string;
    name?: string;
    permissionMode?: 'plan' | 'auto';
    dispatched?: boolean;
    // S7·7d: recorded because the stage is what the host maps to a report-tool
    // offer — a dispatch that forgets it silently re-widens the exposure.
    stage?: TaskStage;
  }> = [];
  // Step 7's instruments, INVERTED BY D46. `resumeCalls` used to prove a fix went
  // to the hot author; it now proves the opposite — it must stay EMPTY on every
  // path, forever.
  readonly resumeCalls: string[] = [];
  readonly sendCalls: Array<{ appSessionId: string; text: string }> = [];
  private nextSpawnResult: SpawnResult = { appSessionId: SPAWNED_SESSION_ID };
  private nextResumeResult: ResumeResult | null = null;
  private nextSendResult: SendResult = { ok: true };
  private spawnThrows: Error | null = null;
  private resumeThrows: Error | null = null;
  private sendThrows: Error | null = null;
  private readonly liveSessionIds = new Set<string>();

  spawnSession(options: {
    channel: 'sdk' | 'pty';
    cwd: string;
    name?: string;
    permissionMode?: 'plan' | 'auto';
    dispatched?: boolean;
    stage?: TaskStage;
  }): SpawnResult {
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

// An instance writer that RECORDS its `proposeMove` calls instead of touching
// the log. It is the instrument for S7·5b-i's I10 assertion: `recordPlan` must move
// the task to `plan-ready` THROUGH this seam (I7's choke point), never by emitting an
// `instance_moved` itself. `proposeMoveCalls.length` alongside the emitted
// events is what proves which of the two happened. Structurally satisfies
// `Pick<InstanceWriter, 'proposeMove'>`; the real class is never constructed.
class RecordingInstanceWriter {
  // Each call also captures how many events had been emitted at the moment it ran,
  // which is the ordering evidence for `recordPlan`'s store → emit → move
  // contract: a move proposed AFTER the `capture_recorded` emit sees a count of 1.
  readonly proposeMoveCalls: Array<{
    taskId: string;
    proposal: TransitionProposal;
    emittedCountBefore: number;
  }> = [];

  constructor(private readonly emittedCount: () => number = () => 0) {}

  proposeMove(taskId: string, proposal: TransitionProposal): ProposeMoveResult {
    this.proposeMoveCalls.push({ taskId, proposal, emittedCountBefore: this.emittedCount() });
    // recordPlan ignores the return value — the move's OWN outcome is the
    // writer's business and is asserted in instanceWriter.test.ts, not here. A fixed
    // stub keeps this fake from re-implementing the state machine.
    return { outcome: 'unknown-task', taskId };
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
  // S7·5b-i instruments. The real in-memory artifact store `recordPlan` writes to
  // (so a test can fetch the stored plan back by the returned hash), and the
  // recording task writer that proves the transition went through I7's choke point.
  artifactStore: MemoryArtifactStore;
  instanceWriter: RecordingInstanceWriter;
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
  // S7·7c. A manager supplied WHOLE, replacing the git-backed one, so a case can
  // hold `ensureWorktree` open on a promise it releases by hand. That is the only
  // way to make the D54 window — the `await` between the decision and
  // `instance_run_attached` — wide enough to assert against rather than a
  // microtask nobody can stand inside.
  worktreeManagerOverride?: Pick<WorktreeManager, 'ensureWorktree'>;
} = {}): Harness {
  const sessionHost = new RecordingSessionHost();
  const artifactStore = new MemoryArtifactStore();
  const emitted: EventInput[] = [];
  const recordingInstanceWriter = new RecordingInstanceWriter(() => emitted.length);
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
    options.worktreeManagerOverride ??
    (realManager === undefined
      ? undefined
      : {
          ensureWorktree: (task: TaskRecord) => {
            worktreeCalls.push(task.taskId);
            return realManager.ensureWorktree(task);
          },
        });

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
    // S7·5b-i: the two deps `recordPlan` writes through. REQUIRED (no default),
    // so every construction of the dispatcher — including every case above — now
    // carries them; the fakes are inert on the dispatch path (nothing there calls
    // recordPlan), so no prior assertion moves.
    artifactStore,
    instanceWriter: recordingInstanceWriter,
  };
  return {
    dispatcher: new TaskDispatcher(deps),
    sessionHost,
    emitted,
    artifactStore,
    instanceWriter: recordingInstanceWriter,
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
  it('spawns exactly once in the resolved cwd and emits exactly one instance_run_attached', async () => {
    // Assertion 5.
    const harness = buildHarness();
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage: 'implementing' },
    ]);
    expect(harness.emitted).toHaveLength(1);
    const attachEvent = harness.emitted[0]!;
    expect(attachEvent.type).toBe(EVENT_TYPES.instanceRunAttached);
    expect(attachEvent.stream).toBe('tasks');
    expect(attachEvent.payload).toEqual({
      instanceId: TASK_ID,
      node: 'implementing',
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
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceRunAttached]);
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
  it('emits no instance_run_attached, does not throw, and reports the host reason', async () => {
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

    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage: 'implementing' },
    ]);
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
      {
        channel: 'sdk',
        cwd: `/var/lib/vimes/worktrees/${TASK_ID}`,
        dispatched: true,
        permissionMode: 'auto',
        stage: 'implementing',
      },
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

// ⚠ **D46 INVERSION (S7·7b) — THIS WHOLE DESCRIBE IS A RECORDED REVERSAL.** It was
// `TaskDispatcher — the FIX LOOP resumes the hot author`, and every case below
// asserted a resume. D46 killed `mode:'resume'` for stage runs on two independent
// grounds (one transcript must never straddle two attempts; an author resumed with
// its own review feedback defends its original approach) — so a fix now SPAWNS a
// stranger, exactly like a first pass, and carries its context in the FIX-SEED
// instead. The cases are KEPT IN PLACE with their setups unchanged and their
// expectations flipped, so the reversal reads as a reversal in the diff rather than
// disappearing with a deleted block. See stageRunner.ts for D46's own argument.
describe('TaskDispatcher — D46 INVERSION: the FIX LOOP spawns FRESH (was: resumes the hot author)', () => {
  it('spawns a FRESH session, calls resumeSession ZERO times, and attaches the NEW session', async () => {
    // Assertion 7, inverted. The task went implementing → review → implementing, so
    // the work already HAS an author and that author is cache-warm — and D46 says
    // that is exactly the session which must not do the fix.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
        }),
      ],
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    // ⚠ THE LOAD-BEARING LINE. The hot author is never touched.
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage: 'implementing' },
    ]);

    // The attach names the NEW session, not the author — this is what makes the
    // next attempt's `attempt` count (recordCompletion) a true count of attempts.
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]!.type).toBe(EVENT_TYPES.instanceRunAttached);
    expect(harness.emitted[0]!.stream).toBe('tasks');
    expect(harness.emitted[0]!.payload).toEqual({
      instanceId: TASK_ID,
      node: 'implementing',
      appSessionId: SPAWNED_SESSION_ID,
    });
    // A SPAWN result, which — unlike the old `resumed` — carries a resolved `cwd`.
    expect(result).toEqual({
      outcome: 'spawned',
      taskId: TASK_ID,
      stage: 'implementing',
      appSessionId: SPAWNED_SESSION_ID,
      cwd: PROJECT_ROOT,
    });
  });

  it('round the loop TWICE still spawns — the most-recent author is not special either', async () => {
    // Was: "resumes the MOST RECENT author when the task has been round the loop
    // twice". The setup is untouched; the ref trail is simply no longer consulted.
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
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
  });

  it('a FIRST-PASS implementing task spawns too — the two are now INDISTINGUISHABLE', async () => {
    // This case survives D46 unflipped, and its meaning changed: it used to prove
    // "the resume is not unconditional", and now it proves that a first pass and a
    // fix produce the SAME dispatch. What separates them is the fix-seed in the
    // briefing, not the session decision.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [{ stage: 'planning', appSessionId: EXISTING_SESSION_ID }],
        }),
      ],
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage: 'implementing' },
    ]);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(result.outcome).toBe('spawned');
  });

  it('DOES resolve a working directory for a fix — cwd resolution is no longer skipped', async () => {
    // Was: "does NOT resolve a working directory for a resume — the author keeps
    // its own cwd". That was true because `resumeSession` takes no cwd (I3). A fix
    // now spawns, so it goes through the SAME `resolveWorkingDirectory` seam as any
    // other spawn — and the result carries the resolved `cwd` the old `resumed`
    // outcome deliberately omitted.
    const resolverCalls: TaskRecord[] = [];
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
      resolveWorkingDirectory: (task) => {
        resolverCalls.push(task);
        return '/var/lib/vimes/worktrees/task-under-fix';
      },
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]!.taskId).toBe(TASK_ID);
    expect(result).toHaveProperty('cwd', '/var/lib/vimes/worktrees/task-under-fix');
    expect(harness.sessionHost.spawnCalls[0]!.cwd).toBe('/var/lib/vimes/worktrees/task-under-fix');
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

    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage: 'review' },
    ]);
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
      instanceId: TASK_ID,
      node: 'review',
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

// ⚠ **D46 INVERSION (S7·7b).** Was `a refused resume is an EXECUTION outcome, not a
// decision` — assertion 9, the `resume-failed` mirror of `spawn-failed`. The
// dispatcher has no resume path left, so a FIX that fails to start fails the way
// every other dispatch fails: `spawn-failed`. The three scenarios are kept because
// what they really guard is FIX-PATH specific and still true — a failed fix must
// not fall back, must not event, and must not touch the prior author.
describe('TaskDispatcher — a fix that cannot start is a spawn-failure (D46 inversion)', () => {
  it('emits no instance_run_attached, does not throw, and reports the host reason', async () => {
    // The host already evented its own refusal (a preflight rejection, typically),
    // so nothing is double-recorded — and no `dispatch_refused` is invented, because
    // that enum is the DECISION vocabulary and this decision was to run the stage.
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.refuseNextSpawn('no credentials');

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

    // ⚠ NO FALLBACK TO THE AUTHOR. A failed fix spawn must not silently become
    // "resume the person who wrote it after all" — that would reinstate D46's
    // reversal through the error path, which is the quietest way to lose a decision.
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'spawn-failed',
      taskId: TASK_ID,
      reason: 'no credentials',
    });
  });

  it('a task whose AUTHOR IS LIVE is refused at decision time — the one remaining guard', async () => {
    // ⚠ WAS "I11 IS THE BACKSTOP". Pre-D46 there were TWO independent guards on a
    // fix: `decideDispatch`'s `already-running` (the dispatcher's view of liveness)
    // and `SessionHost.resumeSession`'s own I11 refusal at the instant of the call.
    // **D46 REMOVED THE SECOND ONE FROM THIS PATH** — a fresh spawn has no existing
    // session to collide with, so there is nothing for I11 to refuse, and the
    // `already-running` decision is now the ONLY thing standing between a live
    // implementer and a second concurrent one. That is a real reduction in
    // defence-in-depth, recorded here rather than left to be rediscovered; it is not
    // a regression D46 overlooked, because the hazard changed shape (double-resume
    // of one session → two sessions on one task) and only a lock fully closes the
    // new one. There is still no scheduler and no lock (see `dispatchTask`'s note).
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.markLive(HOT_AUTHOR_SESSION_ID);

    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toMatchObject({ outcome: 'refused', reason: 'already-running' });
    expect(harness.sessionHost.spawnCalls).toHaveLength(0);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
  });

  it('resumeSession is UNREACHABLE — a fix runs clean even with the resume rigged to throw', async () => {
    // Was "survives a session host that THROWS on resume". The strongest available
    // form of the inversion: the fake's resume is armed with a bomb, and the
    // dispatch succeeds — which can only happen if nothing on this path calls it.
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    harness.sessionHost.throwOnResume(new Error('this must never be reached'));

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

    expect(result).toMatchObject({ outcome: 'spawned', appSessionId: SPAWNED_SESSION_ID });
    expect(harness.sessionHost.resumeCalls).toEqual([]);
  });
});

describe('TaskDispatcher — the instruction seam (MACHINERY; the words are deferred)', () => {
  // ⚠ NO PROMPT TEXT IS ASSERTED HERE BEYOND WHAT A TEST ITSELF SUPPLIES. What a
  // review or fix prompt should SAY is Wes's decision and is explicitly out of
  // this step; these cases prove only that a string handed to the seam arrives
  // verbatim, once, and that the DEFAULT is silence.
  const STUB_INSTRUCTION = 'test-only instruction text — not a product prompt';

  it('the DEFAULT composer sends nothing at all, on a first pass and on a fix alike', async () => {
    // Assertion 10, first half — and this is the whole of the default behaviour.
    // (D46: the second harness was "the resume path"; it is a fix, and a fix is a
    // spawn now. The case is kept because the two dispatches still differ — one has
    // a prior author on the record — and both must stay silent by default.)
    const firstPassHarness = buildHarness();
    await firstPassHarness.dispatcher.dispatchTask(TASK_ID);
    expect(firstPassHarness.sessionHost.sendCalls).toEqual([]);

    const fixHarness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
    });
    await fixHarness.dispatcher.dispatchTask(TASK_ID);
    expect(fixHarness.sessionHost.sendCalls).toEqual([]);
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

  it('sends the composed string EXACTLY ONCE to the FIX session — the NEW one, not the author', async () => {
    // ⚠ D46 INVERSION. Was "sends the composed string EXACTLY ONCE to the RESUMED
    // session", and it asserted `mode: 'resume'` + `appSessionId` == the hot author,
    // on the grounds that `plan.mode` was "the only way the composer can brief a
    // returning author differently from a fresh one". There is no returning author;
    // the composer sees `spawn` for a fix exactly as for a first pass, and the brief
    // is sent to the FRESH session. What distinguishes a fix now is the fix-seed in
    // the CONTEXT (asserted in the S7·7b block below), not the plan mode.
    const composerCalls: string[] = [];
    const harness = buildHarness({
      tasks: [
        taskRecord({ stage: 'implementing', sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)] }),
      ],
      composeStageInstruction: (_task, plan) => {
        composerCalls.push(plan.mode);
        return STUB_INSTRUCTION;
      },
    });
    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(composerCalls).toEqual(['spawn']);
    // The brief goes to the session that will do the work. Sending it to
    // HOT_AUTHOR_SESSION_ID would be briefing a session nobody dispatched.
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: STUB_INSTRUCTION },
    ]);
    expect(result).toMatchObject({ outcome: 'spawned', instructionDelivery: { status: 'sent' } });
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
    expect(eventTypes(refusedHarness.emitted)).toEqual([EVENT_TYPES.instanceRunAttached]);

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

// ─── S7·7a: the daemon fetches the plan blob and threads it to the composer ────
//
// The composer is pure and cannot read the artifact store, so the ONE piece of IO
// the fresh-implementer briefing needs — the plan blob by `planArtifactHash` —
// happens in `deliverStageInstruction` and is passed IN as the context. These
// cases pin exactly that threading, using a composer stub that echoes the context
// (the core prose itself is pinned in stageInstruction.test.ts; here we only prove
// the blob reaches the third argument, and never fails the dispatch).
describe('TaskDispatcher — S7·7a plan-blob fetch and threading', () => {
  const SENTINEL_PLAN = 'SENTINEL-PLAN-BLOB — the approved plan text';
  const PLAN_HASH = 'a'.repeat(64);

  // A composer stub that reports what context it received, so the delivered text
  // proves whether the daemon fetched and threaded the plan.
  const echoContextComposer: TaskDispatcherDeps['composeStageInstruction'] = (
    _task,
    _plan,
    context,
  ) => (context?.plan === undefined ? 'NO-PLAN-CONTEXT' : `PLAN:${context.plan}`);

  it('fetches getBlob(planArtifactHash) and threads the blob to the composer (spawn path)', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'implementing', planArtifactHash: PLAN_HASH })],
      composeStageInstruction: echoContextComposer,
    });
    const getBlobHashes: string[] = [];
    harness.artifactStore.getBlob = (hash: string) => {
      getBlobHashes.push(hash);
      return SENTINEL_PLAN;
    };

    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(getBlobHashes).toEqual([PLAN_HASH]);
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: `PLAN:${SENTINEL_PLAN}` },
    ]);
    expect(result).toMatchObject({ outcome: 'spawned', instructionDelivery: { status: 'sent' } });
  });

  it('threads the fetched blob on a FIX dispatch too — the store is consulted once per run', async () => {
    // ⚠ D46 INVERSION. Was "threads the fetched blob on the RESUME path too — both
    // call sites are covered". There is ONE call site now (`deliverStageInstruction`
    // is only reached from the spawn path), so what this case still earns is the
    // fix-specific setup: a task carrying a prior author's ref must fetch and thread
    // its plan exactly like a virgin one, and must do it for the NEW session.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          planArtifactHash: PLAN_HASH,
          sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
        }),
      ],
      composeStageInstruction: echoContextComposer,
    });
    const getBlobHashes: string[] = [];
    harness.artifactStore.getBlob = (hash: string) => {
      getBlobHashes.push(hash);
      return SENTINEL_PLAN;
    };

    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(getBlobHashes).toEqual([PLAN_HASH]);
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: `PLAN:${SENTINEL_PLAN}` },
    ]);
    expect(result).toMatchObject({ outcome: 'spawned', instructionDelivery: { status: 'sent' } });
  });

  it('does NOT consult the store when the task has no planArtifactHash', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'implementing' })],
      composeStageInstruction: echoContextComposer,
    });
    let getBlobCallCount = 0;
    harness.artifactStore.getBlob = () => {
      getBlobCallCount += 1;
      return SENTINEL_PLAN;
    };

    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(getBlobCallCount).toBe(0);
    // The composer ran with no plan context — the daemon never fabricated one.
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: 'NO-PLAN-CONTEXT' },
    ]);
    expect(result.outcome).toBe('spawned');
  });

  it('a present hash whose blob is NULL degrades to the no-plan briefing, never throws', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'implementing', planArtifactHash: PLAN_HASH })],
      composeStageInstruction: echoContextComposer,
    });
    harness.artifactStore.getBlob = () => null;

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

    // getBlob returned null → context is undefined → the briefing degrades, and the
    // dispatch still succeeds. A null blob is a degrade, not a dispatch failure.
    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: 'NO-PLAN-CONTEXT' },
    ]);
    expect(result.outcome).toBe('spawned');
  });

  it('a THROWING getBlob cannot fail the dispatch — it degrades to no plan', async () => {
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'implementing', planArtifactHash: PLAN_HASH })],
      composeStageInstruction: echoContextComposer,
    });
    harness.artifactStore.getBlob = () => {
      throw new Error('store read exploded');
    };

    const result = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);

    expect(harness.sessionHost.sendCalls).toEqual([
      { appSessionId: SPAWNED_SESSION_ID, text: 'NO-PLAN-CONTEXT' },
    ]);
    expect(result.outcome).toBe('spawned');
  });
});

describe('TaskDispatcher — step 7 changes nothing about WHETHER a stage runs', () => {
  it('I10 STILL HOLDS AGAINST A TASK UNDER FIX: a failed gate reaches neither spawn NOR resume', async () => {
    // Assertion 11, and the one worth stating loudest. The task has a prior author
    // sitting right there, which is exactly the shape a "just pick it back up, it is
    // cheap" shortcut would wave through — no continuation is free, it runs a real
    // agent against a real budget. The headroom refusal must precede the runner.
    // (D46 made this MORE true, not less: a fix now pays a full cold spawn.)
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

  it('already-running still refuses a task whose author is LIVE — before anything is attempted', async () => {
    // `decideDispatch`'s guard, unchanged by D46: a live author means an in-flight
    // run, and the refusal precedes the runner. ⚠ The old comment went on to say
    // "the host's I11 refusal would also catch this" — post-D46 it would NOT, because
    // a spawn creates a new session rather than reviving that one. This guard is now
    // load-bearing on its own; see the inversion note in the spawn-failure block.
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

  it('the FIX path is deterministic too — identical inputs, identical results and events', async () => {
    // (Was "the resume path is deterministic too". Same setup, same guarantee — the
    // path underneath it changed, D46.)
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
      expect(harness.sessionHost.spawnCalls).toEqual([
        { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage: 'implementing' },
      ]);
      expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
      expect(harness.worktreeCalls()).toEqual([]);
      expect(harness.gitCalls()).toEqual([]);
      // And no worktree event, so the tasks stream is byte-identical too.
      expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceRunAttached]);
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
    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: WORKTREE_PATH, dispatched: true, permissionMode: 'auto', stage: 'implementing' },
    ]);
    expect(result).toMatchObject({ outcome: 'spawned', cwd: WORKTREE_PATH });

    // ⚠ ORDER IS THE ASSERTION, not merely presence. The directory exists before
    // the session does; recording it afterwards would leave a window in which an
    // agent is running somewhere the log has never mentioned.
    expect(eventTypes(harness.emitted)).toEqual([
      EVENT_TYPES.taskWorktreeCreated,
      EVENT_TYPES.instanceRunAttached,
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

  it('a FIX under isolation goes through the worktree like any other spawn (D46 inversion)', async () => {
    // ⚠ WAS "a RESUME still keeps the author's own cwd — no worktree is resolved",
    // on the I3/D6 grounds that `resumeSession` takes no cwd and the author is
    // already sitting IN its worktree. D46 removed the resume, so a fix spawns — and
    // a spawn under isolation resolves the worktree. `ensureWorktree` is IDEMPOTENT,
    // so the fix lands in the SAME directory the prior attempt used and REUSES it
    // (no creation event); that reuse is what keeps D53's "read the prior attempt's
    // diff off disk" true for an isolated task — the diff is only there if the fixer
    // is in the same worktree.
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

    expect(result).toMatchObject({ outcome: 'spawned', cwd: WORKTREE_PATH });
    expect(harness.sessionHost.spawnCalls[0]!.cwd).toBe(WORKTREE_PATH);
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.worktreeCalls()).toHaveLength(1);
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

    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage: 'implementing' },
    ]);
    expect(result).toMatchObject({ outcome: 'spawned', cwd: PROJECT_ROOT });
    expect(harness.worktreeCalls()).toEqual([]);
    expect(harness.gitCalls()).toEqual([]);
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceRunAttached]);
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
      // 2. NO `instance_run_attached` — there is no session to attach — and no
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
      artifactStore: new MemoryArtifactStore(),
      instanceWriter: new RecordingInstanceWriter(),
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
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceRunAttached]);
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

// ─── S7·5b-ii — the planning stage spawns in permissionMode 'plan' (D48) ──────
//
// The dispatcher's ONLY plan-mode behaviour: a `planning`-stage spawn asks the
// session host for plan mode; every other stage spawns exactly as before. The
// `spawnCalls` spy is the instrument — the presence/absence of `permissionMode`
// on the recorded options is the whole assertion.
//
// S7·7d ADDED THE SECOND HALF: every dispatched spawn also NAMES ITS STAGE, which
// is what lets the host scope the report-tool offer (the host-side map is asserted
// in sessionHost.test.ts). Asserted here on every stage the dispatcher can spawn,
// because `stage` reaching the host wrong is exactly the plumbing bug that would
// re-open the planner gate this unit closed.

describe('TaskDispatcher — planning spawns in plan mode (D48) + every spawn names its stage (S7·7d)', () => {
  it('a planning-stage dispatch passes permissionMode plan AND stage planning to spawnSession', async () => {
    const harness = buildHarness({ tasks: [taskRecord({ stage: 'planning' })] });

    const result = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(result).toMatchObject({ outcome: 'spawned', stage: 'planning' });
    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'plan', stage: 'planning' },
    ]);
  });

  it('implementing / review dispatches set permissionMode "auto" (dispatched classifier footing, spike 2026-07-26) and their own stage', async () => {
    for (const stage of ['implementing', 'review'] as const) {
      const harness = buildHarness({ tasks: [taskRecord({ stage })] });

      const result = await harness.dispatcher.dispatchTask(TASK_ID);

      expect(result).toMatchObject({ outcome: 'spawned', stage });
      // `stage` is the LOOP VARIABLE, not a literal: the point of the case is that
      // the dispatched stage travels through unchanged, so hard-coding one of them
      // would let the other pass on the first one's name.
      expect(harness.sessionHost.spawnCalls).toEqual([
        { channel: 'sdk', cwd: PROJECT_ROOT, dispatched: true, permissionMode: 'auto', stage },
      ]);
    }
  });
});

// ─── S7·5b-i — recordPlan: the DETERMINISTIC I10 core of native plan capture ──
//
// recordPlan is the STATE-OWNING half of the D48 seam. The fragile SDK adapter
// (5b-ii) will only OBSERVE a plan and PROPOSE it back through a callback; THIS
// method does the writing — store the blob, emit `capture_recorded`, propose the
// planning→plan-ready transition THROUGH the task writer (I7's choke point).
//
// The instruments: `harness.artifactStore` (was the blob stored, and under the
// returned hash?), `harness.emitted` (exactly one `capture_recorded`, and — the I10
// point — NO hand-rolled `instance_moved`), and `harness.instanceWriter`
// (`proposeTransitionCalls` proves the transition went through the writer, and
// `emittedCountBefore` proves it went AFTER the emit).

const PLANNER_SESSION_ID = 'cccccccc-0000-4000-8000-000000000005';
const PLAN_TEXT = 'Step 1: build the seam.\nStep 2: wire the dispatcher.\n';

// A task whose planning stage is being run by PLANNER_SESSION_ID — the record
// recordPlan reverse-looks-up. Defaults to stage 'planning' with exactly one
// planning ref; overrides tune attempt-count and workOrderRev cases.
function planningTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    stage: 'planning',
    sessionRefs: [{ stage: 'planning', appSessionId: PLANNER_SESSION_ID }],
    ...overrides,
  });
}

describe('TaskDispatcher — recordPlan: the native plan-capture seam (S7·5b-i)', () => {
  it('happy path: stores the blob, emits ONE capture_recorded, then proposes the move — in that order', () => {
    const harness = buildHarness({ tasks: [planningTask()] });

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    // Exactly one event, and it is S7·5a's plan capture — now `capture_recorded`
    // (captureKind 'plan') — with the full payload.
    expect(harness.emitted).toHaveLength(1);
    const planEvent = harness.emitted[0]!;
    expect(planEvent.type).toBe(EVENT_TYPES.captureRecorded);
    expect(planEvent.stream).toBe('tasks');
    const payload = planEvent.payload as {
      instanceId: string;
      captureKind: string;
      artifactHash: string;
      node: string;
      attempt: number;
      payloadRev: number;
      capturedFrom: { appSessionId: string };
    };
    expect(payload).toEqual({
      instanceId: TASK_ID,
      captureKind: 'plan',
      artifactHash: payload.artifactHash,
      node: 'planning',
      attempt: 1,
      payloadRev: 0,
      capturedFrom: { appSessionId: PLANNER_SESSION_ID },
    });

    // store → emit: the blob is retrievable under the hash the event carries, so
    // the put ran and produced the hash before the event was built.
    expect(harness.artifactStore.getBlob(payload.artifactHash)).toBe(PLAN_TEXT);

    // The transition went through the writer's choke point (I7), once, with the
    // right proposal — and AFTER the emit (emittedCountBefore === 1).
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([
      {
        taskId: TASK_ID,
        proposal: { toStage: 'plan-ready', proposedBy: 'dispatcher' },
        emittedCountBefore: 1,
      },
    ]);
  });

  it('I10: the transition goes through the writer, NOT a hand-rolled instance_moved emit', () => {
    const harness = buildHarness({ tasks: [planningTask()] });

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    // The dispatcher is NOT a second writer of task state: the ONLY event it emits
    // is capture_recorded. If recordPlan is "simplified" to emit instance_moved
    // itself, this reddens (a second event type appears) AND the writer call below
    // vanishes — the two halves of the I10/I7 guard.
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.captureRecorded]);
    expect(harness.emitted.some((event) => event.type === EVENT_TYPES.instanceMoved)).toBe(false);
    expect(harness.instanceWriter.proposeMoveCalls).toHaveLength(1);
  });

  it('empty plan → total no-op: no put, no emit, no transition', () => {
    const harness = buildHarness({ tasks: [planningTask()] });

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, '   \n\t  ');

    expect(harness.emitted).toEqual([]);
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([]);
    // Nothing was stored: the task has no artifacts recorded against it.
    expect(harness.artifactStore.listByTask(TASK_ID)).toEqual([]);
  });

  it('unknown / non-planning session → no-op, no throw', () => {
    const harness = buildHarness({ tasks: [planningTask()] });

    // A session id no task carries a planning ref for.
    expect(() =>
      harness.dispatcher.recordPlan('cccccccc-0000-4000-8000-00000000dead', PLAN_TEXT),
    ).not.toThrow();
    expect(harness.emitted).toEqual([]);
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([]);
    expect(harness.artifactStore.listByTask(TASK_ID)).toEqual([]);
  });

  it('a ref that matches the session but NOT the planning stage → no-op', () => {
    // The reverse-lookup keys on BOTH {stage:'planning', appSessionId}: a session
    // that authored an IMPLEMENTING ref for this task never captured a plan.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [{ stage: 'implementing', appSessionId: PLANNER_SESSION_ID }],
        }),
      ],
    });

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    expect(harness.emitted).toEqual([]);
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([]);
  });

  it('attempt counts the planning refs — two prior planning runs → attempt 2', () => {
    const harness = buildHarness({
      tasks: [
        planningTask({
          sessionRefs: [
            { stage: 'planning', appSessionId: 'cccccccc-0000-4000-8000-0000000000aa' },
            { stage: 'implementing', appSessionId: 'cccccccc-0000-4000-8000-0000000000bb' },
            { stage: 'planning', appSessionId: PLANNER_SESSION_ID },
          ],
        }),
      ],
    });

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    const payload = harness.emitted[0]!.payload as { attempt: number };
    // Two planning refs → this is the 2nd planning attempt. The implementing ref
    // does not count.
    expect(payload.attempt).toBe(2);
  });

  it('workOrderRev is read from the task and defaults to 0 when absent', () => {
    const withoutRev = buildHarness({ tasks: [planningTask()] });
    withoutRev.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);
    expect((withoutRev.emitted[0]!.payload as { payloadRev: number }).payloadRev).toBe(0);

    const withRev = buildHarness({ tasks: [planningTask({ workOrderRev: 3 })] });
    withRev.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);
    expect((withRev.emitted[0]!.payload as { payloadRev: number }).payloadRev).toBe(3);
    // The artifact envelope is stamped with the same rev the plan was produced against.
    expect(withRev.artifactStore.listByTask(TASK_ID)[0]!.rev).toBe(3);
  });

  it('S7·2b end-to-end: an AMENDMENT bumps the record to rev 1, and the plan records rev 1', () => {
    // **THE SLICE ASSERTION "STAGE-RUN IDENTITY CARRIES REV", PROVED THROUGH THE
    // REAL PARTS.** The case above pins the READ (a hand-built record carrying
    // rev 3); this one pins the whole chain that PRODUCES the number — a real
    // `InstanceWriter.revisePayload` emits `instance_payload_revised`, the real projection
    // folds it onto the record, and `recordPlan` reads the rev back off that fold.
    // Without it, the `?? 0` sites are only ever exercised against revs a test
    // typed in by hand, and nothing would catch a writer/fold pair that agreed
    // with each other but not with the dispatcher.
    const store = new MemoryEventStore({
      clock: new SteppingClock(FIXED_NOW, 1000),
      ids: new CountingIdSource(),
    });
    const readTasks = (): TasksState =>
      legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store)));
    const emit = (events: EventInput[]): void => {
      store.append(events);
    };
    store.append([
      taskCreated({
        taskId: TASK_ID,
        projectRoot: PROJECT_ROOT,
        createdBy: 'human',
        isolation: 'shared-dir',
        stage: 'planning',
        scope: 'the scope as first authored',
      }),
      taskSessionAttached({ taskId: TASK_ID, stage: 'planning', appSessionId: PLANNER_SESSION_ID }),
    ]);

    const amendResult = new InstanceWriter({ emit, readTasks, ids: new CountingIdSource() }).revisePayload(
      TASK_ID,
      { amendedBy: 'human', scope: 'the scope as amended mid-planning' },
    );
    expect(amendResult).toMatchObject({ outcome: 'amended' });
    expect(readTasks().tasks[TASK_ID]!.workOrderRev).toBe(1);

    const artifactStore = new MemoryArtifactStore();
    new TaskDispatcher({
      sessionHost: new RecordingSessionHost(),
      emit,
      readTasks,
      readMeters: () => ({ meters: {}, history: {} }),
      nowIso: () => FIXED_NOW,
      staleAfterMs: STALE_AFTER_MS,
      artifactStore,
      // The transition is the writer's business and irrelevant here; the fake keeps
      // it out of the log so the only events below are the amendment and the plan.
      instanceWriter: new RecordingInstanceWriter(),
    }).recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    const planEvent = store.read('tasks', 1).find((record) => record.type === EVENT_TYPES.captureRecorded)!;
    expect((planEvent.payload as { payloadRev: number }).payloadRev).toBe(1);
    // The artifact envelope is stamped with the SAME rev, so the stored plan is
    // attributable to the revision it was produced against.
    expect(artifactStore.listByTask(TASK_ID)[0]!.rev).toBe(1);
  });

  it('the injected clock is the artifact envelope’s only createdAt source', () => {
    const harness = buildHarness({ tasks: [planningTask()], nowIso: FIXED_NOW });
    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);
    const envelope = harness.artifactStore.listByTask(TASK_ID)[0]!;
    expect(envelope.createdAt).toBe(FIXED_NOW);
    expect(envelope.createdBy).toEqual({ appSessionId: PLANNER_SESSION_ID });
    expect(envelope.kind).toBe('plan');
    expect(envelope.taskRef).toEqual({ taskId: TASK_ID, stage: 'planning' });
  });

  it('I6 replay: the emitted capture_recorded folds to a task carrying planArtifactHash, deterministically', () => {
    // End-to-end against the REAL tasks projection over a real MemoryEventStore:
    // recordPlan emits into the log, and the fold must augment the record with the
    // stored plan's hash — the S7·5a fold, exercised through recordPlan.
    const store = new MemoryEventStore({
      clock: new SteppingClock(FIXED_NOW, 1000),
      ids: new CountingIdSource(),
    });
    store.append([
      taskCreated({
        taskId: TASK_ID,
        projectRoot: PROJECT_ROOT,
        createdBy: 'human',
        isolation: 'shared-dir',
        stage: 'planning',
      }),
      taskSessionAttached({ taskId: TASK_ID, stage: 'planning', appSessionId: PLANNER_SESSION_ID }),
    ]);
    const readTasks = (): TasksState => legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store)));

    const artifactStore = new MemoryArtifactStore();
    const dispatcher = new TaskDispatcher({
      sessionHost: new RecordingSessionHost(),
      emit: (events) => {
        store.append(events);
      },
      readTasks,
      readMeters: () => ({ meters: {}, history: {} }),
      nowIso: () => FIXED_NOW,
      staleAfterMs: STALE_AFTER_MS,
      artifactStore,
      // The transition's own event is the writer's business; the fake keeps it out
      // of the log so this test isolates the capture_recorded fold.
      instanceWriter: new RecordingInstanceWriter(),
    });

    dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    const foldedTask = readTasks().tasks[TASK_ID]!;
    expect(foldedTask.planArtifactHash).toBeDefined();
    // The folded hash names the stored plan blob.
    expect(artifactStore.getBlob(foldedTask.planArtifactHash!)).toBe(PLAN_TEXT);

    // Double-fold identical (I6): the same log serializes to the same bytes.
    const firstSerialization = canonicalJson(readTasks());
    const secondSerialization = canonicalJson(
      legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store))),
    );
    expect(secondSerialization).toBe(firstSerialization);
  });
});

// ─── S7·6b — recordReview: the DETERMINISTIC I10 core of the review path ──────
//
// recordReview mirrors recordPlan. The SDK adapter (S7·6b) only OBSERVES a review
// session's report_review verdicts and PROPOSES them back through a callback; THIS
// method does the writing — emit `report_filed (review)`, then propose the
// review→done/implementing transition THROUGH the task writer (I7's choke point).
// No artifact store: the review payload is small structured data carried inline.
//
// Instruments: `harness.emitted` (exactly one `report_filed (review)` with the built
// payload, and — the I10 point — NO hand-rolled `instance_moved`), and
// `harness.instanceWriter` (`proposeMoveCalls` proves the move went through
// the writer with the DERIVED toStage, `emittedCountBefore` proves it went AFTER
// the emit).

const REVIEWER_SESSION_ID = 'cccccccc-0000-4000-8000-000000000006';

// A task whose review stage is being run by REVIEWER_SESSION_ID, with a two-item
// acceptance list — the record recordReview reverse-looks-up and derives against.
function reviewTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    stage: 'review',
    sessionRefs: [{ stage: 'review', appSessionId: REVIEWER_SESSION_ID }],
    acceptanceCriteria: [
      { id: 'c1', text: 'first criterion' },
      { id: 'c2', text: 'second criterion' },
    ],
    ...overrides,
  });
}

describe('TaskDispatcher — recordReview: the review path seam (S7·6b)', () => {
  it('all pass + full coverage → emits ONE report_filed (review) then proposes done — in that order', () => {
    const harness = buildHarness({ tasks: [reviewTask()] });
    const criteria = [
      { criterionId: 'c1', verdict: 'pass' as const },
      { criterionId: 'c2', verdict: 'pass' as const, note: 'looks good' },
    ];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    // Exactly one event, and it is S7·6a's review report — now `report_filed`
    // (reportKind 'review') — with the full payload.
    expect(harness.emitted).toHaveLength(1);
    const event = harness.emitted[0]!;
    expect(event.type).toBe(EVENT_TYPES.reportFiled);
    expect(event.stream).toBe('tasks');
    expect(event.payload).toEqual({
      instanceId: TASK_ID,
      node: 'review',
      attempt: 1,
      payloadRev: 0,
      reportKind: 'review',
      body: { criteria },
    });

    // The transition went through the writer's choke point (I7), once, with the
    // DERIVED toStage (done), and AFTER the emit (emittedCountBefore === 1).
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([
      {
        taskId: TASK_ID,
        proposal: { toStage: 'done', proposedBy: 'dispatcher' },
        emittedCountBefore: 1,
      },
    ]);
  });

  it('any fail → proposes implementing (the fix loop)', () => {
    const harness = buildHarness({ tasks: [reviewTask()] });
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, [
      { criterionId: 'c1', verdict: 'pass' },
      { criterionId: 'c2', verdict: 'fail', note: 'regression' },
    ]);
    expect(harness.instanceWriter.proposeMoveCalls[0]!.proposal.toStage).toBe('implementing');
  });

  it('incomplete coverage (a task criterion never passed) → proposes implementing', () => {
    const harness = buildHarness({ tasks: [reviewTask()] });
    // Only c1 reported; c2 is uncovered → implementing.
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, [{ criterionId: 'c1', verdict: 'pass' }]);
    expect(harness.instanceWriter.proposeMoveCalls[0]!.proposal.toStage).toBe('implementing');
  });

  it('a bare task (no acceptance criteria) → vacuously covered → done', () => {
    const harness = buildHarness({ tasks: [reviewTask({ acceptanceCriteria: undefined })] });
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, []);
    expect(harness.instanceWriter.proposeMoveCalls[0]!.proposal.toStage).toBe('done');
  });

  it('unknown / non-review session → total no-op: no event, no proposal', () => {
    const harness = buildHarness({ tasks: [reviewTask()] });
    expect(() =>
      harness.dispatcher.recordReview('cccccccc-0000-4000-8000-00000000dead', [
        { criterionId: 'c1', verdict: 'pass' },
      ]),
    ).not.toThrow();
    expect(harness.emitted).toEqual([]);
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([]);
  });

  it('a ref that matches the session but NOT the review stage → no-op', () => {
    // The reverse-lookup keys on BOTH {stage:'review', appSessionId}: a session that
    // authored an IMPLEMENTING ref for this task never ran a review. This guard is
    // what makes exposing report_review to every dispatched session safe.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [{ stage: 'implementing', appSessionId: REVIEWER_SESSION_ID }],
        }),
      ],
    });
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, [{ criterionId: 'c1', verdict: 'pass' }]);
    expect(harness.emitted).toEqual([]);
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([]);
  });

  it('I7: the transition goes through the writer, NOT a hand-rolled instance_moved emit', () => {
    const harness = buildHarness({ tasks: [reviewTask()] });
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, [
      { criterionId: 'c1', verdict: 'pass' },
      { criterionId: 'c2', verdict: 'pass' },
    ]);
    // The ONLY event the dispatcher emits is report_filed (review). If recordReview is
    // "simplified" to emit instance_moved itself, this reddens (a second event
    // type appears) AND the writer call below vanishes — the two halves of I10/I7.
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.reportFiled]);
    expect(harness.emitted.some((event) => event.type === EVENT_TYPES.instanceMoved)).toBe(false);
    expect(harness.instanceWriter.proposeMoveCalls).toHaveLength(1);
  });

  it('attempt counts the review refs — two prior review runs → attempt 2', () => {
    const harness = buildHarness({
      tasks: [
        reviewTask({
          sessionRefs: [
            { stage: 'review', appSessionId: 'cccccccc-0000-4000-8000-0000000000aa' },
            { stage: 'implementing', appSessionId: 'cccccccc-0000-4000-8000-0000000000bb' },
            { stage: 'review', appSessionId: REVIEWER_SESSION_ID },
          ],
        }),
      ],
    });
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, [
      { criterionId: 'c1', verdict: 'pass' },
      { criterionId: 'c2', verdict: 'pass' },
    ]);
    const payload = harness.emitted[0]!.payload as { attempt: number };
    // Two review refs → this is the 2nd review attempt. The implementing ref does
    // not count.
    expect(payload.attempt).toBe(2);
  });

  it('workOrderRev is read from the task and defaults to 0 when absent', () => {
    const bothPass = [
      { criterionId: 'c1', verdict: 'pass' as const },
      { criterionId: 'c2', verdict: 'pass' as const },
    ];
    const withoutRev = buildHarness({ tasks: [reviewTask()] });
    withoutRev.dispatcher.recordReview(REVIEWER_SESSION_ID, bothPass);
    expect((withoutRev.emitted[0]!.payload as { payloadRev: number }).payloadRev).toBe(0);

    const withRev = buildHarness({ tasks: [reviewTask({ workOrderRev: 4 })] });
    withRev.dispatcher.recordReview(REVIEWER_SESSION_ID, bothPass);
    expect((withRev.emitted[0]!.payload as { payloadRev: number }).payloadRev).toBe(4);
  });

  it('I6 replay: an emitted report_filed (review) folds deterministically and does not perturb the record', () => {
    // End-to-end against the REAL tasks projection over a real MemoryEventStore.
    // S7·6a added report_filed (review) as an event with NO fold, so it must not change
    // the task record; the transition (which WOULD) goes through the fake writer,
    // which does not emit — so the stage stays 'review'.
    const store = new MemoryEventStore({
      clock: new SteppingClock(FIXED_NOW, 1000),
      ids: new CountingIdSource(),
    });
    store.append([
      taskCreated({
        taskId: TASK_ID,
        projectRoot: PROJECT_ROOT,
        createdBy: 'human',
        isolation: 'shared-dir',
        stage: 'review',
      }),
      taskSessionAttached({ taskId: TASK_ID, stage: 'review', appSessionId: REVIEWER_SESSION_ID }),
    ]);
    const readTasks = (): TasksState => legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store)));

    const dispatcher = new TaskDispatcher({
      sessionHost: new RecordingSessionHost(),
      emit: (events) => {
        store.append(events);
      },
      readTasks,
      readMeters: () => ({ meters: {}, history: {} }),
      nowIso: () => FIXED_NOW,
      staleAfterMs: STALE_AFTER_MS,
      artifactStore: new MemoryArtifactStore(),
      instanceWriter: new RecordingInstanceWriter(),
    });

    dispatcher.recordReview(REVIEWER_SESSION_ID, [{ criterionId: 'c1', verdict: 'pass' }]);

    const folded = readTasks().tasks[TASK_ID]!;
    expect(folded.stage).toBe('review');

    // Double-fold identical (I6): the same log serializes to the same bytes.
    const firstSerialization = canonicalJson(readTasks());
    const secondSerialization = canonicalJson(
      legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store))),
    );
    expect(secondSerialization).toBe(firstSerialization);
  });
});

// ─── S7·7b — recordCompletion: the DETERMINISTIC I10 core of the FIX side ─────
//
// recordCompletion mirrors recordReview exactly. The SDK adapter only OBSERVES a
// dispatched implementing session's `report_completion` call and PROPOSES the
// worklog back through a callback; THIS method does the writing — emit
// `report_filed (completion)`, then propose `implementing → review` THROUGH the task
// writer (I7's choke point). No artifact store: the worklog is small structured
// data carried inline.
//
// ⚠ **`implementing → review` IS AN OUTCOME, NOT A PROMOTION (D53).** The work
// reports its own state; the orchestrator's judgement comes AFTER, when it decides
// reviewer-vs-bounce. `review` is a HOLDING PEN, so nothing auto-dispatches from
// it — a completion report never chains into a reviewer spawn, and the assertion
// below that the session host is never touched is what pins that.
//
// Instruments: `harness.emitted` (exactly one `report_filed (completion)` with the built
// payload, and — the I10 point — NO hand-rolled `instance_moved`), and
// `harness.instanceWriter` (`proposeMoveCalls` proves the move went through
// the writer, `emittedCountBefore` proves it went AFTER the emit).

const IMPLEMENTER_SESSION_ID = 'cccccccc-0000-4000-8000-000000000007';

const SAMPLE_WORKLOG = {
  decisionsMade: ['kept the existing schema and widened it', 'named the flag after the D-number'],
  pathsRejected: ['a second projection — it would double-write task state'],
};

// A task whose implementing stage is being run by IMPLEMENTER_SESSION_ID — the
// record recordCompletion reverse-looks-up.
function implementingTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    stage: 'implementing',
    sessionRefs: [{ stage: 'implementing', appSessionId: IMPLEMENTER_SESSION_ID }],
    ...overrides,
  });
}

describe('TaskDispatcher — recordCompletion: the completion path seam (S7·7b)', () => {
  it('emits ONE report_filed (completion) then proposes implementing→review — in that order', () => {
    const harness = buildHarness({ tasks: [implementingTask()] });

    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);

    // Exactly one event, and it is `report_filed` (reportKind 'completion') with
    // the FULL payload — the identity tuple VIMES supplied plus the worklog the
    // session reported.
    expect(harness.emitted).toHaveLength(1);
    const event = harness.emitted[0]!;
    expect(event.type).toBe(EVENT_TYPES.reportFiled);
    expect(event.stream).toBe('tasks');
    expect(event.payload).toEqual({
      instanceId: TASK_ID,
      node: 'implementing',
      attempt: 1,
      payloadRev: 0,
      reportKind: 'completion',
      body: { worklog: SAMPLE_WORKLOG },
    });

    // The transition went through the writer's choke point (I7), once, to `review`,
    // and AFTER the emit (`emittedCountBefore === 1` is the ordering proof — record
    // the FACT before the CONSEQUENCE).
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([
      {
        taskId: TASK_ID,
        proposal: { toStage: 'review', proposedBy: 'dispatcher' },
        emittedCountBefore: 1,
      },
    ]);
  });

  it('D53 NO CHAINING: landing in review dispatches NOTHING', () => {
    // `review` is a holding pen, not an active stage. A completion report must not
    // spawn a reviewer — that call is the orchestrator's, and an auto-dispatch here
    // would reverse D53 silently.
    const harness = buildHarness({ tasks: [implementingTask()] });
    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);
    expect(harness.sessionHost.spawnCalls).toEqual([]);
    expect(harness.sessionHost.sendCalls).toEqual([]);
  });

  it('I7: the transition goes through the writer, NOT a hand-rolled instance_moved emit', () => {
    const harness = buildHarness({ tasks: [implementingTask()] });
    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);
    // The ONLY event the dispatcher emits is report_filed (completion). If this is
    // "simplified" to emit instance_moved itself, a second event type appears
    // AND the writer call vanishes — the two halves of I10/I7.
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.reportFiled]);
    expect(harness.emitted.some((event) => event.type === EVENT_TYPES.instanceMoved)).toBe(false);
    expect(harness.instanceWriter.proposeMoveCalls).toHaveLength(1);
  });

  it('unknown / non-implementing session → total no-op: no event, no proposal', () => {
    const harness = buildHarness({ tasks: [implementingTask()] });
    expect(() =>
      harness.dispatcher.recordCompletion('cccccccc-0000-4000-8000-00000000dead', SAMPLE_WORKLOG),
    ).not.toThrow();
    expect(harness.emitted).toEqual([]);
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([]);
  });

  it('a ref that matches the session but NOT the implementing stage → no-op', () => {
    // The reverse-lookup keys on BOTH {stage:'implementing', appSessionId}: a
    // session that authored a REVIEW ref for this task never implemented it. THIS
    // GUARD is what makes exposing report_completion to every dispatched session
    // safe — a reviewer that spuriously calls the tool is stopped right here.
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'review',
          sessionRefs: [{ stage: 'review', appSessionId: IMPLEMENTER_SESSION_ID }],
        }),
      ],
    });
    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);
    expect(harness.emitted).toEqual([]);
    expect(harness.instanceWriter.proposeMoveCalls).toEqual([]);
  });

  it('attempt counts the IMPLEMENTING refs — two prior implementing runs → attempt 2', () => {
    const harness = buildHarness({
      tasks: [
        implementingTask({
          sessionRefs: [
            { stage: 'implementing', appSessionId: 'cccccccc-0000-4000-8000-0000000000aa' },
            { stage: 'review', appSessionId: 'cccccccc-0000-4000-8000-0000000000bb' },
            { stage: 'implementing', appSessionId: IMPLEMENTER_SESSION_ID },
          ],
        }),
      ],
    });
    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);
    const payload = harness.emitted[0]!.payload as { attempt: number };
    // Two implementing refs → this is the 2nd implementation attempt (D46 makes
    // that an exact count: every fix spawns, so refs and attempts are 1:1). The
    // review ref does not count.
    expect(payload.attempt).toBe(2);
  });

  it('workOrderRev is read from the task and defaults to 0 when absent', () => {
    const withoutRev = buildHarness({ tasks: [implementingTask()] });
    withoutRev.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);
    expect((withoutRev.emitted[0]!.payload as { payloadRev: number }).payloadRev).toBe(0);

    const withRev = buildHarness({ tasks: [implementingTask({ workOrderRev: 3 })] });
    withRev.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);
    expect((withRev.emitted[0]!.payload as { payloadRev: number }).payloadRev).toBe(3);
  });

  it('an EMPTY worklog is recorded, not dropped — it is a real report', () => {
    // An attempt that genuinely rejected no paths still reported. Silently dropping
    // it would lose the `implementing → review` outcome along with it.
    const harness = buildHarness({ tasks: [implementingTask()] });
    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, {
      decisionsMade: [],
      pathsRejected: [],
    });
    expect(harness.emitted).toHaveLength(1);
    expect((harness.emitted[0]!.payload as { body: { worklog: unknown } }).body.worklog).toEqual({
      decisionsMade: [],
      pathsRejected: [],
    });
    expect(harness.instanceWriter.proposeMoveCalls).toHaveLength(1);
  });

  it('I6 replay: an emitted report_filed (completion) folds lastCompletion deterministically', () => {
    // End-to-end against the REAL tasks projection over a real MemoryEventStore.
    // S7·7b-core added the `lastCompletion` fold, so unlike the S7·6b review case
    // this event DOES change the record — and the change must be replay-stable.
    const store = new MemoryEventStore({
      clock: new SteppingClock(FIXED_NOW, 1000),
      ids: new CountingIdSource(),
    });
    store.append([
      taskCreated({
        taskId: TASK_ID,
        projectRoot: PROJECT_ROOT,
        createdBy: 'human',
        isolation: 'shared-dir',
        stage: 'implementing',
      }),
      taskSessionAttached({
        taskId: TASK_ID,
        stage: 'implementing',
        appSessionId: IMPLEMENTER_SESSION_ID,
      }),
    ]);
    const readTasks = (): TasksState => legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store)));

    const dispatcher = new TaskDispatcher({
      sessionHost: new RecordingSessionHost(),
      emit: (events) => {
        store.append(events);
      },
      readTasks,
      readMeters: () => ({ meters: {}, history: {} }),
      nowIso: () => FIXED_NOW,
      staleAfterMs: STALE_AFTER_MS,
      artifactStore: new MemoryArtifactStore(),
      instanceWriter: new RecordingInstanceWriter(),
    });

    dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);

    const folded = readTasks().tasks[TASK_ID]!;
    // The fake writer does not emit, so the stage stays put; the fold is the point.
    expect(folded.stage).toBe('implementing');
    expect(folded.lastCompletion).toEqual({
      taskId: TASK_ID,
      stage: 'implementing',
      attempt: 1,
      workOrderRev: 0,
      worklog: SAMPLE_WORKLOG,
    });

    // Double-fold identical (I6): the same log serializes to the same bytes.
    const firstSerialization = canonicalJson(readTasks());
    const secondSerialization = canonicalJson(
      legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store))),
    );
    expect(secondSerialization).toBe(firstSerialization);
  });
});

// ─── S7·7b — the FIX-SEED reaches the composer (D46) ──────────────────────────
//
// The dispatcher's half of the fix-seed: `lastReview.criteria` and
// `lastCompletion.worklog` are read straight off the task record (folded fields —
// NO IO, unlike the plan blob) and threaded into `StageInstructionContext`. The
// WORDS are core's job and are pinned in stageInstruction.test.ts; these cases
// prove only that the two values arrive, and that their ABSENCE is byte-identical
// to before this unit.

describe('TaskDispatcher — S7·7b fix-seed threading', () => {
  const SEEDED_REVIEW = {
    taskId: TASK_ID,
    stage: 'review' as const,
    attempt: 1,
    workOrderRev: 0,
    criteria: [{ criterionId: 'c1', verdict: 'fail' as const, note: 'the guard never fires' }],
  };
  const SEEDED_COMPLETION = {
    taskId: TASK_ID,
    stage: 'implementing' as const,
    attempt: 1,
    workOrderRev: 0,
    worklog: SAMPLE_WORKLOG,
  };

  // Captures the context object BY REFERENCE so a case can assert on key PRESENCE,
  // which is the discipline under test — `'reviewFeedback' in context` is a
  // different fact from `context.reviewFeedback === undefined`.
  function captureContext(): {
    composer: TaskDispatcherDeps['composeStageInstruction'];
    contexts: Array<Record<string, unknown> | undefined>;
  } {
    const contexts: Array<Record<string, unknown> | undefined> = [];
    return {
      contexts,
      composer: (_task, _plan, context) => {
        contexts.push(context as Record<string, unknown> | undefined);
        return 'stub instruction';
      },
    };
  }

  it('a bounced task carries BOTH halves of the seed to the composer', async () => {
    const { composer, contexts } = captureContext();
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          sessionRefs: [implementingRef(HOT_AUTHOR_SESSION_ID)],
          lastReview: SEEDED_REVIEW,
          lastCompletion: SEEDED_COMPLETION,
        }),
      ],
      composeStageInstruction: composer,
    });
    await harness.dispatcher.dispatchTask(TASK_ID);

    expect(contexts).toHaveLength(1);
    // The CRITERIA and the WORKLOG, unwrapped from their payloads — the composer
    // gets the content, not the envelope.
    expect(contexts[0]).toEqual({
      reviewFeedback: SEEDED_REVIEW.criteria,
      worklog: SEEDED_COMPLETION.worklog,
    });
  });

  it('a FIRST PASS carries NO fix-seed keys at all — absent stays absent', async () => {
    // ⚠ THE BYTE-IDENTICAL CLAIM. A task that has never been reviewed and never
    // reported must produce the SAME call the pre-S7·7b dispatcher produced: a
    // third argument of `undefined`, not `{}` and not `{reviewFeedback: undefined}`.
    const { composer, contexts } = captureContext();
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'implementing' })],
      composeStageInstruction: composer,
    });
    await harness.dispatcher.dispatchTask(TASK_ID);

    expect(contexts).toEqual([undefined]);
  });

  it('review feedback WITHOUT a worklog threads only the key it has', async () => {
    // A real, expected state (D46): a task bounced by hand, or reviewed against work
    // whose author never reported. The absent half must not appear as a present
    // undefined — see the composer's own asymmetry note in stageInstruction.ts.
    const { composer, contexts } = captureContext();
    const harness = buildHarness({
      tasks: [taskRecord({ stage: 'implementing', lastReview: SEEDED_REVIEW })],
      composeStageInstruction: composer,
    });
    await harness.dispatcher.dispatchTask(TASK_ID);

    expect(Object.keys(contexts[0]!)).toEqual(['reviewFeedback']);
    expect('worklog' in contexts[0]!).toBe(false);
  });

  it('the fix-seed rides ALONGSIDE the fetched plan, all three keys at once', async () => {
    const PLAN_HASH_FOR_FIX = 'b'.repeat(64);
    const { composer, contexts } = captureContext();
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          planArtifactHash: PLAN_HASH_FOR_FIX,
          lastReview: SEEDED_REVIEW,
          lastCompletion: SEEDED_COMPLETION,
        }),
      ],
      composeStageInstruction: composer,
    });
    harness.artifactStore.getBlob = () => 'the approved plan';
    await harness.dispatcher.dispatchTask(TASK_ID);

    expect(contexts[0]).toEqual({
      plan: 'the approved plan',
      reviewFeedback: SEEDED_REVIEW.criteria,
      worklog: SEEDED_COMPLETION.worklog,
    });
  });

  it('reads the seed WITHOUT touching the artifact store — the folds are already in the record', async () => {
    // The plan needs IO; the fix-seed does not. A store read here would mean the
    // payloads had been moved to blobs, which would need a degrade path this
    // method deliberately does not have for the seed.
    const { composer } = captureContext();
    const getBlobCalls: string[] = [];
    const harness = buildHarness({
      tasks: [
        taskRecord({
          stage: 'implementing',
          lastReview: SEEDED_REVIEW,
          lastCompletion: SEEDED_COMPLETION,
        }),
      ],
      composeStageInstruction: composer,
    });
    harness.artifactStore.getBlob = (hash: string) => {
      getBlobCalls.push(hash);
      return null;
    };
    await harness.dispatcher.dispatchTask(TASK_ID);

    expect(getBlobCalls).toEqual([]);
  });
});

// ─── S7·7c — THE D54 PER-TASK IN-FLIGHT LOCK ─────────────────────────────────
//
// D54's finding: `already-running` is derived from the task's OWN refs against
// live processes, so it cannot fire until `instance_run_attached` has LANDED.
// Since step 8 there is an `await` between the decision and that event (worktree
// creation is a subprocess), and a second attempt arriving INSIDE that window
// used to reach a second spawn — two live sessions on one task.
//
// ⚠ **THE HARD PART OF TESTING THIS IS PROVING THE OVERLAP IS REAL.** Two
// `await`ed calls in sequence would pass against a dispatcher with no lock at all
// — the first would have finished before the second started, and the test would
// be asserting nothing. Every case below therefore does the same three things:
//   1. FIRES both calls WITHOUT awaiting the first, so the first is suspended
//      inside the window when the second's synchronous prefix runs;
//   2. asserts, WHILE the first is still suspended, that no spawn has happened
//      yet — the positive evidence that the window is genuinely open;
//   3. only then releases the gate and awaits both.
// The gate is a `worktreeManagerOverride` whose `ensureWorktree` parks on a
// promise this file resolves by hand, which holds the exact `await` D54 named
// open for as long as the assertions need.

const SECOND_TASK_ID = 'task-dispatch-0002';

function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// A worktree manager that RECORDS and PARKS. `reused: true` on the way out, so it
// emits no `task_worktree_created` and `emitted` stays a clean instrument for
// "did the in-flight attempt write anything".
function gatedWorktreeManager(): {
  manager: Pick<WorktreeManager, 'ensureWorktree'>;
  ensureCalls: string[];
  release: () => void;
} {
  const gate = createGate();
  const ensureCalls: string[] = [];
  return {
    manager: {
      ensureWorktree: async (task: TaskRecord) => {
        ensureCalls.push(task.taskId);
        await gate.promise;
        return {
          ok: true as const,
          path: `${WORKTREE_ROOT}/task-${task.taskId}`,
          branch: `vimes/task-${task.taskId}`,
          reused: true,
          setupMs: 0,
        };
      },
    },
    ensureCalls,
    release: gate.release,
  };
}

describe('TaskDispatcher — the D54 in-flight lock (S7·7c)', () => {
  it('two OVERLAPPING attempts on one task: exactly one spawn, the other is in-flight', async () => {
    const gated = gatedWorktreeManager();
    const harness = buildHarness({
      worktreeIsolationEnabled: true,
      worktreeManagerOverride: gated.manager,
    });

    // FIRE BOTH. Neither is awaited yet: the first runs its synchronous prefix,
    // claims the lock, reaches `ensureWorktree` and PARKS there.
    const firstAttempt = harness.dispatcher.dispatchTask(TASK_ID);
    const secondAttempt = harness.dispatcher.dispatchTask(TASK_ID);

    // ⚠ THE OVERLAP PROOF. The second attempt has already returned — its whole
    // body is the lock check — while the first is still suspended: no session has
    // been spawned, and nothing has been written. A dispatcher WITHOUT the lock
    // would be parked twice inside `ensureWorktree` here, and would spawn twice
    // the moment the gate opened.
    expect(await secondAttempt).toEqual({ outcome: 'in-flight', taskId: TASK_ID });
    expect(harness.sessionHost.spawnCalls).toEqual([]);
    expect(harness.emitted).toEqual([]);
    // Only ONE attempt ever reached the worktree — the loser never got past the
    // lock, so it never touched the manager either.
    expect(gated.ensureCalls).toEqual([TASK_ID]);

    gated.release();
    expect(await firstAttempt).toEqual({
      outcome: 'spawned',
      taskId: TASK_ID,
      stage: 'implementing',
      appSessionId: SPAWNED_SESSION_ID,
      cwd: WORKTREE_PATH,
    });

    // ONE spawn, ONE event. The in-flight attempt is SILENT — no `dispatch_refused`
    // (the decision function never saw it) and no event of its own (nothing
    // happened and nothing changed; the winner's result is the record).
    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceRunAttached]);
  });

  it('holds on the SHIPPED default path too (flag off, no manager at all)', async () => {
    // The case above needs a manager to widen the window; production today runs
    // with the flag OFF, where the only `await` is the resolver's own microtask.
    // The lock must still serialise there, and the evidence is the same: at the
    // instant both calls have been FIRED, the first has not yet spawned.
    const harness = buildHarness();

    const firstAttempt = harness.dispatcher.dispatchTask(TASK_ID);
    const secondAttempt = harness.dispatcher.dispatchTask(TASK_ID);
    expect(harness.sessionHost.spawnCalls).toEqual([]);

    const [firstResult, secondResult] = await Promise.all([firstAttempt, secondAttempt]);
    expect(firstResult).toMatchObject({ outcome: 'spawned', taskId: TASK_ID });
    expect(secondResult).toEqual({ outcome: 'in-flight', taskId: TASK_ID });
    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceRunAttached]);
  });

  it('RELEASES: a third attempt after both settle is never in-flight', async () => {
    // The `finally` is the whole point — a lock that leaked would make this task
    // permanently undispatchable for the life of the process, a silent stall that
    // would look exactly like "the orchestrator stopped promoting things".
    const harness = buildHarness();
    const [, secondResult] = await Promise.all([
      harness.dispatcher.dispatchTask(TASK_ID),
      harness.dispatcher.dispatchTask(TASK_ID),
    ]);
    expect(secondResult).toEqual({ outcome: 'in-flight', taskId: TASK_ID });

    const thirdResult = await harness.dispatcher.dispatchTask(TASK_ID);
    // The HONEST outcome of this fake's config: `readTasks` returns a FIXED state
    // (no projection feeds the attach event back), and the fake host marks nothing
    // live, so `decideDispatch` sees no live run and spawns again. That is not a
    // bug in the lock — it is D54's own point restated: `already-running` is the
    // POST-ATTACH guard and it needs the projection to have caught up.
    expect(thirdResult).toMatchObject({ outcome: 'spawned', taskId: TASK_ID });
    expect(thirdResult.outcome).not.toBe('in-flight');
  });

  it('once the attach has LANDED, the post-attach guard speaks — not the lock', async () => {
    // The other half of the release proof, and the shape production actually has:
    // a task whose ref is live refuses `already-running`. The lock is not involved
    // at all, which is exactly the division of labour the docstring claims — the
    // lock covers the window BETWEEN the decision and the attach, `already-running`
    // covers everything after it.
    const harness = buildHarness({
      tasks: [
        taskRecord({ sessionRefs: [{ stage: 'implementing', appSessionId: EXISTING_SESSION_ID }] }),
      ],
    });
    harness.sessionHost.markLive(EXISTING_SESSION_ID);

    const firstResult = await harness.dispatcher.dispatchTask(TASK_ID);
    const secondResult = await harness.dispatcher.dispatchTask(TASK_ID);

    expect(firstResult).toEqual({
      outcome: 'refused',
      taskId: TASK_ID,
      reason: 'already-running',
    });
    expect(secondResult).toEqual(firstResult);
    expect(secondResult.outcome).not.toBe('in-flight');
    // A refusal IS evented (I10), once per attempt — the lock released between
    // them, so the second attempt really was adjudicated rather than short-circuited.
    expect(eventTypes(harness.emitted)).toEqual([
      EVENT_TYPES.dispatchRefused,
      EVENT_TYPES.dispatchRefused,
    ]);
    expect(harness.sessionHost.spawnCalls).toEqual([]);
  });

  it('RELEASES ON THE FAILURE PATH — a spawn that THREW does not strand the lock', async () => {
    // The path a hand-placed `delete` before each return forgets. `spawnSession`
    // throwing unwinds past every release point except a `finally`.
    const harness = buildHarness();
    harness.sessionHost.throwOnSpawn(new Error('the host fell over'));

    const firstResult = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);
    expect(firstResult).toEqual({
      outcome: 'spawn-failed',
      taskId: TASK_ID,
      reason: 'spawn-threw:the host fell over',
    });

    const secondResult = await dispatchWithoutRejecting(harness.dispatcher, TASK_ID);
    expect(secondResult.outcome).not.toBe('in-flight');
    expect(secondResult).toEqual(firstResult);
    // Both attempts really reached the host — the second was not short-circuited.
    expect(harness.sessionHost.spawnCalls).toHaveLength(2);
  });

  it('is PER TASK — two different tasks overlapping do not contend', async () => {
    // A global lock would serialise the whole board, which is the opposite of what
    // a task dispatcher is for. Both calls park inside the SAME gate, so their
    // windows genuinely overlap; both must still spawn.
    const gated = gatedWorktreeManager();
    const harness = buildHarness({
      tasks: [taskRecord(), taskRecord({ taskId: SECOND_TASK_ID })],
      worktreeIsolationEnabled: true,
      worktreeManagerOverride: gated.manager,
    });

    const firstAttempt = harness.dispatcher.dispatchTask(TASK_ID);
    const secondAttempt = harness.dispatcher.dispatchTask(SECOND_TASK_ID);
    // BOTH are suspended in the window at the same moment — the overlap is real,
    // and neither was turned away.
    expect(gated.ensureCalls).toEqual([TASK_ID, SECOND_TASK_ID]);
    expect(harness.sessionHost.spawnCalls).toEqual([]);

    gated.release();
    const [firstResult, secondResult] = await Promise.all([firstAttempt, secondAttempt]);

    expect(firstResult).toMatchObject({ outcome: 'spawned', taskId: TASK_ID });
    expect(secondResult).toMatchObject({ outcome: 'spawned', taskId: SECOND_TASK_ID });
    expect(harness.sessionHost.spawnCalls).toHaveLength(2);
    expect(eventTypes(harness.emitted)).toEqual([
      EVENT_TYPES.instanceRunAttached,
      EVENT_TYPES.instanceRunAttached,
    ]);
  });
});

// ─── S11-A6 — SINGLE SPELLING ON THE WRITE PATH (the dispatcher's half) ──────
//
// The writer's four kinds are guarded in instanceWriter.test.ts; these are the
// dispatcher's four. One flow per emission site, folded together, and every
// emitted `type` is checked against `RETIRED_EVENT_KINDS` — the table itself is
// the oracle, so a kind retired in a later wave starts being guarded here for
// free rather than needing a new string added to a hand-written list.
//
// ⚠ `dispatch_refused` and `task_worktree_created` are DELIBERATELY still their
// original spelling and are NOT in the alias table (slice-11.md's explicitly-out):
// their generic siblings arrive with the watchdog/dispatcher splits and the E2
// tree store. This assertion is therefore exactly right about them too — it asks
// "is this a RETIRED kind", not "does this start with task_".
describe('TaskDispatcher — S11-A6: every emitted kind is the GENERIC one', () => {
  it('attach + capture + both reports emit NO retired kind', async () => {
    const emittedAcrossFlows: EventInput[] = [];

    const attachHarness = buildHarness();
    await attachHarness.dispatcher.dispatchTask(TASK_ID);
    emittedAcrossFlows.push(...attachHarness.emitted);

    const planHarness = buildHarness({ tasks: [planningTask()] });
    planHarness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);
    emittedAcrossFlows.push(...planHarness.emitted);

    const reviewHarness = buildHarness({ tasks: [reviewTask()] });
    reviewHarness.dispatcher.recordReview(REVIEWER_SESSION_ID, [
      { criterionId: 'c1', verdict: 'pass' },
      { criterionId: 'c2', verdict: 'pass' },
    ]);
    emittedAcrossFlows.push(...reviewHarness.emitted);

    const completionHarness = buildHarness({ tasks: [implementingTask()] });
    completionHarness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, SAMPLE_WORKLOG);
    emittedAcrossFlows.push(...completionHarness.emitted);

    // The flows really did produce all three generic kinds — otherwise the
    // containment check below would pass vacuously over a shorter log than it
    // claims to cover.
    expect(new Set(eventTypes(emittedAcrossFlows))).toEqual(
      new Set([
        EVENT_TYPES.instanceRunAttached,
        EVENT_TYPES.captureRecorded,
        EVENT_TYPES.reportFiled,
      ]),
    );

    const retiredKinds = Object.keys(RETIRED_EVENT_KINDS);
    expect(retiredKinds.length).toBeGreaterThan(0);
    for (const event of emittedAcrossFlows) {
      expect(retiredKinds, `${event.type} is a RETIRED kind`).not.toContain(event.type);
    }
  });
});
