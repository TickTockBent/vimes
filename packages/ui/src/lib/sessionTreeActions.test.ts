import { describe, expect, it } from 'vitest';
import type { TreeNode, TreeResponse, TreeRoot, TreeSession } from '@vimes/core';
// VALUE import of the core grammar constants, on purpose: `.test.ts` files are
// exempt from D87 rider 1 (the D87 addendum, S15-F2) precisely so a UI literal
// can be cross-checked against the wire name it mirrors. `sessionTreeActions.ts`
// hard-codes `'project:'`; these two assertions are what make that mirror
// drift-proof rather than merely commented.
import { PROJECT_ROOT_ID_PREFIX, UNFILED_ROOT_ID, projectRootId } from '@vimes/core';
import {
  attachAfterSpawnNodeId,
  attachTargetsOf,
  canCreateNodeUnder,
  createNodeRequestFor,
  nodeActionTarget,
  nodeWriteFailureMessage,
  projectIdOfRootId,
  rootActionTarget,
  sessionTreeActionTargets,
  spawnPrefillFor,
  type NodeActionTarget,
} from './sessionTreeActions.js';
import { nodeRefusalMessage } from './nodeRefusalMessages.js';

// Fixture builders, deliberately the SAME shape sessionTreeRows.test.ts uses —
// one house idiom for the tree payload, so a reader moving between the two
// files is reading the same fixture language.

const EMPTY_ROLLUP = { worst: null, processCount: 0 } as const;

function session(appSessionId: string, overrides: Partial<TreeSession> = {}): TreeSession {
  return {
    appSessionId,
    shortId: appSessionId.slice(0, 4),
    name: null,
    derivedTitle: null,
    liveness: 'running',
    needsAttention: null,
    seenAt: null,
    custody: 'host',
    severity: 'working',
    overlays: {},
    createdAt: '2026-08-12T09:00:00.000Z',
    ...overrides,
  };
}

function node(nodeId: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    nodeId,
    name: nodeId,
    provenance: null,
    directory: null,
    closed: false,
    effectivelyClosed: false,
    rollup: EMPTY_ROLLUP,
    overlays: {},
    nodes: [],
    sessions: [],
    ...overrides,
  };
}

function root(rootId: string, overrides: Partial<TreeRoot> = {}): TreeRoot {
  return {
    rootId,
    name: rootId,
    directory: null,
    rollup: EMPTY_ROLLUP,
    nodes: [],
    sessions: [],
    ...overrides,
  };
}

function tree(roots: readonly TreeRoot[]): TreeResponse {
  return { orderVersion: 1, roots };
}

describe('projectIdOfRootId — the F1 grammar, read backwards', () => {
  it('the mirrored prefix IS core’s prefix (drift guard for the hard-coded literal)', () => {
    // If core ever respells the grammar, THIS reddens rather than the UI
    // silently addressing a project that does not exist.
    expect(projectIdOfRootId(`${PROJECT_ROOT_ID_PREFIX}abc`)).toBe('abc');
    expect(projectIdOfRootId(projectRootId('9f2c-uuid'))).toBe('9f2c-uuid');
  });

  it('strips the prefix EXACTLY ONCE — a projectId that itself looks prefixed survives', () => {
    // The inverse of concatenation, not a search-and-replace: `slice` at a fixed
    // offset returns what `projectRootId` was handed, whatever it looked like.
    expect(projectIdOfRootId('project:project:x')).toBe('project:x');
  });

  it('A8/A5 REFUSAL: `unfiled` names no project', () => {
    expect(projectIdOfRootId(UNFILED_ROOT_ID)).toBeNull();
    expect(projectIdOfRootId('unfiled')).toBeNull();
  });

  it('is total over strings — an unprefixed or empty id answers null, never throws', () => {
    expect(projectIdOfRootId('')).toBeNull();
    expect(projectIdOfRootId('unfil')).toBeNull();
    expect(projectIdOfRootId('some-node-uuid')).toBeNull();
    // `project:` with nothing after it names nothing.
    expect(projectIdOfRootId('project:')).toBeNull();
  });
});

