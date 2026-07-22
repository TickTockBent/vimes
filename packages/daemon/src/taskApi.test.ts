import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  readAllStreamsGrouped,
  replayFromEmpty,
  tasksProjection,
  type EventRecord,
  type IdSource,
  type MeterRecord,
  type MetersState,
  type TaskRecord,
} from '@vimes/core';
import { createAccessAuthMiddleware, type AccessVerifier } from './auth.js';
import { createDaemon, NO_OBSERVATION_IS_FRESH_STALE_BAND_MS, type Daemon, type DaemonDeps } from './app.js';
import type { DaemonConfig } from './config.js';
import { registerTaskApi, type CreateTaskResponse, type DispatchResponse, type ProposeTransitionResponse } from './taskApi.js';
import { TaskWriter } from './taskWriter.js';
import { TaskDispatcher } from './taskDispatcher.js';
import type { SdkQueryFactory, SdkStreamMessage, SpawnResult } from './sessionHost.js';

// ─── slice 6 step 4b — the task API over real HTTP requests ──────────────────
//
// ⚠ NOTHING IN THIS FILE SPAWNS A REAL CLAUDE PROCESS. The composed-app half
// drives a FAKE session host that records instead of spawning; the daemon half
// injects a fake SDK query factory (the hookIngress.test.ts pattern) and never
// reads ~/.claude, never touches the live daemon, and writes only into a temp dir.
//
// ⚠ THE INSTRUMENTS THAT MATTER ARE THE EVENT LOG AND THE SPAWN-CALL COUNTER,
// NOT THE STATUS CODE. Three of the invariants this step carries are only
// observable there:
//   • I7  — a rejection is EVENTED, not merely returned (409 alone proves nothing).
//   • I10 — a failed gate NEVER REACHES the session host (a `dispatch_refused`
//           emitted AFTER a spawn would satisfy an events-only check while
//           violating the invariant outright).
//   • the 403 wall — a refused creation leaves NO task-shaped record behind.
// So every such case asserts the log head did not move, or that the spawn
// recorder is empty, in addition to whatever came back over the wire.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-taskapi-'));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

const ANY_TOKEN = 'valid-token-stub';
// Rejects a missing/empty token, accepts anything else — the same shape
// auth.test.ts and hookIngress.test.ts use to make the I14 wall testable without
// minting real JWTs.
const tokenRequiredVerifier: AccessVerifier = {
  verify: async (token) =>
    token === undefined || token === '' ? { ok: false, reason: 'missing-token' } : { ok: true },
};

// `null` means SEND NO TOKEN AT ALL — deliberately a distinct sentinel from
// `undefined`, which would silently fall back to the default and turn an I14 case
// into an authenticated request that happens to pass.
function authHeaders(token: string | null = ANY_TOKEN): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === null ? {} : { 'cf-access-jwt-assertion': token }),
  };
}

// ── the composed-app harness ─────────────────────────────────────────────────
//
// Composed the SAME WAY app.ts composes it: the real auth middleware on `*`,
// then registerTaskApi, over a real TaskWriter and a real TaskDispatcher. The
// only fakes are the session host and the meters.

interface RecordedSpawn {
  channel: 'sdk' | 'pty';
  cwd: string;
}

class RecordingSessionHost {
  readonly spawnCalls: RecordedSpawn[] = [];
  private nextSpawnResult: SpawnResult = { appSessionId: 'ffffffff-0000-4000-8000-000000000001' };
  private readonly liveSessionIds = new Set<string>();

  spawnSession(options: { channel: 'sdk' | 'pty'; cwd: string; name?: string }): SpawnResult {
    this.spawnCalls.push({ channel: options.channel, cwd: options.cwd });
    return this.nextSpawnResult;
  }

  isLive(appSessionId: string): boolean {
    return this.liveSessionIds.has(appSessionId);
  }

  refuseNextSpawn(reason: string): void {
    this.nextSpawnResult = { refused: true, reason };
  }
}

const FIXED_NOW = '2026-07-22T12:00:00.000Z';
const FRESH_STALE_BAND_MS = 90_000;

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

interface ApiHarness {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  sessionHost: RecordingSessionHost;
  // Every record on the 'tasks' stream, in order.
  taskEvents: () => EventRecord[];
  taskEventTypes: () => string[];
  // The 'tasks' stream head — the "did anything get written" instrument.
  tasksHead: () => number;
  dispatchCallCount: () => number;
  allowedRoot: string;
  outsideRoot: string;
}

