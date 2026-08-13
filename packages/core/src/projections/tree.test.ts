import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonicalJson.js';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput, EventRecord } from '../schemas.js';
import {
  gateFired,
  livenessChanged,
  nodeClosed,
  nodeCreated,
  projectArchived,
  projectCreated,
  questionAsked,
  seen,
  sessionAttachedToNode,
  sessionCreated,
} from '../events.js';
import { readAllStreamsGrouped, replayFromEmpty } from './projection.js';
import { nodesProjection, type NodesState } from './nodes.js';
import { ATTENTION_SEVERITY_ORDER_VERSION } from './nodeRollup.js';
import { projectsProjection, type ProjectsState } from './projects.js';
import { sessionsProjection, type SessionsState } from './sessions.js';
import {
  defaultRootForSession,
  projectRootId,
  treeOf,
  PROJECT_ROOT_ID_PREFIX,
  UNFILED_ROOT_ID,
  type TreeNode,
  type TreeRoot,
  type TreeSession,
} from './tree.js';

// ─── S14·U2 — the composed tree read model ───────────────────────────────────
//
// ⚠ **THE FIXTURE IS BUILT TO EXPOSE ORDER, DELIBERATELY (S14-A11).** Creation
// order, alphabetical order and attachment order are all DIFFERENT in it, in
// every dimension the wire shape declares an ordering for. A double-run
// determinism check (A8) only catches nondeterminism the fixture happens to
// reveal; a fixture whose creation order is also its alphabetical order reveals
// nothing, and an implementation that sorted by id would sail through it.
//
// Ids are therefore chosen for their SORT POSITION rather than for readability:
// the first project created is `zeta-…`, the second `alpha-…`; the first session
// attached to a node was created SECOND; and so on. Every one of those
// inversions is load-bearing.
//
// Frozen fixtures under `fixtures/` are untouched — everything here is folded
// from synthesized events, which is also what makes the states real projection
// output rather than hand-built objects that could drift from the folds.

// ── projects: creation order (zeta, alpha, mid) ≠ alphabetical (alpha, mid, zeta)
const PROJECT_VIMES = 'zeta-project-0001';
const PROJECT_JOHNNY = 'alpha-project-0002';
const PROJECT_RETIRED = 'mid-project-0003';

const VIMES_ROOT = '/home/w/projects/vimes';
const JOHNNY_ROOT = '/home/w/projects/johnny';
const RETIRED_ROOT = '/home/w/projects/oldthing';

// ── nodes: creation order (zulu, alfa, mike, delta, bravo) ≠ alphabetical
const NODE_TRUNK = 'node-zulu-0001';
const NODE_ALFA = 'node-alfa-0002';
const NODE_MIKE = 'node-mike-0003'; // closed, with a LIVING session under it
const NODE_DELTA = 'node-delta-0004'; // child of the closed node
const NODE_STRAY = 'node-bravo-0005'; // belongs to the ARCHIVED project

// ── sessions: creation order ≠ alphabetical ≠ attachment order
const SESSION_ATTACHED_SECOND = 'sess-charlie-07'; // created FIRST
const SESSION_ATTACHED_FIRST = 'sess-yankee-01'; // created SECOND
const SESSION_JOHNNY = 'sess-alpha-02';
const SESSION_GAMES = 'sess-zulu-03';
const SESSION_VIMES_LOOSE = 'sess-delta-04';
const SESSION_ON_CLOSED_NODE = 'sess-echo-05';
const SESSION_RETIRED_CWD = 'sess-bravo-06';

const WORKTREE_PROVENANCE = {
  branch: 'feature/tree',
  baseRef: 'master',
  resolvedCommit: 'ffffffffffffffffffffffffffffffffffffffff',
  path: '/home/w/worktrees/tree',
};

interface FoldedStates {
  readonly projects: ProjectsState;
  readonly nodes: NodesState;
  readonly sessions: SessionsState;
  readonly records: EventRecord[];
}

function bornSession(appSessionId: string, cwd: string, name: string | null = null): EventInput {
  return sessionCreated({
    appSessionId,
    channel: 'sdk',
    cwd,
    name,
    forkedFrom: null,
    taskRef: null,
  });
}

