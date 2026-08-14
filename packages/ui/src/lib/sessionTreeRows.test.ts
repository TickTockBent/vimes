import { describe, expect, it } from 'vitest';
import type { TreeNode, TreeResponse, TreeRoot, TreeSession } from '@vimes/core';
import type { ProjectView } from './projectContext.js';
import {
  sessionTreeContainerIds,
  sessionTreeForeignRootHref,
  sessionTreeRows,
  sessionTreeScopedRootId,
} from './sessionTreeRows.js';

// Fixture builders keep every test focused on ORDER, not on filling out every
// field of a large payload shape by hand — same idiom as
// sessionListPartition.test.ts's `row()` helper, adapted to the tree's three
// record kinds. Defaults are the "nothing interesting here" case; each test
// overrides only what it is asserting about.

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

function projectView(projectId: string, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId,
    root: `/home/wes/projects/${projectId}`,
    archived: false,
    pathSegment: projectId,
    ...overrides,
  };
}

function rowIds(rows: ReturnType<typeof sessionTreeRows>): string[] {
  return rows.map((r) => r.id);
}

describe('sessionTreeRows', () => {
  it('A1: served sibling order is preserved VERBATIM at every depth — deliberately non-lexicographic, non-chronological-looking names/ids', () => {
    // Root order: zeta, alpha, mmm — none of the "helpful" sorts (alpha
    // first, or insertion order matching the names) would produce this if a
    // .sort() crept in anywhere.
    //
    // ⚠ The node ids at depth 1 are deliberately served ZETA-BEFORE-MMM
    // ('node-zzz2' before 'node-mmm5') — the REVERSE of their lexicographic
    // order. A lexicographic id/name sort sneaking into the sibling-node loop
    // would silently flip them to mmm-before-zeta, which is exactly the
    // regression this fixture exists to catch (a same-spelling id sort that
    // happens to match served order proves nothing).
    const zetaSession = session('sess-zzz9');
    const alphaSession = session('sess-aaa1');
    const mmmNode = node('node-mmm5', { sessions: [alphaSession, zetaSession] });
    const zetaNode = node('node-zzz2');
    const zetaRoot = root('project:zeta-root', { name: 'zeta', nodes: [zetaNode, mmmNode] });
    const alphaRoot = root('project:alpha-root', { name: 'alpha' });
    const mmmRoot = root('unfiled', { name: 'mmm' });

    const payload = tree([zetaRoot, alphaRoot, mmmRoot]);
    const allExpanded = new Set(['project:zeta-root', 'node-mmm5']);

    const rows = sessionTreeRows(payload, allExpanded);

    // Depth 0: roots in served order, exactly zeta, alpha, mmm.
    expect(rowIds(rows.filter((r) => r.depth === 0))).toEqual(['project:zeta-root', 'project:alpha-root', 'unfiled']);

    // Depth 1, under the expanded zeta root: zeta-node before mmm-node
    // (served order) — the REVERSE of lexicographic ('node-mmm5' <
    // 'node-zzz2'), so a sneaked-in `.sort()` on sibling nodes flips this.
    const depth1UnderZeta = rows.filter((r) => r.depth === 1);
    expect(rowIds(depth1UnderZeta)).toEqual(['node-zzz2', 'node-mmm5']);

    // Depth 2, under the expanded mmm-node: alpha-session before zeta-session
    // (served order) — proves session children keep their own served order
    // independent of any id/name sort.
    const depth2UnderMmm = rows.filter((r) => r.depth === 2);
    expect(rowIds(depth2UnderMmm)).toEqual(['sess-aaa1', 'sess-zzz9']);

    // Whole-list order is exactly the depth-first walk of the fixture as
    // constructed above, proving no stage anywhere reorders across depths.
    expect(rowIds(rows)).toEqual([
      'project:zeta-root',
      'node-zzz2',
      'node-mmm5',
      'sess-aaa1',
      'sess-zzz9',
      'project:alpha-root',
      'unfiled',
    ]);
  });

  it('children order within a container is NODES then SESSIONS, both in served order', () => {
    const firstSession = session('sess-first');
    const secondSession = session('sess-second');
    const firstNode = node('node-first');
    const secondNode = node('node-second');
    const parentRoot = root('project:p', {
      nodes: [firstNode, secondNode],
      sessions: [firstSession, secondSession],
    });
    const payload = tree([parentRoot]);

    const rows = sessionTreeRows(payload, new Set(['project:p']));

    expect(rowIds(rows)).toEqual(['project:p', 'node-first', 'node-second', 'sess-first', 'sess-second']);
  });

  it('a collapsed root yields exactly one row, with its rollup reachable through row.root', () => {
    const busySession = session('sess-loud', { severity: 'gate_fired' });
    const childNode = node('node-child', { sessions: [busySession], rollup: { worst: 'gate_fired', processCount: 1 } });
    const collapsedRoot = root('project:p', {
      nodes: [childNode],
      rollup: { worst: 'gate_fired', processCount: 1 },
    });
    const payload = tree([collapsedRoot]);

    // Empty expandedIds — nothing expanded.
    const rows = sessionTreeRows(payload, new Set());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('root');
    expect(rows[0]?.expanded).toBe(false);
    // The rollup that would tell the view "something loud is under here" is
    // still reachable off the collapsed row — U5's requirement.
    expect(rows[0]?.root?.rollup.worst).toBe('gate_fired');
  });

  it('expanding a root reveals its nodes before its sessions; nested node expansion respects depth', () => {
    const leafSession = session('sess-leaf');
    const innerNode = node('node-inner', { sessions: [leafSession] });
    const outerNode = node('node-outer', { nodes: [innerNode] });
    const directSession = session('sess-direct');
    const populatedRoot = root('project:p', { nodes: [outerNode], sessions: [directSession] });
    const payload = tree([populatedRoot]);

    // Expand the root only — inner node stays collapsed.
    const rootOnlyRows = sessionTreeRows(payload, new Set(['project:p']));
    expect(rowIds(rootOnlyRows)).toEqual(['project:p', 'node-outer', 'sess-direct']);
    const outerRow = rootOnlyRows.find((r) => r.id === 'node-outer');
    expect(outerRow?.depth).toBe(1);
    expect(outerRow?.expandable).toBe(true);
    expect(outerRow?.expanded).toBe(false);

    // Expand root, outer node, AND inner node — inner node's own session
    // appears at depth 2 only once every ancestor container on its path is
    // itself expanded (each level's expansion is independent).
    const nestedRows = sessionTreeRows(payload, new Set(['project:p', 'node-outer', 'node-inner']));
    expect(rowIds(nestedRows)).toEqual(['project:p', 'node-outer', 'node-inner', 'sess-leaf', 'sess-direct']);
    const leafRow = nestedRows.find((r) => r.id === 'sess-leaf');
    // root(0) -> node-outer(1) -> node-inner(2) -> sess-leaf(3).
    expect(leafRow?.depth).toBe(3);
    expect(leafRow?.expandable).toBe(false);
    expect(leafRow?.expanded).toBe(false);
  });

  it('a container with zero children is expandable: false and expanded: false regardless of the expansion set', () => {
    const emptyRoot = root('unfiled');
    const payload = tree([emptyRoot]);

    // Deliberately put the empty root's id IN the expansion set — it must
    // not matter, because "nothing to expand" is a fact about the payload.
    const rows = sessionTreeRows(payload, new Set(['unfiled']));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.expandable).toBe(false);
    expect(rows[0]?.expanded).toBe(false);
  });

  it('A9: an empty unfiled root yields its own row rather than being filtered out', () => {
    const projectWithSessions = root('project:p', { sessions: [session('sess-a')] });
    const emptyUnfiled = root('unfiled');
    const payload = tree([projectWithSessions, emptyUnfiled]);

    const rows = sessionTreeRows(payload, new Set(['project:p']));

    expect(rowIds(rows)).toEqual(['project:p', 'sess-a', 'unfiled']);
    const unfiledRow = rows.find((r) => r.id === 'unfiled');
    expect(unfiledRow).toBeDefined();
    expect(unfiledRow?.expandable).toBe(false);
  });

  it('A9: a zero-node project with direct sessions yields root row + session rows', () => {
    const directSessionA = session('sess-a');
    const directSessionB = session('sess-b');
    const projectRoot = root('project:p', { sessions: [directSessionA, directSessionB] });
    const payload = tree([projectRoot]);

    const rows = sessionTreeRows(payload, new Set(['project:p']));

    expect(rowIds(rows)).toEqual(['project:p', 'sess-a', 'sess-b']);
    expect(rows.map((r) => r.kind)).toEqual(['root', 'session', 'session']);
  });

  it('every row records the correct discriminant object and nulls the other two', () => {
    const leafSession = session('sess-a');
    const childNode = node('node-a', { sessions: [leafSession] });
    const projectRoot = root('project:p', { nodes: [childNode] });
    const payload = tree([projectRoot]);

    const rows = sessionTreeRows(payload, new Set(['project:p', 'node-a']));

    const rootRow = rows.find((r) => r.kind === 'root');
    expect(rootRow?.root).not.toBeNull();
    expect(rootRow?.node).toBeNull();
    expect(rootRow?.session).toBeNull();

    const nodeRow = rows.find((r) => r.kind === 'node');
    expect(nodeRow?.node).not.toBeNull();
    expect(nodeRow?.root).toBeNull();
    expect(nodeRow?.session).toBeNull();

    const sessionRow = rows.find((r) => r.kind === 'session');
    expect(sessionRow?.session).not.toBeNull();
    expect(sessionRow?.root).toBeNull();
    expect(sessionRow?.node).toBeNull();
  });
});