function buildApiHarness(
  options: { meters?: MetersState; staleAfterMs?: number } = {},
): ApiHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock(FIXED_NOW, 1000),
    ids: new CountingIdSource(),
  });
  const sessionHost = new RecordingSessionHost();
  // Real directories, so `resolveWithinRoots` runs its REAL symlink-aware probe
  // rather than a fake that could agree with a wrong implementation.
  const allowedRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'root-')));
  const outsideRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'outside-')));
  const metersState: MetersState = options.meters ?? {
    meters: { 'window-5h': meterRecord() },
    history: {},
  };
  let dispatchCallCount = 0;

  const readTasks = () => replayFromEmpty(tasksProjection, readAllStreamsGrouped(store));
  const emit = (events: Parameters<MemoryEventStore['append']>[0]): void => {
    store.append(events);
  };

  const taskWriter = new TaskWriter({ emit, readTasks, ids: new CountingIdSource() });
  const taskDispatcher = new TaskDispatcher({
    sessionHost,
    emit,
    readTasks,
    readMeters: () => metersState,
    nowIso: () => FIXED_NOW,
    staleAfterMs: options.staleAfterMs ?? FRESH_STALE_BAND_MS,
  });

  const app = new Hono();
  // I14 exactly as app.ts installs it: auth in front of EVERYTHING, registered
  // BEFORE any route, so no handler can run without the middleware passing first.
  app.use(
    '*',
    createAccessAuthMiddleware({
      verifier: tokenRequiredVerifier,
      // A rejection writes to the SYSTEM stream in production; here it is a no-op
      // so the 'tasks' stream head stays a clean instrument for "the route wrote
      // something".
      emitAuthRejected: () => {},
    }),
  );
  registerTaskApi(app, {
    taskWriter,
    dispatchTask: (taskId) => {
      dispatchCallCount += 1;
      return taskDispatcher.dispatchTask(taskId);
    },
    getAllowedRoots: () => [allowedRoot],
  });

  return {
    request: async (path, init) => app.request(path, init),
    sessionHost,
    taskEvents: () => store.read('tasks', 1),
    taskEventTypes: () => store.read('tasks', 1).map((record) => record.type),
    tasksHead: () => store.head('tasks'),
    dispatchCallCount: () => dispatchCallCount,
    allowedRoot,
    outsideRoot,
  };
}

function postJson(body: unknown, token: string | null = ANY_TOKEN): RequestInit {
  return {
    method: 'POST',
    headers: authHeaders(token),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

async function createTaskThrough(
  harness: ApiHarness,
  overrides: Record<string, unknown> = {},
): Promise<TaskRecord> {
  const response = await harness.request(
    '/api/tasks',
    postJson({ projectRoot: harness.allowedRoot, createdBy: 'human', ...overrides }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateTaskResponse).task;
}

// ── assertion 8: create ──────────────────────────────────────────────────────

describe('POST /api/tasks — create', () => {
  it('creates (201) and applies the D32 `worktree` and `backlog` defaults', async () => {
    // Assertion 8. D32 (spike S2) pinned `worktree` as the isolation default, and
    // this route is the FIRST PLACE IN CODE that default becomes real.
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/tasks',
      postJson({ projectRoot: harness.allowedRoot, createdBy: 'human' }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateTaskResponse;
    expect(body.task.isolation).toBe('worktree');
    expect(body.task.stage).toBe('backlog');
    expect(body.task.gates).toEqual({});
    expect(body.task.sessionRefs).toEqual([]);
    expect(body.task.manualReviewRequired).toBe(false);

    // Exactly one event, and it is the birth record.
    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.taskCreated]);
  });

  it('honours an explicit isolation and stage over the defaults', async () => {
    // The per-task override D32 deliberately retained.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, {
      isolation: 'shared-dir',
      stage: 'planning',
      createdBy: 'orchestrator',
    });
    expect(task.isolation).toBe('shared-dir');
    expect(task.stage).toBe('planning');
    expect(task.createdBy).toBe('orchestrator');
  });

  it('round-trips `gates` into the created record', async () => {
    // Assertion 8, the step-4b widening over the wire. Before this step no event
    // could carry gates at all, so I10's refusal path was unreachable in
    // production — this is the request that makes a gated task expressible.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, {
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 }, deferUntilReset: 'weekly-cap' },
    });
    expect(task.gates).toEqual({
      requireHeadroom: { meterId: 'window-5h', pct: 40 },
      deferUntilReset: 'weekly-cap',
    });
  });
});

// ── assertion 9: THE SECURITY BOUNDARY ───────────────────────────────────────