// APPEND ORDER IS CREATION ORDER. Every event is appended through one store with
// one stepping clock, so `createdAt` on each session record is distinct and
// ordered — which is what makes "session-creation order" an assertable claim
// rather than a hope about map iteration.
function foldFixture(): FoldedStates {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-08-12T09:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });

  store.append([
    projectCreated({ projectId: PROJECT_VIMES, root: VIMES_ROOT, name: undefined, description: undefined }),
    projectCreated({ projectId: PROJECT_JOHNNY, root: JOHNNY_ROOT, name: 'Johnny', description: undefined }),
    projectCreated({ projectId: PROJECT_RETIRED, root: RETIRED_ROOT, name: undefined, description: undefined }),
    projectArchived({ projectId: PROJECT_RETIRED }),
  ]);

  store.append([
    nodeCreated({
      nodeId: NODE_TRUNK,
      parentNodeId: null,
      projectId: PROJECT_VIMES,
      name: 'trunk',
      provenance: null,
      directory: VIMES_ROOT,
      nodeConfig: null,
    }),
    nodeCreated({
      nodeId: NODE_ALFA,
      parentNodeId: NODE_TRUNK,
      projectId: PROJECT_VIMES,
      name: 'branch-alfa',
      provenance: null,
      directory: null,
      nodeConfig: null,
    }),
    nodeCreated({
      nodeId: NODE_MIKE,
      parentNodeId: NODE_TRUNK,
      projectId: PROJECT_VIMES,
      name: 'branch-mike',
      provenance: null,
      directory: null,
      nodeConfig: null,
    }),
    nodeCreated({
      nodeId: NODE_DELTA,
      parentNodeId: NODE_MIKE,
      projectId: PROJECT_VIMES,
      name: 'branch-delta',
      // The one provenance-bearing node in the fixture (S14-A2).
      provenance: WORKTREE_PROVENANCE,
      directory: '/home/w/worktrees/tree',
      nodeConfig: null,
    }),
    nodeCreated({
      nodeId: NODE_STRAY,
      parentNodeId: null,
      projectId: PROJECT_RETIRED,
      name: 'stray',
      provenance: null,
      directory: null,
      nodeConfig: null,
    }),
  ]);

  store.append([
    bornSession(SESSION_ATTACHED_SECOND, `${VIMES_ROOT}/packages/ui`),
    bornSession(SESSION_ATTACHED_FIRST, `${VIMES_ROOT}/packages/core`, 'the core run'),
    bornSession(SESSION_JOHNNY, JOHNNY_ROOT),
    bornSession(SESSION_GAMES, '/home/w/games/dongfu'),
    bornSession(SESSION_VIMES_LOOSE, VIMES_ROOT),
    bornSession(SESSION_ON_CLOSED_NODE, `${VIMES_ROOT}/packages/daemon`),
    bornSession(SESSION_RETIRED_CWD, `${RETIRED_ROOT}/src`),
  ]);

  // ⚠ ATTACHMENT ORDER IS THE INVERSE OF CREATION ORDER on NODE_ALFA — the
  // session created second is attached first. Nothing may quietly re-sort this.
  store.append([
    sessionAttachedToNode({ nodeId: NODE_ALFA, appSessionId: SESSION_ATTACHED_FIRST }),
    sessionAttachedToNode({ nodeId: NODE_ALFA, appSessionId: SESSION_ATTACHED_SECOND }),
    sessionAttachedToNode({ nodeId: NODE_MIKE, appSessionId: SESSION_ON_CLOSED_NODE }),
  ]);

  store.append([
    livenessChanged({ appSessionId: SESSION_ATTACHED_FIRST, to: 'running', cause: 'spawn' }),
    livenessChanged({ appSessionId: SESSION_ATTACHED_SECOND, to: 'dormant', cause: 'idle' }),
    livenessChanged({ appSessionId: SESSION_JOHNNY, to: 'running', cause: 'spawn' }),
    livenessChanged({ appSessionId: SESSION_GAMES, to: 'dormant', cause: 'idle' }),
    livenessChanged({ appSessionId: SESSION_VIMES_LOOSE, to: 'running', cause: 'spawn' }),
    livenessChanged({ appSessionId: SESSION_ON_CLOSED_NODE, to: 'running', cause: 'spawn' }),
    livenessChanged({ appSessionId: SESSION_RETIRED_CWD, to: 'dead', cause: 'exit' }),
  ]);

  store.append([
    // The gate sits on the session under the CLOSED node — so the closed branch
    // is the loudest thing in the estate, and a rollup that filtered closed
    // nodes would lose it (S14-A3).
    gateFired({ appSessionId: SESSION_ON_CLOSED_NODE, prompt: 'may I write?' }),
    questionAsked({ appSessionId: SESSION_JOHNNY, prompt: 'which branch?' }),
  ]);

  // Closure LAST, so the fold has already attached a living session to it.
  store.append([nodeClosed({ nodeId: NODE_MIKE })]);

  // D83 (S14-A5): a `seen` on the session that is ALSO asking a question.
  store.append([seen({ appSessionId: SESSION_JOHNNY })]);

  const records = readAllStreamsGrouped(store);
  return {
    projects: replayFromEmpty(projectsProjection, records),
    nodes: replayFromEmpty(nodesProjection, records),
    sessions: replayFromEmpty(sessionsProjection, records),
    records,
  };
}

function treeFromFixture(rootId?: string) {
  const { projects, nodes, sessions } = foldFixture();
  return treeOf(projects, nodes, sessions, rootId === undefined ? {} : { rootId });
}

function rootById(tree: { roots: readonly TreeRoot[] }, rootId: string): TreeRoot {
  const found = tree.roots.find((root) => root.rootId === rootId);
  expect(found, `no root ${rootId}`).toBeDefined();
  return found!;
}

function everyTreeNode(container: { nodes: readonly TreeNode[] }): TreeNode[] {
  return container.nodes.flatMap((node) => [node, ...everyTreeNode(node)]);
}

function everyTreeSession(root: TreeRoot): TreeSession[] {
  return [...root.sessions, ...everyTreeNode(root).flatMap((node) => node.sessions)];
}

function everySessionInTree(tree: { roots: readonly TreeRoot[] }): TreeSession[] {
  return tree.roots.flatMap(everyTreeSession);
}

// ─── S14-A1: the forest, and every session in it exactly once ────────────────

