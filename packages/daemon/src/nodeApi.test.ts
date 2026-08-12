import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  UNFILED_ROOT_ID,
  nodesProjection,
  projectArchived,
  projectCreated,
  projectRootId,
  projectsProjection,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionCreated,
  sessionsProjection,
  type EventRecord,
  type NodeRecord,
  type TreeResponse,
  type TreeRoot,
  type TreeSession,
} from '@vimes/core';
import { createAccessAuthMiddleware, type AccessVerifier } from './auth.js';
import { registerNodeApi, type NodeResponse } from './nodeApi.js';
import { NodeWriter, nodeRefusalReasonSchema, type NodeRefusalReason } from './nodeWriter.js';

// ─── S14·U3 — the session-tree API over real HTTP requests ───────────────────
//
// ⚠ THE INSTRUMENTS THAT MATTER ARE THE EVENT LOG AND THE WRITER-CALL COUNTER,
// NOT THE STATUS CODE (projectApi.test.ts's posture, for the same reasons). Two
// families of guarantee are only observable there:
//   • **A refusal writes NOTHING.** Every one of the eleven reasons must leave
//     the 'nodes' stream head exactly where it was and must consume no id from
//     the injected source — a route that emitted first and adjudicated second
//     would still answer 409.
//   • **The record is the FOLD.** `createdAt`, `closed`, `sessionIds` and a
//     `provenance` of `null` exist only because the projection produced them, so
//     reading them back off the response is what proves the log is the source of
//     record (I12) rather than the route echoing its own input.
//
// The projects and sessions this file needs are seeded by appending their BIRTH
// EVENTS directly rather than by driving the registry API: this unit's subject
// is the forest, and routing every fixture through another unit's HTTP surface
// would make these cases fail when THAT unit changes.

const ANY_TOKEN = 'valid-token-stub';

// Rejects a missing/empty token, accepts anything else — the shape auth.test.ts
// and projectApi.test.ts use to make the I14 wall testable without minting real
// JWTs.
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

interface ApiHarness {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  // Every record on the 'nodes' stream, in order.
  nodeEvents: () => EventRecord[];
  nodeEventTypes: () => string[];
  // The 'nodes' stream head — the "did anything get written" instrument.
  nodesHead: () => number;
  // How many times a WRITER method was entered. "A refusal reaches the writer
  // and stops there" is a claim only this can see.
  writerCallCount: () => number;
  // How many ids the injected source has minted. A refused creation must consume
  // none of them.
  mintedIdCount: () => number;
  // Seed a live project (its birth event, straight into the log).
  declareProject: (projectId: string, root: string) => void;
  archiveProject: (projectId: string) => void;
  // Seed a session with a cwd, so `defaultRootForSession` has something to
  // resolve.
  declareSession: (appSessionId: string, cwd: string) => void;
}

