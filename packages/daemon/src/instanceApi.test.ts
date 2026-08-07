import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryArtifactStore,
  MemoryEventStore,
  SteppingClock,
  readAllStreamsGrouped,
  replayFromEmpty,
  taskStageEdgesRecord,
  // S11·U1 (D72 Move 2): the fold is the INSTANCE store now; every task-shaped
  // read below goes through `legacyTasksViewOf`, which is where the shape these
  // assertions speak lives. The subjects under test (writer/dispatcher/api/tool)
  // are untouched by the rename — that is what these unchanged assertions prove.
  canonicalJson,
  instancesProjection,
  legacyTasksViewOf,
  type EventRecord,
  type IdSource,
  type InstanceRecord,
  type InstancesState,
  type MeterRecord,
  type MetersState,
  type TaskRecord,
} from '@vimes/core';
import { createAccessAuthMiddleware, type AccessVerifier } from './auth.js';
import { createDaemon, NO_OBSERVATION_IS_FRESH_STALE_BAND_MS, type Daemon, type DaemonDeps } from './app.js';
import type { DaemonConfig } from './config.js';
import {
  createTaskBodySchema,
  registerInstanceApi,
  WORK_ORDER_FIELD_DESCRIPTORS,
  type AmendWorkOrderResponse,
  type CreateInstanceResponse,
  type CreateTaskResponse,
  type DispatchResponse,
  type ProposeMoveResponse,
  type ProposeTransitionResponse,
  type RevisePayloadResponse,
  type StageEdgesResponse,
  type WorkOrderFieldDescriptor,
  type WorkOrderSchemaResponse,
} from './instanceApi.js';
import { InstanceWriter } from './instanceWriter.js';
import { TaskDispatcher, type DispatchAttemptResult } from './taskDispatcher.js';
import type {
  ResumeResult,
  SdkQueryFactory,
  SdkStreamMessage,
  SendResult,
  SpawnResult,
} from './sessionHost.js';

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
//
// ─── S11·U3 (D72 Move 2) — WHAT THIS FILE IS NOW ─────────────────────────────
//
// `taskApi.test.ts` re-homed alongside its subject. **EVERY PRE-EXISTING
// ASSERTION IN THIS FILE IS THE ALIAS CONTRACT** and still drives the
// `/api/tasks/*` paths on purpose: those routes must answer BYTE-IDENTICALLY to
// what shipped, because the deployed UI keeps calling them, unrestarted and
// untouched, through this slice's daemon deploy (q24, one deploy of overlap).
// An assertion below that changed would be an alias that changed, which is the
// one thing this unit may not do — so the only edits to the existing bodies are
// the import site and two new harness accessors.
//
// The NEW half is the parity block at the end of the file (S11-A4): each
// generic route and its alias, driven with equivalent requests, must append
// IDENTICAL events and answer with the same record under their own envelope
// keys. That is what makes "one handler core, two surfaces" a fact rather than
// an intention.

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
// then registerInstanceApi, over a real InstanceWriter and a real TaskDispatcher. The
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

  // ⚠ Step 7 widened the dispatcher's session-host seam (resume for the fix loop,
  // sendMessage for the instruction seam). Both are recorded and BOTH MUST STAY AT
  // ZERO CALLS for the API's cases: every task this file dispatches is a first-pass
  // run with no prior implementing ref, so `resolveStageRunner` says spawn. If one
  // of these ever fires here, the API surface changed shape without anyone saying so.
  readonly resumeCalls: string[] = [];
  readonly sendCalls: Array<{ appSessionId: string; text: string }> = [];

  resumeSession(appSessionId: string): ResumeResult {
    this.resumeCalls.push(appSessionId);
    return { appSessionId };
  }

  sendMessage(appSessionId: string, text: string): SendResult {
    this.sendCalls.push({ appSessionId, text });
    return { ok: true };
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
  // S7·7c: the taskIds `dispatchTask` was called with, in order. The COUNT alone
  // cannot tell "the route dispatched the right task" from "the route dispatched
  // something", and dispatch-on-promotion is the first feature where the route
  // chooses the argument rather than echoing a path param it was handed.
  dispatchedTaskIds: () => string[];
  allowedRoot: string;
  outsideRoot: string;
  // S11·U3, used ONLY by the parity block: the instance fold the generic
  // envelopes are read back from, and the raw payloads the two surfaces are
  // compared on. Nothing in the pre-existing (alias) cases touches either.
  readInstances: () => InstancesState;
  taskEventPayloads: () => unknown[];
}

