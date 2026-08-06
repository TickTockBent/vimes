import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput } from '../schemas.js';
import { nodeClosed, nodeCreated, sessionAttachedToNode, type NodeCreatedPayload } from '../events.js';
import { readAllStreamsGrouped, replayFromEmpty } from './projection.js';
import { nodesProjection, type NodesState } from './nodes.js';
import {
  ATTENTION_SEVERITY_ORDER_VERSION,
  ATTENTION_SEVERITY_RANKS,
  rollupNode,
  type AttentionSeverity,
} from './nodeRollup.js';

// ─── S9·1 — the subtree rollup (architecture.md E2-b) ────────────────────────
//
// Two pins are under test and both are failure-shaped rather than feature-shaped:
// (1) the total order is EXPLICIT and VERSIONED, so a severity added later cannot
// silently sort last; (2) the rollup counts PROCESSES, not open nodes — a rollup
// that filtered by node-open-state would turn closed-but-alive sessions into
// invisible spend, which is the going-silently-dark failure the attention system
// exists to prevent.

const PROJECT_A = 'project-aaaa-0001';
const ROOT_NODE = 'node-root-0001';
const OPEN_CHILD = 'node-open-0002';
const CLOSED_CHILD = 'node-shut-0003';
const GRANDCHILD = 'node-deep-0004';
const SIBLING_ROOT = 'node-else-0005';

function stateFromLog(batches: EventInput[][]): NodesState {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-08-05T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  for (const batch of batches) {
    store.append(batch);
  }
  return replayFromEmpty(nodesProjection, readAllStreamsGrouped(store));
}

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

// root ─┬─ OPEN_CHILD
//       └─ CLOSED_CHILD ── GRANDCHILD          (plus an unrelated SIBLING_ROOT)
// Sessions: one on the root, one under the CLOSED child, one under its child.
function forestWithAClosedBranch(): NodesState {
  return stateFromLog([
    [
      birthOf({ nodeId: ROOT_NODE, name: 'vimes' }),
      birthOf({ nodeId: OPEN_CHILD, parentNodeId: ROOT_NODE }),
      birthOf({ nodeId: CLOSED_CHILD, parentNodeId: ROOT_NODE }),
      birthOf({ nodeId: GRANDCHILD, parentNodeId: CLOSED_CHILD }),
      birthOf({ nodeId: SIBLING_ROOT, name: 'another project entirely' }),
    ],
    [
      sessionAttachedToNode({ nodeId: ROOT_NODE, appSessionId: 'session-on-root' }),
      sessionAttachedToNode({ nodeId: CLOSED_CHILD, appSessionId: 'session-under-closed' }),
      sessionAttachedToNode({ nodeId: GRANDCHILD, appSessionId: 'session-under-closed-deep' }),
      sessionAttachedToNode({ nodeId: SIBLING_ROOT, appSessionId: 'session-elsewhere' }),
    ],
    [nodeClosed({ nodeId: CLOSED_CHILD })],
  ]);
}

// A severity lookup from a plain table; a session absent from it reads
// `undefined` — the caller has no reading for it, which is not the same as idle.
function severityFrom(
  readings: Record<string, AttentionSeverity>,
): (appSessionId: string) => AttentionSeverity | undefined {
  return (appSessionId) => readings[appSessionId];
}