describe('POST /api/tasks — the projectRoot allowlist wall (403, and NOTHING is written)', () => {
  // ⚠ WHY THIS WALL EXISTS, in one line: `sessionHost.spawnSession()` does NOT
  // validate `cwd` — the only other guard in the daemon is inside
  // `wsHub.handleSpawn`. A task is a DURABLE instruction to spawn a Claude process
  // in a directory, so an unvalidated projectRoot here would be an allowlist
  // bypass WITH A PERSISTENCE LAYER: written once, honoured on every later
  // dispatch. Each case therefore asserts BOTH halves — the 403 AND that the
  // 'tasks' stream head did not move.

  it('refuses an absolute path outside the roots and writes no event', async () => {
    const harness = buildApiHarness();
    const headBefore = harness.tasksHead();

    const response = await harness.request(
      '/api/tasks',
      postJson({ projectRoot: harness.outsideRoot, createdBy: 'human' }),
    );

    expect(response.status).toBe(403);
    // THE LOAD-BEARING HALF: a refused creation left no task-shaped record.
    expect(harness.tasksHead()).toBe(headBefore);
    expect(harness.taskEvents()).toEqual([]);
  });

  it('refuses `..` traversal that climbs out of a root and writes no event', async () => {
    const harness = buildApiHarness();
    const headBefore = harness.tasksHead();

    const response = await harness.request(
      '/api/tasks',
      postJson({ projectRoot: `${harness.allowedRoot}/../../etc`, createdBy: 'human' }),
    );

    expect(response.status).toBe(403);
    expect(harness.tasksHead()).toBe(headBefore);
    expect(harness.taskEvents()).toEqual([]);
  });

  it('refuses a symlink inside a root that points OUT of it', async () => {
    // The reason `resolveWithinRoots` (and not a string prefix check) is the
    // guard: a lexically-contained path can still resolve outside the roots.
    const harness = buildApiHarness();
    const escapeLink = join(harness.allowedRoot, 'escape-hatch');
    symlinkSync(harness.outsideRoot, escapeLink);

    const response = await harness.request(
      '/api/tasks',
      postJson({ projectRoot: escapeLink, createdBy: 'human' }),
    );

    expect(response.status).toBe(403);
    expect(harness.taskEvents()).toEqual([]);
  });

  it('stores the RESOLVED path, never the raw input', async () => {
    // Assertion 9, third half. A record that kept `<root>/nested/..` would carry a
    // path that could resolve somewhere else later; the allowlist is checked once,
    // and what gets persisted is exactly what was checked.
    const harness = buildApiHarness();
    mkdirSync(join(harness.allowedRoot, 'nested'), { recursive: true });

    const task = await createTaskThrough(harness, {
      projectRoot: `${harness.allowedRoot}/nested/..`,
    });

    expect(task.projectRoot).toBe(harness.allowedRoot);
    expect(task.projectRoot).not.toContain('..');
    // And the LOG carries the resolved path too, not just the response.
    expect(harness.taskEvents()[0]!.payload).toMatchObject({ projectRoot: harness.allowedRoot });
  });
});

// ── assertion 10: I7 over HTTP ───────────────────────────────────────────────

describe('POST /api/tasks/:taskId/transitions — I7 over HTTP', () => {
  it('accepts a legal edge: 200 + the moved task, one task_transitioned', async () => {
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);

    const response = await harness.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'planning', proposedBy: 'human' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProposeTransitionResponse;
    expect(body).toEqual({
      accepted: true,
      task: { ...task, stage: 'planning' },
    });
    expect(harness.taskEventTypes()).toEqual([
      EVENT_TYPES.taskCreated,
      EVENT_TYPES.taskTransitioned,
    ]);
  });

  it('409 WITH the reason, AND the rejection is in the log — both halves', async () => {
    // Assertion 10, and the point of I7. A route that returned the right 409 and
    // wrote nothing would pass any status-code check while violating the
    // invariant: "the machine returned a rejection" is not the invariant,
    // "the rejection was written down" is.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);

    const response = await harness.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'review', proposedBy: 'orchestrator' }),
    );

    // Half one: the wire.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ accepted: false, reason: 'illegal-edge' });

    // Half two: THE LOG.
    expect(harness.taskEventTypes()).toEqual([
      EVENT_TYPES.taskCreated,
      EVENT_TYPES.taskTransitionRejected,
    ]);
    expect(harness.taskEvents()[1]!.payload).toEqual({
      taskId: task.taskId,
      fromStage: 'backlog',
      attemptedToStage: 'review',
      reason: 'illegal-edge',
      proposedBy: 'orchestrator',
    });
  });

  it('an UNKNOWN STAGE is refused BY THE MACHINE (409 + evented), not by zod', async () => {
    // ⚠ THE BRANCH THAT WOULD VANISH IF `toStage` WERE VALIDATED AS THE ENUM.
    // Step 1 typed the rejection payload's stage fields as `z.string()` precisely
    // so an `unknown-stage` rejection stays RECORDABLE. A 400 here would leave the
    // one case slice 7's hostile input cares about most with nothing in the log.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);

    const response = await harness.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'shipped-it-lol', proposedBy: 'orchestrator' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ accepted: false, reason: 'unknown-stage' });
    expect(harness.taskEvents()[1]!.type).toBe(EVENT_TYPES.taskTransitionRejected);
    expect(harness.taskEvents()[1]!.payload).toMatchObject({
      attemptedToStage: 'shipped-it-lol',
      reason: 'unknown-stage',
    });
  });

  it('EVERY enumerated rejection reason returns 409 and is evented', async () => {
    // The status-code rationale, asserted rather than only written down: ONE code
    // for "the machine refused", so clients (and slice 7's MCP client) read the
    // `reason` field instead of branching on HTTP semantics we would then have to
    // keep stable forever.
    const rejectionCases: Array<{
      startingStage: TaskRecord['stage'];
      toStage: string;
      reason: string;
    }> = [
      { startingStage: 'backlog', toStage: 'review', reason: 'illegal-edge' },
      { startingStage: 'done', toStage: 'implementing', reason: 'terminal-stage' },
      { startingStage: 'planning', toStage: 'planning', reason: 'same-stage' },
      { startingStage: 'quarantined', toStage: 'done', reason: 'quarantined-cannot-complete' },
      { startingStage: 'backlog', toStage: 'not-a-stage', reason: 'unknown-stage' },
    ];

    for (const rejectionCase of rejectionCases) {
      const harness = buildApiHarness();
      const task = await createTaskThrough(harness, { stage: rejectionCase.startingStage });
      const response = await harness.request(
        `/api/tasks/${task.taskId}/transitions`,
        postJson({ toStage: rejectionCase.toStage, proposedBy: 'dispatcher' }),
      );

      expect(response.status, rejectionCase.reason).toBe(409);
      expect(await response.json()).toEqual({ accepted: false, reason: rejectionCase.reason });
      expect(harness.taskEventTypes()).toEqual([
        EVENT_TYPES.taskCreated,
        EVENT_TYPES.taskTransitionRejected,
      ]);
      // No `task_transitioned` rode along: the board did not move.
      expect(harness.taskEventTypes()).not.toContain(EVENT_TYPES.taskTransitioned);
    }
  });

  it('404 for an unknown taskId, and NOTHING is written', async () => {
    // Fabricating a rejection here would put a taskId in the tasks stream that no
    // `task_created` ever introduced.
    const harness = buildApiHarness();
    const headBefore = harness.tasksHead();

    const response = await harness.request(
      '/api/tasks/task-that-never-existed/transitions',
      postJson({ toStage: 'planning', proposedBy: 'human' }),
    );

    expect(response.status).toBe(404);
    expect(harness.tasksHead()).toBe(headBefore);
  });
});

