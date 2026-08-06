import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord } from '../schemas.js';
import type { Projection } from './projection.js';
import {
  EVENT_TYPES,
  nodeClosedPayloadSchema,
  nodeCreatedPayloadSchema,
  sessionAttachedToNodePayloadSchema,
  type NodeProvenance,
} from '../events.js';

// ─── S9·1 — the session-tree projection (PURE, packages/core) ────────────────
//
// architecture.md E2's one new engine primitive, folded from the 'nodes' stream:
// sessions live in a FOREST rooted in D42 projects, not a flat list. Tree shape
// is ENGINE STATE and event-sourced — every client renders the same tree because
// there is one fold, here, and no client computes its own (E2, walked).
//
// STREAM-LOCAL (D34, architecture.md): this fold consumes ONLY 'nodes' events,
// which is why `session_attached_to_node` lives on that stream and not on the
// session's own — the fact being recorded is about the NODE's membership list.
//
// ⚠ **RESERVED (rule 0.5): NOTHING EMITS THESE EVENTS YET.** The schema and the
// fold land now so the shapes are pinned and the invariants are tested; the
// daemon wiring, the engine API and the clients land with their consumers (D11).
//
// The four invariants this fold exists to hold (E2's invariant candidates):
//   1. Nodes form a FOREST — no orphans (an unknown parent is refused), no
//      cycles (nothing is ever re-parented, because there is no `node_moved`).
//   2. Provenance is WRITE-ONCE-AT-CREATION — no code path below writes it after
//      the birth record, and that structural absence IS the enforcement.
//   3. Every session has exactly ONE parent node — a cross-node re-attach is
//      refused, because re-homing a session is `node_moved`-adjacent.
//   4. The three axes are independent — closing a node touches tree state and
//      nothing else. See `node_closed` below.

export interface NodeRecord {
  nodeId: string;
  parentNodeId: string | null;
  projectId: string;
  name: string;
  provenance: NodeProvenance | null; // write-once: fold NEVER updates it
  directory: string | null;
  closed: boolean;
  sessionIds: readonly string[]; // attachment order preserved
}

export interface NodesState {
  nodes: Record<string, NodeRecord>;
}

// Immutably replace one node; a no-op when the node is unknown (log is truth,
// nothing throws — events for nodes we never saw created are ignored and never
// fabricate a record). Mirrors `withProject` in projections/projects.ts.
function withNode(
  state: NodesState,
  nodeId: string,
  update: (node: NodeRecord) => NodeRecord,
): NodesState {
  const existingNode = state.nodes[nodeId];
  if (existingNode === undefined) {
    return state;
  }
  return {
    nodes: { ...state.nodes, [nodeId]: update(existingNode) },
  };
}

