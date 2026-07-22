import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  attentionCleared,
  claudeSessionMapped,
  gateFired,
  livenessChanged,
  message,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionCreated,
  sessionsProjection,
  taskCreated,
  taskSessionAttached,
  withNotificationTrigger,
  type Clock,
  type EventInput,
  type IdSource,
  type SessionsState,
  type TaskRecord,
  type TasksState,
  type WatchdogPolicy,
} from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import { loadConfigFromEnv, type DaemonConfig } from './config.js';
import { TaskWatchdog, type TaskWatchdogDeps } from './taskWatchdog.js';

// ─── slice 6 step 5b — the watchdog RUNNER ───────────────────────────────────
//
// ⚠ EVERY case here drives FAKES. Nothing in this file spawns a Claude process,
// reads ~/.claude, opens a socket or touches the live daemon: the runner's whole
// job is (projections in) → (pure verdict) → (the right events, or deliberately
// none), and all of it is observable through an in-memory event store.
//
// ⚠ **THE SESSIONS STATE IS FOLDED BY THE REAL PROJECTION, from the events the
// runner itself emits.** That is the point of the harness rather than an
// accident: the dedup, the attention flag it reads, and the `staleEpisodes`
// counter that numbers each episode are all round-tripped through
// `sessionsProjection` exactly as production does. A hand-stubbed sessions state
// would let the dedup pass while the real fold disagreed with it.
//
// ⚠ **NO NUMBER IN THIS FILE IS A PIN.** The policy is supplied per test and the
// assertions are about SHAPE and RELATIONSHIPS ("exactly one event", "nothing at
// all", "`wouldQuarantine` rides the record") — never that 15 minutes, 3 retries
// or any backoff curve is the right value. The retry ⟨tune⟩s are unpinned (D30),
// so no assertion here may FAIL on their value.

const TASK_ID = 'task-watchdog-0001';
const SECOND_TASK_ID = 'task-watchdog-0002';
const SESSION_ID = 'dddddddd-0000-4000-8000-000000000001';
const SECOND_SESSION_ID = 'dddddddd-0000-4000-8000-000000000002';
const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';

// The seeded run's events start here; `NOW_TEN_HOURS_LATER` is when the check
// runs. Ten hours is deliberately the S3a human-gated observation (599.99 min):
// far past any band, so a run that is NOT protected is unambiguously stale and a
// run that IS protected proves the protection rather than a small margin.
const RUN_START_ISO = '2026-07-22T02:00:00.000Z';
const NOW_TEN_HOURS_LATER = '2026-07-22T12:00:00.000Z';

// A caller-supplied policy. D30's band is 15 min; the retry ⟨tune⟩s are UNPINNED
// and appear here only because `WatchdogPolicy` requires them — no assertion in
// this file depends on their values.
const TEST_POLICY: WatchdogPolicy = {
  staleAfterMs: 900_000,
  maxStaleRetries: 3,
  retryBackoffMs: [60_000, 300_000],
};

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    projectRoot: PROJECT_ROOT,
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    sessionRefs: [{ stage: 'implementing', appSessionId: SESSION_ID }],
    createdBy: 'human',
    // RETIRED by D34 — birth values, never written by anything. The watchdog
    // must not read either of them; it reads the SESSION record.
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

interface WatchdogHarness {
  readonly watchdog: TaskWatchdog;
  // Everything the runner emitted, in order, across every check.
  readonly emitted: EventInput[];
  // Append events to the log WITHOUT attributing them to the runner (world
  // events: the run appends, a human dismisses attention, …).
  readonly appendWorldEvents: (events: EventInput[]) => void;
  readonly sessions: () => SessionsState;
  readonly nowIsoCallCount: () => number;
}