// ── S15·U7 / D90 — the scope gate ───────────────────────────────────────────
//
// A three-root estate: the tab's own project, a sibling project, and `unfiled`
// — each with something under it, so "flattened" can never be confused with
// "empty". Every scoping test below reads this same forest, the way a real tab
// does: ONE payload, `GET /api/tree` unparameterized, gated only at render.
const SCOPED_ROOT_ID = 'project:vimes';
const SIBLING_ROOT_ID = 'project:johnny';

function scopedEstate(): TreeResponse {
  const ownSession = session('sess-own');
  const ownNode = node('node-own', { sessions: [ownSession] });
  const ownRoot = root(SCOPED_ROOT_ID, { name: 'vimes', nodes: [ownNode] });
  // The sibling is deliberately LOUD: D90's whole cross-project attention
  // channel is this rollup surviving the flattening.
  const siblingSession = session('sess-sibling', { severity: 'gate_fired' });
  const siblingNode = node('node-sibling', { sessions: [siblingSession] });
  const siblingRoot = root(SIBLING_ROOT_ID, {
    name: 'johnny',
    nodes: [siblingNode],
    rollup: { worst: 'gate_fired', processCount: 1 },
  });
  const unfiledRoot = root('unfiled', { sessions: [session('sess-unfiled')] });
  return tree([ownRoot, siblingRoot, unfiledRoot]);
}

