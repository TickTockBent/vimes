import { describe, expect, it } from 'vitest';
import type { PricedRow, PriceStatus } from './priceUsageRow.js';
import {
  buildCostTree,
  buildParentMap,
  resolveDirectoryKey,
  sessionDisplayLabel,
  findReconciliationViolations,
  assertTreeReconciles,
  OUTSIDE_ROOTS_PROJECT_KEY,
  UNKNOWN_DIRECTORY_KEY,
  ABSENT_ATTRIBUTION_KEY,
  type CostTree,
  type CostTreeInputRow,
  type AgentNode,
  type DirectoryNode,
  type RollupTotals,
} from './costTree.js';

// ── walking the directory forest in tests ─────────────────────────────────────
// Find a node anywhere in the forest by its absolute path.
function findDirectory(tree: CostTree, directoryPath: string): DirectoryNode | undefined {
  const pending: DirectoryNode[] = [...tree.directories];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.directoryPath === directoryPath) {
      return node;
    }
    pending.push(...node.children);
  }
  return undefined;
}

// Every node in the forest, pre-order.
function allDirectories(tree: CostTree): DirectoryNode[] {
  const flattened: DirectoryNode[] = [];
  const pending: DirectoryNode[] = [...tree.directories].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    flattened.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]!);
    }
  }
  return flattened;
}

// The single directory node a one-directory fixture produces, for the many older
// tests that only care about the session/agent levels below it.
function onlyLeafDirectory(tree: CostTree): DirectoryNode {
  const withSessions = allDirectories(tree).filter((node) => node.sessions.length > 0);
  expect(withSessions).toHaveLength(1);
  return withSessions[0]!;
}

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

    // The rows' cwd is `…/games/dongfu` and PROJECT_ROOTS is `…/games`, so the
    // forest is games → dongfu, and the session hangs off dongfu.
    const rootNode = tree.directories[0]!;
    expect(rootNode.directoryPath).toBe('/home/ticktockbent/projects/games');
    expect(rootNode.subtree.pricedNanoDollars).toBe(1_500);
    const directoryNode = findDirectory(tree, '/home/ticktockbent/projects/games/dongfu')!;
    expect(directoryNode.subtree.pricedNanoDollars).toBe(1_500);
    const sessionNode = directoryNode.sessions[0]!;
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

    const session = onlyLeafDirectory(tree).sessions[0]!;
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

    const session = onlyLeafDirectory(tree).sessions[0]!;
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
    const session = onlyLeafDirectory(tree).sessions[0]!;
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
    const session = onlyLeafDirectory(tree).sessions[0]!;
    expect(session.agents).toHaveLength(1);
    expect(session.agents[0]!.own.pricedNanoDollars).toBe(777);
  });
});