function buildHarness(
  options: {
    seed?: (appendWorldEvents: (events: EventInput[]) => void) => void;
    tasks?: TaskRecord[];
    nowIso?: string;
    policy?: WatchdogPolicy;
    readSessions?: () => SessionsState;
  } = {},
): WatchdogHarness {
  // One-second steps from the run's start, so seeded events land in the past and
  // the check's `nowIso` is hours later.
  const store = new MemoryEventStore({
    clock: new SteppingClock(RUN_START_ISO, 1000),
    ids: new CountingIdSource(),
  });
  const appendWorldEvents = (events: EventInput[]): void => {
    store.append(events);
  };
  options.seed?.(appendWorldEvents);

  const emitted: EventInput[] = [];
  const tasksById: Record<string, TaskRecord> = {};
  for (const task of options.tasks ?? [taskRecord()]) {
    tasksById[task.taskId] = task;
  }
  const tasksState: TasksState = { tasks: tasksById };
  let nowIsoCallCount = 0;

  const foldSessions = (): SessionsState =>
    replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));

  const deps: TaskWatchdogDeps = {
    readTasks: () => tasksState,
    readSessions: options.readSessions ?? foldSessions,
    emit: (events) => {
      emitted.push(...events);
      // The runner's own writes go into the SAME log every read folds, exactly
      // as the router does in production. This is what makes the dedup and the
      // episode counter real rather than asserted against a stub.
      store.append(events);
    },
    nowIso: () => {
      nowIsoCallCount += 1;
      return options.nowIso ?? NOW_TEN_HOURS_LATER;
    },
    policy: options.policy ?? TEST_POLICY,
  };

  return {
    watchdog: new TaskWatchdog(deps),
    emitted,
    appendWorldEvents,
    sessions: foldSessions,
    nowIsoCallCount: () => nowIsoCallCount,
  };
}

// A run that is genuinely wedged: alive, nothing waiting on a human, one real
// transcript append hours ago, and a resume boundary that PRECEDES that append
// (so the resume protection has legitimately lapsed).
function seedGenuinelyStaleRun(appendWorldEvents: (events: EventInput[]) => void): void {
  appendWorldEvents([
    sessionCreated({
      appSessionId: SESSION_ID,
      channel: 'sdk',
      cwd: PROJECT_ROOT,
      name: null,
      forkedFrom: null,
      taskRef: null,
    }),
  ]);
  appendWorldEvents([livenessChanged({ appSessionId: SESSION_ID, to: 'running', cause: 'spawned' })]);
  appendWorldEvents([
    claudeSessionMapped({ appSessionId: SESSION_ID, claudeSessionId: 'c1', jsonlPath: '/p/c1.jsonl' }),
  ]);
  // The heartbeat: the last thing the run actually appended.
  appendWorldEvents([message({ appSessionId: SESSION_ID, role: 'assistant', content: 'working' })]);
}

function staleEventsIn(emitted: readonly EventInput[]): EventInput[] {
  return emitted.filter((event) => event.type === EVENT_TYPES.watchdogStale);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('task watchdog — a genuinely stale run is reported ONCE, with evidence', () => {
  // ASSERTION 7.
  it('emits exactly one watchdog_stale carrying the evidence fields', () => {
    const harness = buildHarness({ seed: seedGenuinelyStaleRun });
    const summary = harness.watchdog.checkOnce();

    // The setter and its notification trigger — nothing else.
    expect(harness.emitted.map((event) => event.type)).toEqual([
      EVENT_TYPES.watchdogStale,
      EVENT_TYPES.notificationTrigger,
    ]);
    const staleEvent = staleEventsIn(harness.emitted)[0]!;
    expect(staleEvent.stream).toBe(SESSION_ID);
    expect(staleEvent.payload).toMatchObject({
      appSessionId: SESSION_ID,
      taskId: TASK_ID,
      // The FIRST episode.
      retryNumber: 1,
      // Detection only: the verdict was `stale`, not `quarantine`.
      wouldQuarantine: false,
    });
    // The silence is the one the DECISION measured, recorded verbatim — hours,
    // not a re-derivation. Asserted as a relationship (it exceeds the band),
    // never as a pinned number.
    const observedSilenceMs = (staleEvent.payload as { observedSilenceMs: number }).observedSilenceMs;
    expect(observedSilenceMs).toBeGreaterThanOrEqual(TEST_POLICY.staleAfterMs);

    expect(summary.checkedAt).toBe(NOW_TEN_HOURS_LATER);
    expect(summary.runsExamined).toBe(1);
    expect(summary.staleReportsEmitted).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'reported', taskId: TASK_ID });
  });

  it('the report reaches the attention path — the projection folds it to reason=stale', () => {
    // The consequence that makes a false positive expensive: attention is what
    // PUSHES A NOTIFICATION TO A PHONE. Asserted end to end through the real
    // projection rather than assumed from the event's existence.
    const harness = buildHarness({ seed: seedGenuinelyStaleRun });
    harness.watchdog.checkOnce();
    const session = harness.sessions().sessions[SESSION_ID]!;
    expect(session.needsAttention).toMatchObject({ reason: 'stale' });
    expect(session.staleEpisodes).toBe(1);
  });

  it('a run whose silence is INSIDE the band is left alone', () => {
    // Non-vacuity for every "emits nothing" case below: the harness only reports
    // because the run is genuinely silent, not because it reports everything.
    const harness = buildHarness({
      seed: seedGenuinelyStaleRun,
      // One second after the seeded appends — well inside any band.
      nowIso: '2026-07-22T02:00:10.000Z',
    });
    const summary = harness.watchdog.checkOnce();
    expect(harness.emitted).toEqual([]);
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'silent' });
  });
});

