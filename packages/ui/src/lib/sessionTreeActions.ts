import type { TreeNode, TreeResponse, TreeRoot } from '@vimes/core';
import { nodeRefusalMessage } from './nodeRefusalMessages.js';

// ─── S15·U3 — the tree's WRITE derivations (slice-15.md A5/A8, ui-doctrine U8) ─
//
// TreeView's three write flows (create node, attach session, close node) plus
// spawn-from-node all need the same handful of decisions made ONCE, in a place a
// test can reach: which row may create a node under it, what `projectId` that
// creation names, what cwd a spawn from this row starts with, which nodes an
// attach may target, and what an operator is told when the daemon refuses.
//
// ⚠ **NOTHING HERE RE-DERIVES A SERVED FACT (U8).** The only thing this module
// computes from the payload is CONTAINMENT — which root a node sits under, which
// the payload declares structurally by nesting the node inside that root. No
// sorting, no filtering that reorders, no second opinion about names, ids or
// severity. `attachTargetsOf` walks in SERVED order and filters ONLY on
// `effectivelyClosed`, which is a field the daemon computed.
//
// ⚠ **THE CLIENT-SIDE OPEN-NODE FILTER IS KINDNESS, NOT ENFORCEMENT.** The
// daemon owns every refusal: a node that closes between the picker rendering and
// the operator tapping it yields a 409 `node-closed`, and that refusal renders
// verbatim through `nodeWriteFailureMessage` below. This module never pretends
// to have adjudicated anything.

// ── the virtual-root grammar (mirrored, deliberately) ───────────────────────
//
// `PROJECT_ROOT_ID_PREFIX` in `packages/core/src/projections/tree.ts` — the F1
// grammar, mirrored here as a literal rather than imported because D87 sanctions
// TYPE-ONLY core imports in shipped UI source (a value import would put engine
// code in the browser bundle). The same narrow-mirroring posture TreeView takes
// toward `UNFILED_ROOT_ID`. THE MIRROR IS CROSS-CHECKED: this module's test
// value-imports the core constants and asserts the derivation against them
// (the D87 addendum's sanctioned test-file exemption, S15-F2), so drift reddens
// a test rather than silently addressing the wrong root.
const PROJECT_ROOT_ID_PREFIX = 'project:';

/**
 * The `projectId` a virtual root names, or `null` when the root names no
 * project.
 *
 * ⚠ **THE PREFIX IS STRIPPED EXACTLY ONCE AND NEVER SEARCHED FOR.** A project
 * id that itself contains the prefix (`project:project:x` as a rootId) yields
 * `project:x` — the id core would have built from it — because `slice` at a
 * fixed offset is the inverse of `projectRootId`'s concatenation, while a
 * `replace`/`split` would mangle it. This is the F1 grammar read backwards, and
 * it is the ONLY place in the client that reads it.
 *
 * `unfiled` is the load-bearing `null`: it is a statement about what nothing has
 * claimed, NOT a project, so no `projectId` exists to derive and no node may be
 * created under it (A5's sibling half of A8's no-prefill rule). Any root id
 * lacking the prefix answers the same way — total over strings, never a throw.
 */
export function projectIdOfRootId(rootId: string): string | null {
  if (!rootId.startsWith(PROJECT_ROOT_ID_PREFIX)) {
    return null;
  }
  const projectId = rootId.slice(PROJECT_ROOT_ID_PREFIX.length);
  // `project:` with nothing after it names no project. Structurally impossible
  // from `projectRootId` (a projectId is a uuid), so this is a total-function
  // guard rather than a case anybody expects to see.
  return projectId.length === 0 ? null : projectId;
}

/**
 * Everything a write affordance needs to know about the row it hangs on,
 * resolved from the served payload's own nesting.
 *
 * A node target carries its OWNING ROOT because `TreeNode` has no `projectId`
 * (`packages/core/src/projections/tree.ts`) — the root is the only place the
 * project identity lives, and creating a node under a node needs both that and
 * the parent's id.
 */
export interface NodeActionTarget {
  readonly kind: 'root' | 'node';
  readonly rootId: string;
  // The project's declared root directory; `null` for `unfiled`, which is not a
  // place on disk (core's own words) and must not pretend to be one.
  readonly rootDirectory: string | null;
  // Null on a root target.
  readonly nodeId: string | null;
  readonly nodeDirectory: string | null;
  // A node's `effectivelyClosed` (its own flag OR an ancestor's); always false
  // for a root, which has no closure of its own — roots are virtual and there is
  // no event that could close one.
  readonly effectivelyClosed: boolean;
  // What the sheet's header calls this row. The row's own served name; never
  // re-derived, never decorated.
  readonly label: string;
}