// ── Deliverable 2: rule 9 — outside-roots bucket retained, not dropped ────────
describe('rule 9: slugs are not projects; outside-roots is retained in its bucket', () => {
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

    const outside = tree.directories.find((node) => node.directoryPath === OUTSIDE_ROOTS_PROJECT_KEY);
    expect(outside).toBeDefined();
    expect(outside!.insideProjectRoots).toBe(false);
    expect(outside!.subtree.pricedNanoDollars).toBe(42); // retained, not dropped
    // ASSERTION 5: the outside bucket is TOP-LEVEL and childless — never folded
    // into a path chain, however tempting `/tmp/scratchpad` looks like a path.
    expect(outside!.children).toEqual([]);
    expect(outside!.depth).toBe(0);
    expect(tree.grandTotal.pricedNanoDollars).toBe(50);
  });

  it('resolveDirectoryKey: the cwd VERBATIM — no boundary is inferred (D37)', () => {
    const deepCwd = '/home/ticktockbent/projects/games/dongfu/subdir/here';
    const inside = resolveDirectoryKey(row({ projectCwd: deepCwd }), PROJECT_ROOTS);
    // The OLD behaviour truncated this to `…/games/dongfu` — the immediate child
    // of the root. D37 keeps the real directory; rolling it up under dongfu is
    // the tree's job, done with real ancestors.
    expect(inside).toEqual({ directoryPath: deepCwd, insideProjectRoots: true });

    const outside = resolveDirectoryKey(
      row({ insideProjectRoots: false, projectCwd: '/tmp/x' }),
      PROJECT_ROOTS,
    );
    expect(outside.directoryPath).toBe(OUTSIDE_ROOTS_PROJECT_KEY);
  });

  it('two subdirs of the same repo roll up into it, and keep their own nodes', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 's1', projectCwd: '/home/ticktockbent/projects/games/dongfu', priced: priced(3) }),
      row({ sessionId: 's2', projectCwd: '/home/ticktockbent/projects/games/dongfu/evaluations', priced: priced(4) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: PROJECT_ROOTS });
    assertTreeReconciles(tree);

    const dongfu = findDirectory(tree, '/home/ticktockbent/projects/games/dongfu')!;
    // s1 launched AT dongfu (its `own`); s2 launched a level below (a child node).
    expect(dongfu.sessions.map((session) => session.sessionId)).toEqual(['s1']);
    expect(dongfu.own.pricedNanoDollars).toBe(3);
    expect(dongfu.subtree.pricedNanoDollars).toBe(7);
    const evaluations = findDirectory(tree, '/home/ticktockbent/projects/games/dongfu/evaluations')!;
    expect(evaluations.sessions.map((session) => session.sessionId)).toEqual(['s2']);
    expect(evaluations.subtree.pricedNanoDollars).toBe(4);
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
    // The fixtures below all put their session on a single leaf directory, which
    // is the deepest node of the single top-level chain.
    const leafDirectory = onlyLeafDirectory(tree);
    const session = leafDirectory.sessions[0]!;
    const agent = session.agents[0]!;
    const brokenSubtree: RollupTotals = {
      ...agent.subtree,
      pricedNanoDollars: agent.subtree.pricedNanoDollars + 1, // off by one nano-dollar
    };
    const brokenAgent: AgentNode = { ...agent, subtree: brokenSubtree };
    const brokenLeaf: DirectoryNode = {
      ...leafDirectory,
      sessions: [
        { ...session, agents: [brokenAgent, ...session.agents.slice(1)] },
        ...leafDirectory.sessions.slice(1),
      ],
    };
    // Re-hang the corrupted leaf in place of the original, all the way to the top.
    const replaceInChain = (node: DirectoryNode): DirectoryNode => {
      if (node.directoryPath === brokenLeaf.directoryPath) {
        return brokenLeaf;
      }
      return { ...node, children: node.children.map(replaceInChain) };
    };
    return { ...tree, directories: tree.directories.map(replaceInChain) };
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

// ═══════════════════════════════════════════════════════════════════════════
// D37 — the DIRECTORY ROLLUP. Nothing below infers a project boundary; every
// node asserted here is a directory a row's cwd named, or an ancestor of one.
// ═══════════════════════════════════════════════════════════════════════════

// The lab's real layout: one root, `<category>/<project>` beneath it.
const LAB_ROOTS = ['/home/ticktockbent/projects'];