describe('task watchdog — the dedup bounds writes on a long-silent run', () => {
  // ASSERTION 8. A check every minute against a run silent since yesterday must
  // not write an event every minute.
  it('ten consecutive checks emit exactly ONE event', () => {
    const harness = buildHarness({ seed: seedGenuinelyStaleRun });
    for (let checkIndex = 0; checkIndex < 10; checkIndex += 1) {
      harness.watchdog.checkOnce();
    }
    expect(staleEventsIn(harness.emitted)).toHaveLength(1);
    // Ten checks, one record — the other nine saw `needsAttention.reason` was
    // already 'stale' and wrote nothing.
    expect(harness.emitted).toHaveLength(2); // the setter + its trigger
  });

  it('after attention CLEARS, a new episode is reported again', () => {
    const harness = buildHarness({ seed: seedGenuinelyStaleRun });
    harness.watchdog.checkOnce();
    expect(staleEventsIn(harness.emitted)).toHaveLength(1);

    // The world clears attention (a human dismissed it, or the run resumed).
    // Note what this does NOT do: `attention_cleared` is not a transcript
    // append, so the heartbeat has not moved and the run is still silent.
    harness.appendWorldEvents([attentionCleared({ appSessionId: SESSION_ID, cause: 'dismissed' })]);

    for (let checkIndex = 0; checkIndex < 10; checkIndex += 1) {
      harness.watchdog.checkOnce();
    }
    const staleEvents = staleEventsIn(harness.emitted);
    expect(staleEvents).toHaveLength(2);
    // The EPISODE COUNTER advanced through the real projection: this is the
    // second episode, not a repeat of the first.
    expect(staleEvents[1]!.payload).toMatchObject({ retryNumber: 2 });
    expect(harness.sessions().sessions[SESSION_ID]!.staleEpisodes).toBe(2);
  });

  it('a run that APPENDS again clears attention through the ordinary path and can be reported later', () => {
    // The dedup's release condition, stated as behaviour: the flag is not a
    // permanent mute, and the heartbeat moves only on a real append.
    const harness = buildHarness({ seed: seedGenuinelyStaleRun });
    harness.watchdog.checkOnce();
    harness.appendWorldEvents([
      attentionCleared({ appSessionId: SESSION_ID, cause: 'run_resumed' }),
      message({ appSessionId: SESSION_ID, role: 'assistant', content: 'back' }),
    ]);
    const sessionAfterAppend = harness.sessions().sessions[SESSION_ID]!;
    expect(sessionAfterAppend.needsAttention).toBeNull();
    expect(sessionAfterAppend.lastAppendAt).not.toBeNull();

    // Now the run is silent AGAIN (the check's clock is still ten hours on).
    harness.watchdog.checkOnce();
    expect(staleEventsIn(harness.emitted)).toHaveLength(2);
  });
});