export function rootActionTarget(root: TreeRoot): NodeActionTarget {
  return {
    kind: 'root',
    rootId: root.rootId,
    rootDirectory: root.directory,
    nodeId: null,
    nodeDirectory: null,
    effectivelyClosed: false,
    label: root.name,
  };
}

export function nodeActionTarget(root: TreeRoot, node: TreeNode): NodeActionTarget {
  return {
    kind: 'node',
    rootId: root.rootId,
    rootDirectory: root.directory,
    nodeId: node.nodeId,
    nodeDirectory: node.directory,
    effectivelyClosed: node.effectivelyClosed,
    label: node.name,
  };
}

/**
 * Every container row's action target, keyed by the id `sessionTreeRows` gives
 * that row (`rootId` for roots, `nodeId` for nodes). ONE walk, so the view looks
 * a target up rather than re-walking the forest per affordance tap.
 *
 * Session rows are deliberately absent: a session leaf's write flow is ATTACH,
 * which targets a node picked from `attachTargetsOf`, not the row it started
 * from.
 */
export function sessionTreeActionTargets(tree: TreeResponse): Map<string, NodeActionTarget> {
  const targets = new Map<string, NodeActionTarget>();
  function walkNodes(root: TreeRoot, nodes: readonly TreeNode[]): void {
    for (const node of nodes) {
      targets.set(node.nodeId, nodeActionTarget(root, node));
      walkNodes(root, node.nodes);
    }
  }
  for (const root of tree.roots) {
    targets.set(root.rootId, rootActionTarget(root));
    walkNodes(root, root.nodes);
  }
  return targets;
}

// ── create node ─────────────────────────────────────────────────────────────

/**
 * The `POST /api/nodes` body. Field-for-field the route's
 * `createNodeBodySchema` (`packages/daemon/src/nodeApi.ts`) — `directory` is
 * deliberately absent this unit (the WO defers the optional directory field),
 * and the route reads an absent directory as `null`, which is the label-only
 * group the E2 vocabulary already calls ordinary.
 */
export interface CreateNodeRequest {
  readonly projectId: string;
  readonly parentNodeId: string | null;
  readonly name: string;
}

/**
 * The creation request a row implies, or `null` when the row CANNOT host one.
 *
 * ⚠ **`unfiled` RETURNS NULL AND THE AFFORDANCE MUST NOT EXIST THERE.** It is
 * not a project; no `projectId` can be derived from it; a "create node" button
 * on that row could only ever produce a request naming nothing. That is a
 * structural impossibility, which is why it lives HERE rather than in the
 * component's template logic.
 *
 * The name is passed through UNTRIMMED and unvalidated: `empty-name` is the
 * WRITER's refusal to make (`nodeWriter.ts` trims and adjudicates), and a client
 * that pre-judged it would be a second opinion about a rule the engine owns. The
 * view may disable its submit button on a blank field as kindness — that is UX,
 * not adjudication.
 */
export function createNodeRequestFor(
  target: NodeActionTarget,
  name: string,
): CreateNodeRequest | null {
  const projectId = projectIdOfRootId(target.rootId);
  if (projectId === null) {
    return null;
  }
  return {
    projectId,
    // A root target creates a TOP-LEVEL node; a node target creates a child of
    // that node. Nothing else can be a parent.
    parentNodeId: target.kind === 'node' ? target.nodeId : null,
    name,
  };
}

/**
 * Whether the create-node affordance should be DRAWN on this row: a derivable
 * project (never `unfiled`) and a container that is not effectively closed.
 *
 * The closed half is kindness, not enforcement — the daemon refuses
 * `parent-closed` on its own and that refusal renders honestly if a node closes
 * underneath the operator. Kept separate from `createNodeRequestFor`'s null so
 * the two reasons never blur: one is "this row can never host a node", the other
 * is "this row cannot host one right now".
 */
export function canCreateNodeUnder(target: NodeActionTarget): boolean {
  return projectIdOfRootId(target.rootId) !== null && !target.effectivelyClosed;
}

// ── spawn-from-node (A8, F4) ────────────────────────────────────────────────

/**
 * The cwd a spawn started from this row prefills with, or `null` for no prefill.
 *
 * A8, exactly: a node's own `directory` → else its project root's `directory` →
 * else nothing. `unfiled` is the `null` case in both shapes, and **the null must
 * stay a null**: coercing it to `''` would put an empty cwd in a text box and
 * call it a default, and E3-a's whole point is that `directory` is a spawn
 * DEFAULT rather than a containment claim — an absent default is a real answer.
 *
 * Nothing is normalised, joined or resolved here: the string is the one the
 * engine recorded, and the session host's own allow-list is where a path is
 * judged (`nodeApi.ts`'s header says so at the other end of the same wire).
 */
