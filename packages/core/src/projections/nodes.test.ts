import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput, EventRecord } from '../schemas.js';
import {
  checkoutRemoved,
  nodeClosed,
  nodeCreated,
  sessionAttachedToNode,
  taskCreated,
  type NodeCreatedPayload,
} from '../events.js';
import { readAllStreamsGrouped, replayFromEmpty } from './projection.js';
import {
  isEffectivelyClosed,
  nodeIdForSession,
  nodesProjection,
  subtreeNodeIds,
  type NodesState,
} from './nodes.js';

// ─── S9·1 — the session-tree projection (architecture.md E2) ─────────────────
//
// The fold is ordinary projection work; the INVARIANTS are not. Four of these
// tests exist because E2 named a failure that follows from getting them wrong:
// an orphan makes subtree walks non-terminating, a rewritable provenance makes
// every checkout claim unfalsifiable, a re-homed session moves attribution out
// from under a rollup that already counted it, and a closure that reached across
// the axes would let tidying up kill a process.

const PROJECT_A = 'project-aaaa-0001';
const ROOT_NODE = 'node-root-0001';
const GROUP_NODE = 'node-group-0002';
const WORKTREE_NODE = 'node-work-0003';
const SESSION_A = 'app-session-0001';
const SESSION_B = 'app-session-0002';

const CHECKOUT_PROVENANCE = {
  branch: 'feature/session-tree',
  baseRef: 'main',
  resolvedCommit: '975d22f0c0ffee0000000000000000000000beef',
  path: '/home/user/projects/vimes-worktrees/session-tree',
};

const FIXTURE_EPOCH = '2026-08-05T00:00:00.000Z';
const FIXTURE_STEP_MS = 1000;

function makeStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock(FIXTURE_EPOCH, FIXTURE_STEP_MS),
    ids: new CountingIdSource(),
  });
}

// The `ts` the fixture clock stamps on the record at `recordIndex` (0-based over
// the whole log — `SteppingClock` steps PER RECORD). Spelled exactly rather than
// matched loosely: S14-F2's claim is that `createdAt` IS the birth event's `ts`,
// and `expect.any(String)` would pass for a clock read inside the fold too.
function tsAt(recordIndex: number): string {
  return new Date(Date.parse(FIXTURE_EPOCH) + recordIndex * FIXTURE_STEP_MS).toISOString();
}

// Fold a list of event batches through the projection exactly as boot would.
function stateFromLog(batches: EventInput[][]): NodesState {
  const store = makeStore();
  for (const batch of batches) {
    store.append(batch);
  }
  return replayFromEmpty(nodesProjection, readAllStreamsGrouped(store));
}

// A single recorded event, for the cases that apply one event to a hand-built
// state (purity, malformed payloads, unknown types).
function recordOf(input: EventInput): EventRecord {
  const store = makeStore();
  store.append([input]);
  return store.read(input.stream, 1)[0]!;
}

// A birth record with the boring fields filled in, so each test states only the
// fact it is actually about.
function birthOf(overrides: Partial<NodeCreatedPayload> & { nodeId: string }): EventInput {
  return nodeCreated({
    parentNodeId: null,
    projectId: PROJECT_A,
    name: overrides.nodeId,
    provenance: null,
    directory: null,
    nodeConfig: null,
    ...overrides,
  });
}

// root → group → worktree, the shape every subtree case reads against.
function declareChain(): EventInput[] {
  return [
    birthOf({ nodeId: ROOT_NODE, name: 'vimes' }),
    birthOf({ nodeId: GROUP_NODE, parentNodeId: ROOT_NODE, name: 'frontend/checkout' }),
    birthOf({
      nodeId: WORKTREE_NODE,
      parentNodeId: GROUP_NODE,
      name: 'session-tree checkout',
      provenance: CHECKOUT_PROVENANCE,
      directory: CHECKOUT_PROVENANCE.path,
    }),
  ];
}