// Every container in the fixture, so "expanded" means expanded and a flattened
// foreign root cannot be mistaken for a collapsed one.
const EVERY_CONTAINER_ID = new Set([
  SCOPED_ROOT_ID,
  'node-own',
  SIBLING_ROOT_ID,
  'node-sibling',
  'unfiled',
]);

describe('sessionTreeRows — D90 project scoping', () => {
  it('the scoped root nests in full; every other root flattens to ONE foreign row with no sessions', () => {
    const rows = sessionTreeRows(scopedEstate(), EVERY_CONTAINER_ID, SCOPED_ROOT_ID);

    // The sibling's node and session rows are ABSENT — not dimmed, not
    // collapsed-but-present: absent. The unfiled session likewise.
    expect(rowIds(rows)).toEqual([
      SCOPED_ROOT_ID,
      'node-own',
      'sess-own',
      SIBLING_ROOT_ID,
      'unfiled',
    ]);

    const scopedRow = rows.find((r) => r.id === SCOPED_ROOT_ID);
    expect(scopedRow?.foreign).toBe(false);
    expect(scopedRow?.expandable).toBe(true);
    expect(scopedRow?.expanded).toBe(true);

    const siblingRow = rows.find((r) => r.id === SIBLING_ROOT_ID);
    expect(siblingRow?.foreign).toBe(true);
    expect(siblingRow?.expandable).toBe(false);
    expect(siblingRow?.expanded).toBe(false);
    // U5 / D90: the rollup rides the same payload and stays reachable off the
    // flattened row, so a gate under johnny still reads loud on johnny's row.
    expect(siblingRow?.root?.rollup.worst).toBe('gate_fired');
    expect(siblingRow?.root?.rollup.processCount).toBe(1);

    // Nothing below depth 0 belongs to a foreign root: every non-root row is
    // marked non-foreign, by construction.
    expect(rows.filter((r) => r.foreign).map((r) => r.kind)).toEqual(['root', 'root']);
  });

  it('`unfiled` is foreign like any sibling — one row, no sessions (D90 accepted consequence)', () => {
    const rows = sessionTreeRows(scopedEstate(), EVERY_CONTAINER_ID, SCOPED_ROOT_ID);

    const unfiledRow = rows.find((r) => r.id === 'unfiled');
    expect(unfiledRow?.kind).toBe('root');
    expect(unfiledRow?.foreign).toBe(true);
    expect(unfiledRow?.expandable).toBe(false);
    expect(rows.some((r) => r.id === 'sess-unfiled')).toBe(false);
  });

  it('a foreign root CANNOT be expanded by the expansion set — the scope wins over stale ids', () => {
    // The exact race this guards: the first tree payload can land before the
    // registry resolves the segment, so the view may have seeded an expansion
    // set from the UNSCOPED walk. Those ids must be inert once a scope exists.
    const rows = sessionTreeRows(scopedEstate(), EVERY_CONTAINER_ID, SCOPED_ROOT_ID);

    for (const foreignId of [SIBLING_ROOT_ID, 'unfiled']) {
      const foreignRow = rows.find((r) => r.id === foreignId);
      expect(foreignRow?.expanded).toBe(false);
      expect(foreignRow?.expandable).toBe(false);
    }
  });

  it('a scope naming a root the payload does not contain flattens EVERYTHING rather than inventing a home', () => {
    const rows = sessionTreeRows(scopedEstate(), EVERY_CONTAINER_ID, 'project:not-in-payload');

    expect(rowIds(rows)).toEqual([SCOPED_ROOT_ID, SIBLING_ROOT_ID, 'unfiled']);
    expect(rows.every((r) => r.foreign)).toBe(true);
  });

  it('NO SCOPE is the pre-U7 full tree, byte for byte (D90 leaves the unscoped tab alone)', () => {
    const payload = scopedEstate();

    const unscoped = sessionTreeRows(payload, EVERY_CONTAINER_ID);
    const explicitlyNullScope = sessionTreeRows(payload, EVERY_CONTAINER_ID, null);

    // Byte-equality of the two call forms: passing the scope parameter as null
    // may never become a different code path from omitting it.
    expect(JSON.stringify(explicitlyNullScope)).toBe(JSON.stringify(unscoped));

    // …and that shared output is the WHOLE forest, every root expanded, which
    // is what the tree did before this unit. Stated as the literal walk so a
    // scoping rule that leaked into the unscoped path reddens here.
    expect(rowIds(unscoped)).toEqual([
      SCOPED_ROOT_ID,
      'node-own',
      'sess-own',
      SIBLING_ROOT_ID,
      'node-sibling',
      'sess-sibling',
      'unfiled',
      'sess-unfiled',
    ]);
    expect(unscoped.some((r) => r.foreign)).toBe(false);
  });
});

