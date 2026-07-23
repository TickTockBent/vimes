import { describe, expect, it } from 'vitest';
import { formatUsd, SLICE_5B_PRICE_TABLE } from './priceTable.js';
import {
  buildCostTree,
  type AgentNode,
  type CostTree,
  type CostTreeInputRow,
  type DirectoryNode,
  type RollupTotals,
} from './costTree.js';
import { priceUsageRow } from './priceUsageRow.js';
import {
  buildCostLedgerReadModel,
  COST_LEDGER_SCOPE_LABEL,
  type CostLedgerInputRow,
} from './costLedgerReadModel.js';

// ─── slice 5b step 4a — the cost-ledger read model (PURE, synthetic) ──────────
//
// These tests exercise ONLY this unit: the day-bucketed history, the scope
// label, the money-formatting alongside the nano integers, the Pillar-4
// un-known handling, and that a built model reconciles. Step 2/3 internals are
// tested in their own files and are consumed here, not re-tested.

const PROJECT_ROOTS = ['/home/ticktockbent/projects'];

// A row builder. Defaults price to a known Opus row (10 input tokens → a nonzero
// integer nano amount); overrides tailor each case.
function row(overrides: Partial<CostLedgerInputRow> = {}): CostLedgerInputRow {
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
    projectSlug: '-home-ticktockbent-projects-alpha',
    projectCwd: '/home/ticktockbent/projects/alpha',
    insideProjectRoots: true,
    attributionAgent: null,
    attributionSkill: null,
    sourceKind: 'session',
    timestamp: '2026-07-21T12:00:00.000Z',
    ...overrides,
  };
}

// The exact priced nano for one default-shaped row (1_000 input tokens on Opus:
// 15 $/MTok = 15 nano/token → 15_000 nano). Derived here from Step 2 so the test
// never hand-copies a number.
const ONE_ROW_NANO = (() => {
  const priced = priceUsageRow(
    {
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
    },
    SLICE_5B_PRICE_TABLE,
  );
  return priced.amountNanoDollars!;
})();

describe('scope label', () => {
  it('is exactly the required string and NEVER "your spend"', () => {
    const model = buildCostLedgerReadModel([row()], { projectRoots: PROJECT_ROOTS });
    expect(model.scopeLabel).toBe('VIMES-hosted work on this host');
    expect(model.scopeLabel).toBe(COST_LEDGER_SCOPE_LABEL);
    const serialized = JSON.stringify(model).toLowerCase();
    expect(serialized).not.toContain('your spend');
    expect(serialized).not.toContain('your cost');
    // C1: no percent-of-window / budget-fraction leaked into the body.
    expect(serialized).not.toContain('percentofwindow');
    expect(serialized).not.toContain('budgetremaining');
  });
});

describe('formatted USD matches the nano integers', () => {
  it('grand total carries both the exact nano and formatUsd of it', () => {
    const model = buildCostLedgerReadModel([row(), row()], { projectRoots: PROJECT_ROOTS });
    expect(model.grandTotal.priced.nanoDollars).toBe(ONE_ROW_NANO * 2);
    expect(model.grandTotal.priced.usd).toBe(formatUsd(ONE_ROW_NANO * 2));
    expect(model.priceTableDate).toBe(SLICE_5B_PRICE_TABLE.effectiveDate);
  });
});