describe('nodes projection — node_created', () => {
  it('inserts a record carrying the birth facts plus the projection-owned defaults', () => {
    const state = stateFromLog([[birthOf({ nodeId: ROOT_NODE, name: 'vimes', directory: '/p' })]]);
    expect(state.nodes[ROOT_NODE]).toEqual({
      nodeId: ROOT_NODE,
      parentNodeId: null,
      projectId: PROJECT_A,
      name: 'vimes',
      // S14-F2: the birth event's own ts, folded onto the record.
      createdAt: tsAt(0),
      provenance: null,
      directory: '/p',
      // Not on the birth record — the projection's documented starting values.
      closed: false,
      sessionIds: [],
    });
  });

  it('records a provenance-bearing node as the SAME shape (E2-a: one node kind)', () => {
    const state = stateFromLog([declareChain()]);
    expect(state.nodes[WORKTREE_NODE]!.provenance).toEqual(CHECKOUT_PROVENANCE);
    expect(state.nodes[GROUP_NODE]!.provenance).toBeNull();
  });

  it('does NOT fold nodeConfig onto the record — reserved on the event only (E3-a)', () => {
    // Rule 0.5 reserves the KEY on the payload; the record has no field it would
    // set, and inventing one here would be building half of (iii) with no
    // consumer — the `project_initialized` precedent, verbatim.
    const state = stateFromLog([[birthOf({ nodeId: ROOT_NODE })]]);
    expect('nodeConfig' in state.nodes[ROOT_NODE]!).toBe(false);
  });
});

describe('nodes projection — the FOREST invariant (no orphans, no cycles)', () => {
  it('DROPS a create whose parent is unknown — an orphan is never fabricated', () => {
    const state = stateFromLog([
      [birthOf({ nodeId: GROUP_NODE, parentNodeId: 'node-never-declared' })],
    ]);
    expect(state.nodes[GROUP_NODE]).toBeUndefined();
    expect(Object.keys(state.nodes)).toEqual([]);
  });

  it('DROPS a self-parenting create — the one cycle creation order cannot rule out', () => {
    const state = stateFromLog([[birthOf({ nodeId: ROOT_NODE, parentNodeId: ROOT_NODE })]]);
    expect(state.nodes[ROOT_NODE]).toBeUndefined();
  });

  it('accepts a null parent — that is a tree root, not a missing one', () => {
    const state = stateFromLog([[birthOf({ nodeId: ROOT_NODE, parentNodeId: null })]]);
    expect(state.nodes[ROOT_NODE]!.parentNodeId).toBeNull();
  });

  it('every recorded node reaches a root, so subtree walks terminate', () => {
    // The property the two drops above exist to preserve, asserted directly.
    const state = stateFromLog([
      declareChain(),
      [birthOf({ nodeId: 'node-orphan-0009', parentNodeId: 'node-never-declared' })],
    ]);
    for (const node of Object.values(state.nodes)) {
      let hops = 0;
      let cursor: string | null = node.nodeId;
      while (cursor !== null) {
        expect(state.nodes[cursor], `dangling parent from ${node.nodeId}`).toBeDefined();
        cursor = state.nodes[cursor]!.parentNodeId;
        hops += 1;
        expect(hops).toBeLessThanOrEqual(Object.keys(state.nodes).length);
      }
    }
  });
});

describe('nodes projection — provenance is WRITE-ONCE-AT-CREATION (E2-a)', () => {
  it('a second create for the same id with DIFFERENT provenance changes nothing', () => {
    // The structural half of the guarantee: duplicate creation is a no-op, so
    // there is no path — replay, re-delivery or a hostile writer — by which a
    // node's checkout claim can be rewritten after the fact. Deep-equal on the
    // record, because "mostly unchanged" is exactly the failure being ruled out.
    const firstState = stateFromLog([declareChain()]);
    const firstRecord = firstState.nodes[WORKTREE_NODE]!;

    const rewrittenState = stateFromLog([
      declareChain(),
      [
        birthOf({
          nodeId: WORKTREE_NODE,
          parentNodeId: ROOT_NODE,
          name: 'a different name entirely',
          provenance: { ...CHECKOUT_PROVENANCE, branch: 'main', resolvedCommit: 'deadbeef' },
          directory: '/somewhere/else',
        }),
      ],
    ]);

    expect(rewrittenState.nodes[WORKTREE_NODE]).toEqual(firstRecord);
    expect(nodesProjection.serialize(rewrittenState)).toBe(nodesProjection.serialize(firstState));
  });

  it('a provenance-NULL node never gains provenance — null stays null forever', () => {
    const state = stateFromLog([
      declareChain(),
      [birthOf({ nodeId: GROUP_NODE, parentNodeId: ROOT_NODE, provenance: CHECKOUT_PROVENANCE })],
      [nodeClosed({ nodeId: GROUP_NODE })],
      [sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A })],
    ]);
    // E2-a: "converting" a group into a checkout means creating a worktree CHILD.
    expect(state.nodes[GROUP_NODE]!.provenance).toBeNull();
    expect(state.nodes[GROUP_NODE]!.directory).toBeNull();
  });
});