describe('D37 assertion 3: the REPORTED layout — nested cwds roll into one repo node', () => {
  it('sessions at vimes/ and vimes/packages/daemon roll into vimes → infrastructure → projects', () => {
    const rows: CostTreeInputRow[] = [
      row({
        sessionId: 'session-vimes-root',
        projectCwd: '/home/ticktockbent/projects/infrastructure/vimes',
        priced: priced(700),
      }),
      row({
        sessionId: 'session-vimes-daemon',
        projectCwd: '/home/ticktockbent/projects/infrastructure/vimes/packages/daemon',
        priced: priced(300),
      }),
      // A second repo under the SAME category, so `infrastructure` is a real
      // rollup of more than one thing rather than a pass-through.
      row({
        sessionId: 'session-repram',
        projectCwd: '/home/ticktockbent/projects/infrastructure/repram',
        priced: priced(11),
      }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    assertTreeReconciles(tree);

    // ONE top-level node: the configured root. It is the full rollup.
    expect(tree.directories.map((node) => node.directoryPath)).toEqual(['/home/ticktockbent/projects']);
    const projectsNode = tree.directories[0]!;
    expect(projectsNode.label).toBe('projects');
    expect(projectsNode.depth).toBe(0);
    expect(projectsNode.subtree.pricedNanoDollars).toBe(1_011);
    // No session was launched at the root itself.
    expect(projectsNode.own.pricedNanoDollars).toBe(0);

    const infrastructure = findDirectory(tree, '/home/ticktockbent/projects/infrastructure')!;
    expect(infrastructure.label).toBe('infrastructure');
    expect(infrastructure.depth).toBe(1);
    expect(infrastructure.subtree.pricedNanoDollars).toBe(1_011);
    expect(projectsNode.children.map((child) => child.directoryPath)).toEqual([
      '/home/ticktockbent/projects/infrastructure',
    ]);

    // The repo node the OLD grouping could not produce.
    const vimes = findDirectory(tree, '/home/ticktockbent/projects/infrastructure/vimes')!;
    expect(vimes.label).toBe('vimes');
    expect(vimes.subtree.pricedNanoDollars).toBe(1_000);
    // The session launched AT vimes is its `own`; the daemon session rolls in
    // from below through the real `packages` and `packages/daemon` directories.
    expect(vimes.own.pricedNanoDollars).toBe(700);
    expect(vimes.sessions.map((session) => session.sessionId)).toEqual(['session-vimes-root']);
    const packages = findDirectory(tree, '/home/ticktockbent/projects/infrastructure/vimes/packages')!;
    expect(packages.sessions).toEqual([]); // an ancestor of a real cwd, no spend of its own
    expect(packages.subtree.pricedNanoDollars).toBe(300);
    const daemon = findDirectory(tree, '/home/ticktockbent/projects/infrastructure/vimes/packages/daemon')!;
    expect(daemon.sessions.map((session) => session.sessionId)).toEqual(['session-vimes-daemon']);
    expect(daemon.subtree.pricedNanoDollars).toBe(300);

    // …and the sibling repo is its OWN line, not summed into vimes.
    const repram = findDirectory(tree, '/home/ticktockbent/projects/infrastructure/repram')!;
    expect(repram.subtree.pricedNanoDollars).toBe(11);
  });

  it('assertion 1: subtree === own + Σ(children.subtree) EXACTLY, at every node of a ≥3-level tree', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 's-a', projectCwd: '/home/ticktockbent/projects/infrastructure/vimes', priced: priced(700) }),
      row({
        sessionId: 's-b',
        projectCwd: '/home/ticktockbent/projects/infrastructure/vimes/packages/daemon',
        priced: priced(300),
        tokens: { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7, cacheCreation5mInputTokens: 8, cacheCreation1hInputTokens: 9 },
      }),
      row({ sessionId: 's-c', projectCwd: '/home/ticktockbent/projects/games/dongfu', priced: priced(13) }),
      row({ sessionId: 's-d', projectCwd: '/home/ticktockbent/projects/games/dongfu', agentId: 'sub', priced: nonPriced('unpriced') }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });

    // The independent verifier agrees at every node, on every additive field.
    expect(findReconciliationViolations(tree)).toEqual([]);

    // And check the identity by hand too, so this does not merely re-run the
    // builder's own construction through its own verifier.
    const nodes = allDirectories(tree);
    expect(nodes.length).toBeGreaterThanOrEqual(6); // projects → infrastructure → vimes → packages → daemon, plus games → dongfu
    for (const node of nodes) {
      const ownFromSessions = node.sessions.reduce(
        (sum, session) => sum + session.subtree.pricedNanoDollars,
        0,
      );
      expect(node.own.pricedNanoDollars).toBe(ownFromSessions);
      const subtreeFromParts =
        node.own.pricedNanoDollars +
        node.children.reduce((sum, child) => sum + child.subtree.pricedNanoDollars, 0);
      expect(node.subtree.pricedNanoDollars).toBe(subtreeFromParts);
      // Un-knowns roll up by the same identity — a status count must not leak.
      const unpricedFromParts =
        node.sessions.reduce((sum, session) => sum + session.subtree.statusCounts.unpriced, 0) +
        node.children.reduce((sum, child) => sum + child.subtree.statusCounts.unpriced, 0);
      expect(node.subtree.statusCounts.unpriced).toBe(unpricedFromParts);
    }
  });
});