describe('sessionTreeScopedRootId', () => {
  it('turns the resolved project record into the root id the payload uses', () => {
    // Binding assertion: the id this builds is the id the tree payload uses for
    // that project — the mirrored `project:` grammar, checked against a fixture
    // root rather than against itself.
    const scopedRootId = sessionTreeScopedRootId(projectView('vimes'));
    expect(scopedRootId).toBe(SCOPED_ROOT_ID);
    expect(scopedEstate().roots[0]?.rootId).toBe(scopedRootId);
  });

  it('no project → no scope', () => {
    expect(sessionTreeScopedRootId(null)).toBeNull();
  });
});

describe('sessionTreeForeignRootHref', () => {
  const registry = [
    projectView('johnny', { pathSegment: 'infrastructure/johnny' }),
    projectView('archived-one', { archived: true }),
    projectView('is-a-root', { pathSegment: '' }),
    projectView('outside-the-fence', { pathSegment: null }),
  ];

  it('an addressable sibling links to its OWN tab, in ProjectPickerView URL shape, verbatim', () => {
    expect(sessionTreeForeignRootHref('project:johnny', registry)).toBe('/infrastructure/johnny/');
  });

  it('unfiled has no tab, so it gets no link', () => {
    expect(sessionTreeForeignRootHref('unfiled', registry)).toBeNull();
  });

  it('archived, root-itself, and outside-the-fence projects render without navigation', () => {
    expect(sessionTreeForeignRootHref('project:archived-one', registry)).toBeNull();
    expect(sessionTreeForeignRootHref('project:is-a-root', registry)).toBeNull();
    expect(sessionTreeForeignRootHref('project:outside-the-fence', registry)).toBeNull();
  });

  it('a root whose project is not in the registry gets no link (never a guessed URL)', () => {
    expect(sessionTreeForeignRootHref('project:unknown', registry)).toBeNull();
    expect(sessionTreeForeignRootHref('project:johnny', [])).toBeNull();
  });
});