describe('nodes projection — node_closed (closure is TREE-state)', () => {
  it('sets closed on THAT node only — no cascade is recorded', () => {
    const state = stateFromLog([declareChain(), [nodeClosed({ nodeId: ROOT_NODE })]]);
    expect(state.nodes[ROOT_NODE]!.closed).toBe(true);
    expect(state.nodes[GROUP_NODE]!.closed).toBe(false);
    expect(state.nodes[WORKTREE_NODE]!.closed).toBe(false);
  });

  it('derives EFFECTIVE closure down the subtree at read time', () => {
    const state = stateFromLog([declareChain(), [nodeClosed({ nodeId: GROUP_NODE })]]);
    expect(isEffectivelyClosed(state, ROOT_NODE)).toBe(false);
    expect(isEffectivelyClosed(state, GROUP_NODE)).toBe(true);
    // Inherited from the ancestor, while the descendant's OWN flag stays false —
    // the distinction a recorded cascade would have destroyed.
    expect(isEffectivelyClosed(state, WORKTREE_NODE)).toBe(true);
    expect(state.nodes[WORKTREE_NODE]!.closed).toBe(false);
  });

  it('an unknown node is not effectively closed, and closing one is a no-op', () => {
    const openState = stateFromLog([declareChain()]);
    expect(isEffectivelyClosed(openState, 'node-never-declared')).toBe(false);
    const afterUnknownClosure = stateFromLog([
      declareChain(),
      [nodeClosed({ nodeId: 'node-never-declared' })],
    ]);
    expect(nodesProjection.serialize(afterUnknownClosure)).toBe(
      nodesProjection.serialize(openState),
    );
  });

  it('closing is idempotent — the second closure leaves no accumulating trace', () => {
    const once = stateFromLog([declareChain(), [nodeClosed({ nodeId: GROUP_NODE })]]);
    const twice = stateFromLog([
      declareChain(),
      [nodeClosed({ nodeId: GROUP_NODE }), nodeClosed({ nodeId: GROUP_NODE })],
    ]);
    expect(nodesProjection.serialize(twice)).toBe(nodesProjection.serialize(once));
  });

  it('there is NO reopen — nothing in the vocabulary clears the flag', () => {
    // E2's walked vocabulary has three events; reopening awaits a D-record. The
    // assertion is that folding EVERY event kind we have over a closed node
    // leaves it closed.
    const state = stateFromLog([
      declareChain(),
      [nodeClosed({ nodeId: GROUP_NODE })],
      [
        birthOf({ nodeId: GROUP_NODE, parentNodeId: ROOT_NODE }),
        sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A }),
      ],
    ]);
    expect(state.nodes[GROUP_NODE]!.closed).toBe(true);
  });
});

describe('nodes projection — THE THREE AXES ARE INDEPENDENT (E2)', () => {
  it('closing a node leaves its sessions and its provenance untouched', () => {
    // Axis 1 is closure (tree-state), axis 2 is kill (process-state), axis 3 is
    // removal (disk-state). Core owns no process and touches no disk, so the
    // assertion available here is the one that matters for the fold: closure
    // changes EXACTLY ONE field, and every session-visible and disk-visible
    // field on the record survives it byte-identical.
    const openState = stateFromLog([
      declareChain(),
      [
        sessionAttachedToNode({ nodeId: WORKTREE_NODE, appSessionId: SESSION_A }),
        sessionAttachedToNode({ nodeId: WORKTREE_NODE, appSessionId: SESSION_B }),
      ],
    ]);
    const closedState = stateFromLog([
      declareChain(),
      [
        sessionAttachedToNode({ nodeId: WORKTREE_NODE, appSessionId: SESSION_A }),
        sessionAttachedToNode({ nodeId: WORKTREE_NODE, appSessionId: SESSION_B }),
      ],
      [nodeClosed({ nodeId: WORKTREE_NODE })],
    ]);

    const before = openState.nodes[WORKTREE_NODE]!;
    const after = closedState.nodes[WORKTREE_NODE]!;
    expect(after).toEqual({ ...before, closed: true });
    // Spelled out, because `{...before, closed: true}` passing is only
    // convincing if these are the fields anyone would ask about.
    expect(after.sessionIds).toEqual([SESSION_A, SESSION_B]);
    expect(after.provenance).toEqual(CHECKOUT_PROVENANCE);
    expect(after.directory).toBe(CHECKOUT_PROVENANCE.path);
    // And the session is still findable through the tree while its node is shut.
    expect(nodeIdForSession(closedState, SESSION_A)).toBe(WORKTREE_NODE);
  });

  it('attaching a session to a CLOSED node still records the attachment', () => {
    // A closed node is not a sealed one: closure is a tree-state statement, and
    // refusing attachments would make it quietly mean "and no more work here".
    const state = stateFromLog([
      declareChain(),
      [nodeClosed({ nodeId: WORKTREE_NODE })],
      [sessionAttachedToNode({ nodeId: WORKTREE_NODE, appSessionId: SESSION_A })],
    ]);
    expect(state.nodes[WORKTREE_NODE]!.sessionIds).toEqual([SESSION_A]);
    expect(state.nodes[WORKTREE_NODE]!.closed).toBe(true);
  });
});