export const nodesProjection: Projection<NodesState> = {
  id: 'nodes',

  // TOTAL: unknown event types are no-ops; events for unknown nodes are no-ops;
  // a malformed payload is a no-op. Nothing throws (I8's spirit — hostile input
  // must not crash a fold). PURE: `state` is never mutated, because snapshots
  // share references with live state and boot replays a snapshot forward.
  init(): NodesState {
    return { nodes: {} };
  },

  apply(state: NodesState, event: EventRecord): NodesState {
    switch (event.type) {
      case EVENT_TYPES.nodeCreated: {
        const parsed = nodeCreatedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        if (state.nodes[payload.nodeId] !== undefined) {
          // Duplicate creation is a no-op — never clobber an existing record
          // (projections/projects.ts precedent). It is also half of what makes
          // provenance WRITE-ONCE structural rather than merely documented: a
          // second birth record carrying DIFFERENT provenance changes nothing,
          // so there is no path — replay, re-delivery or malice — by which a
          // node's checkout claim can be rewritten after the fact.
          return state;
        }
        // ⚠ **THE FOREST INVARIANT, ENFORCED HERE OR NOWHERE.** A creation whose
        // parent we have never seen is DROPPED rather than recorded: honouring
        // it would either fabricate the missing parent or leave a node dangling
        // outside every tree, and an orphan is exactly the state that makes
        // "walk to the root" and "roll up the subtree" stop terminating. Log is
        // truth, so nothing throws — the record is simply not written.
        //
        // Only `null` (a project root) is a legal unknown parent.
        if (payload.parentNodeId !== null && state.nodes[payload.parentNodeId] === undefined) {
          return state;
        }
        // ⚠ **CYCLES ARE IMPOSSIBLE BY CONSTRUCTION, AND THE ARGUMENT IS SHORT
        // ENOUGH TO CHECK.** A cycle needs an edge into an already-reachable
        // node. Parent edges are written exactly once, at creation, pointing at
        // a node that already existed (the check above) — so every edge points
        // strictly backwards in creation order, and nothing re-parents because
        // E2 bans `node_moved` in v1. The one case the ordering argument does
        // NOT cover is a node naming ITSELF as its parent, since it is not yet
        // in the map when the check above runs: that is refused explicitly.
        if (payload.parentNodeId === payload.nodeId) {
          return state;
        }
        const bornNode: NodeRecord = {
          nodeId: payload.nodeId,
          parentNodeId: payload.parentNodeId,
          projectId: payload.projectId,
          name: payload.name,
          // Recorded verbatim from the birth record and never touched again by
          // any case below (invariant 2). `null` stays `null` forever: E2-a's
          // "converting" a group into a checkout means creating a worktree
          // CHILD, which is a different event about a different node.
          provenance: payload.provenance,
          // E3-a: a label-only group scopes nothing (`null`); a directory-bearing
          // one supplies the SPAWN DEFAULT cwd — never containment.
          directory: payload.directory,
          // A CREATED node is OPEN, and an empty node holds no sessions. Neither
          // is on the birth record: they are the projection's documented starting
          // values, the same division `project_created` draws for `archived`.
          closed: false,
          sessionIds: [],
        };
        return { nodes: { ...state.nodes, [payload.nodeId]: bornNode } };
      }

      case EVENT_TYPES.nodeClosed: {
        const parsed = nodeClosedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // ⚠ **CLOSURE IS TREE-STATE, AND THIS CASE MUST STAY THIS SMALL.** E2's
        // three orthogonal axes: closing a node never kills a process (axis 2)
        // and never removes anything on disk (axis 3). So this sets ONE boolean
        // on ONE record — it does not clear `sessionIds`, does not touch
        // `provenance`, and does not cascade to children. A cascade written here
        // would be a tree-state event silently claiming subtree authority; the
        // subtree's closed-ness is a READ-TIME derivation instead
        // (`isEffectivelyClosed` below), which keeps a child's own recorded
        // closed-ness distinct from the closure it inherits.
        //
        // Unknown node → no-op (I8 totality). Idempotent: folding the same
        // closure twice writes `true` twice and leaves no accumulating trace.
        //
        // ⚠ **THERE IS NO REOPEN EVENT, DELIBERATELY.** E2's walked vocabulary
        // has three events and reopening is not among them; reserving one here
        // would be inventing vocabulary nobody settled. Reopening awaits a
        // D-record.
        return withNode(state, payload.nodeId, (node) => ({
          // I12: a NEW record by spread — the previous one is never mutated in
          // place, because snapshots share references with live state.
          ...node,
          closed: true,
        }));
      }

      case EVENT_TYPES.sessionAttachedToNode: {
        const parsed = sessionAttachedToNodePayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Unknown node → no-op: attaching to a node no `node_created` ever
        // introduced would fabricate a parent, exactly as the forest invariant
        // above refuses to.
        if (state.nodes[payload.nodeId] === undefined) {
          return state;
        }
        // ⚠ **ONE PARENT PER SESSION (invariant 3).** A session already attached
        // ANYWHERE is refused here — including a duplicate attach to the same
        // node, which is the harmless half of the same check (idempotent
        // re-delivery must not list a session twice). Re-homing a session to a
        // DIFFERENT node is `node_moved`-adjacent and is banned with it: it is
        // the same act (an edge rewritten after the fact) wearing the session's
        // name instead of the node's, and it would let attribution move out from
        // under a subtree rollup that had already counted it.
        const currentHomeNodeId = nodeIdForSession(state, payload.appSessionId);
        if (currentHomeNodeId !== null) {
          return state;
        }
        return withNode(state, payload.nodeId, (node) => ({
          ...node,
          // Attachment ORDER is preserved — appended, never sorted — so the
          // recorded sequence of who joined a node survives the fold.
          sessionIds: [...node.sessionIds, payload.appSessionId],
        }));
      }

      // ── deliberately NOT folded ────────────────────────────────────────────
      //
      // Every other event type, which does not change a NodeRecord. In
      // particular `session_created` is NOT folded: this projection is
      // stream-local to 'nodes', and a session's membership is established by
      // its own explicit `session_attached_to_node` event rather than inferred
      // from a session appearing somewhere else in the log.
      default:
        return state;
    }
  },

  serialize(state: NodesState): string {
    // canonicalJson sorts keys deeply, so the `nodes` Record's INSERTION order
    // cannot leak into the bytes. Never hand-roll the ordering here.
    return canonicalJson(state);
  },
};