describe('task watchdog — THE FINDING GUARD: a protected run is never reported', () => {
  // ASSERTION 9. The slice's named rule-0.1 finding is "the watchdog escalates a
  // HEALTHY run". Each case asserts the emit list is EMPTY — not merely that no
  // quarantine happened, because an implementation that wrote a `watchdog_stale`
  // for a run waiting on a human has already buzzed a phone at 3am.
  it('a GATE-BLOCKED run silent for ten hours emits NOTHING', () => {
    const harness = buildHarness({
      seed: (appendWorldEvents) => {
        seedGenuinelyStaleRun(appendWorldEvents);
        appendWorldEvents(withNotificationTrigger(gateFired({ appSessionId: SESSION_ID, prompt: 'approve?' })));
      },
    });
    const summary = harness.watchdog.checkOnce();
    expect(harness.emitted).toEqual([]);
    expect(summary.staleReportsEmitted).toBe(0);
    expect(summary.outcomes[0]).toMatchObject({
      outcome: 'silent',
      verdict: { verdict: 'healthy', reason: 'awaiting-human' },
    });
  });

  it('a run at a RESUME BOUNDARY silent for ten hours emits NOTHING', () => {
    const harness = buildHarness({
      seed: (appendWorldEvents) => {
        seedGenuinelyStaleRun(appendWorldEvents);
        // A newer mapping than the last append: the run resumed and has not
        // appended since. That silence is startup, measured in wall-clock.
        appendWorldEvents([
          claudeSessionMapped({
            appSessionId: SESSION_ID,
            claudeSessionId: 'c2',
            jsonlPath: '/p/c2.jsonl',
          }),
        ]);
      },
    });
    const summary = harness.watchdog.checkOnce();
    expect(harness.emitted).toEqual([]);
    expect(summary.outcomes[0]).toMatchObject({
      outcome: 'silent',
      verdict: { verdict: 'healthy', reason: 'resume-boundary' },
    });
  });

  it('a run with an UNOBSERVABLE heartbeat emits NOTHING', () => {
    const harness = buildHarness({
      seed: (appendWorldEvents) => {
        // Created and running, but nothing has ever been observed appending.
        appendWorldEvents([
          sessionCreated({
            appSessionId: SESSION_ID,
            channel: 'sdk',
            cwd: PROJECT_ROOT,
            name: null,
            forkedFrom: null,
            taskRef: null,
          }),
        ]);
        appendWorldEvents([
          livenessChanged({ appSessionId: SESSION_ID, to: 'running', cause: 'spawned' }),
        ]);
      },
    });
    const summary = harness.watchdog.checkOnce();
    expect(harness.emitted).toEqual([]);
    expect(summary.outcomes[0]).toMatchObject({
      outcome: 'silent',
      verdict: { verdict: 'unknown', reason: 'no-heartbeat-observed' },
    });
  });

  it('a run whose liveness is not governed (dormant) emits NOTHING', () => {
    const harness = buildHarness({
      seed: (appendWorldEvents) => {
        seedGenuinelyStaleRun(appendWorldEvents);
        appendWorldEvents([livenessChanged({ appSessionId: SESSION_ID, to: 'dormant', cause: 'idle' })]);
      },
    });
    harness.watchdog.checkOnce();
    expect(harness.emitted).toEqual([]);
  });
});

describe('task watchdog — task_quarantined is NEVER emitted', () => {
  // ASSERTION 10 — THE UNIT'S HEADLINE SAFETY PROPERTY. D30 pinned the band and
  // pinned NOTHING about retries, so the destructive half may not ship (rule
  // 0.2). `wouldQuarantine` records what we would have done instead.
  it('a QUARANTINE verdict still writes only a watchdog_stale, flagged wouldQuarantine', () => {
    const harness = buildHarness({
      seed: seedGenuinelyStaleRun,
      // Zero retries allowed → the very first escalation is a `quarantine`
      // verdict. A test-supplied number, not a pin.
      policy: { ...TEST_POLICY, maxStaleRetries: 0 },
    });
    const summary = harness.watchdog.checkOnce();

    expect(harness.emitted.map((event) => event.type)).toEqual([
      EVENT_TYPES.watchdogStale,
      EVENT_TYPES.notificationTrigger,
    ]);
    expect(harness.emitted.some((event) => event.type === EVENT_TYPES.taskQuarantined)).toBe(false);
    expect(staleEventsIn(harness.emitted)[0]!.payload).toMatchObject({
      taskId: TASK_ID,
      wouldQuarantine: true,
      // Episode numbering stays continuous across the stale→quarantine
      // boundary: zero retries were exhausted, so this is episode 1.
      retryNumber: 1,
    });
    expect(summary.outcomes[0]).toMatchObject({
      outcome: 'reported',
      wouldQuarantine: true,
      verdict: { verdict: 'quarantine' },
    });
    // And the task itself never moved: no transition, no quarantine, nothing.
    expect(harness.emitted.some((event) => event.type === EVENT_TYPES.taskTransitioned)).toBe(false);
  });

  it('across EVERY policy and every state, the runner writes only two event types', () => {
    // Read structurally: whatever the verdict, whatever the retry ⟨tune⟩s, the
    // set of things this runner can write is {watchdog_stale,
    // notification_trigger}. There is no branch that reaches a destructive
    // event, so no number can unlock one.
    const policies: WatchdogPolicy[] = [
      { staleAfterMs: 900_000, maxStaleRetries: 0, retryBackoffMs: [1] },
      { staleAfterMs: 900_000, maxStaleRetries: 1, retryBackoffMs: [1, 2] },
      { staleAfterMs: 900_000, maxStaleRetries: 99, retryBackoffMs: [1] },
      { staleAfterMs: 0, maxStaleRetries: 0, retryBackoffMs: [1] },
    ];
    const seeds: Array<(appendWorldEvents: (events: EventInput[]) => void) => void> = [
      seedGenuinelyStaleRun,
      (appendWorldEvents) => {
        seedGenuinelyStaleRun(appendWorldEvents);
        appendWorldEvents(withNotificationTrigger(gateFired({ appSessionId: SESSION_ID, prompt: 'p' })));
      },
      (appendWorldEvents) => {
        seedGenuinelyStaleRun(appendWorldEvents);
        appendWorldEvents([
          livenessChanged({ appSessionId: SESSION_ID, to: 'dormant', cause: 'idle' }),
        ]);
      },
    ];

    const emittedTypes = new Set<string>();
    let anyReportSeen = false;
    for (const policy of policies) {
      for (const seed of seeds) {
        const harness = buildHarness({ seed, policy });
        // Several checks each, so the escalation ladder is climbed as far as
        // the policy allows rather than sampled at its first rung.
        for (let checkIndex = 0; checkIndex < 5; checkIndex += 1) {
          harness.appendWorldEvents([
            attentionCleared({ appSessionId: SESSION_ID, cause: 'dismissed' }),
          ]);
          harness.watchdog.checkOnce();
        }
        for (const event of harness.emitted) {
          emittedTypes.add(event.type);
        }
        anyReportSeen ||= staleEventsIn(harness.emitted).length > 0;
      }
    }
    // Non-vacuous: the matrix really did report staleness somewhere.
    expect(anyReportSeen).toBe(true);
    expect([...emittedTypes].sort()).toEqual(
      [EVENT_TYPES.notificationTrigger, EVENT_TYPES.watchdogStale].sort(),
    );
  });
});

