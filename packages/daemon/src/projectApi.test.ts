import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  projectsProjection,
  readAllStreamsGrouped,
  replayFromEmpty,
  type EventRecord,
  type ProjectRecord,
} from '@vimes/core';
import { createAccessAuthMiddleware, type AccessVerifier } from './auth.js';
import {
  registerProjectApi,
  type ListProjectsResponse,
  type ProjectResponse,
} from './projectApi.js';
import { ProjectWriter } from './projectWriter.js';

// ─── S8·1 — the project-registry API over real HTTP requests ─────────────────
//
// ⚠ THE INSTRUMENTS THAT MATTER ARE THE EVENT LOG AND THE WRITER-CALL COUNTER,
// NOT THE STATUS CODE. Two of this unit's guarantees are only observable there:
//   • the D60 fence — a root outside the STATIC config roots must never REACH the
//     writer, so a refused declaration leaves no record and consumes no id. A
//     route that emitted first and validated second would still answer 403.
//   • the refusals that write nothing (`duplicate-root`, `empty-update`,
//     `already-archived`) — the status code alone proves none of them.
//
// The directories are REAL temp dirs, so `resolveWithinRoots` runs its REAL
// symlink-aware probe rather than a fake that could agree with a wrong
// implementation (the taskApi.test.ts pattern).

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-projectapi-'));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

const ANY_TOKEN = 'valid-token-stub';
// Rejects a missing/empty token, accepts anything else — the same shape
// auth.test.ts and taskApi.test.ts use to make the I14 wall testable without
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

function postJson(body: unknown, token: string | null = ANY_TOKEN): RequestInit {
  return {
    method: 'POST',
    headers: authHeaders(token),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

interface ApiHarness {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  // Every record on the 'projects' stream, in order.
  projectEvents: () => EventRecord[];
  projectEventTypes: () => string[];
  // The 'projects' stream head — the "did anything get written" instrument.
  projectsHead: () => number;
  // How many times a WRITER method was entered. The D60 fence is a claim about
  // what never reaches the writer, and only this can see it.
  writerCallCount: () => number;
  // Inside the STATIC config roots — the only place a project may be declared.
  configuredRoot: string;
  // A directory OUTSIDE the config roots that a live session's cwd would have put
  // into the file/git/task allow-list union. This API deliberately does not use
  // that union (D60), so it must stay refused.
  liveSessionCwd: string;
  // Outside everything.
  outsideRoot: string;
}

function buildApiHarness(): ApiHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-07-29T12:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  const configuredRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'configured-')));
  const liveSessionCwd = realpathSync(mkdtempSync(join(temporaryDirectory, 'live-cwd-')));
  const outsideRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'outside-')));

  const readProjects = () => replayFromEmpty(projectsProjection, readAllStreamsGrouped(store));
  const projectWriter = new ProjectWriter({
    emit: (events) => store.append(events),
    readProjects,
    ids: new CountingIdSource(),
  });

  // Count every ENTRY into the writer. Wrapping the instance rather than faking
  // the class keeps the real writer in the loop — the count is an extra
  // observation, never a substitute for one.
  let writerCallCount = 0;
  const realCreate = projectWriter.createProject.bind(projectWriter);
  const realUpdate = projectWriter.updateProject.bind(projectWriter);
  const realArchive = projectWriter.archiveProject.bind(projectWriter);
  projectWriter.createProject = (input) => {
    writerCallCount += 1;
    return realCreate(input);
  };
  projectWriter.updateProject = (projectId, input) => {
    writerCallCount += 1;
    return realUpdate(projectId, input);
  };
  projectWriter.archiveProject = (projectId) => {
    writerCallCount += 1;
    return realArchive(projectId);
  };

  const app = new Hono();
  // I14 exactly as app.ts installs it: auth in front of EVERYTHING, registered
  // BEFORE any route, so no handler can run without the middleware passing first.
  app.use(
    '*',
    createAccessAuthMiddleware({
      verifier: tokenRequiredVerifier,
      // A rejection writes to the SYSTEM stream in production; here it is a no-op
      // so the 'projects' stream head stays a clean instrument for "the route
      // wrote something".
      emitAuthRejected: () => {},
    }),
  );
  registerProjectApi(app, {
    projectWriter,
    readProjects,
    // ⚠ **THE STATIC CONFIG ROOTS ONLY (D60).** `liveSessionCwd` is deliberately
    // NOT in this list even though the file/git/task APIs would have it in their
    // union — that asymmetry is the security content of this unit, and the case
    // below pins it.
    getConfiguredProjectRoots: () => [configuredRoot],
  });

  return {
    request: async (path, init) => app.request(path, init),
    projectEvents: () => store.read('projects', 1),
    projectEventTypes: () => store.read('projects', 1).map((record) => record.type),
    projectsHead: () => store.head('projects'),
    writerCallCount: () => writerCallCount,
    configuredRoot,
    liveSessionCwd,
    outsideRoot,
  };
}