describe('D37 assertion 2: the GRAND TOTAL does not move — same rows, same money, different buckets', () => {
  // The pinned figure. These six rows total 1,000 + 300 + 700 + 42 + 8 + 9 =
  // 2,059 nano-dollars whatever the grouping is; the point of D37 is that only
  // the BUCKETS changed. A moved total here is a BUG, never a refresh.
  const REGROUPED_ROWS: CostTreeInputRow[] = [
    row({ sessionId: 'g1', projectCwd: '/home/ticktockbent/projects/infrastructure/vimes', priced: priced(1_000) }),
    row({ sessionId: 'g2', projectCwd: '/home/ticktockbent/projects/infrastructure/vimes/packages/daemon', priced: priced(300) }),
    row({ sessionId: 'g3', projectCwd: '/home/ticktockbent/projects/infrastructure/repram', priced: priced(700) }),
    row({ sessionId: 'g4', projectCwd: '/home/ticktockbent/projects/games/dongfu', priced: priced(42) }),
    row({ sessionId: 'g5', projectCwd: '/home/ticktockbent/projects', priced: priced(8) }),
    row({ sessionId: 'g6', insideProjectRoots: false, projectCwd: '/tmp/scratch', priced: priced(9) }),
  ];
  const EXPECTED_GRAND_NANO = 2_059;

  it('the grand total equals the pinned figure AND the raw row sum', () => {
    const tree = buildCostTree(REGROUPED_ROWS, { projectRoots: LAB_ROOTS });
    assertTreeReconciles(tree);
    expect(tree.grandTotal.pricedNanoDollars).toBe(EXPECTED_GRAND_NANO);

    const rawRowSum = REGROUPED_ROWS.reduce(
      (sum, inputRow) => sum + (inputRow.priced.amountNanoDollars ?? 0),
      0,
    );
    expect(tree.grandTotal.pricedNanoDollars).toBe(rawRowSum);
    expect(tree.grandTotal.rowCount).toBe(REGROUPED_ROWS.length);
  });

  it('the SAME rows regroup identically under a coarser root — buckets move, money does not', () => {
    // With no roots configured at all, every cwd becomes its own top-level node:
    // the most different bucketing this module can produce. The total must not care.
    const treeWithRoots = buildCostTree(REGROUPED_ROWS, { projectRoots: LAB_ROOTS });
    const treeWithoutRoots = buildCostTree(REGROUPED_ROWS, { projectRoots: [] });
    assertTreeReconciles(treeWithoutRoots);

    expect(treeWithoutRoots.directories.length).toBeGreaterThan(treeWithRoots.directories.length);
    expect(treeWithoutRoots.grandTotal).toEqual(treeWithRoots.grandTotal);
    expect(treeWithoutRoots.grandTotal.pricedNanoDollars).toBe(EXPECTED_GRAND_NANO);
    // The attribution groupings are a second, independent path to the same money.
    const skillTotal = treeWithRoots.byAttributionSkill.reduce(
      (sum, group) => sum + group.totals.pricedNanoDollars,
      0,
    );
    expect(skillTotal).toBe(EXPECTED_GRAND_NANO);
  });
});

describe('D37 assertion 4: a FLAT layout still produces a sensible tree', () => {
  it('projects/<repo> with no category level gives root → repo, one node per repo', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'f1', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(5) }),
      row({ sessionId: 'f2', projectCwd: '/home/ticktockbent/projects/beta', priced: priced(6) }),
      row({ sessionId: 'f3', projectCwd: '/home/ticktockbent/projects/beta', priced: priced(7) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    assertTreeReconciles(tree);

    const projectsNode = tree.directories[0]!;
    expect(projectsNode.directoryPath).toBe('/home/ticktockbent/projects');
    expect(projectsNode.children.map((child) => child.label)).toEqual(['alpha', 'beta']);
    expect(projectsNode.subtree.pricedNanoDollars).toBe(18);
    const beta = findDirectory(tree, '/home/ticktockbent/projects/beta')!;
    expect(beta.sessions).toHaveLength(2);
    expect(beta.own.pricedNanoDollars).toBe(13);
    expect(beta.children).toEqual([]);
    // No repo grew a phantom child level from the flat layout.
    expect(allDirectories(tree)).toHaveLength(3);
  });

  it('a session launched AT the root itself hangs off the root node, not a child', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'at-root', projectCwd: '/home/ticktockbent/projects', priced: priced(4) }),
      row({ sessionId: 'below', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(6) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    assertTreeReconciles(tree);
    const projectsNode = tree.directories[0]!;
    expect(projectsNode.sessions.map((session) => session.sessionId)).toEqual(['at-root']);
    expect(projectsNode.own.pricedNanoDollars).toBe(4);
    expect(projectsNode.subtree.pricedNanoDollars).toBe(10);
    // …and it is still the single top-level node, not duplicated by the deeper chain.
    expect(tree.directories).toHaveLength(1);
  });
});