// ─── read-time derivations over the forest ───────────────────────────────────

// Which node currently holds this session, or null. The one-parent invariant is
// what makes "the" node a meaningful phrase: at most one record can ever list a
// given appSessionId, because the fold above refuses the second attach.
//
// A scan rather than an index: `NodesState` deliberately carries ONE map (the
// nodes), so there is no second structure that could disagree with it about
// where a session lives (principle 9 — one source of record per fact). If tree
// sizes ever make the scan matter, the answer is a derived index built from this
// map, not a second thing the fold has to keep in step.
export function nodeIdForSession(state: NodesState, appSessionId: string): string | null {
  for (const node of Object.values(state.nodes)) {
    if (node.sessionIds.includes(appSessionId)) {
      return node.nodeId;
    }
  }
  return null;
}

// ⚠ **EFFECTIVE CLOSURE IS DERIVED, NEVER RECORDED.** `node_closed` sets one
// flag on one node (see the fold); "is this node closed BECAUSE AN ANCESTOR
// was?" is answered here, at read time, by walking to the root. E2: closing a
// parent closes engine state for the subtree — but recording that as a flag on
// every descendant would destroy the distinction between a node that was closed
// and a node that merely sits under one, and would need a reopen cascade to
// undo.
//
// PURE and TOTAL: unknown node → false (there is no closure to inherit from a
// tree we have no record of). The `visitedNodeIds` guard is belt-and-braces
// against a malformed state — cycles cannot be built by the fold above — and it
// keeps this walk terminating rather than hanging if a future vocabulary ever
// makes an edge writable twice.
export function isEffectivelyClosed(state: NodesState, nodeId: string): boolean {
  const visitedNodeIds = new Set<string>();
  let currentNodeId: string | null = nodeId;
  while (currentNodeId !== null && !visitedNodeIds.has(currentNodeId)) {
    visitedNodeIds.add(currentNodeId);
    const currentNode: NodeRecord | undefined = state.nodes[currentNodeId];
    if (currentNode === undefined) {
      return false;
    }
    if (currentNode.closed) {
      return true;
    }
    currentNodeId = currentNode.parentNodeId;
  }
  return false;
}

// Every node in the subtree ROOTED AT `nodeId`, the root included, in a
// deterministic order (creation order of the map, depth-first from the root).
// Unknown node → empty list. Shared by the rollup so there is one definition of
// "the subtree" rather than two walks that could disagree about whether the root
// counts (it does).
export function subtreeNodeIds(state: NodesState, nodeId: string): string[] {
  if (state.nodes[nodeId] === undefined) {
    return [];
  }
  const collectedNodeIds: string[] = [];
  const visitedNodeIds = new Set<string>();
  const pendingNodeIds: string[] = [nodeId];
  while (pendingNodeIds.length > 0) {
    const currentNodeId = pendingNodeIds.shift()!;
    if (visitedNodeIds.has(currentNodeId)) {
      continue;
    }
    visitedNodeIds.add(currentNodeId);
    collectedNodeIds.push(currentNodeId);
    for (const candidateNode of Object.values(state.nodes)) {
      if (candidateNode.parentNodeId === currentNodeId) {
        pendingNodeIds.push(candidateNode.nodeId);
      }
    }
  }
  return collectedNodeIds;
}