async function declareProjectThrough(
  harness: ApiHarness,
  overrides: Record<string, unknown> = {},
): Promise<ProjectRecord> {
  const response = await harness.request(
    '/api/projects',
    postJson({ root: harness.configuredRoot, ...overrides }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as ProjectResponse).project;
}

// A real directory nested inside the configured root, so nesting cases have a
// genuine path to declare rather than a string the fs would refuse.
function makeNestedDirectory(harness: ApiHarness, prefix: string): string {
  return realpathSync(mkdtempSync(join(harness.configuredRoot, prefix)));
}

describe('POST /api/projects — declare', () => {
  it('declares (200) and returns the record AS FOLDED, with archived false', async () => {
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/projects',
      postJson({ root: harness.configuredRoot, name: 'VIMES', description: 'the session host' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectResponse;
    expect(body.project.root).toBe(harness.configuredRoot);
    expect(body.project.name).toBe('VIMES');
    expect(body.project.description).toBe('the session host');
    expect(body.project.archived).toBe(false);

    // Exactly one event, and it is the birth record.
    expect(harness.projectEventTypes()).toEqual([EVENT_TYPES.projectCreated]);
    // ⚠ THE COUNTER IS LIVE. Every fence case below asserts `writerCallCount()`
    // is ZERO, and a counter that never moved would make all of them pass
    // vacuously — this is the case that proves it moves.
    expect(harness.writerCallCount()).toBe(1);
  });

  it('ABSENT STAYS ABSENT: no name in the body → no name key on the record OR the event', async () => {
    // D42's basename fallback is a READ-TIME derivation; storing it here would make
    // "unnamed" and "named after its folder" the same recorded fact.
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness);
    expect('name' in project).toBe(false);
    expect('description' in project).toBe(false);

    const birthPayload = harness.projectEvents()[0]!.payload as Record<string, unknown>;
    expect('name' in birthPayload).toBe(false);
  });

  it('TRIMS a padded name, and REFUSES a whitespace-only one with NO EVENT', async () => {
    // `.trim()` runs before `.min(1)`, so `"   "` is not a name — it is a body that
    // was never a declaration, and the idiom for that is 400 with nothing written.
    const harness = buildApiHarness();
    const padded = await declareProjectThrough(harness, { name: '  VIMES  ' });
    expect(padded.name).toBe('VIMES');

    const headAfterPadded = harness.projectsHead();
    const blank = await harness.request(
      '/api/projects',
      postJson({ root: makeNestedDirectory(harness, 'blank-'), name: '   ' }),
    );
    expect(blank.status).toBe(400);
    expect(harness.projectsHead()).toBe(headAfterPadded);
  });

  it('a name AT the cap is accepted; one character OVER is 400 with NO EVENT', async () => {
    // ⚠ THE INSTRUMENT IS THE LOG, NOT THE STATUS CODE. A route that emitted the
    // birth record before validating would still answer 400 here; only the
    // untouched stream head proves nothing was written.
    const cap = 200;
    const harness = buildApiHarness();
    const atTheCap = await declareProjectThrough(harness, { name: 'x'.repeat(cap) });
    expect(atTheCap.name).toHaveLength(cap);

    const headAfterAccepted = harness.projectsHead();
    const overTheCap = await harness.request(
      '/api/projects',
      postJson({ root: makeNestedDirectory(harness, 'over-'), name: 'x'.repeat(cap + 1) }),
    );
    expect(overTheCap.status).toBe(400);
    expect(harness.projectsHead()).toBe(headAfterAccepted);
  });

  it('refuses a malformed body (400) and a missing root (400), writing nothing', async () => {
    const harness = buildApiHarness();
    const notJson = await harness.request('/api/projects', postJson('{not json at all'));
    expect(notJson.status).toBe(400);
    const noRoot = await harness.request('/api/projects', postJson({ name: 'rootless' }));
    expect(noRoot.status).toBe(400);
    expect(harness.projectsHead()).toBe(0);
    expect(harness.writerCallCount()).toBe(0);
  });

  it('⚠ VALIDATION ORDER: an out-of-roots root NEVER REACHES THE WRITER (403)', async () => {
    // The D60 fence, asserted on the writer-call counter rather than the status
    // code. A route that called the writer first and checked the allow-list second
    // would answer 403 identically while having already minted an id and written a
    // birth record for a directory nobody allowed.
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/projects',
      postJson({ root: harness.outsideRoot, name: 'somewhere else' }),
    );
    expect(response.status).toBe(403);
    expect(harness.writerCallCount()).toBe(0);
    expect(harness.projectsHead()).toBe(0);
    // No path echo — a refusal names the class of failure and never confirms what
    // does or does not exist outside the roots.
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('forbidden');
    expect(JSON.stringify(body)).not.toContain(harness.outsideRoot);
  });

  it('⚠ D60: a path the LIVE SESSION-CWD UNION would allow is still REFUSED', async () => {
    // The one place this file deliberately differs from fileApi/gitApi/taskApi,
    // and the whole security content of the unit. A session's transient cwd is not
    // a declarable boundary: declaring inside one would mint a PERMANENT boundary
    // out of a temporary allowance, and a worktree-isolated stage run's cwd sits
    // outside every root by design (`config.worktreeRoot`).
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/projects',
      postJson({ root: harness.liveSessionCwd }),
    );
    expect(response.status).toBe(403);
    expect(harness.writerCallCount()).toBe(0);
    expect(harness.projectsHead()).toBe(0);
  });

  it('refuses a traversal that climbs out of the roots (403), before the writer', async () => {
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/projects',
      postJson({ root: join(harness.configuredRoot, '..', '..', '..', 'etc') }),
    );
    expect(response.status).toBe(403);
    expect(harness.writerCallCount()).toBe(0);
  });

  it('refuses a root INSIDE the fence that does not exist (400 no-such-directory)', async () => {
    // A boundary pointing at nothing would sit in the registry forever, matching no
    // cwd, with no way for the human to see why. `resolveWithinRoots` says `ok`
    // here — it canonicalizes the existing ancestor and re-appends the missing tail
    // — so existence is this route's question to ask.
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/projects',
      postJson({ root: join(harness.configuredRoot, 'no-such-subdirectory') }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toBe('no-such-directory');
    expect(harness.writerCallCount()).toBe(0);
    expect(harness.projectsHead()).toBe(0);
  });

  it('refuses a root that is a FILE (400 not-a-directory)', async () => {
    const harness = buildApiHarness();
    const filePath = join(harness.configuredRoot, 'not-a-directory.txt');
    writeFileSync(filePath, 'a project boundary this is not\n');
    const response = await harness.request('/api/projects', postJson({ root: filePath }));
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toBe('not-a-directory');
    expect(harness.writerCallCount()).toBe(0);
    expect(harness.projectsHead()).toBe(0);
  });

  it('an EXACT duplicate live root is 409 + the existing projectId, with NO EVENT', async () => {
    const harness = buildApiHarness();
    const first = await declareProjectThrough(harness, { name: 'the first one' });
    const headAfterFirst = harness.projectsHead();

    const response = await harness.request(
      '/api/projects',
      postJson({ root: harness.configuredRoot, name: 'the second one' }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { detail: string; projectId: string };
    expect(body.detail).toBe('duplicate-root');
    // The id IS echoed, unlike the 403's path suppression: it names a project this
    // caller just proved it may see, and it is how a picker navigates there.
    expect(body.projectId).toBe(first.projectId);
    expect(harness.projectsHead()).toBe(headAfterFirst);
  });

  it('NESTING is accepted — a directory under an existing project (D42)', async () => {
    const harness = buildApiHarness();
    await declareProjectThrough(harness, { name: 'the parent' });
    const nestedDirectory = makeNestedDirectory(harness, 'nested-');
    const response = await harness.request(
      '/api/projects',
      postJson({ root: nestedDirectory, name: 'the child' }),
    );
    expect(response.status).toBe(200);
    expect(harness.projectEventTypes()).toEqual([
      EVENT_TYPES.projectCreated,
      EVENT_TYPES.projectCreated,
    ]);
  });

  it('is behind the auth wall (I14) — no token, no route', async () => {
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/projects',
      postJson({ root: harness.configuredRoot }, null),
    );
    expect(response.status).toBe(401);
    expect(harness.writerCallCount()).toBe(0);
    expect(harness.projectsHead()).toBe(0);
  });
});

describe('GET /api/projects — the registry', () => {
  it('is empty on first launch (D42s blank picker)', async () => {
    const harness = buildApiHarness();
    const response = await harness.request('/api/projects', { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ListProjectsResponse).projects).toEqual([]);
  });

  it('ORDERS BY ROOT, regardless of declaration order', async () => {
    // `Object.values` order is declaration order, which is neither meaningful to a
    // human nor stable across a snapshot boundary. Declared deliberately out of
    // alphabetical order so the assertion cannot pass by accident.
    const harness = buildApiHarness();
    const zebra = makeNestedDirectory(harness, 'zebra-');
    const alpha = makeNestedDirectory(harness, 'alpha-');
    await declareProjectThrough(harness, { root: zebra });
    await declareProjectThrough(harness, { root: alpha });
    await declareProjectThrough(harness);

    const response = await harness.request('/api/projects', { headers: authHeaders() });
    const roots = ((await response.json()) as ListProjectsResponse).projects.map(
      (project) => project.root,
    );
    expect(roots).toEqual([...roots].sort((left, right) => left.localeCompare(right)));
    expect(roots).toContain(zebra);
    expect(roots).toContain(alpha);
    // The parent sorts before both of its children — the nesting D42 describes,
    // reading the way it nests.
    expect(roots[0]).toBe(harness.configuredRoot);
  });

  it('INCLUDES ARCHIVED RECORDS — the flag is on the record, clients filter', async () => {
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness, { name: 'to be retired' });
    await harness.request(`/api/projects/${project.projectId}/archive`, postJson({}));

    const response = await harness.request('/api/projects', { headers: authHeaders() });
    const projects = ((await response.json()) as ListProjectsResponse).projects;
    expect(projects).toHaveLength(1);
    expect(projects[0]!.archived).toBe(true);
  });

  it('is behind the auth wall (I14)', async () => {
    const harness = buildApiHarness();
    const response = await harness.request('/api/projects', { headers: authHeaders(null) });
    expect(response.status).toBe(401);
  });
});