describe('task watchdog — determinism and the clock (rule 0.3)', () => {
  // ASSERTION 11.
  it('reads the clock ONCE per check, and only through nowIso', () => {
    const harness = buildHarness({ seed: seedGenuinelyStaleRun });
    harness.watchdog.checkOnce();
    expect(harness.nowIsoCallCount()).toBe(1);
    harness.watchdog.checkOnce();
    expect(harness.nowIsoCallCount()).toBe(2);
  });

  it('installs NO timer — checkOnce is called, never scheduled', () => {
    vi.useFakeTimers();
    const harness = buildHarness({ seed: seedGenuinelyStaleRun });
    expect(vi.getTimerCount()).toBe(0);
    harness.watchdog.checkOnce();
    harness.watchdog.checkOnce();
    // Constructing and running the watchdog scheduled nothing: the cadence is
    // the daemon boundary's business (app.ts), so tests drive the check by hand.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is deterministic under a fixed clock — repeated checks agree', () => {
    // A HEALTHY run, so no emission changes the state between calls: the same
    // inputs and the same instant must produce the same summary, forever.
    const harness = buildHarness({
      seed: (appendWorldEvents) => {
        seedGenuinelyStaleRun(appendWorldEvents);
        appendWorldEvents(withNotificationTrigger(gateFired({ appSessionId: SESSION_ID, prompt: 'p' })));
      },
    });
    const summaries = [
      harness.watchdog.checkOnce(),
      harness.watchdog.checkOnce(),
      harness.watchdog.checkOnce(),
    ].map((summary) => JSON.stringify(summary));
    expect(summaries[1]).toBe(summaries[0]);
    expect(summaries[2]).toBe(summaries[0]);
    expect(harness.emitted).toEqual([]);
  });
});

