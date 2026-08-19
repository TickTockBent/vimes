import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CountingIdSource, SteppingClock, type NodeRecord } from '@vimes/core';
import { createDaemon, type Daemon } from './app.js';
import { createAccessAuthMiddleware, type AccessVerifier } from './auth.js';
import type { DaemonConfig } from './config.js';
import {
  registerCheckoutApi,
  statusForCheckoutRefusal,
  type CheckoutNodeResponse,
  type CheckoutRefusalResponse,
  type CheckoutRemovedResponse,
} from './checkoutApi.js';
import {
  checkoutRefusalReasonSchema,
  type CheckoutRefusalReason,
  type CreateCheckoutRequest,
  type CreateCheckoutResult,
  type OpenCheckoutRequest,
  type OpenCheckoutResult,
  type RemoveCheckoutRequest,
  type RemoveCheckoutResult,
} from './checkoutCoordinator.js';

// ─── S17·U4 — the checkout propose-routes over real HTTP requests ────────────
//
// ⚠ **THE INSTRUMENT THAT MATTERS IS THE COORDINATOR'S ARGUMENT LOG, NOT THE
// STATUS CODE.** The unit's central rule (§3.4) is a claim about what the engine
// is ASKED, not about what the caller is told: "a caller-supplied filesystem
// path is never accepted" is only observable by looking at the request object
// that actually reached `CheckoutCoordinator`. A route that answered 201 while
// forwarding a smuggled `path` would look identical from the response side, so
// every §3.4 case asserts on the recorded call.
//
// The coordinator is a SCRIPTED DOUBLE rather than the real class, and that is
// the only honest way to state this unit's assertions:
//   • all sixteen refusal reasons must be drivable, and several of them
//     (`node-write-refused`, `path-escapes-worktree-root`,
//     `checkout-unrecorded-mismatch`) are documented in the coordinator as
//     unreachable in practice — a real instance cannot produce them on demand;
//   • the coordinator's OWN behaviour (the lock, the state table, compensation)
//     is already pinned by `checkoutCoordinator.test.ts`, and re-deriving it
//     through HTTP would make these cases fail when that unit changes.
// The real class is not faked away, only its verbs: the double implements
// exactly the narrowed three-verb interface `app.ts` hands the routes, and the
// request/result TYPES are imported from the coordinator, so a change to either
// side of that contract reddens here at typecheck.

const ANY_TOKEN = 'valid-token-stub';

// Rejects a missing/empty token, accepts anything else — the shape auth.test.ts,
// projectApi.test.ts and nodeApi.test.ts use to make the I14 wall testable
// without minting real JWTs.
const tokenRequiredVerifier: AccessVerifier = {
  verify: async (token) =>
    token === undefined || token === '' ? { ok: false, reason: 'missing-token' } : { ok: true },
};

// `null` means SEND NO TOKEN AT ALL — deliberately a distinct sentinel from
// `undefined`, which would silently fall back to the default and turn an I14
// case into an authenticated request that happens to pass.
function authHeaders(token: string | null = ANY_TOKEN): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === null ? {} : { 'cf-access-jwt-assertion': token }),
  };
}