export function spawnPrefillFor(target: NodeActionTarget): string | null {
  if (target.kind === 'node' && target.nodeDirectory !== null) {
    return target.nodeDirectory;
  }
  return target.rootDirectory;
}

// ── attach session ──────────────────────────────────────────────────────────

export interface AttachTargetNode {
  readonly nodeId: string;
  readonly name: string;
  // Nesting level within its root (a top-level node is 0), so the picker can
  // indent exactly as the tree does. Structure the payload declares, not a
  // computed rank.
  readonly depth: number;
}

export interface AttachTargetGroup {
  readonly rootId: string;
  readonly rootName: string;
  readonly nodes: readonly AttachTargetNode[];
}

/**
 * The nodes an attach may target: effectively-OPEN nodes only, grouped by root,
 * every group and every node in SERVED order (roots as the payload ordered them,
 * nodes depth-first parent-before-child in creation order).
 *
 * ⚠ **NO SORT, EVER** — same rule `sessionTreeRows` states at length. The only
 * filtering is `effectivelyClosed`, a served field, and a root that contributes
 * no open node is omitted because a group header over nothing is chrome (U1),
 * not information.
 */
export function attachTargetsOf(tree: TreeResponse): AttachTargetGroup[] {
  const groups: AttachTargetGroup[] = [];
  for (const root of tree.roots) {
    const openNodes: AttachTargetNode[] = [];
    pushOpenNodes(openNodes, root.nodes, 0);
    if (openNodes.length > 0) {
      groups.push({ rootId: root.rootId, rootName: root.name, nodes: openNodes });
    }
  }
  return groups;
}

// Depth-first, parent before child, served order at every level.
function pushOpenNodes(
  openNodes: AttachTargetNode[],
  nodes: readonly TreeNode[],
  depth: number,
): void {
  for (const node of nodes) {
    if (!node.effectivelyClosed) {
      openNodes.push({ nodeId: node.nodeId, name: node.name, depth });
    }
    // Descend INTO a closed node anyway: `effectivelyClosed` on a child is
    // already true wherever an ancestor is closed (the daemon computed it), so
    // descending costs nothing and skipping would make this function depend on a
    // rule it does not own.
    pushOpenNodes(openNodes, node.nodes, depth + 1);
  }
}

// ── what the operator is told (A5, wired) ───────────────────────────────────

/**
 * The message for a node-write answer, or `null` when the write SUCCEEDED.
 *
 * TOTAL over the answers `postJsonApi` can produce (`{status, body}`, the
 * daemon's own verbatim), which is what makes this the single place a node write
 * turns into words:
 *
 *   • **200 / 201** → `null`. Create answers 201, close and attach answer 200
 *     (`nodeApi.ts`); both are successes and neither is special-cased anywhere
 *     else.
 *   • **409** → `nodeRefusalMessage(reason)` — the closed 11-reason engine
 *     vocabulary, rendered by the module that owns it, INCLUDING its
 *     forward-compatible passthrough for a reason this build has never heard of.
 *     A 409 whose body is not a `{reason: string}` envelope is reported as
 *     exactly that rather than dressed up.
 *   • **400** → the body was not a request the route could parse. A client bug,
 *     said plainly rather than hidden.
 *   • **500** → the daemon reported a FINDING (its projection and its log
 *     disagree). Never smoothed into "try again": it is not the operator's
 *     mistake and retrying will not help.
 *   • **0** → `postJsonApi`'s "the request never reached the daemon". Nothing
 *     was written; the wording must not imply anything was.
 */
export function nodeWriteFailureMessage(status: number, body: unknown): string | null {
  if (status === 200 || status === 201) {
    return null;
  }
  if (status === 409) {
    const reason = refusalReasonOf(body);
    return reason === null
      ? 'The daemon refused the write but named no reason.'
      : nodeRefusalMessage(reason);
  }
  if (status === 400) {
    return 'The daemon could not read that request — nothing was written.';
  }
  if (status === 500) {
    return 'The daemon reported a finding on its node store — nothing to retry; this needs a look.';
  }
  if (status === 0) {
    return 'The request never reached the daemon — nothing was written.';
  }
  return `The daemon answered ${status}, which this build does not recognize — nothing was written.`;
}

// The refusal envelope's `reason`, or null if the body is not one. Defensive by
// design: this reads an untrusted-shape JSON body, so every step is checked
// rather than asserted with a cast.
function refusalReasonOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}