// ── assertion 11: malformed bodies ───────────────────────────────────────────

describe('malformed input — 400, nothing evented, nothing crashes (I8)', () => {
  // ⚠ THE 400/409 LINE, WRITTEN DOWN: **409 means "the machine said no"** and the
  // rejection IS in the log. **400 means "this was not a proposal"** — the body
  // never reached the state machine, so there is nothing to record. A 400 that
  // evented would put proposals in the log that were never made.

  const malformedTransitionBodies: Array<{ caseName: string; body: unknown }> = [
    { caseName: 'unparseable JSON', body: '{ not json at all' },
    { caseName: 'empty body', body: '' },
    { caseName: 'a JSON array rather than an object', body: [1, 2, 3] },
    { caseName: 'missing required proposedBy', body: { toStage: 'planning' } },
    { caseName: 'missing required toStage', body: { proposedBy: 'human' } },
    { caseName: 'wrong-typed toStage (number)', body: { toStage: 7, proposedBy: 'human' } },
    {
      caseName: 'proposedBy outside the vocabulary',
      body: { toStage: 'planning', proposedBy: 'the-cat' },
    },
    {
      caseName: 'wrong-typed manualReviewRequired',
      body: { toStage: 'done', proposedBy: 'human', manualReviewRequired: 'yes' },
    },
  ];

  for (const malformedCase of malformedTransitionBodies) {
    it(`transitions: ${malformedCase.caseName} → 400, no event`, async () => {
      const harness = buildApiHarness();
      const task = await createTaskThrough(harness);
      const headAfterCreate = harness.tasksHead();

      const response = await harness.request(
        `/api/tasks/${task.taskId}/transitions`,
        postJson(malformedCase.body),
      );

      expect(response.status).toBe(400);
      expect(harness.tasksHead()).toBe(headAfterCreate);
      expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.taskCreated]);
    });
  }

  const malformedCreateBodies: Array<{ caseName: string; body: unknown }> = [
    { caseName: 'unparseable JSON', body: '}{' },
    { caseName: 'missing required projectRoot', body: { createdBy: 'human' } },
    { caseName: 'missing required createdBy', body: { projectRoot: '/tmp' } },
    { caseName: 'wrong-typed projectRoot (number)', body: { projectRoot: 5, createdBy: 'human' } },
    {
      caseName: 'isolation outside the vocabulary',
      body: { projectRoot: '/tmp', createdBy: 'human', isolation: 'a-submarine' },
    },
    {
      caseName: 'stage outside the vocabulary',
      body: { projectRoot: '/tmp', createdBy: 'human', stage: 'almost-done' },
    },
    {
      caseName: 'wrong-typed gates.requireHeadroom.pct',
      body: {
        projectRoot: '/tmp',
        createdBy: 'human',
        gates: { requireHeadroom: { meterId: 'window-5h', pct: 'lots' } },
      },
    },
    { caseName: 'null body', body: null },
  ];

  for (const malformedCase of malformedCreateBodies) {
    it(`create: ${malformedCase.caseName} → 400, no event`, async () => {
      const harness = buildApiHarness();
      const headBefore = harness.tasksHead();

      const response = await harness.request('/api/tasks', postJson(malformedCase.body));

      expect(response.status).toBe(400);
      expect(harness.tasksHead()).toBe(headBefore);
    });
  }

  it('a stage OUTSIDE the enum is a 400 on CREATE but a 409 on TRANSITION', async () => {
    // The asymmetry, stated on purpose because it looks like an inconsistency and
    // is not. A CREATE names the stage a task is BORN in — an unknown one is
    // simply not a task we can write, and no proposal was made. A TRANSITION
    // PROPOSES an edge, and refusing it is a decision the machine must RECORD.
    const harness = buildApiHarness();
    const createResponse = await harness.request(
      '/api/tasks',
      postJson({ projectRoot: harness.allowedRoot, createdBy: 'human', stage: 'nonsense' }),
    );
    expect(createResponse.status).toBe(400);
    expect(harness.taskEvents()).toEqual([]);

    const task = await createTaskThrough(harness);
    const transitionResponse = await harness.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'nonsense', proposedBy: 'human' }),
    );
    expect(transitionResponse.status).toBe(409);
    expect(harness.taskEvents()[1]!.type).toBe(EVENT_TYPES.taskTransitionRejected);
  });

  it('the daemon survives a barrage of hostile bodies (I8)', async () => {
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);
    const hostileBodies = [
      '{"toStage": "__proto__", "proposedBy": "human"}',
      '{"toStage": "", "proposedBy": "human"}',
      '{"toStage": {"nested": true}, "proposedBy": "human"}',
      '\u0000\u0001\u0002',
      '[]',
      'null',
      '"just a string"',
      '{"toStage":"planning","proposedBy":"human","note":' + '"' + 'x'.repeat(5000) + '"}',
    ];

    for (const hostileBody of hostileBodies) {
      const response = await harness.request(
        `/api/tasks/${task.taskId}/transitions`,
        postJson(hostileBody),
      );
      // Every one is answered — never a hang, never a 500.
      expect([200, 400, 409]).toContain(response.status);
    }
    // And the ones that were genuinely proposals were adjudicated by the machine,
    // never silently applied: nothing reached a stage nobody legally moved it to.
    const finalTypes = harness.taskEventTypes();
    expect(new Set(finalTypes)).toEqual(
      new Set([
        EVENT_TYPES.taskCreated,
        EVENT_TYPES.taskTransitionRejected,
        EVENT_TYPES.taskTransitioned,
      ]),
    );
  });
});

