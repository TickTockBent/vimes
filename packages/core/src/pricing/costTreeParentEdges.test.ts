import { describe, expect, it } from 'vitest';
import type { PricedRow } from './priceUsageRow.js';
import {
  buildCostTree,
  assertTreeReconciles,
  findReconciliationViolations,
  type CostTreeInputRow,
  type AgentNode,
  type ExplicitAgentParentEdge,
} from './costTree.js';
import {
  buildCostLedgerReadModel,
  type AgentView,
  type CostLedgerInputRow,
} from './costLedgerReadModel.js';

// ─── parent-edge fix, unit 1 (CORE) ───────────────────────────────────────────
//
// The pure-core seam that lets an externally-supplied edge list nest the tree.
// On the real corpus the agent→agent edge lives on `toolUseResult.agentId`, which
// appears ONLY on non-usage-bearing records — so the usage rows the tree ingests
// carry `toolUseResultAgentId: null` and `buildParentMap(rows)` recovers nothing.
// Every row here carries `toolUseResultAgentId: null` unless a case deliberately
// adds one, so any nesting observed can ONLY have come from the injected edges.

// ── row builders (same idiom as costTree.test.ts) ─────────────────────────────
function priced(amountNanoDollars: number, validated = true): PricedRow {
  return {
    status: 'priced',
    amountNanoDollars,
    priceTableDate: '2026-07-21',
    modelMatched: 'claude-opus-4-8',
    validated,
    flagReason: null,
    categories: {
      inputNanoDollars: amountNanoDollars,
      outputNanoDollars: 0,
      cacheReadNanoDollars: 0,
      cacheWrite5mNanoDollars: 0,
      cacheWrite1hNanoDollars: 0,
    },
  };
}

function row(overrides: Partial<CostTreeInputRow>): CostTreeInputRow {
  return {
    sessionId: 'session-1',
    agentId: null,
    toolUseResultAgentId: null,
    projectSlug: '-home-ticktockbent-projects-games-dongfu',
    projectCwd: '/home/ticktockbent/projects/games/dongfu',
    insideProjectRoots: true,
    attributionAgent: null,
    attributionSkill: null,
    sourceKind: 'session',
    priced: priced(1_000),
    ...overrides,
  };
}

const PROJECT_ROOTS = ['/home/ticktockbent/projects/games'];

// Find an agent node by agentId anywhere in the tree (depth-first).
function findAgentNode(tree: ReturnType<typeof buildCostTree>, agentId: string): AgentNode | undefined {
  const walk = (nodes: readonly AgentNode[]): AgentNode | undefined => {
    for (const node of nodes) {
      if (node.agentId === agentId) {
        return node;
      }
      const found = walk(node.children);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  // D37: walk the whole directory forest, not a flat project list.
  const pendingDirectories = [...tree.directories];
  while (pendingDirectories.length > 0) {
    const directoryNode = pendingDirectories.pop()!;
    pendingDirectories.push(...directoryNode.children);
    for (const session of directoryNode.sessions) {
      const found = walk(session.agents);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

// ── Assertion 1 — the load-bearing one ────────────────────────────────────────
describe('nesting from the INJECTED edge alone (real-corpus shape)', () => {
  it('nests C under P purely from the injected edge (no row carries the edge)', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: null, priced: priced(100) }), // session-root own messages
      row({ agentId: 'P', toolUseResultAgentId: null, priced: priced(200) }), // parent agent, NO row edge
      row({ agentId: 'C', toolUseResultAgentId: null, priced: priced(400) }), // child agent, NO row edge
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'C', parentAgentId: 'P' },
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });

    const parentNode = findAgentNode(tree, 'P')!;
    const childNode = findAgentNode(tree, 'C')!;
    expect(parentNode.children.map((child) => child.agentId)).toContain('C');
    expect(childNode.parentResolved).toBe(true);
    expect(childNode.parentAgentId).toBe('P');
  });
});

// ── Assertion 2 — reconciliation still holds ──────────────────────────────────
describe('reconciliation holds with injected edges', () => {
  it('assertTreeReconciles does not throw and parent.subtree = own + child.subtree', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: 'P', toolUseResultAgentId: null, priced: priced(200) }),
      row({ agentId: 'C', toolUseResultAgentId: null, priced: priced(400) }),
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'C', parentAgentId: 'P' },
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });

    expect(findReconciliationViolations(tree)).toEqual([]);
    expect(() => assertTreeReconciles(tree)).not.toThrow();

    const parentNode = findAgentNode(tree, 'P')!;
    const childNode = findAgentNode(tree, 'C')!;
    expect(parentNode.subtree.pricedNanoDollars).toBe(
      parentNode.own.pricedNanoDollars + childNode.subtree.pricedNanoDollars,
    );
    expect(parentNode.subtree.pricedNanoDollars).toBe(600);
  });
});

// ── Assertion 3 — injected edge to a non-existent parent ──────────────────────
describe('injected edge whose parent node does not exist', () => {
  it('falls back to the session root, parentResolved false, no throw', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: 'C', toolUseResultAgentId: null, priced: priced(400) }),
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'C', parentAgentId: 'GHOST' },
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });
    expect(() => assertTreeReconciles(tree)).not.toThrow();

    const childNode = findAgentNode(tree, 'C')!;
    expect(childNode.parentResolved).toBe(false);
    expect(childNode.parentAgentId).toBe(null);
    // GHOST never materialises as an agent node.
    expect(findAgentNode(tree, 'GHOST')).toBeUndefined();
  });
});