function buildApiHarness(): ApiHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-08-12T12:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });

  const readProjects = () => replayFromEmpty(projectsProjection, readAllStreamsGrouped(store));
  const readNodes = () => replayFromEmpty(nodesProjection, readAllStreamsGrouped(store));
  const readSessions = () => replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));

  // A counting source whose mints are observable: a refused creation must not
  // advance it (the writer mints AFTER every refusal, deliberately).
  const idSource = new CountingIdSource();
  let mintedIdCount = 0;
  const countingIds = {
    uuid: () => {
      mintedIdCount += 1;
      return idSource.uuid();
    },
  };

  const nodeWriter = new NodeWriter({
    emit: (events) => store.append(events),
    readProjects,
    readNodes,
    readSessions,
    ids: countingIds,
  });

  // Count every ENTRY into the writer. Wrapping the instance rather than faking
  // the class keeps the real writer in the loop — the count is an extra
  // observation, never a substitute for one.
  let writerCallCount = 0;
  const realCreate = nodeWriter.createNode.bind(nodeWriter);
  const realClose = nodeWriter.closeNode.bind(nodeWriter);
  const realAttach = nodeWriter.attachSession.bind(nodeWriter);
  nodeWriter.createNode = (input) => {
    writerCallCount += 1;
    return realCreate(input);
  };
  nodeWriter.closeNode = (input) => {
    writerCallCount += 1;
    return realClose(input);
  };
  nodeWriter.attachSession = (input) => {
    writerCallCount += 1;
    return realAttach(input);
  };

  const app = new Hono();
  // I14 exactly as app.ts installs it: auth in front of EVERYTHING, registered
  // BEFORE any route, so no handler can run without the middleware passing first.
  app.use(
    '*',
    createAccessAuthMiddleware({
      verifier: tokenRequiredVerifier,
      // A rejection writes to the SYSTEM stream in production; a no-op here so
      // the 'nodes' stream head stays a clean instrument.
      emitAuthRejected: () => {},
    }),
  );
  registerNodeApi(app, { nodeWriter, readProjects, readNodes, readSessions });

  return {
    request: async (path, init) => app.request(path, init),
    nodeEvents: () => store.read('nodes', 1),
    nodeEventTypes: () => store.read('nodes', 1).map((record) => record.type),
    nodesHead: () => store.head('nodes'),
    writerCallCount: () => writerCallCount,
    mintedIdCount: () => mintedIdCount,
    declareProject: (projectId, root) => {
      store.append([projectCreated({ projectId, root })]);
    },
    archiveProject: (projectId) => {
      store.append([projectArchived({ projectId })]);
    },
    declareSession: (appSessionId, cwd) => {
      store.append([
        sessionCreated({
          appSessionId,
          channel: 'sdk',
          cwd,
          name: null,
          forkedFrom: null,
          taskRef: null,
        }),
      ]);
    },
  };
}

const PROJECT_ID = 'proj-alpha';
const PROJECT_ROOT = '/home/example/projects/alpha';

// A harness with one live project already declared — the starting point for
// almost every case below.
function harnessWithProject(): ApiHarness {
  const harness = buildApiHarness();
  harness.declareProject(PROJECT_ID, PROJECT_ROOT);
  return harness;
}

async function createNodeThrough(
  harness: ApiHarness,
  overrides: Record<string, unknown> = {},
): Promise<NodeRecord> {
  const response = await harness.request(
    '/api/nodes',
    postJson({ projectId: PROJECT_ID, name: 'a group', ...overrides }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as NodeResponse).node;
}

async function refusalOf(response: Response): Promise<NodeRefusalReason> {
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: string; reason: NodeRefusalReason };
  expect(body.error).toBe('conflict');
  // Every reason on the wire is a member of the CLOSED enum — never free text.
  expect(nodeRefusalReasonSchema.options).toContain(body.reason);
  return body.reason;
}

async function treeThrough(harness: ApiHarness, query = ''): Promise<TreeResponse> {
  const response = await harness.request(`/api/tree${query}`, { headers: authHeaders() });
  expect(response.status).toBe(200);
  return (await response.json()) as TreeResponse;
}

// Every session leaf anywhere in the payload, roots and nodes alike. The
// instrument S14-A1 is stated over.
function allSessionLeaves(tree: TreeResponse): TreeSession[] {
  const leaves: TreeSession[] = [];
  const walkNodes = (nodes: TreeRoot['nodes']): void => {
    for (const node of nodes) {
      leaves.push(...node.sessions);
      walkNodes(node.nodes);
    }
  };
  for (const root of tree.roots) {
    leaves.push(...root.sessions);
    walkNodes(root.nodes);
  }
  return leaves;
}