function buildApiHarness(
  options: {
    meters?: MetersState;
    staleAfterMs?: number;
    // S7·7c. When present, `dispatchTask` is a FAKE returning exactly this, and the
    // real `TaskDispatcher` is never reached. The route's own contract is "call it
    // once and carry the result back verbatim", and a fake is the only way to assert
    // VERBATIM — a real dispatcher's result is a fact about the dispatcher, not
    // about this route's fidelity to it. Cases that want the whole stack (the
    // legal-edge case below) leave it out and get the real one.
    dispatchResult?: DispatchAttemptResult;
  } = {},
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
  const dispatchedTaskIds: string[] = [];

  const readInstances = () => replayFromEmpty(instancesProjection, readAllStreamsGrouped(store));
  const readTasks = () => legacyTasksViewOf(readInstances());
  const emit = (events: Parameters<MemoryEventStore['append']>[0]): void => {
    store.append(events);
  };

  const instanceWriter = new InstanceWriter({ emit, readTasks, ids: new CountingIdSource() });
  const taskDispatcher = new TaskDispatcher({
    sessionHost,
    emit,
    readTasks,
    readMeters: () => metersState,
    nowIso: () => FIXED_NOW,
    staleAfterMs: options.staleAfterMs ?? FRESH_STALE_BAND_MS,
    // S7·5b-i deps — inert here (no test in this file calls recordPlan), but
    // required now that the dispatcher owns the plan-capture seam. The SAME
    // instanceWriter instance, so the move would go through I7's one writer.
    artifactStore: new MemoryArtifactStore(),
    instanceWriter,
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
  registerInstanceApi(app, {
    instanceWriter,
    // S11·U3: the generic routes' read-back. Composed exactly as app.ts does it
    // (the instances fold, no legacy narrowing), so the parity block compares
    // what production would answer.
    readInstances,
    dispatchTask: (taskId: string) => {
      dispatchCallCount += 1;
      dispatchedTaskIds.push(taskId);
      return options.dispatchResult === undefined
        ? taskDispatcher.dispatchTask(taskId)
        : Promise.resolve(options.dispatchResult);
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
    dispatchedTaskIds: () => dispatchedTaskIds,
    allowedRoot,
    outsideRoot,
    readInstances,
    taskEventPayloads: () => store.read('tasks', 1).map((record) => record.payload),
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
    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
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

  // ── slice 6 step 9: the title, and its boundary cap ───────────────────────

  it('accepts a TITLE, persists it in the birth record, and returns it', async () => {
    // ASSERTION 3. Before step 9 a task had no human-readable name at all, which
    // is the whole reason the board could only be labelled by UUID. Asserted at
    // BOTH ends — the response body AND the event actually written — because a
    // route that echoed its own input would satisfy the first alone.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, { title: 'add a card title to the board' });
    expect(task.title).toBe('add a card title to the board');

    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
    const birthRecord = harness.taskEvents()[0]!;
    // Under the record split the authored title lives in the OPAQUE `payload`.
    expect((birthRecord.payload as { payload: { title?: unknown } }).payload.title).toBe(
      'add a card title to the board',
    );
  });

  it('a title AT the cap is accepted; one character OVER is 400 with NO EVENT', async () => {
    // ASSERTION 4. A title is free text from an untrusted caller landing in a
    // durable append-only record and on a rendered card (I8), so it is bounded at
    // the boundary — and the refusal follows the 4b idiom exactly: a body that
    // was never a valid proposal WRITES NOTHING.
    //
    // ⚠ THE INSTRUMENT IS THE LOG, NOT THE STATUS CODE. A route that emitted the
    // birth record before validating would still answer 400 here; only the
    // untouched stream head proves nothing was written.
    const cap = 200;
    const harness = buildApiHarness();

    const atTheCap = await createTaskThrough(harness, { title: 'x'.repeat(cap) });
    expect(atTheCap.title).toHaveLength(cap);
    const headAfterAcceptedTitle = harness.tasksHead();

    const overTheCap = await harness.request(
      '/api/tasks',
      postJson({
        projectRoot: harness.allowedRoot,
        createdBy: 'human',
        title: 'x'.repeat(cap + 1),
      }),
    );
    expect(overTheCap.status).toBe(400);
    expect(harness.tasksHead()).toBe(headAfterAcceptedTitle);
    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
  });

  it('a NON-STRING title is 400 with no event — the cap is not the only guard', async () => {
    // The neighbouring hostile shape: a caller sending an object/array/number
    // where a title belongs must be refused by the same boundary, not coerced.
    const harness = buildApiHarness();
    for (const hostileTitle of [42, { text: 'nope' }, ['nope'], true]) {
      const response = await harness.request(
        '/api/tasks',
        postJson({ projectRoot: harness.allowedRoot, createdBy: 'human', title: hostileTitle }),
      );
      expect(response.status, JSON.stringify(hostileTitle)).toBe(400);
    }
    expect(harness.tasksHead()).toBe(0);
  });

  it('creation with NO title still succeeds and the record carries no title key', async () => {
    // ASSERTION 5's shape at the route: the widening is OPTIONAL-only, so an
    // untitled creation is byte-for-byte the pre-step-9 request. Asserted with
    // `in` rather than `toBeUndefined()` — a record that grew `title: undefined`
    // would pass the latter while changing what the projection serializes.
    // (4b's own create cases above are UNEDITED and still pass; that is the rest
    // of assertion 5.)
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);
    expect('title' in task).toBe(false);

    const birthRecord = harness.taskEvents()[0]!;
    expect('title' in (birthRecord.payload as { payload: object }).payload).toBe(false);
  });

  it('an EMPTY-STRING title is accepted verbatim — the route does not editorialise', async () => {
    // The boundary bounds LENGTH; it does not decide which titles are worth
    // having. `''` is a title someone chose, it is recorded as one, and the
    // BOARD is what falls back to a short taskId when there is nothing to show
    // (lib/taskBoard.ts). Putting that judgement in the route would make two
    // places responsible for the same decision.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, { title: '' });
    expect(task.title).toBe('');
  });

  // ── S7·2a: the four AUTHORED work-order fields, over the wire ──────────────

  it('accepts a full work-order body, persists it, and returns MINTED criterion ids', async () => {
    // THE FORWARD PATH end to end. The client sends acceptance criteria as
    // `{ text }` (text only); the writer mints an `{ id, text }` per criterion
    // from its injected CountingIdSource — taskId is counter #1, so the criteria
    // are #2 and #3 — and the birth record carries the FULL shape. Asserted at
    // BOTH ends: the response body AND the event actually written, because a route
    // that echoed its own input would satisfy the first alone (and would carry no
    // id at all, since the input has none).
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, {
      scope: 'fold the work-order fields onto the born record',
      explicitlyOut: ['the amend path (S7·2b)', 'the authoring UI (S7·3)'],
      acceptanceCriteria: [{ text: 'both suites pass' }, { text: 'ids are minted server-side' }],
      killCriterion: 'a criterion id cannot be made deterministic',
    });

    expect(task.scope).toBe('fold the work-order fields onto the born record');
    expect(task.explicitlyOut).toEqual(['the amend path (S7·2b)', 'the authoring UI (S7·3)']);
    expect(task.killCriterion).toBe('a criterion id cannot be made deterministic');
    expect(task.acceptanceCriteria).toEqual([
      { id: '00000000-0000-4000-8000-000000000002', text: 'both suites pass' },
      { id: '00000000-0000-4000-8000-000000000003', text: 'ids are minted server-side' },
    ]);

    // The LOG carries the minted `{id,text}` criteria, not the bare `{text}` input.
    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
    expect(harness.taskEvents()[0]!.payload).toMatchObject({
      payload: {
        scope: 'fold the work-order fields onto the born record',
        acceptanceCriteria: [
          { id: '00000000-0000-4000-8000-000000000002', text: 'both suites pass' },
          { id: '00000000-0000-4000-8000-000000000003', text: 'ids are minted server-side' },
        ],
      },
    });
  });

  it('creation with NO work-order fields still succeeds and carries none of the keys', async () => {
    // The widening is OPTIONAL-only, so an unauthored creation is byte-for-byte a
    // pre-slice-7 request. Asserted with `in` — a record that grew `scope:
    // undefined` would pass `toBeUndefined()` while changing serialized bytes.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);
    expect('scope' in task).toBe(false);
    expect('explicitlyOut' in task).toBe(false);
    expect('acceptanceCriteria' in task).toBe(false);
    expect('killCriterion' in task).toBe(false);

    const birthRecord = harness.taskEvents()[0]!;
    const authoredPayload = (birthRecord.payload as { payload: object }).payload;
    expect('scope' in authoredPayload).toBe(false);
    expect('acceptanceCriteria' in authoredPayload).toBe(false);
  });

  it('a `scope` one character OVER the 8000 cap is 400 with NO EVENT', async () => {
    // A work-order field is free text from an untrusted caller landing in a durable
    // append-only record (I8), so it is bounded at the boundary — and the refusal
    // follows the 4b idiom: a body that was never a valid proposal WRITES NOTHING.
    //
    // ⚠ THE INSTRUMENT IS THE LOG, NOT THE STATUS CODE. A route that emitted the
    // birth record before validating would still answer 400; only the untouched
    // stream head proves nothing was written.
    const cap = 8000;
    const harness = buildApiHarness();

    const atTheCap = await createTaskThrough(harness, { scope: 'x'.repeat(cap) });
    expect(atTheCap.scope).toHaveLength(cap);
    const headAfterAccepted = harness.tasksHead();

    const overTheCap = await harness.request(
      '/api/tasks',
      postJson({
        projectRoot: harness.allowedRoot,
        createdBy: 'human',
        scope: 'x'.repeat(cap + 1),
      }),
    );
    expect(overTheCap.status).toBe(400);
    expect(harness.tasksHead()).toBe(headAfterAccepted);
    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
  });

  it('MORE than 100 acceptance criteria is 400 with NO EVENT (the list cap)', async () => {
    // The list-length guard: a hostile caller must not be able to force a
    // hundred-thousand-entry birth record. 100 entries is accepted; 101 is refused
    // whole, with nothing written.
    const harness = buildApiHarness();

    const atCap = Array.from({ length: 100 }, (_unused, index) => ({ text: `criterion ${index}` }));
    const accepted = await createTaskThrough(harness, { acceptanceCriteria: atCap });
    expect(accepted.acceptanceCriteria).toHaveLength(100);
    const headAfterAccepted = harness.tasksHead();

    const overCap = Array.from({ length: 101 }, (_unused, index) => ({ text: `criterion ${index}` }));
    const response = await harness.request(
      '/api/tasks',
      postJson({ projectRoot: harness.allowedRoot, createdBy: 'human', acceptanceCriteria: overCap }),
    );
    expect(response.status).toBe(400);
    expect(harness.tasksHead()).toBe(headAfterAccepted);
  });

  it('a work-order body outside the projectRoot allowlist is 403 with NO EVENT', async () => {
    // The security wall runs FIRST and is unchanged by this widening: work-order
    // fields do not bypass it. A refused creation leaves no task-shaped record,
    // work order or not.
    const harness = buildApiHarness();
    const headBefore = harness.tasksHead();

    const response = await harness.request(
      '/api/tasks',
      postJson({
        projectRoot: harness.outsideRoot,
        createdBy: 'human',
        scope: 'this should never be written',
        acceptanceCriteria: [{ text: 'nor should this' }],
      }),
    );

    expect(response.status).toBe(403);
    expect(harness.tasksHead()).toBe(headBefore);
    expect(harness.taskEvents()).toEqual([]);
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
    expect(harness.taskEvents()[0]!.payload).toMatchObject({ project: harness.allowedRoot });
  });
});

// ── assertion 10: I7 over HTTP ───────────────────────────────────────────────

describe('POST /api/tasks/:taskId/transitions — I7 over HTTP', () => {
  it('accepts a legal edge: 200 + the moved task, one task_transitioned — AND, since S7·7c, the D53 dispatch', async () => {
    // ⚠ **THIS CASE MOVED IN S7·7c, AND THE MOVE IS THE FEATURE.** It used to
    // assert exactly `[task_created, task_transitioned]` and an envelope of
    // `{ accepted, task }`. `backlog → planning` proposed by a HUMAN is a
    // PROMOTION INTO AN ACTIVE STAGE, which D53 says starts the work — so the
    // route now makes one dispatch attempt and the envelope carries its result.
    //
    // Deliberately run against the REAL `TaskDispatcher` (no `dispatchResult`
    // fake): this is the whole stack — route → predicate → dispatcher → the fake
    // session host — and the `task_session_attached` below is the evidence that a
    // stage run really started off the back of a promotion.
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
      // The task as the WRITER returned it — computed before the dispatch ran, so
      // it carries no `sessionRefs` yet. The transition and the dispatch are two
      // facts, and the envelope does not blend them.
      task: { ...task, stage: 'planning' },
      dispatch: {
        outcome: 'spawned',
        taskId: task.taskId,
        stage: 'planning',
        appSessionId: 'ffffffff-0000-4000-8000-000000000001',
        cwd: harness.allowedRoot,
      },
    });
    expect(harness.taskEventTypes()).toEqual([
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instanceMoved,
      EVENT_TYPES.instanceRunAttached,
    ]);
    // ONE attempt, on THIS task. The route is not a scheduler.
    expect(harness.dispatchedTaskIds()).toEqual([task.taskId]);
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
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instanceMoveRejected,
    ]);
    expect(harness.taskEvents()[1]!.payload).toEqual({
      instanceId: task.taskId,
      fromNode: 'backlog',
      attemptedToNode: 'review',
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
    expect(harness.taskEvents()[1]!.type).toBe(EVENT_TYPES.instanceMoveRejected);
    expect(harness.taskEvents()[1]!.payload).toMatchObject({
      attemptedToNode: 'shipped-it-lol',
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
        EVENT_TYPES.instanceCreated,
        EVENT_TYPES.instanceMoveRejected,
      ]);
      // No `task_transitioned` rode along: the board did not move.
      expect(harness.taskEventTypes()).not.toContain(EVENT_TYPES.instanceMoved);
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

// ── S7·7c: dispatch-on-promotion, as seen from the wire (D53) ────────────────
//
// The predicate itself is exhaustively tested in core (`dispatchDecision.test.ts`
// has the full stage × proposedBy truth table). What this file owns is the
// ROUTE's three promises, and nothing else:
//   1. it asks the predicate and dispatches EXACTLY ONCE, with the right taskId;
//   2. it carries the dispatcher's result back VERBATIM on the 200;
//   3. when the predicate says no — an outcome edge, an inert stage, a REJECTED
//      transition — it does not call the dispatcher at all, and the envelope is
//      byte-identical to the pre-S7·7c one (the KEY IS ABSENT, not `undefined`).
//
// The dispatcher is a FAKE here (`dispatchResult`), because "verbatim" is only
// assertable against a value this file chose. A distinctive one is used on
// purpose: `deferred` is an outcome the real dispatcher would never produce for
// these tasks, so a route that quietly re-derived a result instead of relaying
// one could not accidentally match it.

const RELAYED_DISPATCH_RESULT: DispatchAttemptResult = {
  outcome: 'deferred',
  taskId: 'the-fake-decides-what-this-says',
  reason: 'awaiting-meter-reset',
  meterId: 'window-5h',
};

describe('POST /api/tasks/:taskId/transitions — the D53 dispatch rider (S7·7c)', () => {
  it('a PROMOTION into planning (human) dispatches once and relays the result verbatim', async () => {
    const harness = buildApiHarness({ dispatchResult: RELAYED_DISPATCH_RESULT });
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
      // VERBATIM — including a `taskId` the fake made up, which is the point: the
      // route relays, it does not reconstruct.
      dispatch: RELAYED_DISPATCH_RESULT,
    });
    expect(harness.dispatchedTaskIds()).toEqual([task.taskId]);
  });

  it('a PROMOTION plan-ready → implementing (orchestrator) dispatches too', async () => {
    // The second promotion edge in D53's taxonomy: plan approval. Same rule, a
    // different proposer, so neither value is hard-wired to one stage.
    const harness = buildApiHarness({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const task = await createTaskThrough(harness, { stage: 'plan-ready' });

    const response = await harness.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'implementing', proposedBy: 'orchestrator' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProposeTransitionResponse;
    expect(body).toEqual({
      accepted: true,
      task: { ...task, stage: 'implementing' },
      dispatch: RELAYED_DISPATCH_RESULT,
    });
    expect(harness.dispatchedTaskIds()).toEqual([task.taskId]);
  });

  it('THE VERDICT BOUNCE: review → implementing by the DISPATCHER starts nothing', async () => {
    // ⚠ D53's no-chaining rule, over HTTP. An OUTCOME never auto-dispatches, even
    // though `implementing` is an active stage — so a bounced task lands there
    // UN-dispatched and starting the fixer is the orchestrator's explicit call.
    // (In production this edge is proposed IN-PROCESS by `recordReview` and never
    // touches this route at all; the route is asserted anyway, because the MCP
    // surface will be a thin client of it and could propose exactly this.)
    const harness = buildApiHarness({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const task = await createTaskThrough(harness, { stage: 'review' });

    const response = await harness.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'implementing', proposedBy: 'dispatcher' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProposeTransitionResponse;
    // KEY ABSENCE, not `undefined` — a present-but-undefined key would still show
    // up in the JSON's shape discussions and would not be byte-identical.
    expect(Object.keys(body).sort()).toEqual(['accepted', 'task']);
    expect(body).toEqual({ accepted: true, task: { ...task, stage: 'implementing' } });
    expect(harness.dispatchedTaskIds()).toEqual([]);
  });

  it('an accepted move into an INERT stage starts nothing (and review is one)', async () => {
    // `planning → plan-ready` is the plan-capture OUTCOME edge; `implementing →
    // review` puts the task in the HOLDING PEN. Both are accepted, neither is an
    // active stage, so neither dispatches — even proposed by a human.
    const inertCases: Array<{ startingStage: TaskRecord['stage']; toStage: string }> = [
      { startingStage: 'planning', toStage: 'plan-ready' },
      { startingStage: 'implementing', toStage: 'review' },
      { startingStage: 'backlog', toStage: 'blocked-external' },
    ];

    for (const inertCase of inertCases) {
      const harness = buildApiHarness({ dispatchResult: RELAYED_DISPATCH_RESULT });
      const task = await createTaskThrough(harness, { stage: inertCase.startingStage });

      const response = await harness.request(
        `/api/tasks/${task.taskId}/transitions`,
        postJson({ toStage: inertCase.toStage, proposedBy: 'human' }),
      );

      expect(response.status, inertCase.toStage).toBe(200);
      const body = (await response.json()) as ProposeTransitionResponse;
      expect(Object.keys(body).sort(), inertCase.toStage).toEqual(['accepted', 'task']);
      expect(harness.dispatchedTaskIds(), inertCase.toStage).toEqual([]);
    }
  });

  it('a REJECTED transition dispatches nothing — there was no promotion', async () => {
    // The rejection is evented (I7) and the dispatcher is never reached. A route
    // that dispatched on a refused move would start work the machine just refused.
    const harness = buildApiHarness({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const task = await createTaskThrough(harness);

    const response = await harness.request(
      `/api/tasks/${task.taskId}/transitions`,
      // backlog → implementing is not a legal edge.
      postJson({ toStage: 'implementing', proposedBy: 'human' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ accepted: false, reason: 'illegal-edge' });
    expect(harness.taskEventTypes()).toEqual([
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instanceMoveRejected,
    ]);
    expect(harness.dispatchedTaskIds()).toEqual([]);
  });

  it('CREATION into an active stage does NOT auto-dispatch — transitions only', async () => {
    // Explicitly out of D53's mechanics: a birth record is not a promotion.
    // Nobody decided anything by writing one, so nothing starts.
    const harness = buildApiHarness({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const task = await createTaskThrough(harness, { stage: 'planning' });

    expect(task.stage).toBe('planning');
    expect(harness.dispatchedTaskIds()).toEqual([]);
    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
  });

  it('EVERY dispatch outcome rides the 200 verbatim — refusals are not HTTP errors', async () => {
    // The transition was ACCEPTED and is in the log; what the dispatch did is a
    // rider fact. 4xx-ing a refused dispatch would retroactively deny an evented
    // transition and push clients into retry machinery for "here is what happened".
    // `unknown-task` is unreachable in practice — the task just transitioned — but
    // it is carried honestly rather than translated, so it is asserted too.
    const outcomes: DispatchAttemptResult[] = [
      { outcome: 'refused', taskId: 'x', reason: 'headroom-insufficient' },
      { outcome: 'deferred', taskId: 'x', reason: 'reset-time-unknown', meterId: 'window-5h' },
      { outcome: 'spawn-failed', taskId: 'x', reason: 'preflight-said-no' },
      { outcome: 'worktree-failed', taskId: 'x', reason: 'not-a-repo:fatal' },
      { outcome: 'in-flight', taskId: 'x' },
      { outcome: 'unknown-task', taskId: 'x' },
    ];

    for (const dispatchResult of outcomes) {
      const harness = buildApiHarness({ dispatchResult });
      const task = await createTaskThrough(harness);

      const response = await harness.request(
        `/api/tasks/${task.taskId}/transitions`,
        postJson({ toStage: 'planning', proposedBy: 'human' }),
      );

      expect(response.status, dispatchResult.outcome).toBe(200);
      const body = (await response.json()) as ProposeTransitionResponse;
      expect(body, dispatchResult.outcome).toEqual({
        accepted: true,
        task: { ...task, stage: 'planning' },
        dispatch: dispatchResult,
      });
      // The transition is in the log regardless of what the dispatch said.
      expect(harness.taskEventTypes(), dispatchResult.outcome).toEqual([
        EVENT_TYPES.instanceCreated,
        EVENT_TYPES.instanceMoved,
      ]);
    }
  });
});

// ── assertion 11: malformed bodies ───────────────────────────────────────────

// ── S7·2b: work-order amendments over the wire (D43) ─────────────────────────
//
// The route's promises, and nothing else (the patch semantics themselves belong to
// the fold, the rev arithmetic to the writer):
//   1. an accepted amendment answers 200 with the FOLDED record, bumped rev and all;
//   2. every refusal writes NOTHING — the tasks head is the instrument, not the
//      status code;
//   3. **it never dispatches.** `dispatchCallCount` staying at 0 is the assertable
//      form of D53's "an amendment is not a promotion".

describe('POST /api/tasks/:taskId/amendments — amend the work order (S7·2b)', () => {
  it('200 + the folded record with a bumped rev, ONE event, and NO dispatch', async () => {
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, {
      scope: 'the scope as first authored',
      killCriterion: 'the kill criterion as first authored',
    });

    const response = await harness.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson({ amendedBy: 'human', scope: 'the narrowed scope' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AmendWorkOrderResponse;
    // The RECORD as folded — the response is the read-back, not an echo of the
    // request, which is why the untouched `killCriterion` rides along on it.
    expect(body.task).toEqual({
      ...task,
      scope: 'the narrowed scope',
      workOrderRev: 1,
    });

    expect(harness.taskEventTypes()).toEqual([
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instancePayloadRevised,
    ]);
    expect(harness.taskEvents()[1]!.payload).toEqual({
      instanceId: task.taskId,
      payloadRev: 1,
      revisedBy: 'human',
      patch: { scope: 'the narrowed scope' },
    });

    // ⚠ THE D53 HALF. Its sibling route dispatches on a promotion; this one must
    // not, ever — an amendment changes what the work order SAYS, and whether to
    // re-run against the new revision is a separate, explicit decision.
    expect(harness.dispatchCallCount()).toBe(0);
    expect(harness.sessionHost.spawnCalls).toEqual([]);
  });

  it('restates a criterion by id and mints one for an id-less entry', async () => {
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, {
      acceptanceCriteria: [{ text: 'the first criterion' }, { text: 'the second criterion' }],
    });
    const firstCriterionId = task.acceptanceCriteria![0]!.id;

    const response = await harness.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson({
        amendedBy: 'orchestrator',
        acceptanceCriteria: [
          { id: firstCriterionId, text: 'the first criterion, reworded' },
          { text: 'a criterion the amendment introduces' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const amendedCriteria = ((await response.json()) as AmendWorkOrderResponse).task
      .acceptanceCriteria!;
    // The restated criterion KEPT its id — that stability is what `report_review`
    // keys its per-criterion verdicts to. The new one got a server-minted id, and
    // the dropped one is gone (the list is a replacement, not a delta).
    expect(amendedCriteria[0]).toEqual({
      id: firstCriterionId,
      text: 'the first criterion, reworded',
    });
    expect(amendedCriteria[1]!.text).toBe('a criterion the amendment introduces');
    expect(amendedCriteria[1]!.id).not.toBe(firstCriterionId);
    expect(amendedCriteria).toHaveLength(2);
  });

  it('404 for an unknown taskId, and NOTHING is written', async () => {
    const harness = buildApiHarness();
    const headBefore = harness.tasksHead();

    const response = await harness.request(
      '/api/tasks/task-that-never-existed/amendments',
      postJson({ amendedBy: 'human', scope: 'an amendment to nothing' }),
    );

    expect(response.status).toBe(404);
    expect(harness.tasksHead()).toBe(headBefore);
    expect(harness.dispatchCallCount()).toBe(0);
  });

  it('400 + the OFFENDING id for a criterion the record does not carry', async () => {
    // The id IS echoed, unlike the create route's 403 path suppression: it came from
    // the caller's own body and names nothing outside the task, so returning it is
    // how a form tells the human WHICH row went stale under them.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, {
      acceptanceCriteria: [{ text: 'the only criterion' }],
    });
    const headAfterCreate = harness.tasksHead();

    const response = await harness.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson({
        amendedBy: 'human',
        scope: 'a scope that must not land',
        acceptanceCriteria: [{ id: 'crit-id-that-was-never-minted', text: 'keyed to nothing' }],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'bad request',
      detail: 'unknown-criterion',
      criterionId: 'crit-id-that-was-never-minted',
    });
    // Refused WHOLE: the `scope` that rode along with it was not written either.
    expect(harness.tasksHead()).toBe(headAfterCreate);
    expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
  });

  it('400 for an amendment that names no work-order field at all', async () => {
    // Well-formed, and asks for nothing. A rev bump that changes nothing is log
    // noise, so the writer refuses it and the log stays where it was.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness);
    const headAfterCreate = harness.tasksHead();

    const response = await harness.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson({ amendedBy: 'human' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad request', detail: 'empty-amendment' });
    expect(harness.tasksHead()).toBe(headAfterCreate);
  });

  it('an explicit empty acceptanceCriteria is an amendment, not an empty one', async () => {
    // The pair the empty check must not conflate — clearing the criteria list is a
    // real, recorded amendment.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, {
      acceptanceCriteria: [{ text: 'the only criterion' }],
    });

    const response = await harness.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson({ amendedBy: 'human', acceptanceCriteria: [] }),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as AmendWorkOrderResponse).task.acceptanceCriteria).toEqual([]);
    expect(harness.taskEventTypes()).toEqual([
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instancePayloadRevised,
    ]);
  });

  it('never dispatches, whatever stage the task is in (D53)', async () => {
    // Run against a task sitting in an ACTIVE stage — the one shape where a reader
    // might expect the amendment to restart the work. It does not: `planning` is
    // exactly where the temptation to chain lives, and the count stays 0.
    const harness = buildApiHarness({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const task = await createTaskThrough(harness, { stage: 'planning' });

    const response = await harness.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson({ amendedBy: 'orchestrator', scope: 'a scope amended mid-planning' }),
    );

    expect(response.status).toBe(200);
    expect(harness.dispatchedTaskIds()).toEqual([]);
    expect(harness.sessionHost.spawnCalls).toEqual([]);
    // The stage did not move either — an amendment is a record fact, not a transition.
    expect(((await response.json()) as AmendWorkOrderResponse).task.stage).toBe('planning');
  });
});

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
      expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
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

  const malformedAmendmentBodies: Array<{ caseName: string; body: unknown }> = [
    { caseName: 'unparseable JSON', body: '{ nope' },
    { caseName: 'missing required amendedBy', body: { scope: 'a scope with no author' } },
    {
      // ⚠ THE ONE THAT ENCODES A DECISION RATHER THAN A TYPO. `dispatcher` is a
      // legal `proposedBy` on the transitions route and is deliberately NOT a legal
      // `amendedBy` here: D53 makes an amendment a DECISION, and the mechanics never
      // author one. A 400 is the wire form of that two-value enum.
      caseName: 'amendedBy: dispatcher — the machinery never amends (D53)',
      body: { amendedBy: 'dispatcher', scope: 'a scope the dispatcher wants' },
    },
    { caseName: 'wrong-typed scope (number)', body: { amendedBy: 'human', scope: 7 } },
    { caseName: 'empty-string scope', body: { amendedBy: 'human', scope: '' } },
    {
      caseName: 'scope over MAX_WORK_ORDER_TEXT — the same cap the create route enforces',
      body: { amendedBy: 'human', scope: 'x'.repeat(8001) },
    },
    {
      caseName: 'an acceptance criterion with no text',
      body: { amendedBy: 'human', acceptanceCriteria: [{ id: 'crit-1' }] },
    },
    {
      caseName: 'more acceptance criteria than MAX_LIST_ITEMS',
      body: {
        amendedBy: 'human',
        acceptanceCriteria: Array.from({ length: 101 }, (_unused, index) => ({
          text: `criterion ${index}`,
        })),
      },
    },
    { caseName: 'a JSON array rather than an object', body: [1, 2, 3] },
    { caseName: 'null body', body: null },
  ];

  for (const malformedCase of malformedAmendmentBodies) {
    it(`amendments: ${malformedCase.caseName} → 400, no event`, async () => {
      const harness = buildApiHarness();
      const task = await createTaskThrough(harness, { scope: 'the scope as first authored' });
      const headAfterCreate = harness.tasksHead();

      const response = await harness.request(
        `/api/tasks/${task.taskId}/amendments`,
        postJson(malformedCase.body),
      );

      expect(response.status).toBe(400);
      expect(harness.tasksHead()).toBe(headAfterCreate);
      expect(harness.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
      expect(harness.dispatchCallCount()).toBe(0);
    });
  }

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
    expect(harness.taskEvents()[1]!.type).toBe(EVENT_TYPES.instanceMoveRejected);
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
    //
    // ⚠ S7·7c ADDED `task_session_attached` TO THIS SET. One body in the barrage
    // above is a VALID `backlog → planning` promotion by a human — a well-formed
    // proposal that happens to be sitting in a hostile list — and D53 says that
    // starts the work. Nothing about hostile input changed; the one legitimate
    // proposal now has one more consequence.
    const finalTypes = harness.taskEventTypes();
    expect(new Set(finalTypes)).toEqual(
      new Set([
        EVENT_TYPES.instanceCreated,
        EVENT_TYPES.instanceMoveRejected,
        EVENT_TYPES.instanceMoved,
        EVENT_TYPES.instanceRunAttached,
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
    {
      routeName: 'amendments',
      path: '/api/tasks/any-task/amendments',
      body: { amendedBy: 'human', scope: 'a scope nobody authenticated to write' },
    },
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

// ── S8: the served legal-edge table ──────────────────────────────────────────

describe('GET /api/tasks/stage-edges — the legal-edge table the move sheet filters against', () => {
  it('serves taskStageEdgesRecord() verbatim behind the same auth wall', async () => {
    const harness = buildApiHarness();
    const response = await harness.request('/api/tasks/stage-edges', {
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as StageEdgesResponse;
    expect(body).toEqual({ edges: taskStageEdgesRecord() });
  });

  it('NO token → 401 (I14), and a genuinely empty token is refused the same way', async () => {
    const harness = buildApiHarness();

    const noToken = await harness.request('/api/tasks/stage-edges', {
      headers: authHeaders(null),
    });
    expect(noToken.status).toBe(401);

    const emptyToken = await harness.request('/api/tasks/stage-edges', {
      headers: authHeaders(''),
    });
    expect(emptyToken.status).toBe(401);
  });

  it('is read-only: fetching it writes nothing to the tasks stream', async () => {
    const harness = buildApiHarness();
    const headBefore = harness.tasksHead();

    await harness.request('/api/tasks/stage-edges', { headers: authHeaders() });

    expect(harness.tasksHead()).toBe(headBefore);
  });
});

// ── S7·3: the work-order authoring descriptor + its drift guard ──────────────
//
// This is the "one definition" insurance the S7·3 unit exists to test. The board
// renders the four authored work-order fields from the SERVED descriptor
// (`GET /api/tasks/work-order-schema`), and the descriptor is derived from the
// SAME caps `createTaskBodySchema` validates against. These tests bind the two
// together so they can never drift silently: same keys, same optionality, same
// caps — a change to one place that is not mirrored in the other reddens here.

describe('WORK_ORDER_FIELD_DESCRIPTORS — bound to createTaskBodySchema (no drift)', () => {
  // The four AUTHORED work-order fields, enumerated. Deliberately NOT derived from
  // the descriptor or the schema — this hard-coded set is the third witness, so a
  // field silently added to (or dropped from) EITHER side is caught rather than
  // agreeing with itself.
  const EXPECTED_WORK_ORDER_KEYS = [
    'scope',
    'explicitlyOut',
    'acceptanceCriteria',
    'killCriterion',
  ] as const;

  // A minimal body that parses, so a single field under test can be swapped in and
  // its cap probed against the schema the route actually uses. projectRoot is only
  // shape-checked here (the allowlist wall is the route's job, not the schema's).
  function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { projectRoot: '/tmp', createdBy: 'human', ...overrides };
  }

  const descriptorByKey = new Map<string, WorkOrderFieldDescriptor>(
    WORK_ORDER_FIELD_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
  );

  it('covers exactly the four authored fields — set-equality both directions', () => {
    const descriptorKeys = WORK_ORDER_FIELD_DESCRIPTORS.map((descriptor) => descriptor.key);
    // No duplicate keys in the descriptor.
    expect(new Set(descriptorKeys).size).toBe(descriptorKeys.length);
    // Descriptor keys === the expected four (order-independent).
    expect(new Set(descriptorKeys)).toEqual(new Set(EXPECTED_WORK_ORDER_KEYS));
  });

  it('every descriptor key exists in createTaskBodySchema.shape AND is optional there', () => {
    for (const descriptor of WORK_ORDER_FIELD_DESCRIPTORS) {
      const shapeField = createTaskBodySchema.shape[descriptor.key as keyof typeof createTaskBodySchema.shape];
      expect(shapeField, `${descriptor.key} exists in the schema`).toBeDefined();
      // Optional: an unauthored creation must still parse (the widening is
      // optional-only), so a descriptor field that became required in the schema
      // would break the byte-identical title-only POST — caught here.
      expect(shapeField.isOptional(), `${descriptor.key} is optional`).toBe(true);
    }
  });

  it('each longtext descriptor cap AT the schema cap parses, one OVER fails', () => {
    for (const descriptor of WORK_ORDER_FIELD_DESCRIPTORS) {
      if (descriptor.kind !== 'longtext') {
        continue;
      }
      const cap = descriptor.maxLength!;
      expect(cap, `${descriptor.key} declares a maxLength`).toBeGreaterThan(0);
      // AT the descriptor's declared cap → the schema accepts it.
      expect(
        createTaskBodySchema.safeParse(baseBody({ [descriptor.key]: 'x'.repeat(cap) })).success,
        `${descriptor.key} at cap parses`,
      ).toBe(true);
      // One character OVER → the schema rejects the whole body. This is what binds
      // the descriptor's advertised cap to what the route enforces.
      expect(
        createTaskBodySchema.safeParse(baseBody({ [descriptor.key]: 'x'.repeat(cap + 1) })).success,
        `${descriptor.key} over cap fails`,
      ).toBe(false);
    }
  });

  it('the explicitlyOut list caps (item count AND item length) match the schema', () => {
    const descriptor = descriptorByKey.get('explicitlyOut')!;
    const maxItems = descriptor.maxItems!;
    const itemMaxLength = descriptor.itemMaxLength!;

    const atItemCap = Array.from({ length: maxItems }, () => 'row');
    expect(createTaskBodySchema.safeParse(baseBody({ explicitlyOut: atItemCap })).success).toBe(true);

    const overItemCap = Array.from({ length: maxItems + 1 }, () => 'row');
    expect(createTaskBodySchema.safeParse(baseBody({ explicitlyOut: overItemCap })).success).toBe(
      false,
    );

    // A single line AT its length cap parses; one over fails.
    expect(
      createTaskBodySchema.safeParse(baseBody({ explicitlyOut: ['x'.repeat(itemMaxLength)] }))
        .success,
    ).toBe(true);
    expect(
      createTaskBodySchema.safeParse(baseBody({ explicitlyOut: ['x'.repeat(itemMaxLength + 1)] }))
        .success,
    ).toBe(false);
  });

  it('the acceptanceCriteria list caps match the schema, and its item shape is { text }', () => {
    const descriptor = descriptorByKey.get('acceptanceCriteria')!;
    expect(descriptor.kind).toBe('criteria-list');
    const maxItems = descriptor.maxItems!;
    const itemMaxLength = descriptor.itemMaxLength!;

    const atItemCap = Array.from({ length: maxItems }, () => ({ text: 'ok' }));
    expect(createTaskBodySchema.safeParse(baseBody({ acceptanceCriteria: atItemCap })).success).toBe(
      true,
    );

    const overItemCap = Array.from({ length: maxItems + 1 }, () => ({ text: 'ok' }));
    expect(
      createTaskBodySchema.safeParse(baseBody({ acceptanceCriteria: overItemCap })).success,
    ).toBe(false);

    // One criterion's TEXT at its length cap parses; one over fails.
    expect(
      createTaskBodySchema.safeParse(
        baseBody({ acceptanceCriteria: [{ text: 'x'.repeat(itemMaxLength) }] }),
      ).success,
    ).toBe(true);
    expect(
      createTaskBodySchema.safeParse(
        baseBody({ acceptanceCriteria: [{ text: 'x'.repeat(itemMaxLength + 1) }] }),
      ).success,
    ).toBe(false);

    // The INPUT shape carries no id — the writer mints it (S7·2a). A criterion sent
    // with an id must not become part of the advertised contract.
    expect(
      createTaskBodySchema.safeParse(baseBody({ acceptanceCriteria: [{ text: 'ok' }] })).success,
    ).toBe(true);
  });
});

describe('GET /api/tasks/work-order-schema — the served authoring descriptor', () => {
  it('serves WORK_ORDER_FIELD_DESCRIPTORS verbatim behind the same auth wall', async () => {
    const harness = buildApiHarness();
    const response = await harness.request('/api/tasks/work-order-schema', {
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as WorkOrderSchemaResponse;
    expect(body).toEqual({ fields: WORK_ORDER_FIELD_DESCRIPTORS });
    // The four keys are present and in the authored order.
    expect(body.fields.map((field) => field.key)).toEqual([
      'scope',
      'explicitlyOut',
      'acceptanceCriteria',
      'killCriterion',
    ]);
  });

  it('NO token → 401 (I14), and a genuinely empty token is refused the same way', async () => {
    const harness = buildApiHarness();

    const noToken = await harness.request('/api/tasks/work-order-schema', {
      headers: authHeaders(null),
    });
    expect(noToken.status).toBe(401);

    const emptyToken = await harness.request('/api/tasks/work-order-schema', {
      headers: authHeaders(''),
    });
    expect(emptyToken.status).toBe(401);
  });

  it('is read-only: fetching it writes nothing to the tasks stream', async () => {
    const harness = buildApiHarness();
    const headBefore = harness.tasksHead();

    await harness.request('/api/tasks/work-order-schema', { headers: authHeaders() });

    expect(harness.tasksHead()).toBe(headBefore);
  });
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
    // Step 7, through the REAL route: a first-pass run resumes nothing and — with
    // the default (silent) instruction composer that app.ts also uses — sends
    // nothing. The API's behaviour is unchanged by the stage runner landing.
    expect(harness.sessionHost.resumeCalls).toEqual([]);
    expect(harness.sessionHost.sendCalls).toEqual([]);
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

  // ── slice 6 step 8, ASSERTION 12: the async ripple did not move the wire ────
  //
  // `dispatchTask` became async (worktree creation is a subprocess) and the Hono
  // handler became async with it. That is a real change to the CALL, and it must be
  // no change at all to the CONTRACT — slice 7's MCP surface is a client of these
  // routes, and an envelope that shifted shape underneath it would be a silent
  // break. The cases above already exercise every pre-existing outcome through the
  // real route; this one pins the ENVELOPE ITSELF: the status, and the exact set of
  // top-level body keys.

  it('every pre-existing outcome still returns 200 with a body of exactly { result }', async () => {
    const envelopeCases: ReadonlyArray<{
      name: string;
      build: () => Promise<{ harness: ApiHarness; taskId: string }>;
      expectedOutcome: string;
    }> = [
      {
        name: 'spawned',
        expectedOutcome: 'spawned',
        build: async () => {
          const harness = buildApiHarness();
          const task = await createTaskThrough(harness, { stage: 'planning' });
          return { harness, taskId: task.taskId };
        },
      },
      {
        name: 'refused',
        expectedOutcome: 'refused',
        build: async () => {
          const harness = buildApiHarness();
          const task = await createTaskThrough(harness);
          return { harness, taskId: task.taskId };
        },
      },
      {
        name: 'deferred',
        expectedOutcome: 'deferred',
        build: async () => {
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
          return { harness, taskId: task.taskId };
        },
      },
      {
        name: 'spawn-failed',
        expectedOutcome: 'spawn-failed',
        build: async () => {
          const harness = buildApiHarness();
          harness.sessionHost.refuseNextSpawn('preflight-failed');
          const task = await createTaskThrough(harness, { stage: 'implementing' });
          return { harness, taskId: task.taskId };
        },
      },
    ];

    for (const envelopeCase of envelopeCases) {
      const { harness, taskId } = await envelopeCase.build();
      const response = await harness.request(`/api/tasks/${taskId}/dispatch`, postJson({}));

      expect(response.status, `${envelopeCase.name}: still 200`).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body), `${envelopeCase.name}: exactly one top-level key`).toEqual([
        'result',
      ]);
      expect((body.result as { outcome: string }).outcome).toBe(envelopeCase.expectedOutcome);
    }
  });

  it('the DEFAULT daemon wiring is ISOLATION OFF — a worktree task spawns in projectRoot', async () => {
    // ⚠ Step 8's shipping promise, asserted through the REAL route against a
    // dispatcher built the way `app.ts` builds it minus the flag: `isolation` is
    // `'worktree'` (D32's default, which the create route applies), and the session
    // still lands in the project root. This harness names no worktree deps at all,
    // which is exactly the point — the safe world is the one you get by saying
    // nothing.
    const harness = buildApiHarness();
    const task = await createTaskThrough(harness, { stage: 'planning' });
    expect(task.isolation).toBe('worktree');

    const response = await harness.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DispatchResponse;
    expect(body.result).toMatchObject({ outcome: 'spawned', cwd: harness.allowedRoot });
    expect(harness.sessionHost.spawnCalls).toEqual([
      { channel: 'sdk', cwd: harness.allowedRoot },
    ]);
    // And no `task_worktree_created` anywhere in the log.
    expect(harness.taskEventTypes()).not.toContain(EVENT_TYPES.taskWorktreeCreated);
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
    usageBackoffMaxIntervalMs: 1_800_000,
    usageBackoffMultiplier: 2,
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
    // Worker isolation (slice 6 step 8): OFF in tests, which is also the shipped
    // default — so no test daemon can create a worktree, and this root is never
    // touched. The flip is a human's; see taskDispatcher.ts's isolation block.
    worktreeIsolation: 'off',
    worktreeRoot: '/tmp/vimes-test-worktrees-never-created',
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

// ─── S11-A4: the alias set and its generic twins are ONE handler ──────────────
//
// The load-bearing property of S11·U3: for equivalent requests, an
// `/api/tasks/*` alias and its `/api/instances/*` twin append IDENTICAL events
// and answer with the SAME record, each under its own envelope key. Everything
// above this line pins the alias contract byte-for-byte (that is the alias half
// of A4); everything below pins that the generic contract cannot drift away
// from it while both exist.
//
// ⚠ THE INSTRUMENT IS THE LOG, FIRST. Two routes can agree on a response body
// and disagree about what they wrote — the response is derived, the log is the
// fact — so every case below compares the recorded events before it looks at a
// status code, and the comparison includes MINTED IDS (each harness owns a
// CountingIdSource seeded identically, so an id that differed would be a route
// minting differently rather than entropy).

interface SurfacePair {
  readonly alias: ApiHarness;
  readonly generic: ApiHarness;
}

// Two harnesses, identically composed: same fixed clock, same counting id
// source, same fake session host. One drives the alias, the other the generic
// twin, so neither script can contaminate the other's log.
function surfacePair(options: Parameters<typeof buildApiHarness>[0] = {}): SurfacePair {
  return { alias: buildApiHarness(options), generic: buildApiHarness(options) };
}

// Every recorded event as `{ type, payload }`, with the harness's own temp
// project root substituted out. The root is the ONE thing that legitimately
// differs between two identical scripts (each harness mkdtemps its own), so
// substituting it is what turns "these payloads differ by a mkdtemp suffix"
// into the byte comparison the parity claim actually means. Nothing else is
// normalised — a difference in any other field is a real divergence.
function normalisedEvents(harness: ApiHarness): unknown {
  const asJson = JSON.stringify(
    harness.taskEvents().map((record) => ({ type: record.type, payload: record.payload })),
  );
  return JSON.parse(asJson.split(harness.allowedRoot).join('<ALLOWED-ROOT>')) as unknown;
}

// The generic create door, mirroring `createTaskThrough` above field for field —
// `project`/`node` in place of `projectRoot`/`stage`, and nothing else.
async function createInstanceThrough(
  harness: ApiHarness,
  overrides: Record<string, unknown> = {},
): Promise<InstanceRecord> {
  const response = await harness.request(
    '/api/instances',
    postJson({ project: harness.allowedRoot, createdBy: 'human', ...overrides }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateInstanceResponse).instance;
}

describe('S11-A4 — POST /api/instances and its POST /api/tasks alias', () => {
  it('write the SAME birth record, and each answers from its own fold', async () => {
    const pair = surfacePair();
    // Everything except the two renamed location fields is spelled identically
    // on both doors — that is the design (`createBodyCommonShape` is ONE object,
    // shared by reference), so the bodies below differ in exactly two keys.
    const authoredHalf = {
      createdBy: 'orchestrator',
      isolation: 'shared-dir',
      title: 'the same instance, twice',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
      scope: 'prove the two doors are one handler',
      explicitlyOut: ['the UI', 'adjudication'],
      acceptanceCriteria: [{ text: 'the events are identical' }],
      killCriterion: 'the two surfaces answer differently',
    };

    const aliasResponse = await pair.alias.request(
      '/api/tasks',
      postJson({ projectRoot: pair.alias.allowedRoot, stage: 'planning', ...authoredHalf }),
    );
    const genericResponse = await pair.generic.request(
      '/api/instances',
      postJson({ project: pair.generic.allowedRoot, node: 'planning', ...authoredHalf }),
    );

    expect(aliasResponse.status).toBe(201);
    expect(genericResponse.status).toBe(201);

    // (a) THE LOG — identical in type and payload, minted criterion ids included.
    expect(pair.generic.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
    expect(normalisedEvents(pair.generic)).toEqual(normalisedEvents(pair.alias));

    // (b) THE ENVELOPES — each carries its own fold, under its own key, and
    // neither grew the other's.
    const genericBody = (await genericResponse.json()) as Record<string, unknown>;
    expect(Object.keys(genericBody)).toEqual(['instance']);
    const created = genericBody.instance as InstanceRecord;
    expect(created).toEqual(pair.generic.readInstances().instances[created.instanceId]);
    expect(created.currentNode).toBe('planning');
    expect(created.project).toBe(pair.generic.allowedRoot);
    expect(created.payload.title).toBe('the same instance, twice');

    const aliasBody = (await aliasResponse.json()) as Record<string, unknown>;
    expect(Object.keys(aliasBody)).toEqual(['task']);
    const task = aliasBody.task as TaskRecord;
    expect(task).toEqual(legacyTasksViewOf(pair.alias.readInstances()).tasks[created.instanceId]);
    // The SAME id came out of both doors: one counting source, one mint order.
    expect(task.taskId).toBe(created.instanceId);
  });

  it('apply the SAME defaults — worktree isolation and the backlog start node', async () => {
    // D32's default and the initial node, asserted on the NEW contract rather
    // than inherited by assumption: a generic door that quietly defaulted
    // differently would be a second policy.
    const pair = surfacePair();
    await createTaskThrough(pair.alias);
    const created = await createInstanceThrough(pair.generic);

    expect(created.isolation).toBe('worktree');
    expect(created.currentNode).toBe('backlog');
    expect(normalisedEvents(pair.generic)).toEqual(normalisedEvents(pair.alias));
  });

  it('refuse a project outside the allowlist identically — 403, same body, NO EVENT', async () => {
    // The security wall is the core's, not the surface's. Both doors answer with
    // the same classified refusal and neither leaves an instance-shaped record.
    const pair = surfacePair();

    const aliasResponse = await pair.alias.request(
      '/api/tasks',
      postJson({ projectRoot: pair.alias.outsideRoot, createdBy: 'human' }),
    );
    const genericResponse = await pair.generic.request(
      '/api/instances',
      postJson({ project: pair.generic.outsideRoot, createdBy: 'human' }),
    );

    expect(genericResponse.status).toBe(403);
    expect(aliasResponse.status).toBe(403);
    expect(await genericResponse.json()).toEqual(await aliasResponse.json());
    expect(pair.generic.tasksHead()).toBe(0);
    expect(pair.alias.tasksHead()).toBe(0);
  });

  it('enforce the SAME caps, and each door refuses the OTHER door’s spelling', async () => {
    // Two halves. First: one character over the title cap is a 400 with the same
    // body on both doors — the caps are one set of schema objects, shared by
    // reference. Second, and the point of the rename: the generic door does NOT
    // quietly accept `projectRoot`/`stage`, and the alias does not accept
    // `project`/`node`. A door that took both spellings would make the migration
    // unobservable.
    const pair = surfacePair();

    const aliasOverCap = await pair.alias.request(
      '/api/tasks',
      postJson({ projectRoot: pair.alias.allowedRoot, createdBy: 'human', title: 'x'.repeat(201) }),
    );
    const genericOverCap = await pair.generic.request(
      '/api/instances',
      postJson({ project: pair.generic.allowedRoot, createdBy: 'human', title: 'x'.repeat(201) }),
    );
    expect(genericOverCap.status).toBe(400);
    expect(aliasOverCap.status).toBe(400);
    expect(await genericOverCap.json()).toEqual(await aliasOverCap.json());

    const genericWithLegacySpelling = await pair.generic.request(
      '/api/instances',
      postJson({ projectRoot: pair.generic.allowedRoot, createdBy: 'human' }),
    );
    expect(genericWithLegacySpelling.status).toBe(400);

    const aliasWithGenericSpelling = await pair.alias.request(
      '/api/tasks',
      postJson({ project: pair.alias.allowedRoot, createdBy: 'human' }),
    );
    expect(aliasWithGenericSpelling.status).toBe(400);

    expect(pair.generic.tasksHead()).toBe(0);
    expect(pair.alias.tasksHead()).toBe(0);
  });
});

describe('S11-A4 — POST /api/instances/:instanceId/moves and its transitions alias', () => {
  it('accept the same edge identically, dispatch rider and all', async () => {
    // The promotion path (D53's S7·7c rider) is the busiest thing either surface
    // does: parse → propose → ONE dispatch attempt → relay. Both doors run the
    // same core, so the events, the attempt count and the relayed result all
    // match; only the envelope key differs.
    const pair = surfacePair({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const task = await createTaskThrough(pair.alias);
    const created = await createInstanceThrough(pair.generic);

    const aliasResponse = await pair.alias.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'planning', proposedBy: 'human' }),
    );
    const genericResponse = await pair.generic.request(
      `/api/instances/${created.instanceId}/moves`,
      postJson({ toNode: 'planning', proposedBy: 'human' }),
    );

    expect(genericResponse.status).toBe(200);
    expect(aliasResponse.status).toBe(200);
    expect(pair.generic.taskEventTypes()).toEqual([
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instanceMoved,
    ]);
    expect(normalisedEvents(pair.generic)).toEqual(normalisedEvents(pair.alias));
    // ONE attempt each, on the instance that moved — no surface dispatches twice.
    expect(pair.generic.dispatchedTaskIds()).toEqual([created.instanceId]);
    expect(pair.alias.dispatchedTaskIds()).toEqual([task.taskId]);

    const genericBody = (await genericResponse.json()) as ProposeMoveResponse;
    expect(genericBody).toEqual({
      accepted: true,
      instance: pair.generic.readInstances().instances[created.instanceId],
      // Relayed VERBATIM on the generic door too, including the taskId the fake
      // made up: the route reports, it does not reconstruct.
      dispatch: RELAYED_DISPATCH_RESULT,
    });
    const aliasBody = (await aliasResponse.json()) as ProposeTransitionResponse;
    expect(aliasBody).toEqual({
      accepted: true,
      task: { ...task, stage: 'planning' },
      dispatch: RELAYED_DISPATCH_RESULT,
    });
  });

  it('omit the dispatch key identically when the move is not a promotion', async () => {
    // ABSENT, not `undefined`, on both doors — the spread is in the surface, but
    // the DECISION is in the core, so neither envelope can grow a key the other
    // lacks.
    const pair = surfacePair({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const task = await createTaskThrough(pair.alias, { stage: 'implementing' });
    const created = await createInstanceThrough(pair.generic, { node: 'implementing' });

    const genericResponse = await pair.generic.request(
      `/api/instances/${created.instanceId}/moves`,
      postJson({ toNode: 'review', proposedBy: 'human' }),
    );
    const aliasResponse = await pair.alias.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'review', proposedBy: 'human' }),
    );

    expect(Object.keys((await genericResponse.json()) as object).sort()).toEqual([
      'accepted',
      'instance',
    ]);
    expect(Object.keys((await aliasResponse.json()) as object).sort()).toEqual([
      'accepted',
      'task',
    ]);
    expect(pair.generic.dispatchedTaskIds()).toEqual([]);
    expect(pair.alias.dispatchedTaskIds()).toEqual([]);
    expect(normalisedEvents(pair.generic)).toEqual(normalisedEvents(pair.alias));
  });

  it('record the same rejection, with the same 409 body, on both doors (I7)', async () => {
    // The rejection envelope carries no record, so the two surfaces answer with
    // literally the same bytes — and BOTH wrote the rejection down, which is the
    // half that matters.
    const pair = surfacePair();
    const task = await createTaskThrough(pair.alias);
    const created = await createInstanceThrough(pair.generic);

    const genericResponse = await pair.generic.request(
      `/api/instances/${created.instanceId}/moves`,
      postJson({ toNode: 'review', proposedBy: 'orchestrator' }),
    );
    const aliasResponse = await pair.alias.request(
      `/api/tasks/${task.taskId}/transitions`,
      postJson({ toStage: 'review', proposedBy: 'orchestrator' }),
    );

    expect(genericResponse.status).toBe(409);
    expect(aliasResponse.status).toBe(409);
    expect(await genericResponse.json()).toEqual(await aliasResponse.json());
    expect(pair.generic.taskEventTypes()).toEqual([
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instanceMoveRejected,
    ]);
    expect(normalisedEvents(pair.generic)).toEqual(normalisedEvents(pair.alias));
  });

  it('let an UNKNOWN NODE through to the machine on both doors, and record it', async () => {
    // `toNode` is a plain string on the generic door for the SAME reason `toStage`
    // is on the alias: refusing it in zod would make `unknown-stage` structurally
    // unreachable and leave the hostile-input case with nothing in the log.
    const pair = surfacePair();
    const created = await createInstanceThrough(pair.generic);

    const response = await pair.generic.request(
      `/api/instances/${created.instanceId}/moves`,
      postJson({ toNode: 'shipped-it-lol', proposedBy: 'orchestrator' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ accepted: false, reason: 'unknown-stage' });
    expect(pair.generic.taskEvents()[1]!.payload).toMatchObject({
      attemptedToNode: 'shipped-it-lol',
      reason: 'unknown-stage',
    });
  });

  it('404 an unknown instance on both doors, and write nothing', async () => {
    const pair = surfacePair();

    const genericResponse = await pair.generic.request(
      '/api/instances/instance-that-never-existed/moves',
      postJson({ toNode: 'planning', proposedBy: 'human' }),
    );
    const aliasResponse = await pair.alias.request(
      '/api/tasks/instance-that-never-existed/transitions',
      postJson({ toStage: 'planning', proposedBy: 'human' }),
    );

    expect(genericResponse.status).toBe(404);
    expect(aliasResponse.status).toBe(404);
    expect(await genericResponse.json()).toEqual(await aliasResponse.json());
    expect(pair.generic.tasksHead()).toBe(0);
    expect(pair.alias.tasksHead()).toBe(0);
  });
});

describe('S11-A4 — POST /api/instances/:instanceId/payload-revisions and its amendments alias', () => {
  const REVISION_BODY = {
    amendedBy: 'human',
    scope: 'the revised scope',
    explicitlyOut: ['the thing we dropped'],
    acceptanceCriteria: [{ text: 'a freshly minted criterion' }],
    killCriterion: 'the revision folded differently on the two doors',
  };

  it('write the same revision and each answers with its own folded record', async () => {
    const pair = surfacePair();
    const task = await createTaskThrough(pair.alias);
    const created = await createInstanceThrough(pair.generic);

    const genericResponse = await pair.generic.request(
      `/api/instances/${created.instanceId}/payload-revisions`,
      postJson(REVISION_BODY),
    );
    const aliasResponse = await pair.alias.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson(REVISION_BODY),
    );

    expect(genericResponse.status).toBe(200);
    expect(aliasResponse.status).toBe(200);
    expect(pair.generic.taskEventTypes()).toEqual([
      EVENT_TYPES.instanceCreated,
      EVENT_TYPES.instancePayloadRevised,
    ]);
    expect(normalisedEvents(pair.generic)).toEqual(normalisedEvents(pair.alias));

    const genericBody = (await genericResponse.json()) as RevisePayloadResponse;
    expect(genericBody.instance).toEqual(
      pair.generic.readInstances().instances[created.instanceId],
    );
    // The rev the fold recorded, read back rather than echoed.
    expect(genericBody.instance.payloadRev).toBe(1);
    expect(genericBody.instance.payload.scope).toBe('the revised scope');

    const aliasBody = (await aliasResponse.json()) as AmendWorkOrderResponse;
    expect(aliasBody.task.workOrderRev).toBe(1);
    expect(aliasBody.task.scope).toBe('the revised scope');
  });

  it('refuse an empty revision and an unknown instance identically, writing nothing', async () => {
    const pair = surfacePair();
    const task = await createTaskThrough(pair.alias);
    const created = await createInstanceThrough(pair.generic);
    const genericHeadBefore = pair.generic.tasksHead();
    const aliasHeadBefore = pair.alias.tasksHead();

    const genericEmpty = await pair.generic.request(
      `/api/instances/${created.instanceId}/payload-revisions`,
      postJson({ amendedBy: 'human' }),
    );
    const aliasEmpty = await pair.alias.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson({ amendedBy: 'human' }),
    );
    expect(genericEmpty.status).toBe(400);
    expect(aliasEmpty.status).toBe(400);
    expect(await genericEmpty.json()).toEqual(await aliasEmpty.json());

    const genericUnknown = await pair.generic.request(
      '/api/instances/nope/payload-revisions',
      postJson(REVISION_BODY),
    );
    const aliasUnknown = await pair.alias.request('/api/tasks/nope/amendments', postJson(REVISION_BODY));
    expect(genericUnknown.status).toBe(404);
    expect(aliasUnknown.status).toBe(404);
    expect(await genericUnknown.json()).toEqual(await aliasUnknown.json());

    expect(pair.generic.tasksHead()).toBe(genericHeadBefore);
    expect(pair.alias.tasksHead()).toBe(aliasHeadBefore);
  });

  it('refuse an unknown criterion id identically, echoing the SAME offending id', async () => {
    const pair = surfacePair();
    const created = await createInstanceThrough(pair.generic);
    const task = await createTaskThrough(pair.alias);
    const staleRevision = {
      amendedBy: 'human',
      acceptanceCriteria: [{ id: 'a-criterion-from-another-life', text: 'restated' }],
    };

    const genericResponse = await pair.generic.request(
      `/api/instances/${created.instanceId}/payload-revisions`,
      postJson(staleRevision),
    );
    const aliasResponse = await pair.alias.request(
      `/api/tasks/${task.taskId}/amendments`,
      postJson(staleRevision),
    );

    expect(genericResponse.status).toBe(400);
    expect(aliasResponse.status).toBe(400);
    expect(await genericResponse.json()).toEqual(await aliasResponse.json());
    expect(pair.generic.taskEventTypes()).toEqual([EVENT_TYPES.instanceCreated]);
  });
});

describe('S11-A4 — POST /api/instances/:instanceId/dispatch and its alias', () => {
  it('return literally the same envelope — the dispatch vocabulary needed no rename', async () => {
    // The one operation with no surface difference at all: the result vocabulary
    // is already engine-shaped and workflow-blind, so both routes share the core
    // AND the response type.
    const pair = surfacePair({ dispatchResult: RELAYED_DISPATCH_RESULT });
    const created = await createInstanceThrough(pair.generic, { node: 'planning' });
    const task = await createTaskThrough(pair.alias, { stage: 'planning' });

    const genericResponse = await pair.generic.request(
      `/api/instances/${created.instanceId}/dispatch`,
      postJson({}),
    );
    const aliasResponse = await pair.alias.request(`/api/tasks/${task.taskId}/dispatch`, postJson({}));

    expect(genericResponse.status).toBe(200);
    expect(aliasResponse.status).toBe(200);
    expect(await genericResponse.json()).toEqual(await aliasResponse.json());
    // ONE attempt per request on either door — no surface loops or retries.
    expect(pair.generic.dispatchCallCount()).toBe(1);
    expect(pair.alias.dispatchCallCount()).toBe(1);
    expect(normalisedEvents(pair.generic)).toEqual(normalisedEvents(pair.alias));
  });

  it('404 an unknown instance identically, having attempted exactly once', async () => {
    const pair = surfacePair();

    const genericResponse = await pair.generic.request('/api/instances/nope/dispatch', postJson({}));
    const aliasResponse = await pair.alias.request('/api/tasks/nope/dispatch', postJson({}));

    expect(genericResponse.status).toBe(404);
    expect(aliasResponse.status).toBe(404);
    expect(await genericResponse.json()).toEqual(await aliasResponse.json());
    expect(pair.generic.dispatchCallCount()).toBe(1);
    expect(pair.alias.dispatchCallCount()).toBe(1);
  });
});

describe('S11-A4 — the alias window, stated as tests', () => {
  // ⚠ THE INVENTORY IS THE CONTRACT (q24). These cases pin WHICH paths exist
  // during the one deploy of overlap, so the alias-removal unit can delete a
  // named list and watch exactly these reddens — and so nothing quietly grows a
  // generic twin the slice deliberately did not build.

  it('every generic route is behind the SAME auth wall (I14), with no side effect', async () => {
    const genericRoutes: Array<{ routeName: string; path: string; body: unknown }> = [
      { routeName: 'create', path: '/api/instances', body: { project: '/tmp', createdBy: 'human' } },
      {
        routeName: 'moves',
        path: '/api/instances/any-instance/moves',
        body: { toNode: 'planning', proposedBy: 'human' },
      },
      {
        routeName: 'payload-revisions',
        path: '/api/instances/any-instance/payload-revisions',
        body: { amendedBy: 'human', scope: 'a scope nobody authenticated to write' },
      },
      { routeName: 'dispatch', path: '/api/instances/any-instance/dispatch', body: {} },
    ];

    for (const genericRoute of genericRoutes) {
      const harness = buildApiHarness();
      for (const token of [null, ''] as const) {
        const response = await harness.request(genericRoute.path, postJson(genericRoute.body, token));
        expect(response.status, `${genericRoute.routeName}/${String(token)}`).toBe(401);
      }
      expect(harness.tasksHead()).toBe(0);
      expect(harness.sessionHost.spawnCalls).toEqual([]);
      expect(harness.dispatchCallCount()).toBe(0);
    }
  });

  it('stage-edges and work-order-schema have NO generic twin this slice (q25)', async () => {
    // Their generalisation is DECLARATION INTROSPECTION and needs pinned
    // declarations to introspect (Move 3+). Serving the compiled task table under
    // an `/api/instances/...` name would be declared truth over observed (0.7),
    // so the old paths keep answering and the new ones do not exist yet. Asserted
    // rather than assumed, because "we deliberately did not build it" and "we
    // forgot" look identical in a diff.
    const harness = buildApiHarness();

    for (const absentPath of ['/api/instances/node-edges', '/api/instances/payload-schema']) {
      const response = await harness.request(absentPath, { headers: authHeaders() });
      expect(response.status, absentPath).toBe(404);
    }

    for (const servedPath of ['/api/tasks/stage-edges', '/api/tasks/work-order-schema']) {
      const response = await harness.request(servedPath, { headers: authHeaders() });
      expect(response.status, servedPath).toBe(200);
    }
    // Read-only on either path: fetching the tables wrote nothing.
    expect(harness.tasksHead()).toBe(0);
  });
});