function postJson(body: unknown, token: string | null = ANY_TOKEN): RequestInit {
  return {
    method: 'POST',
    headers: authHeaders(token),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function postNoBody(token: string | null = ANY_TOKEN): RequestInit {
  return { method: 'POST', headers: authHeaders(token) };
}

// A node as the FOLD would have produced it. The routes pass it through
// untouched, so its only job here is to be recognisable on the wire.
function bornNode(nodeId: string, branch: string, path: string): NodeRecord {
  return {
    nodeId,
    parentNodeId: null,
    projectId: 'project-1',
    name: branch,
    createdAt: '2026-08-18T00:00:00.000Z',
    provenance: { branch, baseRef: 'main', resolvedCommit: 'c0ffee', path },
    directory: path,
    closed: false,
    sessionIds: [],
  };
}

const BORN = bornNode('node-1', 'vimes/node-abc-1234abcd', '/worktrees/node-abc-1234abcd');

const CREATED: CreateCheckoutResult = { outcome: 'created', node: BORN };
const OPENED: OpenCheckoutResult = { outcome: 'opened', node: BORN };
const REMOVED: RemoveCheckoutResult = {
  outcome: 'removed',
  nodeId: 'node-1',
  path: '/worktrees/node-abc-1234abcd',
  branch: 'vimes/node-abc-1234abcd',
  diskRemoved: true,
};

interface CheckoutApiHarness {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  // Every request object the coordinator was handed, in order — the §3.4
  // instrument.
  createCalls: () => CreateCheckoutRequest[];
  openCalls: () => OpenCheckoutRequest[];
  removeCalls: () => RemoveCheckoutRequest[];
  // How many times ANY verb was entered. "A body-shape refusal never reaches the
  // engine" is a claim only this can see.
  verbCallCount: () => number;
  // What the next call to each verb answers.
  scriptCreate: (result: CreateCheckoutResult) => void;
  scriptOpen: (result: OpenCheckoutResult) => void;
  scriptRemove: (result: RemoveCheckoutResult) => void;
}

function buildHarness(): CheckoutApiHarness {
  const createCalls: CreateCheckoutRequest[] = [];
  const openCalls: OpenCheckoutRequest[] = [];
  const removeCalls: RemoveCheckoutRequest[] = [];
  let verbCallCount = 0;
  let createResult: CreateCheckoutResult = CREATED;
  let openResult: OpenCheckoutResult = OPENED;
  let removeResult: RemoveCheckoutResult = REMOVED;

  const app = new Hono();
  // I14 exactly as app.ts installs it: auth in front of EVERYTHING, registered
  // BEFORE any route, so no handler can run without the middleware passing
  // first (nodeApi.test.ts's harness, verbatim in shape).
  app.use(
    '*',
    createAccessAuthMiddleware({
      verifier: tokenRequiredVerifier,
      emitAuthRejected: () => {},
    }),
  );
  registerCheckoutApi(app, {
    checkoutCoordinator: {
      create: async (request) => {
        verbCallCount += 1;
        createCalls.push(request);
        return createResult;
      },
      open: async (request) => {
        verbCallCount += 1;
        openCalls.push(request);
        return openResult;
      },
      remove: async (request) => {
        verbCallCount += 1;
        removeCalls.push(request);
        return removeResult;
      },
    },
  });

  return {
    request: async (path, init) => app.request(path, init),
    createCalls: () => createCalls,
    openCalls: () => openCalls,
    removeCalls: () => removeCalls,
    verbCallCount: () => verbCallCount,
    scriptCreate: (result) => {
      createResult = result;
    },
    scriptOpen: (result) => {
      openResult = result;
    },
    scriptRemove: (result) => {
      removeResult = result;
    },
  };
}

function refused(reason: CheckoutRefusalReason, detail?: string) {
  return detail === undefined
    ? ({ outcome: 'refused', reason } as const)
    : ({ outcome: 'refused', reason, detail } as const);
}

// ── happy paths ──────────────────────────────────────────────────────────────

describe('S17·U4 — POST /api/checkouts (create)', () => {
  it('201 + the BORN node, and the coordinator is asked with identities only', async () => {
    const harness = buildHarness();
    const response = await harness.request(
      '/api/checkouts',
      postJson({ projectId: 'project-1', baseRef: 'main' }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as CheckoutNodeResponse;
    expect(body.node).toEqual(BORN);
    expect(harness.createCalls()).toEqual([{ projectId: 'project-1', baseRef: 'main' }]);
  });

  it('an omitted baseRef stays ABSENT rather than becoming `baseRef: undefined`', async () => {
    const harness = buildHarness();
    const response = await harness.request('/api/checkouts', postJson({ projectId: 'project-1' }));

    expect(response.status).toBe(201);
    // §3.1's default-branch algorithm is the ENGINE's to run; the route must not
    // hand it a key at all. `toEqual` ignores explicit-undefined keys, so the
    // key list is checked directly.
    expect(Object.keys(harness.createCalls()[0]!)).toEqual(['projectId']);
  });
});

describe('S17·U4 — POST /api/checkouts/open', () => {
  it('201 + the BORN node, and the coordinator is asked with projectId + branch only', async () => {
    const harness = buildHarness();
    const response = await harness.request(
      '/api/checkouts/open',
      postJson({ projectId: 'project-1', branch: 'feature/x' }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as CheckoutNodeResponse;
    expect(body.node).toEqual(BORN);
    expect(harness.openCalls()).toEqual([{ projectId: 'project-1', branch: 'feature/x' }]);
  });

  it('is a DIFFERENT verb from create — the create route is never entered', async () => {
    const harness = buildHarness();
    await harness.request('/api/checkouts/open', postJson({ projectId: 'p', branch: 'b' }));
    expect(harness.createCalls()).toEqual([]);
  });
});

describe('S17·U4 — POST /api/checkouts/:nodeId/remove', () => {
  it('200 + the engine-derived facts, and ONLY the id is passed', async () => {
    const harness = buildHarness();
    const response = await harness.request('/api/checkouts/node-1/remove', postNoBody());

    expect(response.status).toBe(200);
    const body = (await response.json()) as CheckoutRemovedResponse;
    expect(body).toEqual({
      nodeId: 'node-1',
      path: '/worktrees/node-abc-1234abcd',
      branch: 'vimes/node-abc-1234abcd',
      diskRemoved: true,
    });
    expect(harness.removeCalls()).toEqual([{ nodeId: 'node-1' }]);
  });

  it("§3.10's idempotent no-op row surfaces as 200 with diskRemoved: false", async () => {
    const harness = buildHarness();
    harness.scriptRemove({ ...REMOVED, diskRemoved: false });
    const response = await harness.request('/api/checkouts/node-1/remove', postNoBody());

    expect(response.status).toBe(200);
    expect(((await response.json()) as CheckoutRemovedResponse).diskRemoved).toBe(false);
  });

  it('reads NO body: a smuggled path-bearing body is not even parsed, and never forwarded', async () => {
    const harness = buildHarness();
    const response = await harness.request(
      '/api/checkouts/node-1/remove',
      postJson({ path: '/etc', worktreePath: '/etc', force: true }),
    );

    expect(response.status).toBe(200);
    expect(harness.removeCalls()).toEqual([{ nodeId: 'node-1' }]);
  });
});

// ── §3.4, THE UNIT'S CENTRAL RULE, ASSERTED DIRECTLY ─────────────────────────

describe('S17·U4 — §3.4: no route accepts a caller-supplied filesystem path', () => {
  const SMUGGLED = {
    path: '/etc/passwd',
    directory: '/etc',
    worktreePath: '/tmp/attacker',
    root: '/',
    repoRoot: '/',
  };

  it('create: the smuggled path fields are STRIPPED (ignored, not refused) and never reach the engine', async () => {
    const harness = buildHarness();
    const response = await harness.request(
      '/api/checkouts',
      postJson({ projectId: 'project-1', baseRef: 'main', ...SMUGGLED }),
    );

    // The house zod convention is `z.object`, which STRIPS unknown keys — the
    // same posture `nodeApi.ts` pins for a smuggled `provenance` (ignored, not
    // refused). Pinning WHICH stop is hit matters: a future `.strict()` would be
    // a deliberate change, not a silent one.
    expect(response.status).toBe(201);
    const forwarded = harness.createCalls()[0]!;
    expect(forwarded).toEqual({ projectId: 'project-1', baseRef: 'main' });
    for (const smuggledKey of Object.keys(SMUGGLED)) {
      expect(Object.keys(forwarded)).not.toContain(smuggledKey);
    }
    // And no value the caller sent survives anywhere in the request object.
    expect(JSON.stringify(forwarded)).not.toContain('/etc');
    expect(JSON.stringify(forwarded)).not.toContain('/tmp/attacker');
  });

  it('open: the smuggled path fields are STRIPPED and never reach the engine', async () => {
    const harness = buildHarness();
    const response = await harness.request(
      '/api/checkouts/open',
      postJson({ projectId: 'project-1', branch: 'feature/x', ...SMUGGLED }),
    );

    expect(response.status).toBe(201);
    const forwarded = harness.openCalls()[0]!;
    expect(forwarded).toEqual({ projectId: 'project-1', branch: 'feature/x' });
    expect(JSON.stringify(forwarded)).not.toContain('/etc');
  });

  it('remove: the target is the id alone — no request field can name a directory', async () => {
    const harness = buildHarness();
    await harness.request(
      '/api/checkouts/node-1/remove',
      postJson({ path: '/etc/passwd', nodeId: 'other-node' }),
    );

    const forwarded = harness.removeCalls()[0]!;
    expect(forwarded).toEqual({ nodeId: 'node-1' });
    expect(Object.keys(forwarded)).toEqual(['nodeId']);
  });

  it('a path smuggled as a VALUE of a legitimate field is still just that field', async () => {
    // The rule is about FIELDS, not about string contents: `projectId` is an
    // identity the engine looks up in the registry, so a path-shaped value is
    // simply an id that names nothing. It must not be re-interpreted as a path
    // by anything on the way in — the route forwards it verbatim as the identity
    // it is, and the engine answers `unknown-project`.
    const harness = buildHarness();
    harness.scriptCreate(refused('unknown-project'));
    const response = await harness.request(
      '/api/checkouts',
      postJson({ projectId: '/etc/passwd' }),
    );

    expect(response.status).toBe(404);
    expect(harness.createCalls()).toEqual([{ projectId: '/etc/passwd' }]);
  });
});

// ── §3.5, the status map ─────────────────────────────────────────────────────

describe('S17·U4 — §3.5: the refusal status map is TOTAL over the closed enum', () => {
  // The full signed table, restated here as DATA so the map is pinned
  // independently of the switch that implements it. A seventeenth enum member
  // fails the enumeration below; a re-mapped member fails its own row.
  const SIGNED_STATUS_BY_REASON: Record<CheckoutRefusalReason, 400 | 404 | 409 | 503> = {
    // 409 — STATE conflicts (§3.5 reserves 409 for exactly these)
    'branch-already-exists': 409,
    'branch-checked-out-elsewhere': 409,
    'checkout-in-use': 409,
    'checkout-unrecorded-mismatch': 409,
    'not-a-checkout': 409,
    'node-write-refused': 409,
    // 404 — the request names nothing that exists
    'unknown-project': 404,
    'unknown-node': 404,
    'branch-not-found': 404,
    'not-a-repo': 404,
    // 400 — no valid operation can be built
    'invalid-ref': 400,
    'unresolvable-ref': 400,
    'no-default-branch': 400,
    'path-escapes-worktree-root': 400,
    'git-failed': 400,
    // 503 — infrastructure
    'git-unavailable': 503,
  };

  it('every one of the sixteen enum members maps to its signed status', () => {
    for (const reason of checkoutRefusalReasonSchema.options) {
      const signedStatus = SIGNED_STATUS_BY_REASON[reason];
      // Fails LOUDLY for an unmapped member rather than quietly comparing
      // undefined to undefined.
      expect(signedStatus, `no signed status for ${reason}`).toBeDefined();
      expect(statusForCheckoutRefusal(reason), reason).toBe(signedStatus);
    }
  });

  it('the enum has exactly the sixteen members this table covers', () => {
    expect([...checkoutRefusalReasonSchema.options].sort()).toEqual(
      Object.keys(SIGNED_STATUS_BY_REASON).sort(),
    );
  });

  it('409 is RESERVED for state conflicts — no identity-miss or validation reason gets one', () => {
    for (const reason of ['unknown-project', 'unknown-node', 'branch-not-found', 'not-a-repo'] as const) {
      expect(statusForCheckoutRefusal(reason), reason).not.toBe(409);
    }
    for (const reason of ['invalid-ref', 'unresolvable-ref', 'no-default-branch', 'git-failed'] as const) {
      expect(statusForCheckoutRefusal(reason), reason).not.toBe(409);
    }
  });
});

describe('S17·U4 — every reachable refusal reaches the wire with its signed status', () => {
  // The reasons each verb can actually answer with, per the coordinator's own
  // code paths. Driven through the real routes, not just the mapping function.
  const CREATE_REASONS: CheckoutRefusalReason[] = [
    'unknown-project',
    'path-escapes-worktree-root',
    'no-default-branch',
    'invalid-ref',
    'unresolvable-ref',
    'branch-already-exists',
    'node-write-refused',
    'git-unavailable',
    'not-a-repo',
    'git-failed',
  ];
  const OPEN_REASONS: CheckoutRefusalReason[] = [
    'unknown-project',
    'path-escapes-worktree-root',
    'invalid-ref',
    'branch-not-found',
    'branch-checked-out-elsewhere',
    'checkout-unrecorded-mismatch',
    'node-write-refused',
    'git-unavailable',
    'not-a-repo',
    'git-failed',
  ];
  const REMOVE_REASONS: CheckoutRefusalReason[] = [
    'unknown-node',
    'not-a-checkout',
    'unknown-project',
    'checkout-in-use',
    'git-unavailable',
    'not-a-repo',
    'git-failed',
  ];

  it('create: each reachable refusal → its signed status and `{ error: <reason> }`', async () => {
    for (const reason of CREATE_REASONS) {
      const harness = buildHarness();
      harness.scriptCreate(refused(reason));
      const response = await harness.request('/api/checkouts', postJson({ projectId: 'project-1' }));

      expect(response.status, reason).toBe(statusForCheckoutRefusal(reason));
      expect(await response.json(), reason).toEqual({ error: reason });
    }
  });

  it('open: each reachable refusal → its signed status and `{ error: <reason> }`', async () => {
    for (const reason of OPEN_REASONS) {
      const harness = buildHarness();
      harness.scriptOpen(refused(reason));
      const response = await harness.request(
        '/api/checkouts/open',
        postJson({ projectId: 'project-1', branch: 'b' }),
      );

      expect(response.status, reason).toBe(statusForCheckoutRefusal(reason));
      expect(await response.json(), reason).toEqual({ error: reason });
    }
  });

  it('remove: each reachable refusal → its signed status and `{ error: <reason> }`', async () => {
    for (const reason of REMOVE_REASONS) {
      const harness = buildHarness();
      harness.scriptRemove(refused(reason));
      const response = await harness.request('/api/checkouts/node-1/remove', postNoBody());

      expect(response.status, reason).toBe(statusForCheckoutRefusal(reason));
      expect(await response.json(), reason).toEqual({ error: reason });
    }
  });

  it('remove: a checkout still in use is a 409 naming its blockers, VERBATIM', async () => {
    const harness = buildHarness();
    harness.scriptRemove(refused('checkout-in-use', 'app-session-a,app-session-b'));
    const response = await harness.request('/api/checkouts/node-1/remove', postNoBody());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'checkout-in-use',
      detail: 'app-session-a,app-session-b',
    });
  });

  it('the detail is passed through UNENRICHED, and OMITTED when the engine omitted it', async () => {
    // §3.10's two `branch-already-exists` variants, which differ in exactly this.
    const withDetail = buildHarness();
    withDetail.scriptCreate(refused('branch-already-exists', '/worktrees/node-old'));
    const detailed = await withDetail.request('/api/checkouts', postJson({ projectId: 'p' }));
    expect(detailed.status).toBe(409);
    expect(await detailed.json()).toEqual({
      error: 'branch-already-exists',
      detail: '/worktrees/node-old',
    });

    const withoutDetail = buildHarness();
    withoutDetail.scriptCreate(refused('branch-already-exists'));
    const bare = await withoutDetail.request('/api/checkouts', postJson({ projectId: 'p' }));
    expect(bare.status).toBe(409);
    const bareBody = (await bare.json()) as CheckoutRefusalResponse;
    expect(bareBody).toEqual({ error: 'branch-already-exists' });
    expect(Object.keys(bareBody)).toEqual(['error']);
  });
});

// ── body-shape refusals (the zod-level 400 the neighbours already produce) ───

describe('S17·U4 — body-shape refusals never reach the engine', () => {
  const BAD_CREATE_BODIES: Array<{ label: string; body: unknown }> = [
    { label: 'missing projectId', body: { baseRef: 'main' } },
    { label: 'empty projectId', body: { projectId: '' } },
    { label: 'non-string projectId', body: { projectId: 42 } },
    { label: 'empty baseRef', body: { projectId: 'p', baseRef: '' } },
    { label: 'non-object body', body: '"just a string"' },
    { label: 'unparseable bytes', body: '{not json' },
  ];

  it.each(BAD_CREATE_BODIES)('create: $label → 400, coordinator untouched', async ({ body }) => {
    const harness = buildHarness();
    const response = await harness.request('/api/checkouts', postJson(body));

    expect(response.status).toBe(400);
    // `nodeApi.ts` / `projectApi.ts`'s zod-level shape, verbatim — the CLASSIFIED
    // reason, never the offending value.
    const parsed = (await response.json()) as { error: string; detail: string };
    expect(parsed.error).toBe('bad request');
    expect(['schema', 'invalid-json']).toContain(parsed.detail);
    expect(harness.verbCallCount()).toBe(0);
  });

  const BAD_OPEN_BODIES: Array<{ label: string; body: unknown }> = [
    { label: 'missing branch', body: { projectId: 'p' } },
    { label: 'empty branch', body: { projectId: 'p', branch: '' } },
    { label: 'missing projectId', body: { branch: 'b' } },
    { label: 'non-string branch', body: { projectId: 'p', branch: ['b'] } },
    { label: 'unparseable bytes', body: '{' },
  ];

  it.each(BAD_OPEN_BODIES)('open: $label → 400, coordinator untouched', async ({ body }) => {
    const harness = buildHarness();
    const response = await harness.request('/api/checkouts/open', postJson(body));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('bad request');
    expect(harness.verbCallCount()).toBe(0);
  });

  it('a refused body is never confused with an engine refusal: `bad request` is not an enum member', () => {
    expect([...checkoutRefusalReasonSchema.options]).not.toContain('bad request');
  });
});

// ── I14: the same auth wall the neighbouring routes sit behind ───────────────

describe('S17·U4 — I14: every checkout route is behind the auth wall', () => {
  const ROUTES: Array<{ path: string; init: (token: string | null) => RequestInit }> = [
    { path: '/api/checkouts', init: (token) => postJson({ projectId: 'p' }, token) },
    { path: '/api/checkouts/open', init: (token) => postJson({ projectId: 'p', branch: 'b' }, token) },
    { path: '/api/checkouts/node-1/remove', init: (token) => postNoBody(token) },
  ];

  it.each(ROUTES)('$path: an unauthenticated request is 401 and the engine is never asked', async ({ path, init }) => {
    const harness = buildHarness();
    const response = await harness.request(path, init(null));

    expect(response.status).toBe(401);
    expect(harness.verbCallCount()).toBe(0);
  });

  it.each(ROUTES)('$path: an authenticated request reaches the engine', async ({ path, init }) => {
    const harness = buildHarness();
    await harness.request(path, init(ANY_TOKEN));
    expect(harness.verbCallCount()).toBe(1);
  });
});

// ── Part D: the routes are actually REGISTERED on the daemon ─────────────────
//
// ⚠ **EVERY CASE ABOVE DRIVES A BARE `Hono` THIS FILE BUILT, SO NOT ONE OF THEM
// WOULD NOTICE IF `app.ts` NEVER CALLED `registerCheckoutApi`.** That is the
// wiring hole this block closes, and it is the same shape as the mistake this
// project has already been bitten by (a UI asking a daemon for a route the
// daemon did not serve, failing as a plausible-looking empty answer rather than
// as an error).
//
// The probe is a BODY-SHAPE refusal — `{}` → 400 `{ error: 'bad request' }` —
// chosen because it is unambiguous: an unregistered route falls through to the
// SPA/static catch-all or a 404, and no engine refusal produces a 400 with that
// body. A refusal probe also means the daemon is never asked to touch git or a
// filesystem: `verbCallCount`'s daemon-side equivalent is that no coordinator
// verb is reachable from a request that never gets past zod.
describe('S17·U4 — Part D: registered on the real daemon', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-checkoutapi-'));
  let databaseFileCounter = 0;

  afterAll(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  // The shipped config with every timer disabled — the same posture
  // gitApi.test.ts's own `buildConfig` takes, kept local because every route
  // module in this daemon owns its harness.
  function buildDaemonConfig(): DaemonConfig {
    databaseFileCounter += 1;
    return {
      port: 0,
      hookPort: 0,
      dbPath: join(temporaryDirectory, `checkoutapi-${databaseFileCounter}.db`),
      dataDir: temporaryDirectory,
      cliVersionFloor: undefined,
      cliVersionLastVerified: undefined,
      sdkCliVersionFloor: undefined,
      sdkCliVersionLastVerified: undefined,
      snapshotIntervalMs: 60_000,
      accessTeamDomain: undefined,
      accessAud: undefined,
      staticDir: undefined,
      wsBufferedLimitBytes: 4_194_304,
      bindHost: '127.0.0.1',
      sdkSettingSources: ['project'],
      projectRoots: [temporaryDirectory],
      pushSubject: 'mailto:test@example.invalid',
      maxEditBytes: 5 * 1024 * 1024,
      terminalIdleReapMs: 0,
      usagePollIntervalMs: 0,
      usageBackoffMaxIntervalMs: 1_800_000,
      usageBackoffMultiplier: 2,
      usageBaseUrl: 'http://usage.invalid',
      usageAlertPercents: [],
      usageForcedRefreshMinIntervalMs: 0,
      costIngestIntervalMs: 0,
      watchdogCheckIntervalMs: 0,
      watchdogStaleAfterMs: 900_000,
      watchdogMaxStaleEpisodes: 3,
      watchdogRetryBackoffMs: [60_000],
      worktreeIsolation: 'off',
      // Never created: no case here reaches a git verb, let alone a filesystem.
      worktreeRoot: join(temporaryDirectory, 'worktrees-never-created'),
    };
  }

  async function withDaemon(run: (daemon: Daemon) => Promise<void>): Promise<void> {
    const daemon = createDaemon({
      config: buildDaemonConfig(),
      clock: new SteppingClock('2026-08-18T00:00:00.000Z', 1000),
      ids: new CountingIdSource(),
      verifier: { verify: async () => ({ ok: true }) },
      // A runner that would throw if anything ever shelled out on these paths.
      gitRunner: async () => {
        throw new Error('no git subprocess may run in a registration probe');
      },
    });
    await daemon.start();
    try {
      await run(daemon);
    } finally {
      await daemon.stop();
    }
  }

  const REGISTERED_ROUTES = [
    { path: '/api/checkouts', body: '{}' },
    { path: '/api/checkouts/open', body: '{}' },
  ];

  it.each(REGISTERED_ROUTES)('$path is served by the daemon', async ({ path, body }) => {
    await withDaemon(async (daemon) => {
      const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': ANY_TOKEN, 'content-type': 'application/json' },
        body,
      });
      expect(response.status, path).toBe(400);
      expect(((await response.json()) as { error: string }).error, path).toBe('bad request');
    });
  });

  it('/api/checkouts/:nodeId/remove is served by the daemon', async () => {
    await withDaemon(async (daemon) => {
      // `remove` reads no body, so its registration probe is the engine's own
      // first gate instead: an id naming no node is `unknown-node` (404), which
      // an unregistered route could never produce — the enum member is the proof
      // the handler ran.
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/checkouts/no-such-node/remove`, {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'unknown-node' });
    });
  });
});