describe('S14-A1 — every session resolves to exactly one parent, with exact counts', () => {
  it('places all seven sessions, each exactly once', () => {
    const tree = treeFromFixture();
    const placed = everySessionInTree(tree).map((leaf) => leaf.appSessionId);
    expect(placed).toHaveLength(7);
    expect(new Set(placed).size).toBe(7);
    expect([...placed].sort()).toEqual(
      [
        SESSION_ATTACHED_FIRST,
        SESSION_ATTACHED_SECOND,
        SESSION_JOHNNY,
        SESSION_GAMES,
        SESSION_VIMES_LOOSE,
        SESSION_ON_CLOSED_NODE,
        SESSION_RETIRED_CWD,
      ].sort(),
    );
  });

  it('ATTACHED BEATS DEFAULTED: a session whose cwd is inside vimes still hangs at its node', () => {
    const tree = treeFromFixture();
    const vimesRoot = rootById(tree, projectRootId(PROJECT_VIMES));
    // Its cwd (`…/packages/core`) resolves to the vimes project, so the
    // derivation alone would have hung it on the root. The explicit attachment
    // overrides it, and the root's own session list does NOT contain it.
    expect(defaultRootForSession(foldFixture().projects, `${VIMES_ROOT}/packages/core`)).toBe(
      projectRootId(PROJECT_VIMES),
    );
    expect(vimesRoot.sessions.map((leaf) => leaf.appSessionId)).toEqual([SESSION_VIMES_LOOSE]);
    const alfa = everyTreeNode(vimesRoot).find((node) => node.nodeId === NODE_ALFA)!;
    expect(alfa.sessions.map((leaf) => leaf.appSessionId)).toContain(SESSION_ATTACHED_FIRST);
  });

  it('places the exact per-root counts the fixture was built to produce', () => {
    const tree = treeFromFixture();
    expect(tree.roots.map((root) => root.rootId)).toHaveLength(3);
    expect(everyTreeSession(rootById(tree, projectRootId(PROJECT_VIMES)))).toHaveLength(4);
    expect(everyTreeSession(rootById(tree, projectRootId(PROJECT_JOHNNY)))).toHaveLength(1);
    expect(everyTreeSession(rootById(tree, UNFILED_ROOT_ID))).toHaveLength(2);
  });

  it('places every NODE exactly once too — no orphan, no duplicate', () => {
    const tree = treeFromFixture();
    const placedNodeIds = tree.roots.flatMap((root) =>
      everyTreeNode(root).map((node) => node.nodeId),
    );
    expect([...placedNodeIds].sort()).toEqual(
      [NODE_TRUNK, NODE_ALFA, NODE_MIKE, NODE_DELTA, NODE_STRAY].sort(),
    );
  });
});

// ─── F2's named derivation, on its own ───────────────────────────────────────

describe('defaultRootForSession — F2, named and tested apart from the composition', () => {
  const { projects } = foldFixture();

  it('LONGEST PREFIX WINS: a cwd deep inside a project resolves to that project', () => {
    expect(defaultRootForSession(projects, `${VIMES_ROOT}/packages/core/src`)).toBe(
      projectRootId(PROJECT_VIMES),
    );
    expect(defaultRootForSession(projects, JOHNNY_ROOT)).toBe(projectRootId(PROJECT_JOHNNY));
  });

  it('NESTING is a feature: the most specific declared boundary wins', () => {
    const nestedStore = new MemoryEventStore({
      clock: new SteppingClock('2026-08-12T09:00:00.000Z', 1000),
      ids: new CountingIdSource(),
    });
    nestedStore.append([
      projectCreated({ projectId: 'outer', root: '/home/w/projects', name: undefined, description: undefined }),
      projectCreated({ projectId: 'inner', root: VIMES_ROOT, name: undefined, description: undefined }),
    ]);
    const nested = replayFromEmpty(projectsProjection, readAllStreamsGrouped(nestedStore));
    expect(defaultRootForSession(nested, `${VIMES_ROOT}/packages`)).toBe(projectRootId('inner'));
    expect(defaultRootForSession(nested, '/home/w/projects/other')).toBe(projectRootId('outer'));
  });

  it('an ARCHIVED project claims nothing — its cwd falls to unfiled', () => {
    expect(defaultRootForSession(projects, `${RETIRED_ROOT}/src`)).toBe(UNFILED_ROOT_ID);
  });

  it('NO MATCH falls to unfiled rather than disappearing', () => {
    expect(defaultRootForSession(projects, '/home/w/games/dongfu')).toBe(UNFILED_ROOT_ID);
    expect(defaultRootForSession(projects, '/')).toBe(UNFILED_ROOT_ID);
  });

  it('respects the segment boundary — a sibling directory is not swallowed', () => {
    expect(defaultRootForSession(projects, `${VIMES_ROOT}-2/src`)).toBe(UNFILED_ROOT_ID);
  });
});

// ─── S14-A2: provenance survives replay untouched ────────────────────────────

describe('S14-A2 — provenance is write-once and stays that way through the read model', () => {
  it('carries the birth record verbatim, and null stays null', () => {
    const tree = treeFromFixture();
    const vimesRoot = rootById(tree, projectRootId(PROJECT_VIMES));
    const nodesUnderVimes = everyTreeNode(vimesRoot);
    const delta = nodesUnderVimes.find((node) => node.nodeId === NODE_DELTA)!;
    expect(delta.provenance).toEqual(WORKTREE_PROVENANCE);
    for (const node of nodesUnderVimes) {
      if (node.nodeId === NODE_DELTA) {
        continue;
      }
      expect(node.provenance, node.nodeId).toBeNull();
    }
  });

  it('is unchanged after unrelated events replay on top (closure, attachment, liveness)', () => {
    // The fixture ALREADY replays a closure and two attachments after the birth
    // records; this pins the comparison against a state folded from the prefix
    // that ends at the last `node_created`.
    const { records } = foldFixture();
    const lastBirthIndex = records.map((record) => record.type).lastIndexOf('node_created');
    const nodesAtBirth = replayFromEmpty(nodesProjection, records.slice(0, lastBirthIndex + 1));
    const nodesAtEnd = replayFromEmpty(nodesProjection, records);
    expect(nodesAtEnd.nodes[NODE_DELTA]!.provenance).toEqual(
      nodesAtBirth.nodes[NODE_DELTA]!.provenance,
    );
    expect(nodesAtEnd.nodes[NODE_DELTA]!.provenance).toEqual(WORKTREE_PROVENANCE);
  });
});

// ─── S14-A3: the rollup counts processes, not open nodes ─────────────────────