describe('nodes projection — ONE PARENT PER SESSION', () => {
  it('records attachments in order', () => {
    const state = stateFromLog([
      declareChain(),
      [
        sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_B }),
        sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A }),
      ],
    ]);
    expect(state.nodes[GROUP_NODE]!.sessionIds).toEqual([SESSION_B, SESSION_A]);
  });

  it('a duplicate attach to the SAME node is a no-op — never listed twice', () => {
    const state = stateFromLog([
      declareChain(),
      [
        sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A }),
        sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A }),
      ],
    ]);
    expect(state.nodes[GROUP_NODE]!.sessionIds).toEqual([SESSION_A]);
  });

  it('a cross-node RE-ATTACH is a no-op — re-homing is node_moved-adjacent', () => {
    const state = stateFromLog([
      declareChain(),
      [sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A })],
      [sessionAttachedToNode({ nodeId: WORKTREE_NODE, appSessionId: SESSION_A })],
    ]);
    expect(state.nodes[GROUP_NODE]!.sessionIds).toEqual([SESSION_A]);
    expect(state.nodes[WORKTREE_NODE]!.sessionIds).toEqual([]);
    expect(nodeIdForSession(state, SESSION_A)).toBe(GROUP_NODE);
  });

  it('attaching to an unknown node is a no-op — no parent is fabricated', () => {
    const baseState = stateFromLog([declareChain()]);
    const state = stateFromLog([
      declareChain(),
      [sessionAttachedToNode({ nodeId: 'node-never-declared', appSessionId: SESSION_A })],
    ]);
    expect(nodesProjection.serialize(state)).toBe(nodesProjection.serialize(baseState));
    expect(nodeIdForSession(state, SESSION_A)).toBeNull();
  });
});

describe('nodes projection — checkout_removed (S17·U1, fold DEFERRED — slice-17.md §1)', () => {
  it('replays as a no-op: the fold is TOTAL, so a registered-but-unfolded kind changes nothing', () => {
    // `checkout_removed` is a real, EVENT_TYPES-registered, schema-validating
    // event (events.ts) — unlike the malformed/foreign hostile records in the
    // "totality and purity" block below, this one parses cleanly. It is still a
    // no-op here because `projections/nodes.ts` does not list a case for it
    // (deliberately — the fold lands with its first consumer, D86). That
    // deferral is exactly what this test makes assertable: the state and its
    // serialized bytes are IDENTICAL with or without the event in the log.
    const priorState = stateFromLog([declareChain()]);
    const serializedBefore = nodesProjection.serialize(priorState);

    const afterState = stateFromLog([
      declareChain(),
      [
        checkoutRemoved({
          nodeId: WORKTREE_NODE,
          path: CHECKOUT_PROVENANCE.path,
          branch: CHECKOUT_PROVENANCE.branch,
        }),
      ],
    ]);

    expect(nodesProjection.serialize(afterState)).toBe(serializedBefore);
    expect(afterState.nodes[WORKTREE_NODE]).toEqual(priorState.nodes[WORKTREE_NODE]);
  });
});