describe('createNodeRequestFor', () => {
  it('a PROJECT ROOT target creates a TOP-LEVEL node in that project', () => {
    const target = rootActionTarget(root('project:p1', { name: 'vimes' }));
    expect(createNodeRequestFor(target, 'slice 15')).toEqual({
      projectId: 'p1',
      parentNodeId: null,
      name: 'slice 15',
    });
  });

  it('a NODE target creates a CHILD of that node, in the owning root’s project', () => {
    const owningRoot = root('project:p1');
    const target = nodeActionTarget(owningRoot, node('node-a'));
    expect(createNodeRequestFor(target, 'sub')).toEqual({
      projectId: 'p1',
      parentNodeId: 'node-a',
      name: 'sub',
    });
  });

  it('⚠ REFUSES `unfiled` — no projectId can be derived, so the affordance must not exist there', () => {
    // The WO's sabotage target: making this return a request (any request) for
    // the unfiled root must redden HERE.
    const target = rootActionTarget(root(UNFILED_ROOT_ID, { name: 'unfiled' }));
    expect(createNodeRequestFor(target, 'anything')).toBeNull();
    expect(canCreateNodeUnder(target)).toBe(false);
  });

  it('passes the name through UNTRIMMED — `empty-name` is the writer’s refusal to make', () => {
    const target = rootActionTarget(root('project:p1'));
    expect(createNodeRequestFor(target, '   ')).toEqual({
      projectId: 'p1',
      parentNodeId: null,
      name: '   ',
    });
  });
});

describe('canCreateNodeUnder', () => {
  it('a project root and an OPEN node may host a node', () => {
    const owningRoot = root('project:p1');
    expect(canCreateNodeUnder(rootActionTarget(owningRoot))).toBe(true);
    expect(canCreateNodeUnder(nodeActionTarget(owningRoot, node('n1')))).toBe(true);
  });

  it('an EFFECTIVELY CLOSED node does not draw the affordance (kindness; the daemon still owns the refusal)', () => {
    const owningRoot = root('project:p1');
    const closedByAncestor = node('n1', { closed: false, effectivelyClosed: true });
    const closedItself = node('n2', { closed: true, effectivelyClosed: true });
    expect(canCreateNodeUnder(nodeActionTarget(owningRoot, closedByAncestor))).toBe(false);
    expect(canCreateNodeUnder(nodeActionTarget(owningRoot, closedItself))).toBe(false);
  });
});

describe('spawnPrefillFor — A8, the whole payoff of E3-a', () => {
  const projectRoot = root('project:p1', { directory: '/home/wes/projects/vimes' });

  it('a node WITH a directory prefills the node’s directory', () => {
    const target = nodeActionTarget(projectRoot, node('n1', { directory: '/home/wes/projects/vimes/packages/ui' }));
    expect(spawnPrefillFor(target)).toBe('/home/wes/projects/vimes/packages/ui');
  });

  it('a node WITHOUT a directory falls back to its project root’s directory', () => {
    const target = nodeActionTarget(projectRoot, node('n1', { directory: null }));
    expect(spawnPrefillFor(target)).toBe('/home/wes/projects/vimes');
  });

  it('a project ROOT prefills its own declared directory', () => {
    expect(spawnPrefillFor(rootActionTarget(projectRoot))).toBe('/home/wes/projects/vimes');
  });

  it('⚠ `unfiled` gets NO PREFILL — null, never an empty string (it is not a place on disk)', () => {
    // The WO's second sabotage target: null-coercing this to `''` must redden.
    // `toBeNull` rather than `toBeFalsy` is the whole point — `''` is falsy and
    // would sail through a looser assertion while putting a fake default in the
    // cwd box.
    const unfiledRoot = root(UNFILED_ROOT_ID, { name: 'unfiled', directory: null });
    expect(spawnPrefillFor(rootActionTarget(unfiledRoot))).toBeNull();
    // …and the same for a (hypothetical) directoryless node under it.
    const target = nodeActionTarget(unfiledRoot, node('n1', { directory: null }));
    expect(spawnPrefillFor(target)).toBeNull();
  });

  it('a project root with NO declared directory also yields null rather than a fabricated path', () => {
    expect(spawnPrefillFor(rootActionTarget(root('project:p1', { directory: null })))).toBeNull();
  });
});