describe('S14-A3 — a closed node with a living session under it stays visible', () => {
  it('the closed node still reports its process and its severity', () => {
    const tree = treeFromFixture();
    const vimesRoot = rootById(tree, projectRootId(PROJECT_VIMES));
    const mike = everyTreeNode(vimesRoot).find((node) => node.nodeId === NODE_MIKE)!;
    expect(mike.closed).toBe(true);
    expect(mike.rollup).toEqual({ worst: 'gate_fired', processCount: 1 });
  });

  it('closure is inherited at READ time and recorded closure is kept distinct', () => {
    const tree = treeFromFixture();
    const vimesRoot = rootById(tree, projectRootId(PROJECT_VIMES));
    const delta = everyTreeNode(vimesRoot).find((node) => node.nodeId === NODE_DELTA)!;
    // Its own record says open; it sits under a closed parent.
    expect(delta.closed).toBe(false);
    expect(delta.effectivelyClosed).toBe(true);
    const mike = everyTreeNode(vimesRoot).find((node) => node.nodeId === NODE_MIKE)!;
    expect(mike.closed).toBe(true);
    expect(mike.effectivelyClosed).toBe(true);
    const trunk = everyTreeNode(vimesRoot).find((node) => node.nodeId === NODE_TRUNK)!;
    expect(trunk.effectivelyClosed).toBe(false);
  });

  // ⚠ PARITY AGAINST A HAND-COMPUTED FIXTURE ROLLUP. Written out by hand from
  // §3b and E2-b's counting rule rather than read off the implementation, so a
  // change to either one shows up here as a disagreement.
  it('every rollup matches the hand-computed forest, root rollups included', () => {
    const tree = treeFromFixture();
    const vimesRoot = rootById(tree, projectRootId(PROJECT_VIMES));
    const byNodeId = new Map(everyTreeNode(vimesRoot).map((node) => [node.nodeId, node]));

    // delta: no sessions at all → NOTHING TO REPORT, never `idle`.
    expect(byNodeId.get(NODE_DELTA)!.rollup).toEqual({ worst: null, processCount: 0 });
    // mike + delta: one running session with a gate raised.
    expect(byNodeId.get(NODE_MIKE)!.rollup).toEqual({ worst: 'gate_fired', processCount: 1 });
    // alfa: running (working) + dormant (idle) → working is worse.
    expect(byNodeId.get(NODE_ALFA)!.rollup).toEqual({ worst: 'working', processCount: 2 });
    // trunk: everything above.
    expect(byNodeId.get(NODE_TRUNK)!.rollup).toEqual({ worst: 'gate_fired', processCount: 3 });
    // the ROOT adds the session that hangs directly on it (running → working).
    expect(vimesRoot.rollup).toEqual({ worst: 'gate_fired', processCount: 4 });

    // johnny: one session, question asked → waiting_input.
    expect(rootById(tree, projectRootId(PROJECT_JOHNNY)).rollup).toEqual({
      worst: 'waiting_input',
      processCount: 1,
    });
    // unfiled: a dormant games session and a dead one, plus a node with nothing
    // in it. Dead ranks `idle` — archaeology, not an alarm.
    expect(rootById(tree, UNFILED_ROOT_ID).rollup).toEqual({ worst: 'idle', processCount: 2 });
  });
});

// ─── S14-A5: seen and needsAttention are two facts ───────────────────────────

describe('S14-A5 — seen ≠ handled, at the new surface', () => {
  it('the leaf carries BOTH, and the seen event cleared nothing', () => {
    const tree = treeFromFixture();
    const johnny = rootById(tree, projectRootId(PROJECT_JOHNNY)).sessions[0]!;
    expect(johnny.appSessionId).toBe(SESSION_JOHNNY);
    expect(johnny.seenAt).not.toBeNull();
    expect(johnny.needsAttention).not.toBeNull();
    expect(johnny.needsAttention!.reason).toBe('question');
    // And the severity still reads the attention, not the seen-ness.
    expect(johnny.severity).toBe('waiting_input');
  });

  it('a session that was never seen carries a null seenAt beside a live attention', () => {
    const tree = treeFromFixture();
    const vimesRoot = rootById(tree, projectRootId(PROJECT_VIMES));
    const gated = everyTreeSession(vimesRoot).find(
      (leaf) => leaf.appSessionId === SESSION_ON_CLOSED_NODE,
    )!;
    expect(gated.seenAt).toBeNull();
    expect(gated.needsAttention!.reason).toBe('gate');
  });

  it('folding a seen changes seenAt ONLY — every other leaf field is byte-identical', () => {
    const { projects, nodes, sessions, records } = foldFixture();
    const withoutTheSeen = replayFromEmpty(
      sessionsProjection,
      records.filter((record) => record.type !== 'seen'),
    );
    const before = treeOf(projects, nodes, withoutTheSeen);
    const after = treeOf(projects, nodes, sessions);
    const leafBefore = rootById(before, projectRootId(PROJECT_JOHNNY)).sessions[0]!;
    const leafAfter = rootById(after, projectRootId(PROJECT_JOHNNY)).sessions[0]!;
    expect(leafBefore.seenAt).toBeNull();
    expect(leafAfter.seenAt).not.toBeNull();
    expect(canonicalJson({ ...leafBefore, seenAt: leafAfter.seenAt })).toBe(
      canonicalJson(leafAfter),
    );
  });
});

// ─── S14-A7: the payload is tenant-blind ─────────────────────────────────────

const TREE_SOURCE_PATH = fileURLToPath(new URL('./tree.ts', import.meta.url));

// The vimes-tasks workflow's own node ids — the tenant vocabulary the engine
// must never learn (#16). Spelled here as data, exactly as the adjudicator's
// own #16 grep spells it.
const TENANT_WORDS: readonly string[] = [
  'backlog',
  'planning',
  'plan-ready',
  'implementing',
  'review',
  'blocked-external',
  'quarantined',
  'done',
  'cancelled',
  'manual-review',
];