describe('task watchdog — totality (I8): hostile and missing state never throw', () => {
  // ASSERTION 13.
  it('a task whose session is missing from the projection is skipped, not thrown on', () => {
    const harness = buildHarness({
      // No seed at all: the task references a session the projection never saw.
      tasks: [taskRecord()],
    });
    let summary!: ReturnType<TaskWatchdog['checkOnce']>;
    expect(() => {
      summary = harness.watchdog.checkOnce();
    }).not.toThrow();
    expect(harness.emitted).toEqual([]);
    expect(summary.outcomes).toEqual([
      { outcome: 'unknown-session', taskId: TASK_ID, appSessionId: SESSION_ID },
    ]);
  });

  it('a task with NO session refs is examined as zero runs', () => {
    const harness = buildHarness({ tasks: [taskRecord({ sessionRefs: [] })] });
    const summary = harness.watchdog.checkOnce();
    expect(summary.runsExamined).toBe(0);
    expect(harness.emitted).toEqual([]);
  });

  it('an EMPTY board writes nothing and reads the clock once', () => {
    const harness = buildHarness({ tasks: [] });
    const summary = harness.watchdog.checkOnce();
    expect(summary).toMatchObject({ runsExamined: 0, staleReportsEmitted: 0 });
    expect(harness.emitted).toEqual([]);
  });

  it('a session record whose liveness is outside the schema enum is left alone', () => {
    // The boundary reason `assessStageRun` widens its predicates to `string`:
    // old snapshots are not validated on load, so a value outside today's enum
    // can physically reach the runner. Ungoverned ⇒ no escalation.
    const harness = buildHarness({
      readSessions: () => ({
        sessions: {
          [SESSION_ID]: {
            appSessionId: SESSION_ID,
            channel: 'sdk',
            cwd: PROJECT_ROOT,
            claudeSessionIds: [],
            liveness: 'zombified' as never,
            needsAttention: null,
            seenAt: null,
            forkedFrom: null,
            taskRef: null,
            observedTtlTier: 'unknown',
            observedBillingBucket: 'unknown',
            name: null,
            createdAt: RUN_START_ISO,
            provider: 'claude-code',
            custody: 'host',
            lastAppendAt: RUN_START_ISO,
          },
        },
      }),
    });
    expect(() => harness.watchdog.checkOnce()).not.toThrow();
    expect(harness.emitted).toEqual([]);
  });

  it('two tasks referencing the SAME session still produce at most one record per check', () => {
    // Not a shape the dispatcher produces, but the log is forever and the dedup
    // reads a sessions state captured once per check — so the guard is explicit
    // rather than incidental.
    const harness = buildHarness({
      seed: seedGenuinelyStaleRun,
      tasks: [
        taskRecord(),
        taskRecord({
          taskId: SECOND_TASK_ID,
          sessionRefs: [{ stage: 'review', appSessionId: SESSION_ID }],
        }),
      ],
    });
    const summary = harness.watchdog.checkOnce();
    expect(staleEventsIn(harness.emitted)).toHaveLength(1);
    expect(summary.runsExamined).toBe(2);
    expect(summary.outcomes.map((outcome) => outcome.outcome)).toEqual([
      'reported',
      'already-reported',
    ]);
  });

  it('reports each of several genuinely stale runs exactly once', () => {
    const harness = buildHarness({
      seed: (appendWorldEvents) => {
        seedGenuinelyStaleRun(appendWorldEvents);
        appendWorldEvents([
          sessionCreated({
            appSessionId: SECOND_SESSION_ID,
            channel: 'sdk',
            cwd: PROJECT_ROOT,
            name: null,
            forkedFrom: null,
            taskRef: null,
          }),
        ]);
        appendWorldEvents([
          livenessChanged({ appSessionId: SECOND_SESSION_ID, to: 'running', cause: 'spawned' }),
        ]);
        appendWorldEvents([
          message({ appSessionId: SECOND_SESSION_ID, role: 'assistant', content: 'working' }),
        ]);
      },
      tasks: [
        taskRecord(),
        taskRecord({
          taskId: SECOND_TASK_ID,
          sessionRefs: [{ stage: 'implementing', appSessionId: SECOND_SESSION_ID }],
        }),
      ],
    });
    harness.watchdog.checkOnce();
    harness.watchdog.checkOnce();
    const staleEvents = staleEventsIn(harness.emitted);
    expect(staleEvents).toHaveLength(2);
    expect(staleEvents.map((event) => event.stream).sort()).toEqual(
      [SESSION_ID, SECOND_SESSION_ID].sort(),
    );
  });
});