describe('history bucketing by day', () => {
  it('two days, two projects → correct per-project and grand series', () => {
    const rows: CostLedgerInputRow[] = [
      // project alpha, day 20
      row({
        sessionId: 'session-alpha',
        projectCwd: '/home/ticktockbent/projects/alpha',
        timestamp: '2026-07-20T09:00:00.000Z',
      }),
      // project alpha, day 21 (two rows same day → summed)
      row({
        sessionId: 'session-alpha',
        projectCwd: '/home/ticktockbent/projects/alpha',
        timestamp: '2026-07-21T09:00:00.000Z',
      }),
      row({
        sessionId: 'session-alpha',
        projectCwd: '/home/ticktockbent/projects/alpha',
        timestamp: '2026-07-21T23:59:00.000Z',
      }),
      // project beta, day 21
      row({
        sessionId: 'session-beta',
        projectCwd: '/home/ticktockbent/projects/beta',
        timestamp: '2026-07-21T10:00:00.000Z',
      }),
    ];
    const model = buildCostLedgerReadModel(rows, { projectRoots: PROJECT_ROOTS });

    // Grand series: day 20 = 1 row, day 21 = 3 rows.
    expect(model.spendHistory.grand).toEqual([
      { day: '2026-07-20', priced: { nanoDollars: ONE_ROW_NANO, usd: formatUsd(ONE_ROW_NANO) } },
      {
        day: '2026-07-21',
        priced: { nanoDollars: ONE_ROW_NANO * 3, usd: formatUsd(ONE_ROW_NANO * 3) },
      },
    ]);

    const alphaKey = '/home/ticktockbent/projects/alpha';
    const betaKey = '/home/ticktockbent/projects/beta';
    const alpha = model.spendHistory.byDirectory.find((series) => series.directoryPath === alphaKey);
    const beta = model.spendHistory.byDirectory.find((series) => series.directoryPath === betaKey);

    expect(alpha?.points).toEqual([
      { day: '2026-07-20', priced: { nanoDollars: ONE_ROW_NANO, usd: formatUsd(ONE_ROW_NANO) } },
      {
        day: '2026-07-21',
        priced: { nanoDollars: ONE_ROW_NANO * 2, usd: formatUsd(ONE_ROW_NANO * 2) },
      },
    ]);
    expect(beta?.points).toEqual([
      { day: '2026-07-21', priced: { nanoDollars: ONE_ROW_NANO, usd: formatUsd(ONE_ROW_NANO) } },
    ]);

    // Each directory node's series reconciles with that node's SUBTREE total.
    const alphaDirectory = model.directories[0]!.children.find(
      (child) => child.directoryPath === alphaKey,
    );
    const alphaHistorySum = (alpha?.points ?? []).reduce(
      (sum, point) => sum + point.priced.nanoDollars,
      0,
    );
    expect(alphaHistorySum).toBe(alphaDirectory?.subtree.priced.nanoDollars);

    // D37: an INTERIOR node has a series too — the rollup of everything beneath
    // it — so the history selector can offer the same nodes the tree shows.
    const rootSeries = model.spendHistory.byDirectory.find(
      (series) => series.directoryPath === '/home/ticktockbent/projects',
    );
    expect(rootSeries).toBeDefined();
    const rootHistorySum = rootSeries!.points.reduce((sum, point) => sum + point.priced.nanoDollars, 0);
    expect(rootHistorySum).toBe(model.directories[0]!.subtree.priced.nanoDollars);
    expect(rootHistorySum).toBe(model.grandTotal.priced.nanoDollars);
  });

  it('buckets by a pure string slice of the timestamp — offset-only ISO grouped by prefix', () => {
    const model = buildCostLedgerReadModel(
      [
        row({ timestamp: '2026-01-05T00:00:00.000+05:00' }),
        row({ timestamp: '2026-01-05T23:00:00.000Z' }),
      ],
      { projectRoots: PROJECT_ROOTS },
    );
    // Both share the '2026-01-05' prefix — one bucket, no Date normalization.
    expect(model.spendHistory.grand.map((point) => point.day)).toEqual(['2026-01-05']);
  });
});

describe('Pillar 4 — a non-priced row never reads as $0', () => {
  it('unknown-model / synthetic / flagged rows do not inflate dollars but appear in status counts', () => {
    const rows: CostLedgerInputRow[] = [
      row(), // priced
      row({ model: 'some-unknown-model' }), // unpriced
      row({ model: '<synthetic>' }), // unpriceable
      row({ model: 'claude-opus-4-8', speed: 'fast' }), // flagged (out-of-set modifier)
    ];
    const model = buildCostLedgerReadModel(rows, { projectRoots: PROJECT_ROOTS });

    // Dollars = exactly the ONE priced row; the three un-knowns add nothing.
    expect(model.grandTotal.priced.nanoDollars).toBe(ONE_ROW_NANO);
    // But every un-known is counted — not one of them vanished into $0.
    expect(model.grandTotal.statusCounts).toEqual({
      priced: 1,
      unpriced: 1,
      unpriceable: 1,
      flagged: 1,
    });
    expect(model.grandTotal.rowCount).toBe(4);
    // The un-known token volume is carried too (each row's 1_000 input tokens).
    expect(model.grandTotal.tokensByStatus.unpriced).toBe(1_000);
    expect(model.grandTotal.tokensByStatus.flagged).toBe(1_000);

    // The history carries ONLY the priced dollars — the un-knowns are not $0 points.
    const grandHistorySum = model.spendHistory.grand.reduce(
      (sum, point) => sum + point.priced.nanoDollars,
      0,
    );
    expect(grandHistorySum).toBe(ONE_ROW_NANO);
  });
});