describe('S14-A7 — no tenant word reaches the tree, in source or on the wire', () => {
  it('the tree module greps clean, prose included', () => {
    const source = readFileSync(TREE_SOURCE_PATH, 'utf8');
    expect(TENANT_WORDS.filter((word) => source.includes(word))).toEqual([]);
  });

  it('the serialized payload greps clean', () => {
    // ⚠ The fixture deliberately raises `gate` and `question` attention rather
    // than `quarantined`. That one attention reason COINCIDES with a tenant
    // stage word — it is engine vocabulary from events.ts and predates the
    // tenant's, so it can appear on the wire as an ATTENTION REASON without the
    // engine having learned anything about a workflow. Every other tenant word
    // is impossible here, and this grep proves it over a payload carrying
    // liveness, attention, custody, severity and every field name.
    const payload = canonicalJson(treeFromFixture());
    expect(TENANT_WORDS.filter((word) => payload.includes(word))).toEqual([]);
  });

  it('workflow state can reach this payload ONLY through the reserved overlays map', () => {
    const tree = treeFromFixture();
    for (const root of tree.roots) {
      for (const node of everyTreeNode(root)) {
        expect(node.overlays).toEqual({});
        expect(Object.isFrozen(node.overlays)).toBe(true);
      }
      for (const leaf of everyTreeSession(root)) {
        expect(leaf.overlays).toEqual({});
        expect(Object.isFrozen(leaf.overlays)).toBe(true);
      }
    }
  });
});

// ─── S14-A8: determinism ─────────────────────────────────────────────────────

describe('S14-A8 — the same states yield the same bytes', () => {
  it('twice over one folded state', () => {
    const { projects, nodes, sessions } = foldFixture();
    expect(canonicalJson(treeOf(projects, nodes, sessions))).toBe(
      canonicalJson(treeOf(projects, nodes, sessions)),
    );
  });

  it('twice over two INDEPENDENT folds of the same events', () => {
    expect(canonicalJson(treeFromFixture())).toBe(canonicalJson(treeFromFixture()));
  });

  it('mutates none of the three states it is handed', () => {
    const { projects, nodes, sessions } = foldFixture();
    const before = canonicalJson({ projects, nodes, sessions });
    treeOf(projects, nodes, sessions);
    treeOf(projects, nodes, sessions, { rootId: UNFILED_ROOT_ID });
    expect(canonicalJson({ projects, nodes, sessions })).toBe(before);
  });

  it('carries the severity order version so a client can tell the order moved', () => {
    expect(treeFromFixture().orderVersion).toBe(ATTENTION_SEVERITY_ORDER_VERSION);
  });
});

// ─── S14-A10: the virtual id grammar ─────────────────────────────────────────

describe('S14-A10 — virtual root ids are namespaced, deterministic, and exact-match only', () => {
  it('mints the declared forms, and nothing else', () => {
    const tree = treeFromFixture();
    expect(tree.roots.map((root) => root.rootId)).toEqual([
      `${PROJECT_ROOT_ID_PREFIX}${PROJECT_VIMES}`,
      `${PROJECT_ROOT_ID_PREFIX}${PROJECT_JOHNNY}`,
      UNFILED_ROOT_ID,
    ]);
    expect(projectRootId('anything')).toBe('project:anything');
  });

  it('a real engine-minted nodeId can never take a virtual form', () => {
    const ids = new CountingIdSource();
    for (let index = 0; index < 100; index += 1) {
      const mintedId = ids.uuid();
      expect(mintedId.startsWith(PROJECT_ROOT_ID_PREFIX)).toBe(false);
      expect(mintedId).not.toBe(UNFILED_ROOT_ID);
      // The `:` is the structural argument — a uuid has none.
      expect(mintedId).not.toContain(':');
    }
    // …and no nodeId in the payload collides either.
    const tree = treeFromFixture();
    for (const root of tree.roots) {
      for (const node of everyTreeNode(root)) {
        expect(node.nodeId.startsWith(PROJECT_ROOT_ID_PREFIX)).toBe(false);
        expect(node.nodeId).not.toBe(UNFILED_ROOT_ID);
      }
    }
  });

  it('the rootId option matches EXACTLY — a virtual id never prefix-resolves', () => {
    expect(treeFromFixture(projectRootId(PROJECT_VIMES)).roots.map((root) => root.rootId)).toEqual([
      projectRootId(PROJECT_VIMES),
    ]);
    expect(treeFromFixture(UNFILED_ROOT_ID).roots.map((root) => root.rootId)).toEqual([
      UNFILED_ROOT_ID,
    ]);
    // Prefixes address NOTHING, in either direction.
    expect(treeFromFixture(PROJECT_ROOT_ID_PREFIX).roots).toEqual([]);
    expect(treeFromFixture(`${PROJECT_ROOT_ID_PREFIX}zeta`).roots).toEqual([]);
    expect(treeFromFixture('unfil').roots).toEqual([]);
    expect(treeFromFixture('unfiled-extra').roots).toEqual([]);
    // A bare projectId is not a rootId; the grammar is the contract.
    expect(treeFromFixture(PROJECT_VIMES).roots).toEqual([]);
    // An archived project has no root to address.
    expect(treeFromFixture(projectRootId(PROJECT_RETIRED)).roots).toEqual([]);
  });

  it('scoping to one root does NOT change the short ids, which are estate-wide', () => {
    const whole = treeFromFixture();
    const scoped = treeFromFixture(UNFILED_ROOT_ID);
    const shortIdsWhole = new Map(
      everySessionInTree(whole).map((leaf) => [leaf.appSessionId, leaf.shortId]),
    );
    for (const leaf of everySessionInTree(scoped)) {
      expect(leaf.shortId).toBe(shortIdsWhole.get(leaf.appSessionId));
    }
  });
});

// ─── S14-A11: sibling ordering is DECLARED ───────────────────────────────────