// ── Assertion 4 — cycle refusal ───────────────────────────────────────────────
describe('cycle refusal for injected edges', () => {
  it('A->B and B->A build without infinite loop, at least one falls back, reconciles', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: 'A', toolUseResultAgentId: null, priced: priced(200) }),
      row({ agentId: 'B', toolUseResultAgentId: null, priced: priced(400) }),
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'B', parentAgentId: 'A' },
      { sessionId: 'session-1', childAgentId: 'A', parentAgentId: 'B' },
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });
    expect(() => assertTreeReconciles(tree)).not.toThrow();

    const nodeA = findAgentNode(tree, 'A')!;
    const nodeB = findAgentNode(tree, 'B')!;
    // At least one of the two must have fallen back (else the tree would cycle).
    expect(nodeA.parentResolved && nodeB.parentResolved).toBe(false);
  });
});

// ── Assertion 5 — null-parent injected edge ───────────────────────────────────
describe('null-parent injected edge', () => {
  it('attaches child to session root, parentResolved false, no crash', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: 'C', toolUseResultAgentId: null, priced: priced(400) }),
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'C', parentAgentId: null },
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });
    expect(() => assertTreeReconciles(tree)).not.toThrow();

    const childNode = findAgentNode(tree, 'C')!;
    expect(childNode.parentResolved).toBe(false);
    expect(childNode.parentAgentId).toBe(null);
  });
});

// ── Assertion 6 — union agreement (no duplicate) ──────────────────────────────
describe('union agreement between a row edge and an injected edge for the same child', () => {
  it('C appears exactly once as P child, parentResolved true', () => {
    const rows: CostTreeInputRow[] = [
      // This row DOES carry the row-derived edge C->P (own agentId P spawned C).
      row({ agentId: 'P', toolUseResultAgentId: 'C', priced: priced(200) }),
      row({ agentId: 'C', toolUseResultAgentId: null, priced: priced(400) }),
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'C', parentAgentId: 'P' },
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });
    expect(() => assertTreeReconciles(tree)).not.toThrow();

    const parentNode = findAgentNode(tree, 'P')!;
    const childOccurrences = parentNode.children.filter((child) => child.agentId === 'C');
    expect(childOccurrences).toHaveLength(1);
    expect(childOccurrences[0]!.parentResolved).toBe(true);
    expect(childOccurrences[0]!.parentAgentId).toBe('P');
  });
});

// ── Assertion 7 — determinism ─────────────────────────────────────────────────
describe('determinism', () => {
  it('the same inputs build byte-identical trees', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: null, priced: priced(100) }),
      row({ agentId: 'P', toolUseResultAgentId: null, priced: priced(200) }),
      row({ agentId: 'C', toolUseResultAgentId: null, priced: priced(400) }),
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'C', parentAgentId: 'P' },
    ];
    const treeA = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });
    const treeB = buildCostTree(rows, { projectRoots: PROJECT_ROOTS, parentEdges });
    expect(JSON.stringify(treeA)).toBe(JSON.stringify(treeB));
  });
});

// ── Assertion 8 — end-to-end through the read model ───────────────────────────
describe('end-to-end through the read model', () => {
  // Row builder mirroring costLedgerReadModel.test.ts; toolUseResultAgentId null so
  // nesting can ONLY come from the injected edges.
  function ledgerRow(overrides: Partial<CostLedgerInputRow> = {}): CostLedgerInputRow {
    return {
      model: 'claude-opus-4-8',
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      speed: null,
      serviceTier: null,
      inferenceGeo: null,
      sessionId: 'session-1',
      agentId: null,
      toolUseResultAgentId: null,
      projectSlug: '-home-ticktockbent-projects-games-dongfu',
      projectCwd: '/home/ticktockbent/projects/games/dongfu',
      insideProjectRoots: true,
      attributionAgent: null,
      attributionSkill: null,
      sourceKind: 'session',
      timestamp: '2026-07-21T12:00:00.000Z',
      ...overrides,
    };
  }

  function findAgentView(views: readonly AgentView[], agentId: string): AgentView | undefined {
    for (const view of views) {
      if (view.agentId === agentId) {
        return view;
      }
      const found = findAgentView(view.children, agentId);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  it('nests the child AgentView under its parent, parentResolved true', () => {
    const inputRows: CostLedgerInputRow[] = [
      ledgerRow({ agentId: 'P', toolUseResultAgentId: null }),
      ledgerRow({ agentId: 'C', toolUseResultAgentId: null }),
    ];
    const parentEdges: ExplicitAgentParentEdge[] = [
      { sessionId: 'session-1', childAgentId: 'C', parentAgentId: 'P' },
    ];
    const model = buildCostLedgerReadModel(inputRows, {
      projectRoots: PROJECT_ROOTS,
      parentEdges,
    });

    // D37: collect the agents from every session of every directory node.
    const allAgents: AgentView[] = [];
    const pendingDirectories = [...model.directories];
    while (pendingDirectories.length > 0) {
      const directoryNode = pendingDirectories.pop()!;
      pendingDirectories.push(...directoryNode.children);
      for (const session of directoryNode.sessions) {
        allAgents.push(...session.agents);
      }
    }
    const parentView = findAgentView(allAgents, 'P')!;
    const childView = findAgentView(allAgents, 'C')!;
    expect(parentView.children.map((child) => child.agentId)).toContain('C');
    expect(childView.parentResolved).toBe(true);
    expect(childView.parentAgentId).toBe('P');
  });
});