// ─── ASSERTION 12 — the config boundary ──────────────────────────────────────
describe('watchdog config — the boundary refuses an empty backoff curve', () => {
  it('rejects VIMES_WATCHDOG_BACKOFF_MS set to the empty string', () => {
    // Every other list-shaped knob reads empty as "disable the feature"; this
    // one MUST NOT, because `assessStageRun` answers an empty curve with
    // `retryAfterMs: 0` — which a runner would read as "retry immediately", a
    // hot loop against a wedged run. It cannot bite today (nothing retries);
    // refusing it now is free.
    expect(() => loadConfigFromEnv({ VIMES_WATCHDOG_BACKOFF_MS: '' })).toThrow(
      /at least one backoff delay/,
    );
    expect(() => loadConfigFromEnv({ VIMES_WATCHDOG_BACKOFF_MS: ' , , ' })).toThrow(
      /at least one backoff delay/,
    );
  });

  it('rejects a curve entry that is not a non-negative integer', () => {
    expect(() => loadConfigFromEnv({ VIMES_WATCHDOG_BACKOFF_MS: '1000,abc' })).toThrow(
      /VIMES_WATCHDOG_BACKOFF_MS/,
    );
    expect(() => loadConfigFromEnv({ VIMES_WATCHDOG_BACKOFF_MS: '1000,-5' })).toThrow(
      /VIMES_WATCHDOG_BACKOFF_MS/,
    );
  });

  it('accepts a real curve, and defaults to a non-empty one', () => {
    expect(loadConfigFromEnv({ VIMES_WATCHDOG_BACKOFF_MS: '1000,2000' }).watchdogRetryBackoffMs).toEqual([
      1000, 2000,
    ]);
    expect(loadConfigFromEnv({}).watchdogRetryBackoffMs.length).toBeGreaterThan(0);
  });

  it('the check interval accepts 0 (the disable switch) and defaults to a cadence', () => {
    expect(loadConfigFromEnv({ VIMES_WATCHDOG_CHECK_MS: '0' }).watchdogCheckIntervalMs).toBe(0);
    expect(loadConfigFromEnv({}).watchdogCheckIntervalMs).toBeGreaterThan(0);
  });

  it('carries D30 PINNED band as a real default, and the UNPINNED episode ceiling as a knob', () => {
    // The band is signed off (D30) so it may be a default. The episode ceiling
    // is a ⟨tune⟩ PREVIEW — asserted only to EXIST and be overridable, never
    // that its value is right (rule 0.2: no unpinned number may become a
    // FAIL-able assertion).
    expect(loadConfigFromEnv({}).watchdogStaleAfterMs).toBe(900_000);
    expect(loadConfigFromEnv({ VIMES_WATCHDOG_STALE_AFTER_MS: '60000' }).watchdogStaleAfterMs).toBe(60_000);
    expect(loadConfigFromEnv({}).watchdogMaxStaleEpisodes).toBeGreaterThan(0);
    expect(
      loadConfigFromEnv({ VIMES_WATCHDOG_MAX_STALE_EPISODES: '7' }).watchdogMaxStaleEpisodes,
    ).toBe(7);
  });
});

// ─── ASSERTION 12 (second half) + the section-D wiring ───────────────────────
//
// A real daemon over a temp sqlite file — the same harness daemonBoot.test.ts
// uses. NO Claude process is spawned (nothing calls spawnSession), no network is
// touched (the usage poller and the cost ingester are both disabled), and the
// db lives in a temp dir that is removed afterwards. The point is the WIRING:
// that the timer exists when the interval is positive, does not when it is 0,
// dies with stop(), and that a check running inside the live daemon writes
// exactly one record through the real router and projections.
const wiringTemporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-watchdog-'));
let wiringDatabaseCounter = 0;
const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

afterAll(() => {
  rmSync(wiringTemporaryDirectory, { recursive: true, force: true });
});

function buildWiringConfig(overrides: Partial<DaemonConfig>): DaemonConfig {
  wiringDatabaseCounter += 1;
  const dbPath = join(wiringTemporaryDirectory, `watchdog-${wiringDatabaseCounter}.db`);
  return {
    port: 0,
    hookPort: 0,
    dbPath,
    dataDir: dirname(dbPath),
    expectedCliVersion: undefined,
    expectedSdkCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots: [],
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    watchdogCheckIntervalMs: 0,
    watchdogStaleAfterMs: 900_000,
    watchdogMaxStaleEpisodes: 3,
    watchdogRetryBackoffMs: [60_000],
    ...overrides,
  };
}

// A clock the test MOVES BY HAND, so a run can be made ten hours silent without
// ten hours passing. The daemon stamps every event and every watchdog check from
// this one source (rule 0.3) — there is no other clock to disagree with.
function movableClock(startIso: string): Clock & { setNow: (iso: string) => void } {
  let currentIso = startIso;
  return {
    now: () => currentIso,
    setNow: (iso: string) => {
      currentIso = iso;
    },
  };
}

function startWiringDaemon(config: DaemonConfig, clock: Clock): Promise<Daemon> {
  const daemon = createDaemon({
    config,
    clock,
    ids: uniqueIdSource,
    verifier: permissiveVerifier,
  });
  return daemon.start().then(() => daemon);
}