describe('S14-A11 — the declared ordering, on a fixture built to expose it', () => {
  it('roots come in project-creation order, with unfiled LAST', () => {
    const tree = treeFromFixture();
    const rootIds = tree.roots.map((root) => root.rootId);
    expect(rootIds).toEqual([
      projectRootId(PROJECT_VIMES),
      projectRootId(PROJECT_JOHNNY),
      UNFILED_ROOT_ID,
    ]);
    // The inversion that makes this a real assertion: alphabetically, johnny
    // comes FIRST. If anything ever sorts by id, this line reddens.
    expect([...rootIds].sort()).not.toEqual(rootIds);
    expect(rootIds[rootIds.length - 1]).toBe(UNFILED_ROOT_ID);
  });

  it('child nodes come in creation order, not alphabetical order', () => {
    const tree = treeFromFixture();
    const trunk = rootById(tree, projectRootId(PROJECT_VIMES)).nodes[0]!;
    expect(trunk.nodeId).toBe(NODE_TRUNK);
    const childIds = trunk.nodes.map((node) => node.nodeId);
    expect(childIds).toEqual([NODE_ALFA, NODE_MIKE]);
    // alfa/mike happen to sort the same way, so the load-bearing inversion is at
    // the ROOT level of the forest: the trunk (`node-zulu-…`) was created before
    // the stray (`node-bravo-…`), and they live under different roots.
    const allNodeIdsInOrder = tree.roots.flatMap((root) =>
      everyTreeNode(root).map((node) => node.nodeId),
    );
    expect(allNodeIdsInOrder).toEqual([NODE_TRUNK, NODE_ALFA, NODE_MIKE, NODE_DELTA, NODE_STRAY]);
    expect([...allNodeIdsInOrder].sort()).not.toEqual(allNodeIdsInOrder);
  });

  it('a node’s sessions come in ATTACHMENT order — not creation, not alphabetical', () => {
    const tree = treeFromFixture();
    const alfa = everyTreeNode(rootById(tree, projectRootId(PROJECT_VIMES))).find(
      (node) => node.nodeId === NODE_ALFA,
    )!;
    const attached = alfa.sessions.map((leaf) => leaf.appSessionId);
    expect(attached).toEqual([SESSION_ATTACHED_FIRST, SESSION_ATTACHED_SECOND]);
    // Creation order is the inverse (charlie was born first)…
    expect(attached).not.toEqual([SESSION_ATTACHED_SECOND, SESSION_ATTACHED_FIRST]);
    // …and alphabetical order is the inverse too.
    expect([...attached].sort()).not.toEqual(attached);
  });

  it('a root’s defaulted sessions come in session-creation order', () => {
    const tree = treeFromFixture();
    const unfiled = rootById(tree, UNFILED_ROOT_ID);
    const defaulted = unfiled.sessions.map((leaf) => leaf.appSessionId);
    // zulu-03 was created before bravo-06 — alphabetically it is the other way
    // round, which is the point of choosing those two names.
    expect(defaulted).toEqual([SESSION_GAMES, SESSION_RETIRED_CWD]);
    expect([...defaulted].sort()).not.toEqual(defaulted);
  });

  it('the defaulted order is DURABLE: it survives a canonicalJson round-trip of the state', () => {
    // ⚠ Session-creation order is sorted from `SessionRecord.createdAt` rather
    // than read off map order, precisely so a snapshot — which serializes state
    // through `canonicalJson`, sorting object keys deeply — cannot re-order it.
    // As of S14-F2's fix (2026-08-12) project- and node-creation order have the
    // same durable marker and the same round-trip proof; see the two cases in
    // the next block.
    const { projects, nodes, sessions } = foldFixture();
    const roundTripped = JSON.parse(canonicalJson(sessions)) as SessionsState;
    const before = treeOf(projects, nodes, sessions);
    const after = treeOf(projects, nodes, roundTripped);
    expect(rootById(after, UNFILED_ROOT_ID).sessions.map((leaf) => leaf.appSessionId)).toEqual(
      rootById(before, UNFILED_ROOT_ID).sessions.map((leaf) => leaf.appSessionId),
    );
  });
});

// ─── S14-F2: root and node order survive a snapshot round-trip ───────────────
//
// ⚠ **A SECOND FIXTURE, AND THE SECOND ONE EARNS ITS KEEP.** The estate fixture
// above inverts creation and alphabetical order where it can, but its only
// sibling NODE pair (alfa, mike) happens to sort the same way in both — so a
// `childNodeIdsInCreationOrder` that quietly sorted by id would sail through it.
// This fixture exists to make every sibling set an INVERSION:
//
//   projects        created zzz-… then aaa-…      (lexicographic is the reverse)
//   top-level nodes created mmm-… then aaa-…      (lexicographic is the reverse)
//   child nodes     created zzz-… then aaa-…      (lexicographic is the reverse)
//
// so each of the three orderings can actually FAIL, and a round-trip assertion
// over it is a claim rather than a coincidence.
const ORDER_PROJECT_FIRST_BORN = 'zzz-project-born-first';
const ORDER_PROJECT_SECOND_BORN = 'aaa-project-born-second';
const ORDER_NODE_PARENT = 'node-mmm-parent-born-first';
const ORDER_NODE_CHILD_FIRST_BORN = 'node-zzz-child-born-first';
const ORDER_NODE_CHILD_SECOND_BORN = 'node-aaa-child-born-second';
const ORDER_NODE_TOP_SECOND_BORN = 'node-aaa-top-born-second';

function foldOrderingFixture(): { projects: ProjectsState; nodes: NodesState } {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-08-12T11:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  store.append([
    projectCreated({ projectId: ORDER_PROJECT_FIRST_BORN, root: '/home/w/zzz', name: undefined, description: undefined }),
    projectCreated({ projectId: ORDER_PROJECT_SECOND_BORN, root: '/home/w/aaa', name: undefined, description: undefined }),
  ]);
  store.append([
    nodeCreated({
      nodeId: ORDER_NODE_PARENT,
      parentNodeId: null,
      projectId: ORDER_PROJECT_FIRST_BORN,
      name: 'parent',
      provenance: null,
      directory: null,
      nodeConfig: null,
    }),
    nodeCreated({
      nodeId: ORDER_NODE_CHILD_FIRST_BORN,
      parentNodeId: ORDER_NODE_PARENT,
      projectId: ORDER_PROJECT_FIRST_BORN,
      name: 'child born first',
      provenance: null,
      directory: null,
      nodeConfig: null,
    }),
    nodeCreated({
      nodeId: ORDER_NODE_CHILD_SECOND_BORN,
      parentNodeId: ORDER_NODE_PARENT,
      projectId: ORDER_PROJECT_FIRST_BORN,
      name: 'child born second',
      provenance: null,
      directory: null,
      nodeConfig: null,
    }),
    nodeCreated({
      nodeId: ORDER_NODE_TOP_SECOND_BORN,
      parentNodeId: null,
      projectId: ORDER_PROJECT_FIRST_BORN,
      name: 'top born second',
      provenance: null,
      directory: null,
      nodeConfig: null,
    }),
  ]);
  const records = readAllStreamsGrouped(store);
  return {
    projects: replayFromEmpty(projectsProjection, records),
    nodes: replayFromEmpty(nodesProjection, records),
  };
}

