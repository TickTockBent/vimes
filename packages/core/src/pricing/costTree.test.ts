import { describe, expect, it } from 'vitest';
import type { PricedRow, PriceStatus } from './priceUsageRow.js';
import {
  buildCostTree,
  buildParentMap,
  resolveProjectKey,
  findReconciliationViolations,
  assertTreeReconciles,
  OUTSIDE_ROOTS_PROJECT_KEY,
  ABSENT_ATTRIBUTION_KEY,
  type CostTree,
  type CostTreeInputRow,
  type AgentNode,
  type RollupTotals,
} from './costTree.js';

// ── row builders ──────────────────────────────────────────────────────────────
// A PRICED result carrying an exact integer nano-dollar amount.
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

// A NON-priced result — amount is null (an un-known, never $0).
function nonPriced(status: Exclude<PriceStatus, 'priced'>): PricedRow {
  return {
    status,
    amountNanoDollars: null,
    priceTableDate: null,
    modelMatched: null,
    validated: null,
    flagReason: status === 'flagged' ? 'unvalidated-modifier' : null,
    categories: null,
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

// ── Deliverable 3: reconciliation — the load-bearing part ─────────────────────
describe('reconciliation: subtree === own + Σ children at every node', () => {
  // project → session → agent → sub-agent, all four levels bear dollars.
  it('a 3-level tree reconciles exactly and equals the sum of all rows', () => {
    const rows: CostTreeInputRow[] = [
      // session-root own messages
      row({ agentId: null, priced: priced(100) }),
      // a top-level agent (parent = session root)
      row({ agentId: 'agentA', priced: priced(200) }),
      // a sub-agent of agentA — the edge is harvested from a row that SPAWNED it:
      // this row's own agentId (agentA) is the parent of agentB.
      row({ agentId: 'agentA', toolUseResultAgentId: 'agentB', priced: priced(0) }),
      row({ agentId: 'agentB', priced: priced(400) }),
      // a sub-sub-agent of agentB (depth 3)
      row({ agentId: 'agentB', toolUseResultAgentId: 'agentC', priced: priced(0) }),
      row({ agentId: 'agentC', priced: priced(800) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });

    expect(findReconciliationViolations(tree)).toEqual([]);
    expect(() => assertTreeReconciles(tree)).not.toThrow();
    // grand total = 100 + 200 + 0 + 400 + 0 + 800 = 1500
    expect(tree.grandTotal.pricedNanoDollars).toBe(1_500);

    const projectNode = tree.projects[0]!;
    expect(projectNode.projectKey).toBe('/home/ticktockbent/projects/games/dongfu');
    expect(projectNode.subtree.pricedNanoDollars).toBe(1_500);
    const sessionNode = projectNode.sessions[0]!;
    expect(sessionNode.own.pricedNanoDollars).toBe(100);
    expect(sessionNode.subtree.pricedNanoDollars).toBe(1_500);
  });

  it('depth-3 nesting rolls up through BOTH hops', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: 'root', toolUseResultAgentId: 'mid', priced: priced(1) }),
      row({ agentId: 'mid', toolUseResultAgentId: 'leaf', priced: priced(10) }),
      row({ agentId: 'leaf', priced: priced(100) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    assertTreeReconciles(tree);

    const session = tree.projects[0]!.sessions[0]!;
    // exactly one top-level agent: root
    expect(session.agents.map((agentNode) => agentNode.agentId)).toEqual(['root']);
    const rootNode = session.agents[0]!;
    expect(rootNode.subtree.pricedNanoDollars).toBe(111);
    const midNode = rootNode.children[0]!;
    expect(midNode.agentId).toBe('mid');
    expect(midNode.parentResolved).toBe(true);
    expect(midNode.subtree.pricedNanoDollars).toBe(110);
    const leafNode = midNode.children[0]!;
    expect(leafNode.agentId).toBe('leaf');
    expect(leafNode.subtree.pricedNanoDollars).toBe(100);
    expect(leafNode.children).toEqual([]);
  });
});

// ── Deliverable 1/2: the 54% fallback + node identity ────────────────────────
describe('the 54% fallback: no recoverable parent → session root', () => {
  it('an agent with no edge attaches to the session root and still rolls up', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: null, priced: priced(5) }),
      // orphan agent: no row anywhere carries toolUseResultAgentId === 'orphan'
      row({ agentId: 'orphan', priced: priced(50) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    assertTreeReconciles(tree);

    const session = tree.projects[0]!.sessions[0]!;
    expect(session.agents).toHaveLength(1);
    const orphanNode = session.agents[0]!;
    expect(orphanNode.agentId).toBe('orphan');
    expect(orphanNode.parentAgentId).toBeNull();
    expect(orphanNode.parentResolved).toBe(false); // the honest "unattributed" flag
    expect(session.subtree.pricedNanoDollars).toBe(55);
  });

  it('parent map: a spawn row makes its own agentId the child parent', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'sX', agentId: 'parent', toolUseResultAgentId: 'child' }),
    ];
    const parentMap = buildParentMap(rows);
    // exactly one edge, keyed by the child within its session, valued by the parent
    expect(parentMap.size).toBe(1);
    expect([...parentMap.values()]).toEqual([{ parentAgentId: 'parent' }]);
  });

  it('a session-spawned agent (spawner agentId null) attaches to session root', () => {
    const rows: CostTreeInputRow[] = [
      // the session root itself spawns 'agentX' (spawner agentId === null)
      row({ agentId: null, toolUseResultAgentId: 'agentX', priced: priced(0) }),
      row({ agentId: 'agentX', priced: priced(9) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    assertTreeReconciles(tree);
    const session = tree.projects[0]!.sessions[0]!;
    expect(session.agents[0]!.agentId).toBe('agentX');
    expect(session.agents[0]!.parentAgentId).toBeNull();
  });
});

// ── the fork double-count must NOT be re-introduced ──────────────────────────
describe('a fork-copied row is not double-counted by the tree', () => {
  it('one node, one contribution — the tree does not re-add', () => {
    // Step 1's global dedup already removed fork/prefix copies, so the SAME priced
    // row reaches the tree exactly once. Assert the tree lands it at exactly one
    // (sessionId, agentId) node and does not somehow re-aggregate it.
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'sess', agentId: 'forkAgent', priced: priced(777) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    assertTreeReconciles(tree);
    expect(tree.grandTotal.pricedNanoDollars).toBe(777);
    expect(tree.grandTotal.rowCount).toBe(1);
    const session = tree.projects[0]!.sessions[0]!;
    expect(session.agents).toHaveLength(1);
    expect(session.agents[0]!.own.pricedNanoDollars).toBe(777);
  });
});

// ── Deliverable 2: rule 7 — outside-roots bucket retained, not dropped ────────
describe('rule 7: slugs are not projects; outside-roots is retained in its bucket', () => {
  it('outside-roots rows land in the single outside bucket', () => {
    const rows: CostTreeInputRow[] = [
      row({
        sessionId: 'outside-session',
        insideProjectRoots: false,
        projectSlug: '-tmp-scratchpad',
        projectCwd: '/tmp/scratchpad',
        priced: priced(42),
      }),
      row({ sessionId: 'inside-session', priced: priced(8) }), // inside-roots session for contrast
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    assertTreeReconciles(tree);

    const outside = tree.projects.find((project) => project.projectKey === OUTSIDE_ROOTS_PROJECT_KEY);
    expect(outside).toBeDefined();
    expect(outside!.insideProjectRoots).toBe(false);
    expect(outside!.subtree.pricedNanoDollars).toBe(42); // retained, not dropped
    expect(tree.grandTotal.pricedNanoDollars).toBe(50);
  });

  it('resolveProjectKey: immediate child of the matched root, never the slug', () => {
    const inside = resolveProjectKey(
      row({ projectCwd: '/home/ticktockbent/projects/games/dongfu/subdir/here' }),
      PROJECT_ROOTS,
    );
    // subdirectories collapse to the ONE project 'dongfu', not fragmented by cwd
    expect(inside).toEqual({ projectKey: '/home/ticktockbent/projects/games/dongfu', insideProjectRoots: true });

    const outside = resolveProjectKey(
      row({ insideProjectRoots: false, projectCwd: '/tmp/x' }),
      PROJECT_ROOTS,
    );
    expect(outside.projectKey).toBe(OUTSIDE_ROOTS_PROJECT_KEY);
  });

  it('two subdirs of the same project collapse to one project node', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 's1', projectCwd: '/home/ticktockbent/projects/games/dongfu', priced: priced(3) }),
      row({ sessionId: 's2', projectCwd: '/home/ticktockbent/projects/games/dongfu/evaluations', priced: priced(4) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    const dongfuProjects = tree.projects.filter((project) =>
      project.projectKey === '/home/ticktockbent/projects/games/dongfu',
    );
    expect(dongfuProjects).toHaveLength(1);
    expect(dongfuProjects[0]!.sessions).toHaveLength(2);
    expect(dongfuProjects[0]!.subtree.pricedNanoDollars).toBe(7);
  });
});

// ── Pillar 4: non-priced never reads as $0; carried alongside ────────────────
describe('non-priced rows: excluded from dollars, carried as status counts + tokens', () => {
  const tokens = {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 1_000,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  };

  it('unpriced/unpriceable/flagged add $0 to dollars but appear in counts + tokens', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: null, priced: priced(500), tokens }),
      row({ agentId: 'a', priced: nonPriced('unpriced'), tokens }),
      row({ agentId: 'a', priced: nonPriced('unpriceable'), tokens }),
      row({ agentId: 'a', priced: nonPriced('flagged'), tokens }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    assertTreeReconciles(tree);

    // dollars: only the priced 500 — the un-knowns did NOT read as $0-in-the-total
    expect(tree.grandTotal.pricedNanoDollars).toBe(500);
    // but the un-knowns are all present, alongside, not vanished:
    expect(tree.grandTotal.statusCounts).toEqual({
      priced: 1,
      unpriced: 1,
      unpriceable: 1,
      flagged: 1,
    });
    // each un-known carries its token weight (1030 each) — quantified, not zero
    const perRowTokens = 10 + 20 + 1_000;
    expect(tree.grandTotal.tokensByStatus.unpriced).toBe(perRowTokens);
    expect(tree.grandTotal.tokensByStatus.unpriceable).toBe(perRowTokens);
    expect(tree.grandTotal.tokensByStatus.flagged).toBe(perRowTokens);
    expect(tree.grandTotal.rowCount).toBe(4);
  });

  it('unvalidated priced dollars are tracked distinctly for honest rendering', () => {
    const rows: CostTreeInputRow[] = [
      row({ priced: priced(300, true) }),
      row({ agentId: 'a', priced: priced(200, false) }), // sonnet-4-6 analogy
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    expect(tree.grandTotal.pricedNanoDollars).toBe(500);
    expect(tree.grandTotal.unvalidatedNanoDollars).toBe(200);
  });
});