describe('D37 assertion 6: hostile and degenerate paths never throw and never escape', () => {
  // Each case is asserted for BOTH properties: the build survives, and every
  // priced nano-dollar is still inside the forest.
  function expectMoneyStaysInTheTree(tree: CostTree, expectedNano: number): void {
    expect(() => assertTreeReconciles(tree)).not.toThrow();
    expect(tree.grandTotal.pricedNanoDollars).toBe(expectedNano);
    const topLevelSum = tree.directories.reduce((sum, node) => sum + node.subtree.pricedNanoDollars, 0);
    expect(topLevelSum).toBe(expectedNano);
    for (const node of allDirectories(tree)) {
      expect(node.label.length).toBeGreaterThan(0); // never a blank directory label
    }
  }

  it('an EMPTY cwd lands in the unknown-directory bucket, never a blank node', () => {
    const rows: CostTreeInputRow[] = [row({ sessionId: 'blank', projectCwd: '', priced: priced(3) })];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    expectMoneyStaysInTheTree(tree, 3);
    expect(tree.directories.map((node) => node.directoryPath)).toEqual([UNKNOWN_DIRECTORY_KEY]);
    expect(tree.directories[0]!.children).toEqual([]);
  });

  it('a null cwd keeps its existing home in the OUTSIDE bucket (unchanged)', () => {
    const rows: CostTreeInputRow[] = [row({ sessionId: 'nocwd', projectCwd: null, priced: priced(3) })];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    expectMoneyStaysInTheTree(tree, 3);
    expect(tree.directories[0]!.directoryPath).toBe(OUTSIDE_ROOTS_PROJECT_KEY);
    expect(tree.directories[0]!.insideProjectRoots).toBe(false);
  });

  it('the filesystem ROOT as both cwd and configured root is a single node labelled /', () => {
    const rows: CostTreeInputRow[] = [row({ sessionId: 'slash', projectCwd: '/', priced: priced(2) })];
    const tree = buildCostTree(rows, { projectRoots: ['/'] });
    expectMoneyStaysInTheTree(tree, 2);
    expect(tree.directories.map((node) => node.directoryPath)).toEqual(['/']);
    expect(tree.directories[0]!.label).toBe('/');
  });

  it('trailing and duplicated separators are the SAME directory, not two nodes', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 't1', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(1) }),
      row({ sessionId: 't2', projectCwd: '/home/ticktockbent/projects/alpha/', priced: priced(2) }),
      row({ sessionId: 't3', projectCwd: '/home/ticktockbent//projects///alpha//', priced: priced(4) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: ['/home/ticktockbent/projects/'] });
    expectMoneyStaysInTheTree(tree, 7);
    const alpha = findDirectory(tree, '/home/ticktockbent/projects/alpha')!;
    expect(alpha.sessions).toHaveLength(3);
    expect(alpha.own.pricedNanoDollars).toBe(7);
  });

  it('a cwd that IS the configured root exactly needs no segment below it', () => {
    const rows: CostTreeInputRow[] = [row({ sessionId: 'exact', projectCwd: '/home/ticktockbent/projects', priced: priced(5) })];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    expectMoneyStaysInTheTree(tree, 5);
    expect(allDirectories(tree)).toHaveLength(1);
    expect(tree.directories[0]!.own.pricedNanoDollars).toBe(5);
  });

  it('unicode path segments survive verbatim — no normalization of meaning', () => {
    const unicodeCwd = '/home/ticktockbent/projects/研究/prójekt-Ω';
    const rows: CostTreeInputRow[] = [row({ sessionId: 'uni', projectCwd: unicodeCwd, priced: priced(9) })];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    expectMoneyStaysInTheTree(tree, 9);
    const node = findDirectory(tree, unicodeCwd)!;
    expect(node.label).toBe('prójekt-Ω');
    expect(node.sessions[0]!.label).toBe('prójekt-Ω');
  });

  it('a VERY deep path builds and verifies without blowing the stack', () => {
    const deepCwd = '/home/ticktockbent/projects/' + Array.from({ length: 2_000 }, (_, index) => `d${index}`).join('/');
    const rows: CostTreeInputRow[] = [row({ sessionId: 'deep', projectCwd: deepCwd, priced: priced(1) })];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    expectMoneyStaysInTheTree(tree, 1);
    expect(allDirectories(tree)).toHaveLength(2_001); // the root plus one node per segment
    expect(findDirectory(tree, deepCwd)!.depth).toBe(2_000);
  });

  it('a path that merely LOOKS like the root prefix is not swallowed by it', () => {
    // `/home/ticktockbent/projects-archive` starts with the root STRING but is a
    // sibling directory, so it must be its own top-level node.
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'inside', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(1) }),
      row({ sessionId: 'sibling', projectCwd: '/home/ticktockbent/projects-archive/alpha', priced: priced(2) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    expectMoneyStaysInTheTree(tree, 3);
    expect(tree.directories.map((node) => node.directoryPath)).toEqual([
      '/home/ticktockbent/projects',
      '/home/ticktockbent/projects-archive/alpha',
    ]);
  });
});