// What a snapshot does to a state, exactly: `SqliteSnapshotStore.save` writes
// `canonicalJson(state)` and `load` hands back `JSON.parse` of it, so this IS
// the production round-trip rather than an imitation of one.
function throughSnapshot<StateType>(state: StateType): StateType {
  return JSON.parse(canonicalJson(state)) as StateType;
}

describe('S14-F2 — root and node order are DURABLE across a canonicalJson round-trip', () => {
  it('the round-trip really does re-order the underlying maps (the fixture is honest)', () => {
    // ⚠ NON-VACUITY GUARD, and without it the two cases below prove nothing: if
    // `canonicalJson` left map order alone, "the order survived" would be true
    // of any implementation, including one that read map order directly. So
    // state the re-ordering as a fact first.
    const { projects, nodes } = foldOrderingFixture();

    expect(Object.keys(projects.projects)).toEqual([
      ORDER_PROJECT_FIRST_BORN,
      ORDER_PROJECT_SECOND_BORN,
    ]);
    expect(Object.keys(throughSnapshot(projects).projects)).toEqual([
      // Lexicographic — the EXACT reverse of creation order.
      ORDER_PROJECT_SECOND_BORN,
      ORDER_PROJECT_FIRST_BORN,
    ]);

    expect(Object.keys(nodes.nodes)).toEqual([
      ORDER_NODE_PARENT,
      ORDER_NODE_CHILD_FIRST_BORN,
      ORDER_NODE_CHILD_SECOND_BORN,
      ORDER_NODE_TOP_SECOND_BORN,
    ]);
    expect(Object.keys(throughSnapshot(nodes).nodes)).not.toEqual(Object.keys(nodes.nodes));
  });

  it('ROOT order survives the round-trip, and is creation order rather than lexicographic', () => {
    const { projects, nodes } = foldOrderingFixture();
    const emptySessions: SessionsState = { sessions: {} };

    const before = treeOf(projects, nodes, emptySessions).roots.map((root) => root.rootId);
    const after = treeOf(throughSnapshot(projects), nodes, emptySessions).roots.map(
      (root) => root.rootId,
    );

    expect(before).toEqual([
      projectRootId(ORDER_PROJECT_FIRST_BORN),
      projectRootId(ORDER_PROJECT_SECOND_BORN),
      UNFILED_ROOT_ID,
    ]);
    // THE ASSERTION: the same order out of a state whose map came back
    // lexicographically sorted. Before `ProjectRecord.createdAt` existed this
    // line was false in production and true in every test, which is exactly the
    // failure S14-F2 named.
    expect(after).toEqual(before);
    // ...and the order is not merely stable, it is the CREATION one: sorting by
    // id would put `aaa-…` first and still be "durable".
    expect([...after].sort()).not.toEqual(after);
  });

  it('NODE order survives the round-trip, at BOTH levels of the forest', () => {
    const { projects, nodes } = foldOrderingFixture();
    const emptySessions: SessionsState = { sessions: {} };

    const nodeIdsOf = (nodesState: NodesState): string[] =>
      treeOf(projects, nodesState, emptySessions).roots.flatMap((root) =>
        everyTreeNode(root).map((node) => node.nodeId),
      );

    const before = nodeIdsOf(nodes);
    const after = nodeIdsOf(throughSnapshot(nodes));

    // Depth-first from the first root: the parent, its two children in creation
    // order, then the top-level node created after it.
    expect(before).toEqual([
      ORDER_NODE_PARENT,
      ORDER_NODE_CHILD_FIRST_BORN,
      ORDER_NODE_CHILD_SECOND_BORN,
      ORDER_NODE_TOP_SECOND_BORN,
    ]);
    expect(after).toEqual(before);

    // Both levels are genuine inversions, so a sort-by-id at either one reddens:
    // the top-level pair (mmm-…, aaa-…) and the sibling pair (zzz-…, aaa-…).
    const topLevelIds = treeOf(projects, throughSnapshot(nodes), emptySessions).roots
      .flatMap((root) => root.nodes)
      .map((node) => node.nodeId);
    expect(topLevelIds).toEqual([ORDER_NODE_PARENT, ORDER_NODE_TOP_SECOND_BORN]);
    expect([...topLevelIds].sort()).not.toEqual(topLevelIds);

    const childIds = treeOf(projects, throughSnapshot(nodes), emptySessions)
      .roots.flatMap((root) => root.nodes)
      .find((node) => node.nodeId === ORDER_NODE_PARENT)!
      .nodes.map((node) => node.nodeId);
    expect(childIds).toEqual([ORDER_NODE_CHILD_FIRST_BORN, ORDER_NODE_CHILD_SECOND_BORN]);
    expect([...childIds].sort()).not.toEqual(childIds);
  });

  it('the id tiebreak is DECLARED and total: same-millisecond births order by id', () => {
    // Two projects (and two nodes) whose `createdAt` is byte-identical — the
    // comparator has to fall through to the id or the sort depends on arrival
    // order, which is the very thing being fixed. Built by hand from folded
    // records rather than from a log, because a stepping clock cannot produce a
    // tie and a real one does.
    const { projects, nodes } = foldOrderingFixture();
    const sameInstant = '2026-08-12T11:00:00.000Z';
    const tiedProjects: ProjectsState = {
      projects: {
        [ORDER_PROJECT_FIRST_BORN]: {
          ...projects.projects[ORDER_PROJECT_FIRST_BORN]!,
          createdAt: sameInstant,
        },
        [ORDER_PROJECT_SECOND_BORN]: {
          ...projects.projects[ORDER_PROJECT_SECOND_BORN]!,
          createdAt: sameInstant,
        },
      },
    };
    const tiedRootIds = treeOf(tiedProjects, nodes, { sessions: {} }).roots.map(
      (root) => root.rootId,
    );
    // `aaa-…` now wins — not because it was created first (it was not) but
    // because the declared tiebreak says so, deterministically, either way the
    // records happen to be ordered in the map.
    expect(tiedRootIds).toEqual([
      projectRootId(ORDER_PROJECT_SECOND_BORN),
      projectRootId(ORDER_PROJECT_FIRST_BORN),
      UNFILED_ROOT_ID,
    ]);
    // The same answer from a map in the opposite order — which is what "total"
    // buys: the comparison is a function of the records, not of their arrival.
    const reversedProjects: ProjectsState = {
      projects: Object.fromEntries(Object.entries(tiedProjects.projects).reverse()),
    };
    expect(treeOf(reversedProjects, nodes, { sessions: {} }).roots.map((root) => root.rootId)).toEqual(
      tiedRootIds,
    );
  });
});