// Seed a genuinely wedged stage run into the LIVE daemon's log: a session that
// appended once at `startIso` and a task that references it.
function seedWedgedRunInDaemon(daemon: Daemon): void {
  daemon.router.emit([
    sessionCreated({
      appSessionId: SESSION_ID,
      channel: 'sdk',
      cwd: PROJECT_ROOT,
      name: null,
      forkedFrom: null,
      taskRef: null,
    }),
  ]);
  daemon.router.emit([livenessChanged({ appSessionId: SESSION_ID, to: 'running', cause: 'spawned' })]);
  daemon.router.emit([message({ appSessionId: SESSION_ID, role: 'assistant', content: 'working' })]);
  daemon.router.emit([
    taskCreated({
      taskId: TASK_ID,
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'implementing',
    }),
  ]);
  daemon.router.emit([
    taskSessionAttached({ taskId: TASK_ID, stage: 'implementing', appSessionId: SESSION_ID }),
  ]);
}

function countStaleRecordsInDaemon(daemon: Daemon): number {
  return daemon.store
    .read(SESSION_ID, 1)
    .filter((record) => record.type === EVENT_TYPES.watchdogStale).length;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadlineMs) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

describe('watchdog wiring — the daemon owns the timer (slice 6 step 5b)', () => {
  it('interval 0 installs NO timer, and no wedged run is ever reported', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clock = movableClock(RUN_START_ISO);
    const daemon = await startWiringDaemon(
      buildWiringConfig({ watchdogCheckIntervalMs: 0 }),
      clock,
    );
    try {
      seedWedgedRunInDaemon(daemon);
      // Ten hours later — unambiguously past any band.
      clock.setNow(NOW_TEN_HOURS_LATER);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      expect(countStaleRecordsInDaemon(daemon)).toBe(0);
      // Structural half: no interval was scheduled at the watchdog's cadence.
      const scheduledDelays = setIntervalSpy.mock.calls.map((call) => call[1]);
      expect(scheduledDelays).not.toContain(25);
    } finally {
      await daemon.stop();
      setIntervalSpy.mockRestore();
    }
  });

  it('a positive interval schedules the check, which reports the wedged run ONCE', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clock = movableClock(RUN_START_ISO);
    const daemon = await startWiringDaemon(
      buildWiringConfig({ watchdogCheckIntervalMs: 25 }),
      clock,
    );
    try {
      expect(setIntervalSpy.mock.calls.map((call) => call[1])).toContain(25);
      seedWedgedRunInDaemon(daemon);
      // Before the clock moves, the run is fresh: several ticks must pass with
      // NOTHING written. This is the non-vacuity half — the timer is running and
      // deliberately silent.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(countStaleRecordsInDaemon(daemon)).toBe(0);

      clock.setNow(NOW_TEN_HOURS_LATER);
      await waitUntil(() => countStaleRecordsInDaemon(daemon) > 0);
      expect(countStaleRecordsInDaemon(daemon)).toBe(1);
      // Many further ticks, still ONE record: the dedup holds inside the live
      // daemon, through the real projections, not just against a fake.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      expect(countStaleRecordsInDaemon(daemon)).toBe(1);
      // And nothing destructive was ever written.
      expect(
        daemon.store.read(SESSION_ID, 1).some((record) => record.type === EVENT_TYPES.taskQuarantined),
      ).toBe(false);
    } finally {
      await daemon.stop();
      setIntervalSpy.mockRestore();
    }
  });

  it('stop() clears the watchdog timer — asserted on the HANDLE, not on silence', async () => {
    // Asserted structurally because the behavioural version is vacuous: the
    // interval callback swallows its own errors, so an uncleared timer firing
    // against a closed db would look exactly like a cleared one. So the test
    // follows the identity of the handle: the interval scheduled at the
    // watchdog's cadence must be the one handed to clearInterval by stop().
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clock = movableClock(RUN_START_ISO);
    const daemon = await startWiringDaemon(
      buildWiringConfig({ watchdogCheckIntervalMs: 25 }),
      clock,
    );
    try {
      seedWedgedRunInDaemon(daemon);
      clock.setNow(NOW_TEN_HOURS_LATER);
      await waitUntil(() => countStaleRecordsInDaemon(daemon) > 0);
      expect(countStaleRecordsInDaemon(daemon)).toBe(1);
    } finally {
      const watchdogTimerHandles = setIntervalSpy.mock.calls
        .map((call, callIndex) => ({ delayMs: call[1], handle: setIntervalSpy.mock.results[callIndex]!.value }))
        .filter((scheduled) => scheduled.delayMs === 25)
        .map((scheduled) => scheduled.handle);
      expect(watchdogTimerHandles).toHaveLength(1);
      await daemon.stop();
      expect(clearIntervalSpy.mock.calls.map((call) => call[0])).toContain(watchdogTimerHandles[0]);
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