describe('nodes projection — subtreeNodeIds', () => {
  it('includes the root of the walk and every descendant', () => {
    const state = stateFromLog([declareChain()]);
    expect(subtreeNodeIds(state, ROOT_NODE).sort()).toEqual(
      [ROOT_NODE, GROUP_NODE, WORKTREE_NODE].sort(),
    );
    expect(subtreeNodeIds(state, GROUP_NODE).sort()).toEqual([GROUP_NODE, WORKTREE_NODE].sort());
    expect(subtreeNodeIds(state, WORKTREE_NODE)).toEqual([WORKTREE_NODE]);
  });

  it('an unknown node has an empty subtree', () => {
    expect(subtreeNodeIds(stateFromLog([declareChain()]), 'node-never-declared')).toEqual([]);
  });
});

describe('nodes projection — totality and purity (I8, I12, I6)', () => {
  const hostileRecords: Array<[string, EventInput]> = [
    ['a malformed node_created', { stream: 'nodes', type: 'node_created', payload: { nodeId: 5 } }],
    ['a malformed node_closed', { stream: 'nodes', type: 'node_closed', payload: {} }],
    [
      'a malformed attachment',
      { stream: 'nodes', type: 'session_attached_to_node', payload: { nodeId: ROOT_NODE } },
    ],
    [
      'a foreign event type',
      {
        stream: 'tasks',
        type: 'task_created',
        payload: {
          taskId: 'task-aaaa-0001',
          projectRoot: '/p',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
        },
      },
    ],
  ];

  for (const [label, hostileInput] of hostileRecords) {
    it(`${label} is a no-op and never throws`, () => {
      const priorState = stateFromLog([declareChain()]);
      const serializedBefore = nodesProjection.serialize(priorState);
      let nextState: NodesState = priorState;
      expect(() => {
        nextState = nodesProjection.apply(priorState, recordOf(hostileInput));
      }).not.toThrow();
      expect(nextState).toBe(priorState);
      expect(nodesProjection.serialize(priorState)).toBe(serializedBefore);
    });
  }

  it('does not mutate the state it was handed (I12)', () => {
    const priorState = stateFromLog([declareChain()]);
    const serializedBefore = nodesProjection.serialize(priorState);
    Object.freeze(priorState);
    Object.freeze(priorState.nodes);
    Object.freeze(priorState.nodes[GROUP_NODE]);
    Object.freeze(priorState.nodes[GROUP_NODE]!.sessionIds);

    const afterAttach = nodesProjection.apply(
      priorState,
      recordOf(sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A })),
    );
    const afterClosure = nodesProjection.apply(
      afterAttach,
      recordOf(nodeClosed({ nodeId: GROUP_NODE })),
    );

    expect(nodesProjection.serialize(priorState)).toBe(serializedBefore);
    expect(afterAttach).not.toBe(priorState);
    expect(afterAttach.nodes[GROUP_NODE]).not.toBe(priorState.nodes[GROUP_NODE]);
    expect(afterClosure.nodes[GROUP_NODE]!.closed).toBe(true);
    expect(priorState.nodes[GROUP_NODE]!.closed).toBe(false);
    expect(priorState.nodes[GROUP_NODE]!.sessionIds).toEqual([]);
  });

  it('I6 double-fold: a log carrying every event kind folds byte-identically twice', () => {
    const fullLog: EventInput[][] = [
      declareChain(),
      [
        birthOf({ nodeId: 'node-orphan-0009', parentNodeId: 'node-never-declared' }),
        birthOf({ nodeId: ROOT_NODE }),
      ],
      [
        sessionAttachedToNode({ nodeId: WORKTREE_NODE, appSessionId: SESSION_A }),
        sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_A }),
        sessionAttachedToNode({ nodeId: GROUP_NODE, appSessionId: SESSION_B }),
      ],
      [
        nodeClosed({ nodeId: GROUP_NODE }),
        taskCreated({
          taskId: 'task-aaaa-0001',
          projectRoot: '/p',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
        }),
      ],
    ];
    const firstFold = stateFromLog(fullLog);
    const secondFold = stateFromLog(fullLog);
    expect(nodesProjection.serialize(secondFold)).toBe(nodesProjection.serialize(firstFold));
    // Not vacuous: the twice-folded state really carries the whole lifecycle.
    expect(Object.keys(firstFold.nodes).sort()).toEqual([GROUP_NODE, ROOT_NODE, WORKTREE_NODE].sort());
    expect(firstFold.nodes[GROUP_NODE]!.closed).toBe(true);
    expect(firstFold.nodes[WORKTREE_NODE]!.sessionIds).toEqual([SESSION_A]);
    expect(firstFold.nodes[GROUP_NODE]!.sessionIds).toEqual([SESSION_B]);
  });
});