// ─── the wire shape itself ───────────────────────────────────────────────────

describe('the leaf and the root carry what the contract says they carry', () => {
  it('a leaf carries the identity fields separately and a precomputed severity', () => {
    const { projects, nodes, sessions } = foldFixture();
    const tree = treeOf(projects, nodes, sessions);
    const alfa = everyTreeNode(rootById(tree, projectRootId(PROJECT_VIMES))).find(
      (node) => node.nodeId === NODE_ALFA,
    )!;
    const named = alfa.sessions[0]!;
    expect(named).toEqual({
      appSessionId: SESSION_ATTACHED_FIRST,
      // ⚠ SIX characters, not the base four: every id in this estate begins
      // `sess-`, so the whole estate is one colliding group and every handle
      // extended together until the group separated. Spelled out rather than
      // recomputed, so a change to the extension rule reddens here.
      shortId: 'sess-y',
      name: 'the core run',
      derivedTitle: null,
      liveness: 'running',
      needsAttention: null,
      seenAt: null,
      custody: 'host',
      severity: 'working',
      overlays: {},
      createdAt: sessions.sessions[SESSION_ATTACHED_FIRST]!.createdAt,
    });
  });

  // S15-F3: `createdAt` is a copy, not a derivation — the leaf's value is
  // byte-identical to the source `SessionRecord`'s, for every session in the
  // fixture, not just the one exact-equality check above happens to cover.
  it('the leaf createdAt is a verbatim pass-through of the source record createdAt', () => {
    const { projects, nodes, sessions } = foldFixture();
    const tree = treeOf(projects, nodes, sessions);
    for (const leaf of everySessionInTree(tree)) {
      expect(leaf.createdAt).toBe(sessions.sessions[leaf.appSessionId]!.createdAt);
    }
  });

  it('a project root carries its display name and its directory; unfiled carries neither', () => {
    const tree = treeFromFixture();
    // D42's read-time fallback: no name on the record, so the basename.
    expect(rootById(tree, projectRootId(PROJECT_VIMES)).name).toBe('vimes');
    expect(rootById(tree, projectRootId(PROJECT_VIMES)).directory).toBe(VIMES_ROOT);
    // A declared name wins over the basename.
    expect(rootById(tree, projectRootId(PROJECT_JOHNNY)).name).toBe('Johnny');
    const unfiled = rootById(tree, UNFILED_ROOT_ID);
    expect(unfiled.name).toBe(UNFILED_ROOT_ID);
    // `unfiled` is not a place on disk and must not pretend to be one.
    expect(unfiled.directory).toBeNull();
  });

  it('the unfiled root is ALWAYS present, even holding nothing at all', () => {
    const emptyStore = new MemoryEventStore({
      clock: new SteppingClock('2026-08-12T09:00:00.000Z', 1000),
      ids: new CountingIdSource(),
    });
    emptyStore.append([
      projectCreated({ projectId: 'solo', root: '/home/w/solo', name: undefined, description: undefined }),
    ]);
    const records = readAllStreamsGrouped(emptyStore);
    const tree = treeOf(
      replayFromEmpty(projectsProjection, records),
      replayFromEmpty(nodesProjection, records),
      replayFromEmpty(sessionsProjection, records),
    );
    expect(tree.roots.map((root) => root.rootId)).toEqual([projectRootId('solo'), UNFILED_ROOT_ID]);
    for (const root of tree.roots) {
      // NOTHING TO REPORT, never coerced to the quietest rank.
      expect(root.rollup).toEqual({ worst: null, processCount: 0 });
    }
  });

  it('is total on empty states — three empty folds yield the unfiled root and nothing else', () => {
    const tree = treeOf({ projects: {} }, { nodes: {} }, { sessions: {} });
    expect(tree.roots).toEqual([
      {
        rootId: UNFILED_ROOT_ID,
        name: UNFILED_ROOT_ID,
        directory: null,
        rollup: { worst: null, processCount: 0 },
        nodes: [],
        sessions: [],
      },
    ]);
  });

  it('every leaf’s short id is the D79 handle rendered over the WHOLE estate', () => {
    const tree = treeFromFixture();
    const leaves = everySessionInTree(tree);
    expect(leaves).toHaveLength(7);
    const shortIds = leaves.map((leaf) => leaf.shortId);
    // All seven fixture ids share `sess-` for five characters, so every one of
    // them collided at the base width and every one of them extended — together.
    expect(new Set(shortIds).size).toBe(7);
    for (const leaf of leaves) {
      expect(leaf.appSessionId.startsWith(leaf.shortId)).toBe(true);
    }
  });
});