// ── assertion 12: I14 ────────────────────────────────────────────────────────

describe('I14 — every task route is behind the auth wall', () => {
  // The middleware is registered on `*` BEFORE any route (exactly as app.ts does
  // it), so the handler cannot run at all without it passing. Each case asserts
  // the handler's SIDE EFFECTS are absent, not merely that the status is 401 —
  // a route that ran and then 401'd would still have written an event.
  const taskRoutes: Array<{ routeName: string; path: string; body: unknown }> = [
    { routeName: 'create', path: '/api/tasks', body: { projectRoot: '/tmp', createdBy: 'human' } },
    {
      routeName: 'transitions',
      path: '/api/tasks/any-task/transitions',
      body: { toStage: 'planning', proposedBy: 'human' },
    },
    { routeName: 'dispatch', path: '/api/tasks/any-task/dispatch', body: {} },
  ];

  for (const taskRoute of taskRoutes) {
    it(`${taskRoute.routeName}: NO token → 401, no event, no spawn`, async () => {
      const harness = buildApiHarness();
      const headBefore = harness.tasksHead();

      const response = await harness.request(
        taskRoute.path,
        postJson(taskRoute.body, null),
      );

      expect(response.status).toBe(401);
      expect(harness.tasksHead()).toBe(headBefore);
      expect(harness.sessionHost.spawnCalls).toEqual([]);
      // The dispatcher was never even consulted.
      expect(harness.dispatchCallCount()).toBe(0);
    });

    it(`${taskRoute.routeName}: EMPTY token → 401, no event, no spawn`, async () => {
      const harness = buildApiHarness();
      const headBefore = harness.tasksHead();

      const response = await harness.request(taskRoute.path, postJson(taskRoute.body, ''));

      expect(response.status).toBe(401);
      expect(harness.tasksHead()).toBe(headBefore);
      expect(harness.sessionHost.spawnCalls).toEqual([]);
      expect(harness.dispatchCallCount()).toBe(0);
    });
  }
});

// ── assertion 13: dispatch ───────────────────────────────────────────────────

describe('POST /api/tasks/:taskId/dispatch — one explicit attempt', () => {
  // CONVENTION UNDER TEST: **200 + the envelope for every honest outcome**.
  // A refusal is a complete answer, not an HTTP error — mirrors
  // `/api/usage/refresh` (documented in app.ts). 4xx-ing it would push clients
  // toward retry/backoff machinery for what is really "here is what happened".

  it('spawned → 200 + the envelope, and dispatchTask ran EXACTLY once', async () => {
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, { stage: 'planning' });

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DispatchResponse;
    expect(body.result).toMatchObject({ outcome: 'spawned', taskId: task.taskId, stage: 'planning' });
    expect(harness.dispatchCallCount()).toBe(1);
    expect(harness.sessionHost.spawnCalls).toEqual([{ channel: 'sdk', cwd: harness.allowedRoot }]);
  });

  it('deferred → 200 + the envelope (and a defer still emits nothing)', async () => {
    const harness = buildApiHarness({
      meters: {
        meters: { 'window-5h': meterRecord({ resetsAt: '2026-07-22T13:00:00.000Z' }) },
        history: {},
      },
    });
    const task = await createTaskThrough(harness, {
      stage: 'planning',
      gates: { deferUntilReset: 'window-5h' },
    });
    const eventsAfterCreate = harness.taskEventTypes();

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DispatchResponse;
    expect(body.result).toMatchObject({ outcome: 'deferred', reason: 'awaiting-meter-reset' });
    // Step 4a's rule holds through the HTTP surface: a defer is not a refusal and
    // writes nothing.
    expect(harness.taskEventTypes()).toEqual(eventsAfterCreate);
  });

  it('refused → 200 + the envelope carrying the DECISION reason', async () => {
    const harness = buildApiHarness();
    // `backlog` is not a dispatchable stage.
    const task = await createTaskThrough(harness);

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DispatchResponse;
    expect(body.result).toEqual({
      outcome: 'refused',
      taskId: task.taskId,
      reason: 'stage-not-dispatchable',
    });
    expect(harness.sessionHost.spawnCalls).toEqual([]);
  });

  it('spawn-failed → 200 + the envelope carrying the HOST\'s reason verbatim', async () => {
    const harness = buildApiHarness();
    harness.sessionHost.refuseNextSpawn('preflight-failed');
    const task = await createTaskThrough(harness, { stage: 'implementing' });

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DispatchResponse;
    expect(body.result).toEqual({
      outcome: 'spawn-failed',
      taskId: task.taskId,
      reason: 'preflight-failed',
    });
  });

  it('404 for an unknown task, and dispatchTask still ran only once', async () => {
    const harness = buildApiHarness();
    const response = await harness.request('/api/tasks/no-such-task/dispatch', postJson({}));

    expect(response.status).toBe(404);
    expect(harness.dispatchCallCount()).toBe(1);
    expect(harness.sessionHost.spawnCalls).toEqual([]);
  });

  it('N requests produce EXACTLY N attempts — no loop, no retry, no scheduling', async () => {
    // Step 4a's boundary through the HTTP surface: one request, one attempt. A
    // route that retried internally would show more attempts than requests here.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);
    for (let requestIndex = 0; requestIndex < 4; requestIndex += 1) {
      await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));
    }
    expect(harness.dispatchCallCount()).toBe(4);
  });
});