describe('ATTENTION_SEVERITY_RANKS — the explicit, versioned total order (E2-b pin 1)', () => {
  it('exports version 1', () => {
    expect(ATTENTION_SEVERITY_ORDER_VERSION).toBe(1);
  });

  it('pins the ordering itself, not just that one exists', () => {
    // Every reserved or future reason declares its rank AT RESERVATION; this
    // assertion is what makes an undeclared addition (or a quiet reorder) fail
    // loudly instead of misordering a rollup in production.
    const bySeverity = Object.entries(ATTENTION_SEVERITY_RANKS).sort(
      ([, leftRank], [, rightRank]) => leftRank - rightRank,
    );
    expect(bySeverity.map(([severity]) => severity)).toEqual([
      'idle',
      'working',
      'waiting_input',
      'gate_fired',
      'error',
    ]);
  });

  it('has no duplicate ranks — a total order, not a partial one', () => {
    const ranks = Object.values(ATTENTION_SEVERITY_RANKS);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('rollupNode — worst takes the MAX of the declared order', () => {
  it('error beats gate_fired beats waiting_input beats working beats idle', () => {
    const state = stateFromLog([
      [birthOf({ nodeId: ROOT_NODE })],
      [
        sessionAttachedToNode({ nodeId: ROOT_NODE, appSessionId: 'session-idle' }),
        sessionAttachedToNode({ nodeId: ROOT_NODE, appSessionId: 'session-working' }),
        sessionAttachedToNode({ nodeId: ROOT_NODE, appSessionId: 'session-waiting' }),
        sessionAttachedToNode({ nodeId: ROOT_NODE, appSessionId: 'session-gate' }),
        sessionAttachedToNode({ nodeId: ROOT_NODE, appSessionId: 'session-error' }),
      ],
    ]);
    const readings: Record<string, AttentionSeverity> = {
      'session-idle': 'idle',
      'session-working': 'working',
      'session-waiting': 'waiting_input',
      'session-gate': 'gate_fired',
      'session-error': 'error',
    };
    expect(rollupNode(state, ROOT_NODE, severityFrom(readings)).worst).toBe('error');

    // Peel the worst reading off one at a time; each step must reveal the next
    // one down, which is the ordering asserted end to end rather than at a point.
    const descending: AttentionSeverity[] = ['error', 'gate_fired', 'waiting_input', 'working', 'idle'];
    const remaining = { ...readings };
    for (const expectedWorst of descending) {
      expect(rollupNode(state, ROOT_NODE, severityFrom(remaining)).worst).toBe(expectedWorst);
      for (const [sessionId, severity] of Object.entries(remaining)) {
        if (severity === expectedWorst) {
          delete remaining[sessionId];
        }
      }
    }
  });

  it('is null when no session supplies a severity — never a fabricated idle', () => {
    const state = forestWithAClosedBranch();
    const rollup = rollupNode(state, ROOT_NODE, () => undefined);
    expect(rollup.worst).toBeNull();
    // The sessions still COUNTED: attachment is what processCount measures.
    expect(rollup.processCount).toBe(3);
  });

  it('an empty subtree rolls up to { worst: null, processCount: 0 }', () => {
    const state = forestWithAClosedBranch();
    expect(rollupNode(state, OPEN_CHILD, () => 'error')).toEqual({ worst: null, processCount: 0 });
  });

  it('an unknown node rolls up to nothing rather than throwing', () => {
    const state = forestWithAClosedBranch();
    expect(rollupNode(state, 'node-never-declared', () => 'error')).toEqual({
      worst: null,
      processCount: 0,
    });
  });
});

describe('rollupNode — PROCESSES, NOT OPEN NODES (E2-b pin 2)', () => {
  it('counts a session under a CLOSED descendant and lets it drive worst', () => {
    // ⚠ The going-silently-dark case, stated as a test: closing a node kills
    // nothing (axis 1 vs axis 2), so a session under a closed branch is still
    // burning tokens. A rollup that filtered on node-open-state would report
    // this subtree as quiet with an erroring session inside it.
    const state = forestWithAClosedBranch();
    const rollup = rollupNode(
      state,
      ROOT_NODE,
      severityFrom({ 'session-under-closed': 'error', 'session-on-root': 'idle' }),
    );
    expect(rollup.processCount).toBe(3);
    expect(rollup.worst).toBe('error');
  });

  it('counts sessions under a closed node’s CHILDREN too — closure does not seal a branch', () => {
    const state = forestWithAClosedBranch();
    const rollup = rollupNode(
      state,
      CLOSED_CHILD,
      severityFrom({ 'session-under-closed-deep': 'gate_fired' }),
    );
    expect(rollup.processCount).toBe(2);
    expect(rollup.worst).toBe('gate_fired');
  });

  it('closing MORE of the tree never changes the rollup', () => {
    // The sabotage-shaped assertion: an open forest and the same forest with
    // every node closed must roll up identically, because closure is tree-state
    // and the rollup measures processes.
    const openForest = stateFromLog([
      [
        birthOf({ nodeId: ROOT_NODE }),
        birthOf({ nodeId: OPEN_CHILD, parentNodeId: ROOT_NODE }),
        birthOf({ nodeId: GRANDCHILD, parentNodeId: OPEN_CHILD }),
      ],
      [
        sessionAttachedToNode({ nodeId: OPEN_CHILD, appSessionId: 'session-a' }),
        sessionAttachedToNode({ nodeId: GRANDCHILD, appSessionId: 'session-b' }),
      ],
    ]);
    const closedForest = stateFromLog([
      [
        birthOf({ nodeId: ROOT_NODE }),
        birthOf({ nodeId: OPEN_CHILD, parentNodeId: ROOT_NODE }),
        birthOf({ nodeId: GRANDCHILD, parentNodeId: OPEN_CHILD }),
      ],
      [
        sessionAttachedToNode({ nodeId: OPEN_CHILD, appSessionId: 'session-a' }),
        sessionAttachedToNode({ nodeId: GRANDCHILD, appSessionId: 'session-b' }),
      ],
      [
        nodeClosed({ nodeId: ROOT_NODE }),
        nodeClosed({ nodeId: OPEN_CHILD }),
        nodeClosed({ nodeId: GRANDCHILD }),
      ],
    ]);
    const readings = severityFrom({ 'session-a': 'working', 'session-b': 'error' });
    expect(rollupNode(closedForest, ROOT_NODE, readings)).toEqual(
      rollupNode(openForest, ROOT_NODE, readings),
    );
    expect(rollupNode(closedForest, ROOT_NODE, readings)).toEqual({
      worst: 'error',
      processCount: 2,
    });
  });
});

describe('rollupNode — scope and purity', () => {
  it('covers the node itself AND its descendants, and stops at the subtree edge', () => {
    const state = forestWithAClosedBranch();
    const readings = severityFrom({
      'session-on-root': 'working',
      'session-elsewhere': 'error', // a different tree entirely
    });
    // The root's own session counts (a node's rollup covers work sitting ON it).
    expect(rollupNode(state, ROOT_NODE, readings)).toEqual({ worst: 'working', processCount: 3 });
    // ...and the unrelated root's erroring session never leaks in.
    expect(rollupNode(state, SIBLING_ROOT, readings)).toEqual({ worst: 'error', processCount: 1 });
  });

  it('a severity the caller invents outside the declared order contributes nothing', () => {
    // TOTAL against a JS caller or a value read back off the wire: an undeclared
    // severity must not sort arbitrarily. It still counts as a process.
    const state = forestWithAClosedBranch();
    const rogueSeverity = (() => 'meltdown') as unknown as (
      appSessionId: string,
    ) => AttentionSeverity | undefined;
    expect(rollupNode(state, SIBLING_ROOT, rogueSeverity)).toEqual({
      worst: null,
      processCount: 1,
    });
  });

  it('does not mutate the state it reads', () => {
    const state = forestWithAClosedBranch();
    const serializedBefore = nodesProjection.serialize(state);
    Object.freeze(state);
    Object.freeze(state.nodes);
    expect(() =>
      rollupNode(state, ROOT_NODE, severityFrom({ 'session-on-root': 'error' })),
    ).not.toThrow();
    expect(nodesProjection.serialize(state)).toBe(serializedBefore);
  });
});