describe('the built model reconciles', () => {
  it('grand total equals the sum of every TOP-LEVEL directory subtree', () => {
    const rows: CostLedgerInputRow[] = [
      row({ sessionId: 'session-alpha', projectCwd: '/home/ticktockbent/projects/alpha' }),
      row({ sessionId: 'session-beta', projectCwd: '/home/ticktockbent/projects/beta' }),
      row({ sessionId: 'session-beta', projectCwd: '/home/ticktockbent/projects/beta', agentId: 'agentX' }),
    ];
    const model = buildCostLedgerReadModel(rows, { projectRoots: PROJECT_ROOTS });
    const topLevelSum = model.directories.reduce(
      (sum, directory) => sum + directory.subtree.priced.nanoDollars,
      0,
    );
    expect(topLevelSum).toBe(model.grandTotal.priced.nanoDollars);
    expect(model.grandTotal.priced.nanoDollars).toBe(ONE_ROW_NANO * 3);
  });

  it('empty input → an empty, servable envelope (no throw)', () => {
    const model = buildCostLedgerReadModel([], { projectRoots: PROJECT_ROOTS });
    expect(model.directories).toEqual([]);
    expect(model.spendHistory.grand).toEqual([]);
    expect(model.spendHistory.byDirectory).toEqual([]);
    expect(model.grandTotal.priced.nanoDollars).toBe(0);
    expect(model.grandTotal.priced.usd).toBe(formatUsd(0));
    expect(model.scopeLabel).toBe(COST_LEDGER_SCOPE_LABEL);
  });

  it('propagates the reconciliation finding rather than serving a wrong number', () => {
    // buildCostTree reconciles by construction — no INPUT can make the
    // builder's own tree fail to reconcile. So this exercises the seam: inject
    // a buildTree that builds a real tree and then hand-corrupts one agent's
    // subtree by one nano-dollar (the same corruption costTree.test.ts's
    // sabotage case uses) and asserts that buildCostLedgerReadModel itself
    // throws — proving the BUILDER runs assertTreeReconciles(tree), not merely
    // that the guard exists and works when called directly.
    const rows: CostLedgerInputRow[] = [row({ agentId: 'agent-x' })];

    const corruptingBuildTree = (
      treeRows: readonly CostTreeInputRow[],
      opts: { projectRoots: readonly string[] },
    ): CostTree => {
      const goodTree = buildCostTree(treeRows, opts);
      // The one leaf directory this single-cwd fixture produces.
      const findLeaf = (node: DirectoryNode): DirectoryNode =>
        node.sessions.length > 0 ? node : findLeaf(node.children[0]!);
      const goodLeaf = findLeaf(goodTree.directories[0]!);
      const goodSession = goodLeaf.sessions[0]!;
      const goodAgent = goodSession.agents[0]!;
      const corruptedSubtree: RollupTotals = {
        ...goodAgent.subtree,
        pricedNanoDollars: goodAgent.subtree.pricedNanoDollars + 1, // one nano-dollar off
      };
      const corruptedAgent: AgentNode = { ...goodAgent, subtree: corruptedSubtree };
      const corruptedLeaf: DirectoryNode = {
        ...goodLeaf,
        sessions: [
          { ...goodSession, agents: [corruptedAgent, ...goodSession.agents.slice(1)] },
          ...goodLeaf.sessions.slice(1),
        ],
      };
      const rehang = (node: DirectoryNode): DirectoryNode =>
        node.directoryPath === corruptedLeaf.directoryPath
          ? corruptedLeaf
          : { ...node, children: node.children.map(rehang) };
      return { ...goodTree, directories: goodTree.directories.map(rehang) };
    };

    expect(() =>
      buildCostLedgerReadModel(rows, { projectRoots: PROJECT_ROOTS, buildTree: corruptingBuildTree }),
    ).toThrow(/reconciliation FAILED/);
  });
});