describe('attachAfterSpawnNodeId — S15-F9, signed: a node row’s spawn lands ON the node', () => {
  const projectRoot = root('project:p1', { name: 'vimes', directory: '/d' });

  it('a NODE target names itself — this is the whole point of the button (⟨Wes⟩)', () => {
    // The WO's sabotage target: returning null here must redden THIS.
    expect(attachAfterSpawnNodeId(nodeActionTarget(projectRoot, node('n1')))).toBe('n1');
    // Depth is irrelevant — a nested node is as attachable as a top-level one.
    expect(attachAfterSpawnNodeId(nodeActionTarget(projectRoot, node('n-deep')))).toBe('n-deep');
  });

  it('a PROJECT ROOT target names nothing — a root holds sessions directly, so nothing is chained', () => {
    // This null IS the "root-row spawns are unchanged" assertion: no attach
    // request is built, so that path stays byte-for-byte the pre-U9 flow.
    expect(attachAfterSpawnNodeId(rootActionTarget(projectRoot))).toBeNull();
  });

  it('the UNFILED root names nothing either — it hosts no nodes at all (A5)', () => {
    const unfiledRoot = root(UNFILED_ROOT_ID, { name: 'unfiled', directory: null });
    expect(attachAfterSpawnNodeId(rootActionTarget(unfiledRoot))).toBeNull();
  });

  it('is TOTAL: a node target with no nodeId answers null rather than inventing one', () => {
    // Structurally impossible from `nodeActionTarget` (a TreeNode always has an
    // id), which is exactly why it is asserted — the fn must never hand a
    // request builder something it would then send as `/api/nodes/null/…`.
    const malformed: NodeActionTarget = { ...rootActionTarget(projectRoot), kind: 'node' };
    expect(attachAfterSpawnNodeId(malformed)).toBeNull();
  });
});

describe('sessionTreeActionTargets', () => {
  const deepChild = node('n-deep', { directory: '/d/deep' });
  const child = node('n-child', { nodes: [deepChild] });
  const top = node('n-top', { nodes: [child], sessions: [session('s1')] });
  const projectRoot = root('project:p1', { name: 'vimes', directory: '/d', nodes: [top] });
  const unfiledRoot = root(UNFILED_ROOT_ID, { name: 'unfiled', sessions: [session('s2')] });
  const targets = sessionTreeActionTargets(tree([projectRoot, unfiledRoot]));

  it('keys every root AND every node at every depth — and no session', () => {
    expect([...targets.keys()]).toEqual([
      'project:p1',
      'n-top',
      'n-child',
      'n-deep',
      'unfiled',
    ]);
  });

  it('a node at ANY depth carries its owning root — the only place a projectId exists', () => {
    // TreeNode has no projectId; without this join a nested node could not be
    // given a parent at all.
    expect(createNodeRequestFor(targets.get('n-deep')!, 'x')).toEqual({
      projectId: 'p1',
      parentNodeId: 'n-deep',
      name: 'x',
    });
    expect(spawnPrefillFor(targets.get('n-deep')!)).toBe('/d/deep');
    // …and the root fallback still reaches a nested node with no directory.
    expect(spawnPrefillFor(targets.get('n-child')!)).toBe('/d');
  });

  it('the unfiled root’s target refuses creation and offers no prefill', () => {
    const unfiledTarget = targets.get('unfiled')!;
    expect(createNodeRequestFor(unfiledTarget, 'x')).toBeNull();
    expect(spawnPrefillFor(unfiledTarget)).toBeNull();
  });
});