// ── assertion 14: I10, end to end over HTTP ──────────────────────────────────

describe('I10 end-to-end over HTTP — a failed gate never reaches the session host', () => {
  it('refuses `headroom-insufficient`, spawns ZERO times, and events exactly one dispatch_refused', async () => {
    // Assertion 14, the whole point of gating tasks. The FIRST assertion is the
    // invariant: `spawnCalls` is EMPTY. An implementation that spawned and THEN
    // emitted a refusal would satisfy an events-only check while violating I10
    // outright.
    //
    // This is also the first time the chain is complete in production: the gate
    // could not be SET before step 4b widened `task_created`, so until this commit
    // I10's refusal path was reachable only from a test.
    const harness = buildApiHarness({
      meters: { meters: { 'window-5h': meterRecord({ percent: 40 }) }, history: {} },
    });
    const task = await createTaskThrough(harness, {
      stage: 'implementing',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } },
    });

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    // 1. THE INVARIANT: the session host was never reached.
    expect(harness.sessionHost.spawnCalls).toEqual([]);

    // 2. The refusal is EVENTED — exactly one `dispatch_refused`.
    const refusals = harness.taskEvents().filter(
      (record) => record.type === EVENT_TYPES.dispatchRefused,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.payload).toEqual({
      taskId: task.taskId,
      reason: 'headroom-insufficient',
    });

    // 3. And the caller was told, honestly, in a 200 envelope.
    expect(response.status).toBe(200);
    expect(((await response.json()) as DispatchResponse).result).toEqual({
      outcome: 'refused',
      taskId: task.taskId,
      reason: 'headroom-insufficient',
    });
  });

  it('a PASSING gate still spawns — the gate refuses, it does not block everything', async () => {
    // The other direction, so the guard cannot degrade into "a gated task never
    // runs". 10% used against a 75% requirement passes.
    const harness = buildApiHarness({
      meters: { meters: { 'window-5h': meterRecord({ percent: 10 }) }, history: {} },
    });
    const task = await createTaskThrough(harness, {
      stage: 'implementing',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } },
    });

    await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(
      harness.taskEvents().filter((record) => record.type === EVENT_TYPES.dispatchRefused),
    ).toEqual([]);
  });
});

// ── assertion 15: the NO_OBSERVATION_IS_FRESH degenerate band ───────────────

