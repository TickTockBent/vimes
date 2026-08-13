import type { TreeResponse, TreeRoot, TreeNode, TreeSession } from '@vimes/core';

// ─── S15·U1 — the tree flattener (slice-15.md §4 A1/A9, ui-doctrine.md U8) ────
//
// `GET /api/tree` (slice 14) already carries the shape a tree VIEW needs: a
// declared root order, node-then-session sibling order within a container, and
// rollups reachable from every container whether or not it is expanded. This
// module's ONLY job is to turn that served forest into a flat list of rows a
// `<template v-for>` can walk, WITHOUT deciding anything the daemon already
// decided.
//
// ⚠ **NO `.sort()` ANYWHERE IN THIS FILE, EVER.** U8: the UI derives nothing
// the daemon serves. The payload's sibling order — nodes before sessions,
// each in served (creation/attachment) order — is rendered verbatim. A
// "helpful" client-side sort here would be a second opinion about ordering
// that the daemon already settled (S14-F2), and the A1 fixture test exists
// specifically to catch that regression.

export type SessionTreeRowKind = 'root' | 'node' | 'session';

export interface SessionTreeRow {
  readonly kind: SessionTreeRowKind;
  // rootId for roots, nodeId for nodes, appSessionId for sessions. Root ids
  // (`project:<uuid>` / `unfiled`) and node/session UUIDs cannot collide —
  // the F1 grammar's `:` and the literal `unfiled` guarantee it — so one id
  // namespace is safe for expansion state.
  readonly id: string;
  readonly depth: number; // 0 for roots
  readonly root: TreeRoot | null; // set when kind === 'root'
  readonly node: TreeNode | null; // set when kind === 'node'
  readonly session: TreeSession | null; // set when kind === 'session'
  readonly expandable: boolean; // roots/nodes with any child rows
  readonly expanded: boolean; // false always for sessions
}

// A container (root or node) has children iff it declares at least one child
// node or session. Zero children means `expandable: false` regardless of the
// caller's expansion set (nothing to expand is a FACT about the payload, not
// a state a set membership test could override — see the WO's rule).
function hasChildren(container: { readonly nodes: readonly TreeNode[]; readonly sessions: readonly TreeSession[] }): boolean {
  return container.nodes.length > 0 || container.sessions.length > 0;
}

// Depth-first walk of one container's children: NODES FIRST (served order),
// then SESSIONS (served order) — the WO's ordering rule, restated here rather
// than left implicit so a future edit to this function trips over the comment
// before it trips over the test.
function pushContainerRows(
  rows: SessionTreeRow[],
  container: { readonly nodes: readonly TreeNode[]; readonly sessions: readonly TreeSession[] },
  depth: number,
  expandedIds: ReadonlySet<string>,
): void {
  for (const childNode of container.nodes) {
    pushNodeRow(rows, childNode, depth, expandedIds);
  }
  for (const childSession of container.sessions) {
    rows.push({
      kind: 'session',
      id: childSession.appSessionId,
      depth,
      root: null,
      node: null,
      session: childSession,
      expandable: false,
      expanded: false,
    });
  }
}

function pushNodeRow(
  rows: SessionTreeRow[],
  node: TreeNode,
  depth: number,
  expandedIds: ReadonlySet<string>,
): void {
  const expandable = hasChildren(node);
  const expanded = expandable && expandedIds.has(node.nodeId);
  rows.push({
    kind: 'node',
    id: node.nodeId,
    depth,
    root: null,
    node,
    session: null,
    expandable,
    expanded,
  });
  if (expanded) {
    pushContainerRows(rows, node, depth + 1, expandedIds);
  }
}

/**
 * Flatten a served `TreeResponse` into display rows.
 *
 * Every root in the payload produces a row, INCLUDING an empty `unfiled` (A9
 * — the view decides what an empty root looks like; this derivation must not
 * hide it by filtering). Roots render in payload order; a collapsed
 * container still yields exactly its own row, with its `root`/`node`
 * (and therefore its `rollup`) reachable so the view can render the branch's
 * `worst` even while collapsed (doctrine U5: a collapsed branch with a gate
 * under it must read loud).
 */
export function sessionTreeRows(tree: TreeResponse, expandedIds: ReadonlySet<string>): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  for (const root of tree.roots) {
    const expandable = hasChildren(root);
    const expanded = expandable && expandedIds.has(root.rootId);
    rows.push({
      kind: 'root',
      id: root.rootId,
      depth: 0,
      root,
      node: null,
      session: null,
      expandable,
      expanded,
    });
    if (expanded) {
      pushContainerRows(rows, root, 1, expandedIds);
    }
  }
  return rows;
}

/**
 * Every expandable container id in the payload (roots and nodes with at
 * least one child), served order, NO session ids. U2 uses this for the
 * expand-all default — a set built from this list expands every branch that
 * has anything under it, in the same order the payload declared.
 */
export function sessionTreeContainerIds(tree: TreeResponse): string[] {
  const ids: string[] = [];
  function walkNodes(nodes: readonly TreeNode[]): void {
    for (const node of nodes) {
      if (hasChildren(node)) {
        ids.push(node.nodeId);
      }
      walkNodes(node.nodes);
    }
  }
  for (const root of tree.roots) {
    if (hasChildren(root)) {
      ids.push(root.rootId);
    }
    walkNodes(root.nodes);
  }
  return ids;
}