describe('attachTargetsOf', () => {
  it('lists effectively-OPEN nodes only, grouped by root, in SERVED order at every level', () => {
    // Deliberately non-lexicographic served order (zeta before alpha, both as
    // roots and as siblings) — a `.sort()` sneaking in reddens this.
    const zetaChild = node('n-zeta-child', { name: 'zeta child' });
    const alphaChild = node('n-alpha-child', { name: 'alpha child' });
    const zetaTop = node('n-zeta', { name: 'zeta', nodes: [zetaChild, alphaChild] });
    const alphaTop = node('n-alpha', { name: 'alpha' });
    const zetaRoot = root('project:zeta', { name: 'zeta project', nodes: [zetaTop, alphaTop] });
    const alphaRoot = root('project:alpha', { name: 'alpha project', nodes: [node('n-solo')] });

    const groups = attachTargetsOf(tree([zetaRoot, alphaRoot]));

    expect(groups.map((g) => g.rootId)).toEqual(['project:zeta', 'project:alpha']);
    expect(groups[0]!.nodes).toEqual([
      { nodeId: 'n-zeta', name: 'zeta', depth: 0 },
      { nodeId: 'n-zeta-child', name: 'zeta child', depth: 1 },
      { nodeId: 'n-alpha-child', name: 'alpha child', depth: 1 },
      { nodeId: 'n-alpha', name: 'alpha', depth: 0 },
    ]);
    expect(groups[1]!.nodes).toEqual([{ nodeId: 'n-solo', name: 'n-solo', depth: 0 }]);
  });

  it('omits effectively-closed nodes but keeps their OPEN descendants reachable in the walk', () => {
    // A child of a closed node is itself effectivelyClosed in a real payload
    // (the daemon computes it), so nothing here can resurrect one; this pins
    // that the walk descends rather than pruning on its own authority.
    const openGrandchild = node('n-open-grandchild', { effectivelyClosed: false });
    const closedChild = node('n-closed', { closed: true, effectivelyClosed: true, nodes: [openGrandchild] });
    const openTop = node('n-open', { nodes: [closedChild] });
    const groups = attachTargetsOf(tree([root('project:p', { nodes: [openTop] })]));

    expect(groups[0]!.nodes).toEqual([
      { nodeId: 'n-open', name: 'n-open', depth: 0 },
      { nodeId: 'n-open-grandchild', name: 'n-open-grandchild', depth: 2 },
    ]);
  });

  it('omits a root that contributes no open node at all — including `unfiled`, which holds none', () => {
    const emptyProject = root('project:empty');
    const allClosed = root('project:shut', {
      nodes: [node('n-shut', { closed: true, effectivelyClosed: true })],
    });
    const unfiledRoot = root(UNFILED_ROOT_ID, { sessions: [session('s1')] });
    expect(attachTargetsOf(tree([emptyProject, allClosed, unfiledRoot]))).toEqual([]);
  });
});