describe('POST /api/projects/:projectId/metadata — patch', () => {
  it('patches (200) and returns the record AS FOLDED', async () => {
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness, { name: 'VIMES' });
    const response = await harness.request(
      `/api/projects/${project.projectId}/metadata`,
      postJson({ description: 'a description added later' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectResponse;
    expect(body.project.description).toBe('a description added later');
    // ABSENT LEAVES ALONE: the name the declaration set survives the patch.
    expect(body.project.name).toBe('VIMES');
    expect(harness.projectEventTypes()).toEqual([
      EVENT_TYPES.projectCreated,
      EVENT_TYPES.projectUpdated,
    ]);
  });

  it('an empty patch is 400 `empty-update` with NO EVENT', async () => {
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness);
    const headAfterDeclaration = harness.projectsHead();

    const response = await harness.request(
      `/api/projects/${project.projectId}/metadata`,
      postJson({}),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toBe('empty-update');
    expect(harness.projectsHead()).toBe(headAfterDeclaration);
  });

  it('an unknown project is 404 with NO EVENT', async () => {
    const harness = buildApiHarness();
    await declareProjectThrough(harness);
    const headAfterDeclaration = harness.projectsHead();

    const response = await harness.request(
      '/api/projects/project-nobody-declared/metadata',
      postJson({ name: 'a name for nothing' }),
    );
    expect(response.status).toBe(404);
    expect(harness.projectsHead()).toBe(headAfterDeclaration);
  });

  it('IGNORES a `root` in the body — a different directory is a different project', async () => {
    // D42, over the wire. zod strips the unknown key, so the request succeeds as an
    // ordinary rename and the boundary does not move.
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness, { name: 'VIMES' });
    const response = await harness.request(
      `/api/projects/${project.projectId}/metadata`,
      postJson({ name: 'still VIMES', root: harness.outsideRoot }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectResponse).project.root).toBe(harness.configuredRoot);
  });

  it('is behind the auth wall (I14)', async () => {
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness);
    const response = await harness.request(
      `/api/projects/${project.projectId}/metadata`,
      postJson({ name: 'unauthorized' }, null),
    );
    expect(response.status).toBe(401);
  });
});

