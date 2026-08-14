import type { TreeResponse, TreeRoot, TreeNode, TreeSession } from '@vimes/core';
import type { ProjectView } from './projectContext.js';

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
//
// ─── S15·U7 — the SCOPE half (D90, closing S15-F8) ───────────────────────────
//
// One project per tab (D42/D61). A tab opened on a project shows THAT project's
// estate in full and every OTHER root — sibling projects AND `unfiled` — as a
// single row with no sessions under it, wearing its rollup glyph. The scope
// fact lives in the URL and is resolved ONCE by App.vue
// (`parseProjectPath`/`resolveProject` → `store.currentProject`); this module
// takes the resolved root id as a parameter and never re-derives it.
//
// ⚠ **THE FETCH DOES NOT CHANGE.** `GET /api/tree` stays parameterless and the
// daemon's `?root=` filter (S14-A10) stays shipped-unconsumed: the sibling
// rollups RIDE THE SAME PAYLOAD, which is what lets a foreign row read loud
// without a second request. Gating is pure rendering, here.
//
// ⚠ **NO SCOPE MEANS NO GATING, EXACTLY AS BEFORE.** `scopedRootId === null`
// (a bare host, an unresolved segment, a `/#/session/x` deep link) takes the
// same path this file took before U7 — every root expandable, every subtree
// walked. D90 left the landing surface unpriced on purpose, so this file must
// not invent a policy for it; the passthrough is pinned by a test that compares
// the scoped-null call to the unscoped one on the same fixture.

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
  // D90: this row is a root OUTSIDE the tab's project scope — a sibling project
  // or `unfiled`. True only on `kind: 'root'` rows and only under a scope; a
  // foreign root is always `expandable: false`, so no node or session row can
  // descend from one and every non-root row is `foreign: false` by
  // construction. The view uses it to draw the row WITHOUT a chevron and
  // WITHOUT write affordances, and to offer the navigation to that project's
  // own tab instead.
  readonly foreign: boolean;
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
      foreign: false,
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
    foreign: false,
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
 *
 * `scopedRootId` is D90's gate: the root id this tab is open on
 * (`project:<projectId>`), or null for an unscoped tab. Under a scope, EVERY
 * OTHER root — siblings and `unfiled` alike — yields exactly one row, marked
 * `foreign`, `expandable: false`, with no descendants. It is still a full row
 * carrying its `root` (and therefore its rollup), because a sibling project
 * raising a gate must read loud from here even though its sessions are not
 * shown (U5 + D90's cross-project attention channel).
 *
 * ⚠ A FOREIGN ROOT CANNOT BE EXPANDED BY THE EXPANSION SET. `expandable` is
 * computed from the scope and the payload, never from `expandedIds` — a stale
 * id left in the set from before the scope resolved must not re-open a
 * sibling's estate.
 */
export function sessionTreeRows(
  tree: TreeResponse,
  expandedIds: ReadonlySet<string>,
  scopedRootId: string | null = null,
): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  for (const root of tree.roots) {
    const foreign = scopedRootId !== null && root.rootId !== scopedRootId;
    const expandable = !foreign && hasChildren(root);
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
      foreign,
    });
    if (expanded) {
      pushContainerRows(rows, root, 1, expandedIds);
    }
  }
  return rows;
}

/**
 * Every expandable container id in the payload (roots and nodes with at
 * least one child), served order, NO session ids. The view uses this for the
 * expansion default — a set built from this list expands every branch that
 * has anything under it, in the same order the payload declared.
 *
 * Under a scope (D90), the walk covers THE SCOPED ROOT ONLY: its whole subtree
 * opens once, exactly as expand-all behaved within one root, and no foreign
 * root or foreign node id is ever in the returned list — so the expansion set
 * the view seeds cannot contain an id a foreign row could ever match. That is
 * the second of the two guards (the first is `sessionTreeRows` refusing to
 * expand a foreign root even if asked); they are deliberately independent,
 * because the scope can resolve AFTER the first payload lands.
 */
export function sessionTreeContainerIds(
  tree: TreeResponse,
  scopedRootId: string | null = null,
): string[] {
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
    if (scopedRootId !== null && root.rootId !== scopedRootId) {
      continue;
    }
    if (hasChildren(root)) {
      ids.push(root.rootId);
    }
    walkNodes(root.nodes);
  }
  return ids;
}

// ── the scope, as ids and as links ──────────────────────────────────────────

// `project:` — the root-id prefix from `packages/core/src/projections/tree.ts`
// (`PROJECT_ROOT_ID_PREFIX`/`projectRootId`), MIRRORED rather than imported for
// the same reason `UNFILED_ROOT_ID` is mirrored in TreeView.vue and the stage
// vocabulary is mirrored in lib/taskBoard.ts: `@vimes/core` is a node package
// and a deliberate non-dependency of `packages/ui`. Core is the authority; if
// the grammar ever changes, change it here in the same diff.
const PROJECT_ROOT_ID_PREFIX = 'project:';

/**
 * The tree root id a project record scopes to, or null when the tab has no
 * project (D61's bare host / unresolved segment / no-project deep link).
 *
 * Takes the ALREADY-RESOLVED record (`store.currentProject`) — never a
 * pathname. App.vue owns the URL→project resolution and runs it once per
 * document; a second resolver here would be a second answer to "which project
 * am I in".
 */
export function sessionTreeScopedRootId(project: ProjectView | null): string | null {
  return project === null ? null : `${PROJECT_ROOT_ID_PREFIX}${project.projectId}`;
}

/**
 * The URL a FOREIGN root row navigates to — that project's own tab — or null
 * when the row is not URL-addressable and must render without navigation.
 *
 * Null for four honest reasons, all of them D90/D61 facts rather than errors:
 * `unfiled` (not a project, and it has no tab — the accepted consequence D90
 * records), a root whose project is not in the registry, an ARCHIVED project
 * (`resolveProject` refuses to match one, so a link would land on the picker
 * saying "no such project"), and a project whose `pathSegment` is `''` or null
 * (it IS a configured root, or it sits under none — the daemon's two honest
 * non-answers).
 *
 * ⚠ THE URL SHAPE IS ProjectPickerView's `projectHref`, RESTATED, NOT
 * RE-INVENTED: `/<pathSegment>/`, verbatim, unencoded. Two different spellings
 * of a project's URL in one app would be two answers to the same question; if
 * that shape ever needs escaping, both sites change together.
 */
export function sessionTreeForeignRootHref(
  rootId: string,
  projects: readonly ProjectView[],
): string | null {
  if (!rootId.startsWith(PROJECT_ROOT_ID_PREFIX)) {
    return null;
  }
  const projectId = rootId.slice(PROJECT_ROOT_ID_PREFIX.length);
  for (const project of projects) {
    if (project.projectId !== projectId) {
      continue;
    }
    if (project.archived || project.pathSegment === null || project.pathSegment === '') {
      return null;
    }
    return `/${project.pathSegment}/`;
  }
  return null;
}