describe('attachTargetsOf — S16-A6, the picker is scoped to the tab’s project', () => {
  // One forest, three roots, deliberately non-lexicographic served order, so a
  // scoping rule that reordered or re-derived anything reddens alongside the
  // filtering it was supposed to do.
  const scopedRoot = root('project:vimes', {
    name: 'vimes',
    nodes: [node('n-own', { name: 'slice 16' })],
  });
  const siblingRoot = root('project:johnny', {
    name: 'johnny',
    nodes: [node('n-sibling', { name: 'sibling work' })],
  });
  const unfiledRoot = root(UNFILED_ROOT_ID, { name: 'unfiled', sessions: [session('s1')] });
  const estate = (): TreeResponse => tree([scopedRoot, siblingRoot, unfiledRoot]);

  it('NO SCOPE is the pre-U3 picker, byte for byte (the unscoped tab is left alone)', () => {
    // Byte-equality of the two call forms: passing the scope parameter as null
    // may never become a different code path from omitting it. Same pin
    // `sessionTreeRows.test.ts` puts on the row flattener's null passthrough.
    const payload = estate();
    const unscoped = attachTargetsOf(payload);
    const explicitlyNullScope = attachTargetsOf(payload, null);

    expect(JSON.stringify(explicitlyNullScope)).toBe(JSON.stringify(unscoped));

    // …and that shared output is the WHOLE forest's open nodes, stated as the
    // literal walk so a scoping rule leaking into the unscoped path reddens.
    expect(unscoped).toEqual([
      {
        rootId: 'project:vimes',
        rootName: 'vimes',
        nodes: [{ nodeId: 'n-own', name: 'slice 16', depth: 0 }],
      },
      {
        rootId: 'project:johnny',
        rootName: 'johnny',
        nodes: [{ nodeId: 'n-sibling', name: 'sibling work', depth: 0 }],
      },
    ]);
  });

  it('SCOPED: only the named root’s group survives — a sibling project is not offered', () => {
    // The sabotage target: ignoring `scopedRootId` (answering the full set)
    // must redden HERE while the passthrough test above stays green.
    const groups = attachTargetsOf(estate(), 'project:vimes');

    expect(groups.map((g) => g.rootId)).toEqual(['project:vimes']);
    expect(groups[0]!.nodes).toEqual([{ nodeId: 'n-own', name: 'slice 16', depth: 0 }]);
  });

  it('SCOPED to a root with NO OPEN NODES answers an empty array (the sheet then says so)', () => {
    // Not an error and not a fallback to the full forest: an empty array is the
    // honest answer, and the picker's existing A9 sentence renders over it.
    const shutRoot = root('project:shut', {
      name: 'shut',
      nodes: [node('n-shut', { closed: true, effectivelyClosed: true })],
    });
    expect(attachTargetsOf(tree([shutRoot, siblingRoot]), 'project:shut')).toEqual([]);
    // …and a scope naming a root the payload does not carry answers the same
    // way, rather than falling through to every other project's nodes.
    expect(attachTargetsOf(estate(), 'project:not-in-payload')).toEqual([]);
    // `unfiled` scoped to itself holds no nodes at all (A5) — empty, always.
    expect(attachTargetsOf(estate(), UNFILED_ROOT_ID)).toEqual([]);
  });
});

describe('nodeWriteFailureMessage — A5, total over what postJsonApi can answer', () => {
  it('201 (create) and 200 (close/attach) are successes: null', () => {
    expect(nodeWriteFailureMessage(201, { node: {} })).toBeNull();
    expect(nodeWriteFailureMessage(200, { node: {} })).toBeNull();
  });

  it('409 renders the engine reason through the closed 11-reason vocabulary, verbatim', () => {
    for (const reason of [
      'unknown-project',
      'unknown-parent',
      'parent-closed',
      'cross-project-parent',
      'empty-name',
      'unknown-node',
      'already-closed',
      'node-closed',
      'unknown-session',
      'already-attached',
      'attached-elsewhere',
    ]) {
      expect(nodeWriteFailureMessage(409, { error: 'conflict', reason })).toBe(
        nodeRefusalMessage(reason),
      );
    }
  });

  it('409 with a reason this build has never heard of renders the ENGINE STRING rather than hiding it (A5 forward-compat)', () => {
    expect(nodeWriteFailureMessage(409, { error: 'conflict', reason: 'reason-from-the-future' })).toBe(
      'reason-from-the-future',
    );
  });

  it('409 with no usable reason says exactly that — never a fabricated cause', () => {
    expect(nodeWriteFailureMessage(409, {})).toBe('The daemon refused the write but named no reason.');
    expect(nodeWriteFailureMessage(409, null)).toBe('The daemon refused the write but named no reason.');
    expect(nodeWriteFailureMessage(409, { reason: 42 })).toBe(
      'The daemon refused the write but named no reason.',
    );
    expect(nodeWriteFailureMessage(409, 'conflict')).toBe(
      'The daemon refused the write but named no reason.',
    );
  });

  it('400 / 500 / 0 / anything else each say what happened, and all say nothing was written', () => {
    expect(nodeWriteFailureMessage(400, { error: 'bad request' })).toMatch(/nothing was written/);
    expect(nodeWriteFailureMessage(500, { error: 'node store finding' })).toMatch(/finding/);
    expect(nodeWriteFailureMessage(0, null)).toMatch(/never reached the daemon/);
    expect(nodeWriteFailureMessage(418, null)).toMatch(/418/);
  });
});