// ─── D37 on the WIRE: the directory rollup and its history ───────────────────
describe('D37 — the servable body carries the directory tree and a series per node', () => {
  const NESTED_ROWS: CostLedgerInputRow[] = [
    row({
      sessionId: 'wire-vimes',
      projectCwd: '/home/ticktockbent/projects/infrastructure/vimes',
      timestamp: '2026-07-20T10:00:00.000Z',
    }),
    row({
      sessionId: 'wire-daemon',
      projectCwd: '/home/ticktockbent/projects/infrastructure/vimes/packages/daemon',
      timestamp: '2026-07-21T10:00:00.000Z',
    }),
    row({
      sessionId: 'wire-dongfu',
      projectCwd: '/home/ticktockbent/projects/games/dongfu',
      timestamp: '2026-07-21T10:00:00.000Z',
    }),
  ];

  function allDirectoryPaths(model: { directories: readonly { directoryPath: string; children: readonly unknown[] }[] }): string[] {
    const paths: string[] = [];
    const pending = [...(model.directories as readonly { directoryPath: string; children: readonly unknown[] }[])];
    while (pending.length > 0) {
      const node = pending.pop()!;
      paths.push(node.directoryPath);
      pending.push(...(node.children as readonly { directoryPath: string; children: readonly unknown[] }[]));
    }
    return paths.sort();
  }

  it('EVERY directory node has a history series, and each sums to that node subtree', () => {
    const model = buildCostLedgerReadModel(NESTED_ROWS, { projectRoots: PROJECT_ROOTS });
    const seriesByPath = new Map(
      model.spendHistory.byDirectory.map((series) => [series.directoryPath, series]),
    );

    // The selector is driven by the tree, so every tree node must have a series
    // — otherwise selecting an interior node charts nothing (seriesForSelection
    // correctly refuses to fall back to grand).
    const pending = [...model.directories];
    let checked = 0;
    while (pending.length > 0) {
      const node = pending.pop()!;
      pending.push(...node.children);
      checked += 1;
      const series = seriesByPath.get(node.directoryPath);
      expect(series, `no series for ${node.directoryPath}`).toBeDefined();
      const seriesSum = series!.points.reduce((sum, point) => sum + point.priced.nanoDollars, 0);
      expect(seriesSum).toBe(node.subtree.priced.nanoDollars);
    }
    expect(checked).toBeGreaterThanOrEqual(6);
    // The grand series still totals the grand total — regrouping moved buckets,
    // not money.
    const grandSum = model.spendHistory.grand.reduce((sum, point) => sum + point.priced.nanoDollars, 0);
    expect(grandSum).toBe(model.grandTotal.priced.nanoDollars);
    expect(model.grandTotal.priced.nanoDollars).toBe(ONE_ROW_NANO * 3);
  });

  it('the tree nests real ancestors and never invents one above the configured root', () => {
    const model = buildCostLedgerReadModel(NESTED_ROWS, { projectRoots: PROJECT_ROOTS });
    expect(allDirectoryPaths(model)).toEqual([
      '/home/ticktockbent/projects',
      '/home/ticktockbent/projects/games',
      '/home/ticktockbent/projects/games/dongfu',
      '/home/ticktockbent/projects/infrastructure',
      '/home/ticktockbent/projects/infrastructure/vimes',
      '/home/ticktockbent/projects/infrastructure/vimes/packages',
      '/home/ticktockbent/projects/infrastructure/vimes/packages/daemon',
    ]);
    // Nothing above the root: no `/home`, no `/home/ticktockbent`, no `/`.
    expect(model.directories.map((node) => node.directoryPath)).toEqual(['/home/ticktockbent/projects']);
  });

  it('session views carry the ladder: injected names win, the rest fall back to the basename', () => {
    const model = buildCostLedgerReadModel(NESTED_ROWS, {
      projectRoots: PROJECT_ROOTS,
      sessionNames: { 'wire-daemon': 'daemon spike' },
    });
    const findSession = (sessionId: string) => {
      const pending = [...model.directories];
      while (pending.length > 0) {
        const node = pending.pop()!;
        pending.push(...node.children);
        const match = node.sessions.find((session) => session.sessionId === sessionId);
        if (match !== undefined) {
          return match;
        }
      }
      return undefined;
    };
    expect(findSession('wire-daemon')!.label).toBe('daemon spike');
    expect(findSession('wire-daemon')!.name).toBe('daemon spike');
    expect(findSession('wire-vimes')!.label).toBe('vimes');
    expect(findSession('wire-vimes')!.name).toBeNull();
    expect(findSession('wire-vimes')!.cwd).toBe('/home/ticktockbent/projects/infrastructure/vimes');
    expect(findSession('wire-vimes')!.directoryPath).toBe('/home/ticktockbent/projects/infrastructure/vimes');
  });
});