describe('D37 assertion 8: the session identity ladder never renders blank', () => {
  it('a named session shows its NAME', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'sess-named', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(1) }),
    ];
    const tree = buildCostTree(rows, {
      projectRoots: LAB_ROOTS,
      sessionNames: { 'sess-named': 'the ledger rewrite' },
    });
    const session = findDirectory(tree, '/home/ticktockbent/projects/alpha')!.sessions[0]!;
    expect(session.name).toBe('the ledger rewrite');
    expect(session.label).toBe('the ledger rewrite');
  });

  it('an UNNAMED session shows its cwd basename', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'sess-unnamed', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(1) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS, sessionNames: { other: 'not mine' } });
    const session = findDirectory(tree, '/home/ticktockbent/projects/alpha')!.sessions[0]!;
    expect(session.name).toBeNull();
    expect(session.label).toBe('alpha');
  });

  it('a BLANK name falls through to the basename rather than rendering empty', () => {
    const rows: CostTreeInputRow[] = [
      row({ sessionId: 'sess-blank', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(1) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS, sessionNames: { 'sess-blank': '   ' } });
    expect(findDirectory(tree, '/home/ticktockbent/projects/alpha')!.sessions[0]!.label).toBe('alpha');
  });

  it('with NEITHER name nor cwd it shows a short id — and an outside session keeps its own basename', () => {
    const rows: CostTreeInputRow[] = [
      // No usable cwd at all → the last rung.
      row({ sessionId: '0123456789abcdef-long', projectCwd: '', priced: priced(1) }),
      // Bucketed outside roots, but its OWN cwd basename is still readable — the
      // bucket key would have made every outside session look identical.
      row({ sessionId: 'outside-1', insideProjectRoots: false, projectCwd: '/tmp/scratchcwd', priced: priced(2) }),
    ];
    const tree = buildCostTree(rows, { projectRoots: LAB_ROOTS });
    const unknownDirectory = tree.directories.find((node) => node.directoryPath === UNKNOWN_DIRECTORY_KEY)!;
    expect(unknownDirectory.sessions[0]!.label).toBe('01234567');
    const outside = tree.directories.find((node) => node.directoryPath === OUTSIDE_ROOTS_PROJECT_KEY)!;
    expect(outside.sessions[0]!.label).toBe('scratchcwd');
  });

  it('the ladder itself is total: no input combination yields a blank label', () => {
    expect(sessionDisplayLabel('abcdefghij', '/a/b', 'a name')).toBe('a name');
    expect(sessionDisplayLabel('abcdefghij', '/a/b', null)).toBe('b');
    expect(sessionDisplayLabel('abcdefghij', null, null)).toBe('abcdefgh');
    expect(sessionDisplayLabel('abc', null, null)).toBe('abc');
    expect(sessionDisplayLabel('', null, null).length).toBeGreaterThan(0);
    expect(sessionDisplayLabel('', '', '').length).toBeGreaterThan(0);
    // An inherited Object key must never be mistaken for a supplied name.
    const treeWithPrototypeKey = buildCostTree(
      [row({ sessionId: 'toString', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(1) })],
      { projectRoots: LAB_ROOTS, sessionNames: {} },
    );
    expect(findDirectory(treeWithPrototypeKey, '/home/ticktockbent/projects/alpha')!.sessions[0]!.label).toBe('alpha');
  });
});