describe('NO_OBSERVATION_IS_FRESH_STALE_BAND_MS — the poller-disabled band', () => {
  // `deriveStaleAfterMs` returns null when the usage poller is off, and
  // `TaskDispatcher` requires a number. Rule 0.2 forbids fabricating a band, and
  // disabling dispatch entirely would make the task system depend on an unrelated
  // feature being switched on. So the daemon passes the DEGENERATE band meaning
  // "nothing counts as fresh" — the literal truth when nothing is being observed.
  // D33 (decisions.md, 2026-07-22) pinned the value at -1: `meterFreshness` uses a
  // strict `>`, so -1 is the value that makes "nothing is fresh" true for every
  // non-negative observation age, closing the one-millisecond gap a band of 0
  // used to leave open.

  it('is -1 — the sentinel that makes every non-negative age stale (D33)', () => {
    expect(NO_OBSERVATION_IS_FRESH_STALE_BAND_MS).toBe(-1);
  });

  it('a requireHeadroom task refuses `headroom-unknown` and NEVER reaches spawnSession', async () => {
    // Assertion 15, first half. The meter reads 1% used — a number that would sail
    // straight through the gate — but under a zero band no observation of any
    // ELAPSED age counts as current, so the honest answer is "we cannot see
    // headroom", NOT "you are out of it". Pillar 4: the two are different facts
    // and must not share a reason.
    const harness = buildApiHarness({
      staleAfterMs: NO_OBSERVATION_IS_FRESH_STALE_BAND_MS,
      meters: {
        // ONE MILLISECOND old. Deliberately not `observedAt: FIXED_NOW` — see the
        // exact-tie case below, which pins why that distinction is real.
        meters: { 'window-5h': meterRecord({ percent: 1, observedAt: '2026-07-22T11:59:59.999Z' }) },
        history: {},
      },
    });
    const task = await createTaskThrough(harness, {
      stage: 'implementing',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 10 } },
    });

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(harness.sessionHost.spawnCalls).toEqual([]);
    expect(((await response.json()) as DispatchResponse).result).toEqual({
      outcome: 'refused',
      taskId: task.taskId,
      reason: 'headroom-unknown',
    });
  });

  it('refuses a meter that has never been observed at all (the poller-off norm)', async () => {
    // With the poller disabled, `meter_sample` is written by nothing at all — the
    // ONLY emitter is `runUsagePoll` (app.ts). So the ordinary poller-off state is
    // "no meter record exists", and a gate against one is unknown regardless of
    // band. Asserted separately so the band's own contribution is not conflated
    // with this, which holds at any band.
    const harness = buildApiHarness({
      staleAfterMs: NO_OBSERVATION_IS_FRESH_STALE_BAND_MS,
      meters: { meters: {}, history: {} },
    });
    const task = await createTaskThrough(harness, {
      stage: 'implementing',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 10 } },
    });

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(harness.sessionHost.spawnCalls).toEqual([]);
    expect(((await response.json()) as DispatchResponse).result).toMatchObject({
      reason: 'headroom-unknown',
    });
  });

  it('D33: an observation stamped at EXACTLY `now` is STALE, and the gated task never reaches spawnSession', async () => {
    // D33 (decisions.md, 2026-07-22) CLOSED the gap this test used to PIN.
    //
    // `meterFreshness` (meterDerivations.ts) classifies with `age > staleAfterMs`,
    // a STRICT `>`. At the old band of 0, an observation whose age was EXACTLY
    // 0 ms read 'fresh' — the constant's name overstated its own guarantee by one
    // millisecond. At the pinned band of -1, that same exact-tie observation has
    // age 0 > -1, so it now reads 'stale': "nothing counts as fresh" is true for
    // every non-negative age, including the tie, not just for elapsed age.
    //
    // This is the exact case the pre-D33 version of this test pinned as a known
    // gap (an observation stamped at `FIXED_NOW` reading 'fresh' and the gate
    // evaluating a genuinely just-observed number). The decision inverted the
    // expected behaviour on purpose; this test now pins the guarantee instead.
    const harness = buildApiHarness({
      staleAfterMs: NO_OBSERVATION_IS_FRESH_STALE_BAND_MS,
      meters: { meters: { 'window-5h': meterRecord({ percent: 1, observedAt: FIXED_NOW }) }, history: {} },
    });
    const task = await createTaskThrough(harness, {
      stage: 'implementing',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 10 } },
    });

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    // The gate refused — headroom is UNKNOWN, not "insufficient" — and NO
    // spawnSession call was made. Assert the call count directly, not merely the
    // response envelope.
    expect(harness.sessionHost.spawnCalls).toEqual([]);
    expect(((await response.json()) as DispatchResponse).result).toEqual({
      outcome: 'refused',
      taskId: task.taskId,
      reason: 'headroom-unknown',
    });
  });

  it('an UNGATED task still spawns under the same band — the blast radius is opt-in', async () => {
    // Assertion 15, second half, and the reason this band is acceptable at all:
    // only tasks that ASKED to be gated are held. Everything else runs.
    const harness = buildApiHarness({
      staleAfterMs: NO_OBSERVATION_IS_FRESH_STALE_BAND_MS,
      meters: { meters: { 'window-5h': meterRecord({ percent: 1 }) }, history: {} },
    });
    const task = await createTaskThrough(harness, { stage: 'implementing' });

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(harness.sessionHost.spawnCalls).toHaveLength(1);
    expect(((await response.json()) as DispatchResponse).result).toMatchObject({
      outcome: 'spawned',
    });
  });
});

// ── the PRODUCTION wiring (app.ts), not a re-composition of it ───────────────
//
// Everything above composes the middleware and the routes the way app.ts does.
// These cases drive the REAL `createDaemon`, so the claims that only hold if the
// wiring is right — auth inherited from `app.use('*')`, the allowlist union, and
// the degenerate staleness band when the poller is disabled — are asserted
// against production composition rather than a copy of it.

// A fake SDK query: yield the init frame, then end. No Claude process, no
// network. Same shape as hookIngress.test.ts.
const fakeSdkFactory: SdkQueryFactory = () => {
  const generator = (async function* (): AsyncGenerator<SdkStreamMessage> {
    yield { type: 'system', subtype: 'init', session_id: 'claude-sdk' };
  })();
  return Object.assign(generator, { close: () => void generator.return(undefined) });
};

// Unique ids across daemons over distinct files (each boot appends host_started).
const uniqueIdSource: IdSource = { uuid: () => randomUUID() };