// ── Deliverable 4: secondary rollups ─────────────────────────────────────────
describe('attributionSkill / attributionAgent groupings', () => {
  it('sum correctly and put an absent attribution in its own bucket', () => {
    const rows: CostTreeInputRow[] = [
      row({ attributionSkill: 'software-orchestration', attributionAgent: 'general-purpose', priced: priced(100) }),
      row({ attributionSkill: 'software-orchestration', attributionAgent: 'fork', priced: priced(50) }),
      row({ attributionSkill: null, attributionAgent: null, priced: priced(7) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });

    const skillMap = new Map(tree.byAttributionSkill.map((group) => [group.key, group.totals.pricedNanoDollars]));
    expect(skillMap.get('software-orchestration')).toBe(150);
    expect(skillMap.get(ABSENT_ATTRIBUTION_KEY)).toBe(7);

    const agentMap = new Map(tree.byAttributionAgent.map((group) => [group.key, group.totals.pricedNanoDollars]));
    expect(agentMap.get('general-purpose')).toBe(100);
    expect(agentMap.get('fork')).toBe(50);
    expect(agentMap.get(ABSENT_ATTRIBUTION_KEY)).toBe(7);

    // groupings reconcile with the grand total (each row in exactly one bucket)
    const skillTotal = tree.byAttributionSkill.reduce((sum, group) => sum + group.totals.pricedNanoDollars, 0);
    const agentTotal = tree.byAttributionAgent.reduce((sum, group) => sum + group.totals.pricedNanoDollars, 0);
    expect(skillTotal).toBe(tree.grandTotal.pricedNanoDollars);
    expect(agentTotal).toBe(tree.grandTotal.pricedNanoDollars);
  });
});

// ── Deliverable 5: the reconciliation-FAILURE fixture (the guard must bite) ────
describe('the reconciliation guard is real (budget-wall discipline)', () => {
  // Corrupt a well-built tree's node so subtree ≠ own + Σ children, and assert the
  // verifier FIRES. Proves the guard is not vacuous.
  function corruptFirstAgentSubtree(tree: CostTree): CostTree {
    const project = tree.projects[0]!;
    const session = project.sessions[0]!;
    const agent = session.agents[0]!;
    const brokenSubtree: RollupTotals = {
      ...agent.subtree,
      pricedNanoDollars: agent.subtree.pricedNanoDollars + 1, // off by one nano-dollar
    };
    const brokenAgent: AgentNode = { ...agent, subtree: brokenSubtree };
    return {
      ...tree,
      projects: [
        {
          ...project,
          sessions: [{ ...session, agents: [brokenAgent, ...session.agents.slice(1)] }, ...project.sessions.slice(1)],
        },
        ...tree.projects.slice(1),
      ],
    };
  }

  it('a deliberately inconsistent node makes findReconciliationViolations report it', () => {
    const rows: CostTreeInputRow[] = [
      row({ agentId: null, priced: priced(100) }),
      row({ agentId: 'a', priced: priced(200) }),
    ];
    const goodTree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    expect(findReconciliationViolations(goodTree)).toEqual([]);

    const brokenTree = corruptFirstAgentSubtree(goodTree);
    const violations = findReconciliationViolations(brokenTree);
    expect(violations.length).toBeGreaterThan(0);
    const agentViolation = violations.find((violation) => violation.nodeKind === 'agent');
    expect(agentViolation).toBeDefined();
    expect(agentViolation!.field).toBe('pricedNanoDollars');
    expect(agentViolation!.delta).toBe(1);
  });

  it('assertTreeReconciles THROWS on the corrupted tree (rule 0.1 finding)', () => {
    const rows: CostTreeInputRow[] = [row({ agentId: 'a', priced: priced(200) })];
    const brokenTree = corruptFirstAgentSubtree(buildCostTree(rows, { projectRoots: PROJECT_ROOTS }));
    expect(() => assertTreeReconciles(brokenTree)).toThrow(/reconciliation FAILED/);
  });
});