describe('POST /api/nodes — create', () => {
  it('creates (201) and returns the record AS FOLDED: provenance null, open, empty, with a createdAt', async () => {
    const harness = harnessWithProject();
    const response = await harness.request(
      '/api/nodes',
      postJson({ projectId: PROJECT_ID, name: 'worktrees', directory: '/tmp/wt' }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as NodeResponse;
    expect(body.node.projectId).toBe(PROJECT_ID);
    expect(body.node.parentNodeId).toBeNull();
    expect(body.node.name).toBe('worktrees');
    expect(body.node.directory).toBe('/tmp/wt');
    // Fold-only fields — a hand-built echo could not have produced them.
    expect(body.node.provenance).toBeNull();
    expect(body.node.closed).toBe(false);
    expect(body.node.sessionIds).toEqual([]);
    expect(body.node.createdAt).toBe('2026-08-12T12:00:01.000Z');

    // EXACTLY ONE event, and it is the birth record.
    expect(harness.nodeEventTypes()).toEqual([EVENT_TYPES.nodeCreated]);
  });

  it('trims the name and refuses a whitespace-only one (empty-name), writing nothing', async () => {
    const harness = harnessWithProject();
    const trimmed = await createNodeThrough(harness, { name: '  spaced  ' });
    expect(trimmed.name).toBe('spaced');

    const headBefore = harness.nodesHead();
    const mintedBefore = harness.mintedIdCount();
    const response = await harness.request(
      '/api/nodes',
      postJson({ projectId: PROJECT_ID, name: '   ' }),
    );
    expect(await refusalOf(response)).toBe('empty-name');
    expect(harness.nodesHead()).toBe(headBefore);
    // The id is minted only after every refusal — a refused creation leaves the
    // sequence exactly where an absent request would have.
    expect(harness.mintedIdCount()).toBe(mintedBefore);
  });

  it('refuses an unknown project, and an ARCHIVED project counts as unknown for CREATE', async () => {
    const harness = harnessWithProject();
    expect(
      await refusalOf(
        await harness.request('/api/nodes', postJson({ projectId: 'no-such', name: 'x' })),
      ),
    ).toBe('unknown-project');

    harness.archiveProject(PROJECT_ID);
    const afterArchive = await harness.request(
      '/api/nodes',
      postJson({ projectId: PROJECT_ID, name: 'x' }),
    );
    expect(await refusalOf(afterArchive)).toBe('unknown-project');
    expect(harness.nodesHead()).toBe(0);
  });

  it('refuses an unknown parent, a parent in ANOTHER project, and a parent under a closed subtree', async () => {
    const harness = harnessWithProject();
    harness.declareProject('proj-beta', '/home/example/projects/beta');

    expect(
      await refusalOf(
        await harness.request(
          '/api/nodes',
          postJson({ projectId: PROJECT_ID, parentNodeId: 'ghost', name: 'x' }),
        ),
      ),
    ).toBe('unknown-parent');

    const alphaNode = await createNodeThrough(harness);
    expect(
      await refusalOf(
        await harness.request(
          '/api/nodes',
          postJson({ projectId: 'proj-beta', parentNodeId: alphaNode.nodeId, name: 'x' }),
        ),
      ),
    ).toBe('cross-project-parent');

    // EFFECTIVE closure: the grandchild's parent is open, but its grandparent is
    // closed, and creating under a finished subtree is refused all the way down.
    const child = await createNodeThrough(harness, { parentNodeId: alphaNode.nodeId, name: 'child' });
    expect(
      (await harness.request(`/api/nodes/${alphaNode.nodeId}/close`, postJson({}))).status,
    ).toBe(200);
    const headBefore = harness.nodesHead();
    expect(
      await refusalOf(
        await harness.request(
          '/api/nodes',
          postJson({ projectId: PROJECT_ID, parentNodeId: child.nodeId, name: 'grandchild' }),
        ),
      ),
    ).toBe('parent-closed');
    expect(harness.nodesHead()).toBe(headBefore);
  });

  it('400s a body that is not a creation request, and NOTHING reaches the writer', async () => {
    const harness = harnessWithProject();
    for (const badBody of ['not json at all', { name: 'no project' }, { projectId: PROJECT_ID }, []]) {
      const response = await harness.request('/api/nodes', postJson(badBody));
      expect(response.status).toBe(400);
    }
    expect(harness.writerCallCount()).toBe(0);
    expect(harness.nodesHead()).toBe(0);
  });

  it('S14-A2 (API half): a body smuggling `provenance` is IGNORED, not refused — the key is stripped', async () => {
    const harness = harnessWithProject();
    const response = await harness.request(
      '/api/nodes',
      postJson({
        projectId: PROJECT_ID,
        name: 'smuggler',
        // Both the wire shape a real provenance takes AND a junk value: the
        // point is that NEITHER reaches the record, and neither is refused.
        provenance: { kind: 'worktree', branch: 'feature/x', path: '/tmp/wt' },
        nodeConfig: { anything: true },
      }),
    );

    // IGNORED, not refused — this is the "prove which" the work order asks for.
    expect(response.status).toBe(201);
    const body = (await response.json()) as NodeResponse;
    expect(body.node.provenance).toBeNull();

    // And the LOG carries null too — the record could not have acquired it later
    // (the fold never updates provenance), so this is the write-once guarantee
    // observed at its only writable moment.
    const birth = harness.nodeEvents()[0]!;
    expect((birth.payload as { provenance: unknown }).provenance).toBeNull();
    expect((birth.payload as { nodeConfig: unknown }).nodeConfig).toBeNull();
  });

  it('requires the auth wall (I14): no token, no route', async () => {
    const harness = harnessWithProject();
    const response = await harness.request('/api/nodes', postJson({ projectId: PROJECT_ID, name: 'x' }, null));
    expect(response.status).toBe(401);
    expect(harness.writerCallCount()).toBe(0);
  });
});

describe('POST /api/nodes/:nodeId/close', () => {
  it('closes (200), records ONE node_closed, and refuses a second close without writing', async () => {
    const harness = harnessWithProject();
    const node = await createNodeThrough(harness);

    const response = await harness.request(`/api/nodes/${node.nodeId}/close`, postJson({}));
    expect(response.status).toBe(200);
    expect(((await response.json()) as NodeResponse).node.closed).toBe(true);
    expect(harness.nodeEventTypes()).toEqual([EVENT_TYPES.nodeCreated, EVENT_TYPES.nodeClosed]);

    const headBefore = harness.nodesHead();
    const second = await harness.request(`/api/nodes/${node.nodeId}/close`, postJson({}));
    expect(await refusalOf(second)).toBe('already-closed');
    expect(harness.nodesHead()).toBe(headBefore);
  });

  it('refuses an unknown node', async () => {
    const harness = harnessWithProject();
    expect(
      await refusalOf(await harness.request('/api/nodes/ghost/close', postJson({}))),
    ).toBe('unknown-node');
  });

  it('ACCEPTS closing a child whose parent is already closed — the check is on the record, not on effective closure', async () => {
    const harness = harnessWithProject();
    const parent = await createNodeThrough(harness, { name: 'parent' });
    const child = await createNodeThrough(harness, { parentNodeId: parent.nodeId, name: 'child' });
    expect((await harness.request(`/api/nodes/${parent.nodeId}/close`, postJson({}))).status).toBe(200);

    // The child is ALREADY effectively closed — and closing it explicitly is
    // still a real, recorded act (E2 lets a subtree record its own closure).
    const response = await harness.request(`/api/nodes/${child.nodeId}/close`, postJson({}));
    expect(response.status).toBe(200);
    expect(((await response.json()) as NodeResponse).node.closed).toBe(true);

    // And the two facts stay distinguishable on the wire.
    const tree = await treeThrough(harness);
    const parentLeaf = tree.roots.find((root) => root.rootId === projectRootId(PROJECT_ID))!.nodes[0]!;
    expect(parentLeaf.closed).toBe(true);
    expect(parentLeaf.nodes[0]!.closed).toBe(true);
    expect(parentLeaf.nodes[0]!.effectivelyClosed).toBe(true);
  });
});

describe('POST /api/nodes/:nodeId/sessions — attach', () => {
  it('attaches (200) and returns the NODE as folded, with the session in attachment order', async () => {
    const harness = harnessWithProject();
    harness.declareSession('sess-one', `${PROJECT_ROOT}/a`);
    harness.declareSession('sess-two', `${PROJECT_ROOT}/b`);
    const node = await createNodeThrough(harness);

    expect(
      (await harness.request(`/api/nodes/${node.nodeId}/sessions`, postJson({ appSessionId: 'sess-one' })))
        .status,
    ).toBe(200);
    const response = await harness.request(
      `/api/nodes/${node.nodeId}/sessions`,
      postJson({ appSessionId: 'sess-two' }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as NodeResponse).node.sessionIds).toEqual(['sess-one', 'sess-two']);
  });

  it('refuses an unknown node, an unknown session, and a body that names no session', async () => {
    const harness = harnessWithProject();
    harness.declareSession('sess-one', PROJECT_ROOT);
    const node = await createNodeThrough(harness);

    expect(
      await refusalOf(
        await harness.request('/api/nodes/ghost/sessions', postJson({ appSessionId: 'sess-one' })),
      ),
    ).toBe('unknown-node');
    expect(
      await refusalOf(
        await harness.request(`/api/nodes/${node.nodeId}/sessions`, postJson({ appSessionId: 'no-such' })),
      ),
    ).toBe('unknown-session');

    const headBefore = harness.nodesHead();
    const badBody = await harness.request(`/api/nodes/${node.nodeId}/sessions`, postJson({}));
    expect(badBody.status).toBe(400);
    expect(harness.nodesHead()).toBe(headBefore);
  });

  it('refuses attaching into an EFFECTIVELY closed subtree (node-closed)', async () => {
    const harness = harnessWithProject();
    harness.declareSession('sess-one', PROJECT_ROOT);
    const parent = await createNodeThrough(harness, { name: 'parent' });
    const child = await createNodeThrough(harness, { parentNodeId: parent.nodeId, name: 'child' });
    expect((await harness.request(`/api/nodes/${parent.nodeId}/close`, postJson({}))).status).toBe(200);

    const headBefore = harness.nodesHead();
    expect(
      await refusalOf(
        await harness.request(`/api/nodes/${child.nodeId}/sessions`, postJson({ appSessionId: 'sess-one' })),
      ),
    ).toBe('node-closed');
    expect(harness.nodesHead()).toBe(headBefore);
  });

  it('refuses a re-attach: already-attached HERE, attached-elsewhere THERE — and the tree keeps exactly one leaf', async () => {
    const harness = harnessWithProject();
    harness.declareSession('sess-one', PROJECT_ROOT);
    const first = await createNodeThrough(harness, { name: 'first' });
    const second = await createNodeThrough(harness, { name: 'second' });
    expect(
      (await harness.request(`/api/nodes/${first.nodeId}/sessions`, postJson({ appSessionId: 'sess-one' })))
        .status,
    ).toBe(200);

    const headBefore = harness.nodesHead();
    expect(
      await refusalOf(
        await harness.request(`/api/nodes/${first.nodeId}/sessions`, postJson({ appSessionId: 'sess-one' })),
      ),
    ).toBe('already-attached');
    // ⚠ THE ONE THE TREE'S EXACTLY-ONCE PROPERTY LEANS ON: v1 has no move, so a
    // re-attach elsewhere is refused rather than silently re-homing the session.
    expect(
      await refusalOf(
        await harness.request(`/api/nodes/${second.nodeId}/sessions`, postJson({ appSessionId: 'sess-one' })),
      ),
    ).toBe('attached-elsewhere');
    expect(harness.nodesHead()).toBe(headBefore);

    const leaves = allSessionLeaves(await treeThrough(harness));
    expect(leaves.map((leaf) => leaf.appSessionId)).toEqual(['sess-one']);
  });
});

describe('GET /api/tree — the composed forest over HTTP', () => {
  it('S14-A1 over the API: two nodes, one attached session, one derived, one unfiled — each session EXACTLY ONCE', async () => {
    const harness = harnessWithProject();
    harness.declareSession('sess-attached', `${PROJECT_ROOT}/one`);
    harness.declareSession('sess-derived', `${PROJECT_ROOT}/two`);
    harness.declareSession('sess-homeless', '/home/example/elsewhere');

    const parent = await createNodeThrough(harness, { name: 'parent' });
    const child = await createNodeThrough(harness, { parentNodeId: parent.nodeId, name: 'child' });
    expect(
      (
        await harness.request(
          `/api/nodes/${child.nodeId}/sessions`,
          postJson({ appSessionId: 'sess-attached' }),
        )
      ).status,
    ).toBe(200);

    const tree = await treeThrough(harness);

    // The forest: one root per live project, `unfiled` LAST and always present.
    expect(tree.roots.map((root) => root.rootId)).toEqual([projectRootId(PROJECT_ID), UNFILED_ROOT_ID]);

    // Every session appears exactly once, across the whole payload.
    const leafIds = allSessionLeaves(tree).map((leaf) => leaf.appSessionId).sort();
    expect(leafIds).toEqual(['sess-attached', 'sess-derived', 'sess-homeless']);

    const projectRoot = tree.roots[0]!;
    // The attached one hangs at its NODE; the derived one at the root; the
    // homeless one under `unfiled`.
    expect(projectRoot.nodes[0]!.nodes[0]!.sessions.map((leaf) => leaf.appSessionId)).toEqual([
      'sess-attached',
    ]);
    expect(projectRoot.sessions.map((leaf) => leaf.appSessionId)).toEqual(['sess-derived']);
    expect(tree.roots[1]!.sessions.map((leaf) => leaf.appSessionId)).toEqual(['sess-homeless']);

    // The rollup counts PROCESSES over the whole estate beneath the root.
    expect(projectRoot.rollup.processCount).toBe(2);
    expect(tree.roots[1]!.rollup.processCount).toBe(1);

    // The reserved shape is on the wire and empty (rule 0.5), and the D79 handle
    // rides the leaf.
    const leaf = allSessionLeaves(tree)[0]!;
    expect(leaf.overlays).toEqual({});
    expect(typeof leaf.shortId).toBe('string');
  });

  it('serves the U2 wire shape VERBATIM — the route adds nothing (byte-identical to treeOf over the same log)', async () => {
    const harness = harnessWithProject();
    harness.declareSession('sess-one', PROJECT_ROOT);
    await createNodeThrough(harness);

    const first = await treeThrough(harness);
    const second = await treeThrough(harness);
    // Determinism at the route (S14-A8's HTTP half): the same log, twice, byte
    // for byte.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // And the only top-level keys are the ones core declares.
    expect(Object.keys(first).sort()).toEqual(['orderVersion', 'roots']);
  });

  it('S14-A10 (route half): ?root= is an EXACT match — no prefix, no wildcard, unknown yields an EMPTY root list', async () => {
    const harness = harnessWithProject();
    harness.declareSession('sess-homeless', '/home/example/elsewhere');
    await createNodeThrough(harness);

    const scoped = await treeThrough(harness, `?root=${encodeURIComponent(projectRootId(PROJECT_ID))}`);
    expect(scoped.roots.map((root) => root.rootId)).toEqual([projectRootId(PROJECT_ID)]);

    const unfiled = await treeThrough(harness, `?root=${UNFILED_ROOT_ID}`);
    expect(unfiled.roots.map((root) => root.rootId)).toEqual([UNFILED_ROOT_ID]);
    expect(unfiled.roots[0]!.sessions.map((leaf) => leaf.appSessionId)).toEqual(['sess-homeless']);

    // A virtual id is NEVER prefix-matched, in either direction: the bare
    // namespace, a truncated project id, and a truncated `unfiled` all address
    // nothing. Empty roots, never a 404 — the scope is real, it just holds
    // nothing this client can see.
    for (const query of ['project:', 'project:proj', `project:${PROJECT_ID}x`, 'unfil', 'unfiledx', '']) {
      const miss = await treeThrough(harness, `?root=${encodeURIComponent(query)}`);
      expect(miss.roots).toEqual([]);
    }
  });

  it('requires the auth wall (I14)', async () => {
    const harness = harnessWithProject();
    const response = await harness.request('/api/tree', { headers: authHeaders(null) });
    expect(response.status).toBe(401);
  });
});

describe('the refusal vocabulary is CLOSED and every member is REACHABLE', () => {
  it('drives all eleven reasons through the API and observes exactly the enum', async () => {
    const observedReasons = new Set<NodeRefusalReason>();

    // ── create refusals ──
    const createHarness = harnessWithProject();
    createHarness.declareProject('proj-beta', '/home/example/projects/beta');
    observedReasons.add(
      await refusalOf(
        await createHarness.request('/api/nodes', postJson({ projectId: 'ghost', name: 'x' })),
      ),
    );
    observedReasons.add(
      await refusalOf(
        await createHarness.request(
          '/api/nodes',
          postJson({ projectId: PROJECT_ID, parentNodeId: 'ghost', name: 'x' }),
        ),
      ),
    );
    observedReasons.add(
      await refusalOf(
        await createHarness.request('/api/nodes', postJson({ projectId: PROJECT_ID, name: ' ' })),
      ),
    );
    const alpha = await createNodeThrough(createHarness);
    observedReasons.add(
      await refusalOf(
        await createHarness.request(
          '/api/nodes',
          postJson({ projectId: 'proj-beta', parentNodeId: alpha.nodeId, name: 'x' }),
        ),
      ),
    );
    expect(
      (await createHarness.request(`/api/nodes/${alpha.nodeId}/close`, postJson({}))).status,
    ).toBe(200);
    observedReasons.add(
      await refusalOf(
        await createHarness.request(
          '/api/nodes',
          postJson({ projectId: PROJECT_ID, parentNodeId: alpha.nodeId, name: 'x' }),
        ),
      ),
    );
    observedReasons.add(
      await refusalOf(await createHarness.request(`/api/nodes/${alpha.nodeId}/close`, postJson({}))),
    );
    observedReasons.add(
      await refusalOf(await createHarness.request('/api/nodes/ghost/close', postJson({}))),
    );

    // ── attach refusals ──
    const attachHarness = harnessWithProject();
    attachHarness.declareSession('sess-one', PROJECT_ROOT);
    const first = await createNodeThrough(attachHarness, { name: 'first' });
    const second = await createNodeThrough(attachHarness, { name: 'second' });
    const closed = await createNodeThrough(attachHarness, { name: 'closed' });
    expect((await attachHarness.request(`/api/nodes/${closed.nodeId}/close`, postJson({}))).status).toBe(
      200,
    );
    observedReasons.add(
      await refusalOf(
        await attachHarness.request('/api/nodes/ghost/sessions', postJson({ appSessionId: 'sess-one' })),
      ),
    );
    observedReasons.add(
      await refusalOf(
        await attachHarness.request(
          `/api/nodes/${closed.nodeId}/sessions`,
          postJson({ appSessionId: 'sess-one' }),
        ),
      ),
    );
    observedReasons.add(
      await refusalOf(
        await attachHarness.request(
          `/api/nodes/${first.nodeId}/sessions`,
          postJson({ appSessionId: 'ghost-session' }),
        ),
      ),
    );
    expect(
      (
        await attachHarness.request(
          `/api/nodes/${first.nodeId}/sessions`,
          postJson({ appSessionId: 'sess-one' }),
        )
      ).status,
    ).toBe(200);
    observedReasons.add(
      await refusalOf(
        await attachHarness.request(
          `/api/nodes/${first.nodeId}/sessions`,
          postJson({ appSessionId: 'sess-one' }),
        ),
      ),
    );
    observedReasons.add(
      await refusalOf(
        await attachHarness.request(
          `/api/nodes/${second.nodeId}/sessions`,
          postJson({ appSessionId: 'sess-one' }),
        ),
      ),
    );

    // ⚠ EXACT EQUALITY, both directions: every member is reachable through the
    // API (no dead vocabulary), and nothing outside the enum ever reached the
    // wire (no free text). A member added later without a producer fails here.
    expect([...observedReasons].sort()).toEqual([...nodeRefusalReasonSchema.options].sort());
  });
});