describe('POST /api/projects/:projectId/archive — retire', () => {
  it('archives (200), returns the record AS FOLDED, and KEEPS it in the registry', async () => {
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness, { name: 'VIMES' });
    const response = await harness.request(
      `/api/projects/${project.projectId}/archive`,
      postJson({}),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectResponse).project).toEqual({
      projectId: project.projectId,
      root: harness.configuredRoot,
      name: 'VIMES',
      archived: true,
    });
    expect(harness.projectEventTypes()).toEqual([
      EVENT_TYPES.projectCreated,
      EVENT_TYPES.projectArchived,
    ]);
  });

  it('a second archive is 409 `already-archived` with NO EVENT', async () => {
    // Idempotence refused honestly: the fold would be identical either way, so only
    // the log can tell the honest refusal from a silent accept.
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness);
    await harness.request(`/api/projects/${project.projectId}/archive`, postJson({}));
    const headAfterArchive = harness.projectsHead();

    const response = await harness.request(
      `/api/projects/${project.projectId}/archive`,
      postJson({}),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { detail: string; projectId: string };
    expect(body.detail).toBe('already-archived');
    expect(body.projectId).toBe(project.projectId);
    expect(harness.projectsHead()).toBe(headAfterArchive);
  });

  it('an unknown project is 404 with NO EVENT', async () => {
    const harness = buildApiHarness();
    const response = await harness.request(
      '/api/projects/project-nobody-declared/archive',
      postJson({}),
    );
    expect(response.status).toBe(404);
    expect(harness.projectsHead()).toBe(0);
  });

  it('ARCHIVING FREES THE ROOT: re-declaring the same directory mints a NEW project', async () => {
    // The end-to-end shape of the writer's rule, over HTTP. Identity is the id, not
    // the path — both records survive, and the registry shows both.
    const harness = buildApiHarness();
    const original = await declareProjectThrough(harness, { name: 'the first vimes' });
    await harness.request(`/api/projects/${original.projectId}/archive`, postJson({}));

    const revived = await declareProjectThrough(harness, { name: 'the second vimes' });
    expect(revived.projectId).not.toBe(original.projectId);
    expect(revived.archived).toBe(false);

    const listed = ((await (
      await harness.request('/api/projects', { headers: authHeaders() })
    ).json()) as ListProjectsResponse).projects;
    expect(listed).toHaveLength(2);
    expect(listed.filter((project) => project.archived)).toHaveLength(1);
  });

  it('is behind the auth wall (I14)', async () => {
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness);
    const response = await harness.request(
      `/api/projects/${project.projectId}/archive`,
      postJson({}, null),
    );
    expect(response.status).toBe(401);
    expect(harness.projectEventTypes()).toEqual([EVENT_TYPES.projectCreated]);
  });
});

describe('the project API — no DELETE anywhere (D42: archive, not delete)', () => {
  it('DELETE /api/projects/:projectId is not a route', async () => {
    // Asserted rather than only documented: nothing is ever removed from the log
    // (I12), and the record has to survive so the history under its root stays
    // attributable. A 404 here is Hono saying no such route — no handler exists.
    const harness = buildApiHarness();
    const project = await declareProjectThrough(harness);
    const response = await harness.request(`/api/projects/${project.projectId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(response.status).toBe(404);
    expect(harness.projectEventTypes()).toEqual([EVENT_TYPES.projectCreated]);
  });
});
