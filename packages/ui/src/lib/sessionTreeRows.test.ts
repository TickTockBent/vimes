import { describe, expect, it } from 'vitest';
import type { TreeNode, TreeResponse, TreeRoot, TreeSession } from '@vimes/core';
import { sessionTreeContainerIds, sessionTreeRows } from './sessionTreeRows.js';

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

describe('sessionTreeContainerIds', () => {
  it('returns every root + node id, served order, no session ids', () => {
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

  it('an all-empty payload yields no container ids', () => {
    const payload = tree([root('unfiled')]);
    expect(sessionTreeContainerIds(payload)).toEqual([]);
  });
});