let daemonDatabaseCounter = 0;
function buildDaemonConfig(projectRoots: string[]): DaemonConfig {
  daemonDatabaseCounter += 1;
  return {
    port: 0,
    hookPort: 0,
    dbPath: join(temporaryDirectory, `taskapi-daemon-${daemonDatabaseCounter}.db`),
    dataDir: temporaryDirectory,
    expectedCliVersion: undefined,
    expectedSdkCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots,
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    // ⚠ THE POLLER IS DISABLED HERE ON PURPOSE — this is the configuration in
    // which `deriveStaleAfterMs` returns null and the degenerate band is used.
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
    costIngestIntervalMs: 0,
    // The stage-run watchdog (slice 6 step 5b): DISABLED in tests — 0 means the
    // daemon never creates the timer, so no test daemon can wake up and write
    // attention/notifications behind a case's back. The policy values are inert
    // while the interval is 0.
    watchdogCheckIntervalMs: 0,
    watchdogStaleAfterMs: 900_000,
    watchdogMaxStaleEpisodes: 3,
    watchdogRetryBackoffMs: [60_000],
  };
}

async function startDaemonWithRoot(projectRoot: string): Promise<{ daemon: Daemon; port: number }> {
  const deps: DaemonDeps = {
    config: buildDaemonConfig([projectRoot]),
    clock: new SteppingClock(FIXED_NOW, 1000),
    ids: uniqueIdSource,
    verifier: tokenRequiredVerifier,
    sdkQueryFactory: fakeSdkFactory,
    projectsRoot: projectRoot,
  };
  const daemon = createDaemon(deps);
  await daemon.start();
  return { daemon, port: daemon.port };
}

describe('the production wiring in app.ts', () => {
  it('inherits the auth wall on all three task routes (I14, real daemon)', async () => {
    const projectRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'daemon-root-')));
    const { daemon, port } = await startDaemonWithRoot(projectRoot);
    try {
      for (const path of [
        '/api/tasks',
        '/api/tasks/any/transitions',
        '/api/tasks/any/dispatch',
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status, path).toBe(401);
      }
      // Nothing reached the task stream: no route ran.
      const tasksBody = await (
        await fetch(`http://127.0.0.1:${port}/api/projections/tasks`, {
          headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
        })
      ).json();
      expect(tasksBody).toEqual({ tasks: {} });
    } finally {
      await daemon.stop();
    }
  });

  it('creates + dispatches end to end, and honours the degenerate band with the poller OFF', async () => {
    // Assertion 15 against PRODUCTION composition: `usagePollIntervalMs: 0` means
    // `deriveStaleAfterMs` is null, so app.ts passes NO_OBSERVATION_IS_FRESH_STALE_BAND_MS.
    // A gated task must therefore refuse `headroom-unknown`, while an ungated one
    // still runs.
    const projectRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'daemon-root-')));
    const { daemon, port } = await startDaemonWithRoot(projectRoot);
    const call = (path: string, body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
    try {
      // A GATED task: refused, and NO session is created for it.
      const gatedResponse = await call('/api/tasks', {
        projectRoot,
        createdBy: 'human',
        stage: 'implementing',
        gates: { requireHeadroom: { meterId: 'window-5h', pct: 10 } },
      });
      expect(gatedResponse.status).toBe(201);
      const gatedTask = ((await gatedResponse.json()) as CreateTaskResponse).task;
      const gatedDispatch = (await (
        await call(`/api/tasks/${gatedTask.taskId}/dispatch`, {})
      ).json()) as DispatchResponse;
      expect(gatedDispatch.result).toEqual({
        outcome: 'refused',
        taskId: gatedTask.taskId,
        reason: 'headroom-unknown',
      });
      expect(daemon.sessionHost.liveSessionCwds()).toEqual([]);

      // An UNGATED task: spawns, through the real session host, on the fake SDK.
      const ungatedTask = ((await (
        await call('/api/tasks', { projectRoot, createdBy: 'human', stage: 'implementing' })
      ).json()) as CreateTaskResponse).task;
      const ungatedDispatch = (await (
        await call(`/api/tasks/${ungatedTask.taskId}/dispatch`, {})
      ).json()) as DispatchResponse;
      expect(ungatedDispatch.result).toMatchObject({ outcome: 'spawned', cwd: projectRoot });

      // ...and the board, read through the projection route (the ONE reader —
      // there is deliberately no GET /api/tasks), agrees with the log.
      const board = (await (
        await fetch(`http://127.0.0.1:${port}/api/projections/tasks`, {
          headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
        })
      ).json()) as { tasks: Record<string, TaskRecord> };
      expect(board.tasks[gatedTask.taskId]!.gates).toEqual({
        requireHeadroom: { meterId: 'window-5h', pct: 10 },
      });
      expect(board.tasks[ungatedTask.taskId]!.sessionRefs).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it('walls a projectRoot outside the configured roots (403, nothing written)', async () => {
    // The allowlist union app.ts hands the task API is the same one the file/git
    // APIs get; this proves the wiring passed it, not just that the route can use
    // one.
    const projectRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'daemon-root-')));
    const outside = realpathSync(mkdtempSync(join(temporaryDirectory, 'daemon-outside-')));
    const { daemon, port } = await startDaemonWithRoot(projectRoot);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ projectRoot: outside, createdBy: 'human' }),
      });
      expect(response.status).toBe(403);

      const board = (await (
        await fetch(`http://127.0.0.1:${port}/api/projections/tasks`, {
          headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
        })
      ).json()) as { tasks: Record<string, TaskRecord> };
      expect(board.tasks).toEqual({});
    } finally {
      await daemon.stop();
    }
  });
});