describe('sessionTreeContainerIds', () => {
  it('unscoped: returns every root + node id, served order, no session ids', () => {
    const leafSession = session('sess-a');
    const innerNode = node('node-inner', { sessions: [leafSession] });
    const outerNode = node('node-outer', { nodes: [innerNode] });
    const emptyNode = node('node-empty');
    const populatedRoot = root('project:p', { nodes: [outerNode, emptyNode] });
    const emptyRoot = root('unfiled');
    const payload = tree([populatedRoot, emptyRoot]);

    const ids = sessionTreeContainerIds(payload);

    // 'node-empty' and 'unfiled' have zero children and are excluded — only
    // containers that actually have something to expand appear. Order is
    // served: root, then its nodes depth-first, then the next root.
    expect(ids).toEqual(['project:p', 'node-outer', 'node-inner']);
  });

  it('unscoped: an all-empty payload yields no container ids', () => {
    const payload = tree([root('unfiled')]);
    expect(sessionTreeContainerIds(payload)).toEqual([]);
  });

  // ── S15·U7 / D90 — expansion init, scoped ─────────────────────────────────
  //
  // This list IS the expansion default. Under a scope it must open the tab's
  // own project once (its whole subtree, as expand-all behaved within one
  // root) and must never name a foreign container — a foreign id in the seeded
  // set would be a latent instruction to open a sibling estate.
  it('scoped: only the scoped root and its own nodes — no foreign root id, no foreign node id', () => {
    const ids = sessionTreeContainerIds(scopedEstate(), SCOPED_ROOT_ID);

    expect(ids).toEqual([SCOPED_ROOT_ID, 'node-own']);
    expect(ids).not.toContain(SIBLING_ROOT_ID);
    expect(ids).not.toContain('node-sibling');
    expect(ids).not.toContain('unfiled');
  });

  it('scoped: the whole subtree of the scoped root opens, at every depth', () => {
    const deepLeaf = session('sess-deep');
    const innerNode = node('node-inner', { sessions: [deepLeaf] });
    const outerNode = node('node-outer', { nodes: [innerNode] });
    const ownRoot = root(SCOPED_ROOT_ID, { nodes: [outerNode] });
    const siblingRoot = root(SIBLING_ROOT_ID, { nodes: [node('node-sibling', { sessions: [session('s')] })] });
    const payload = tree([ownRoot, siblingRoot]);

    const ids = sessionTreeContainerIds(payload, SCOPED_ROOT_ID);
    expect(ids).toEqual([SCOPED_ROOT_ID, 'node-outer', 'node-inner']);

    // And that seeded set really does render the scoped estate fully open,
    // while the sibling stays one row — the two halves of the unit, joined.
    const rows = sessionTreeRows(payload, new Set(ids), SCOPED_ROOT_ID);
    expect(rowIds(rows)).toEqual([
      SCOPED_ROOT_ID,
      'node-outer',
      'node-inner',
      'sess-deep',
      SIBLING_ROOT_ID,
    ]);
  });

  it('scoped: a scope naming no root in the payload yields no ids at all', () => {
    expect(sessionTreeContainerIds(scopedEstate(), 'project:not-in-payload')).toEqual([]);
  });

  it('no scope: the container list is unchanged from the unscoped call, byte for byte', () => {
    const payload = scopedEstate();
    expect(JSON.stringify(sessionTreeContainerIds(payload, null))).toBe(
      JSON.stringify(sessionTreeContainerIds(payload)),
    );
    expect(sessionTreeContainerIds(payload)).toEqual([
      SCOPED_ROOT_ID,
      'node-own',
      SIBLING_ROOT_ID,
      'node-sibling',
      'unfiled',
    ]);
  });
});