describe('D37: the rollup identity is checked at DIRECTORY level too (the guard bites there)', () => {
  it('a corrupted directory subtree is reported as a directory violation', () => {
    const tree = buildCostTree(
      [
        row({ sessionId: 'c1', projectCwd: '/home/ticktockbent/projects/infrastructure/vimes', priced: priced(10) }),
        row({ sessionId: 'c2', projectCwd: '/home/ticktockbent/projects/infrastructure/repram', priced: priced(20) }),
      ],
      { projectRoots: LAB_ROOTS },
    );
    expect(findReconciliationViolations(tree)).toEqual([]);

    const infrastructure = findDirectory(tree, '/home/ticktockbent/projects/infrastructure')!;
    const brokenInfrastructure: DirectoryNode = {
      ...infrastructure,
      subtree: { ...infrastructure.subtree, pricedNanoDollars: infrastructure.subtree.pricedNanoDollars + 1 },
    };
    const brokenTree: CostTree = {
      ...tree,
      directories: [{ ...tree.directories[0]!, children: [brokenInfrastructure] }],
    };
    const violations = findReconciliationViolations(brokenTree);
    const directoryViolation = violations.find(
      (violation) =>
        violation.nodeKind === 'directory' &&
        violation.field === 'pricedNanoDollars' &&
        violation.nodeId === '/home/ticktockbent/projects/infrastructure',
    );
    expect(directoryViolation).toBeDefined();
    expect(directoryViolation!.delta).toBe(1);
    // The inflated child also breaks its PARENT's identity — a corrupted node is
    // caught at every level it lies to, not just its own.
    const parentViolation = violations.find(
      (violation) => violation.nodeKind === 'directory' && violation.nodeId === '/home/ticktockbent/projects',
    );
    expect(parentViolation).toBeDefined();
    expect(() => assertTreeReconciles(brokenTree)).toThrow(/reconciliation FAILED/);
  });

  it("a directory's `own` that disagrees with its sessions is caught separately", () => {
    const tree = buildCostTree(
      [row({ sessionId: 'o1', projectCwd: '/home/ticktockbent/projects/alpha', priced: priced(10) })],
      { projectRoots: LAB_ROOTS },
    );
    const alpha = findDirectory(tree, '/home/ticktockbent/projects/alpha')!;
    // Move a nano-dollar into `own` AND `subtree` together, so the subtree
    // identity still holds and ONLY the own-vs-sessions identity can catch it.
    const brokenAlpha: DirectoryNode = {
      ...alpha,
      own: { ...alpha.own, pricedNanoDollars: alpha.own.pricedNanoDollars + 1 },
      subtree: { ...alpha.subtree, pricedNanoDollars: alpha.subtree.pricedNanoDollars + 1 },
    };
    const brokenTree: CostTree = {
      ...tree,
      directories: [{ ...tree.directories[0]!, children: [brokenAlpha] }],
    };
    const ownViolation = findReconciliationViolations(brokenTree).find(
      (violation) => violation.field === 'own.pricedNanoDollars',
    );
    expect(ownViolation).toBeDefined();
    expect(ownViolation!.nodeId).toBe('/home/ticktockbent/projects/alpha');
    expect(ownViolation!.delta).toBe(1);
  });
});
