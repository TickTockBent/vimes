import { describe, expect, it } from 'vitest';
import {
  attributionRows,
  defaultExpandedKeys,
  directoryRowKey,
  directorySelectOptions,
  flattenDirectoryNodes,
  formatMoney,
  formatTokenCount,
  hasUnknownTokens,
  ledgerState,
  ledgerTreeRows,
  seriesForSelection,
  sessionRowKey,
  spendAxisMax,
  spendBars,
  unknownTokenBadges,
  unvalidatedNote,
  ABSENT_ATTRIBUTION_LABEL,
  DEFAULT_EXPANDED_DIRECTORY_DEPTH,
  type AgentView,
  type AttributionView,
  type CostLedgerBody,
  type CostLedgerReadModel,
  type DirectoryView,
  type MoneyAmount,
  type PriceStatusCountsView,
  type RollupView,
  type SessionView,
  type SpendHistoryPoint,
} from './costDisplay.js';

function money(nanoDollars: number, usd: string): MoneyAmount {
  return { nanoDollars, usd };
}

function counts(overrides: Partial<PriceStatusCountsView> = {}): PriceStatusCountsView {
  return { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0, ...overrides };
}

function rollup(overrides: Partial<RollupView> = {}): RollupView {
  return {
    priced: money(0, '$0.00'),
    unvalidated: money(0, '$0.00'),
    statusCounts: counts(),
    tokensByStatus: counts(),
    rowCount: 0,
    ...overrides,
  };
}

function point(day: string, nanoDollars: number, usd: string): SpendHistoryPoint {
  return { day, priced: money(nanoDollars, usd) };
}

// ── D37 tree fixtures ────────────────────────────────────────────────────────
function agent(agentId: string, children: AgentView[] = []): AgentView {
  return {
    sessionId: 'sess',
    agentId,
    parentAgentId: null,
    parentResolved: children.length > 0,
    own: rollup(),
    subtree: rollup(),
    children,
  };
}

function session(sessionId: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId,
    directoryPath: '/p',
    cwd: '/p',
    name: null,
    label: sessionId,
    own: rollup(),
    subtree: rollup(),
    agents: [],
    ...overrides,
  };
}

function directory(overrides: Partial<DirectoryView> & { directoryPath: string }): DirectoryView {
  return {
    label: overrides.directoryPath,
    depth: 0,
    insideProjectRoots: true,
    own: rollup(),
    subtree: rollup(),
    sessions: [],
    children: [],
    ...overrides,
  };
}

describe('unknownTokenBadges', () => {
  it('returns nothing for a fully-priced node', () => {
    expect(unknownTokenBadges(rollup({ tokensByStatus: counts({ priced: 500_000 }) }))).toEqual([]);
    expect(hasUnknownTokens(rollup({ tokensByStatus: counts({ priced: 500_000 }) }))).toBe(false);
  });

  it('surfaces each non-zero un-known status as a token badge, priced excluded', () => {
    const badges = unknownTokenBadges(
      rollup({ tokensByStatus: counts({ priced: 999, unpriced: 12_300, unpriceable: 0, flagged: 4 }) }),
    );
    expect(badges.map((badge) => badge.status)).toEqual(['unpriced', 'flagged']);
    expect(badges[0]).toMatchObject({ label: 'unpriced', tokens: 12_300, tokensLabel: '12.3k' });
    expect(badges[1]).toMatchObject({ label: 'flagged', tokens: 4, tokensLabel: '4' });
  });

  it('never invents badges from a null rollup', () => {
    expect(unknownTokenBadges(null)).toEqual([]);
    expect(unknownTokenBadges(undefined)).toEqual([]);
  });
});

describe('unvalidatedNote', () => {
  it('is null when nothing was priced by analogy', () => {
    expect(unvalidatedNote(rollup())).toBeNull();
  });

  it('renders the 2-dp (formatMoney) form, not the wire\'s 6-dp usd string', () => {
    // D38 assertion 7: even though the wire's own `usd` string carries 6 dp
    // (never actually 2 dp in real data), the note must emit the display form.
    expect(unvalidatedNote(rollup({ unvalidated: money(1_230_000_000, '$1.230000') }))).toBe(
      'incl. $1.23 unvalidated',
    );
  });
});

describe('spendBars', () => {
  it('is empty for no points', () => {
    expect(spendBars([])).toEqual([]);
    expect(spendBars(null)).toEqual([]);
  });

  it('normalizes heights to the tallest day and keeps a real small day visible', () => {
    const bars = spendBars([
      point('2026-07-19', 10_000_000, '$0.01'), // 1 cent — the wire's own (ignored) label agrees
      point('2026-07-20', 100_000_000, '$0.10'), // 10 cents, tallest (10x day 1)
      point('2026-07-21', 500, '$0.00'), // a genuine sub-cent day, not a zero day
    ]);
    expect(bars[1]!.heightPercent).toBe(100); // tallest
    expect(bars[0]!.heightPercent).toBe(10);
    // A real but tiny day is floored to a visible minimum, never 0.
    expect(bars[2]!.heightPercent).toBeGreaterThan(0);
    // D38: `.usd` is `formatMoney`'d from `nanoDollars`, NOT the wire's `usd`
    // string passed through — day 3's true sub-cent spend renders `<$0.01`,
    // never the fabricated `$0.00` a verbatim pass-through would have shown.
    expect(bars.map((bar) => bar.usd)).toEqual(['$0.01', '$0.10', '<$0.01']);
  });

  it('keeps every bar flat at 0 for an all-zero series (no divide-by-zero)', () => {
    const bars = spendBars([point('2026-07-20', 0, '$0.00'), point('2026-07-21', 0, '$0.00')]);
    expect(bars.map((bar) => bar.heightPercent)).toEqual([0, 0]);
  });
});

describe('seriesForSelection', () => {
  const history = {
    grand: [point('2026-07-20', 1_000_000, '$0.10')],
    byDirectory: [
      { directoryPath: '/p/infrastructure/vimes', points: [point('2026-07-20', 600_000, '$0.06')] },
    ],
  };

  it('returns the grand series for a null selection', () => {
    expect(seriesForSelection(history, null)).toBe(history.grand);
  });

  it('returns the matching directory series', () => {
    expect(seriesForSelection(history, '/p/infrastructure/vimes')).toEqual(history.byDirectory[0]!.points);
  });

  it('returns empty for a directory with no series rather than misattributing grand', () => {
    // The contract D37 leans on: an interior node the selector offers but the
    // history does not carry must chart NOTHING, never the grand total under
    // that node's name.
    expect(seriesForSelection(history, '/p/infrastructure')).toEqual([]);
    expect(seriesForSelection(history, 'no-such-directory')).toEqual([]);
    expect(seriesForSelection(null, '/p/infrastructure/vimes')).toEqual([]);
    expect(seriesForSelection({ grand: [], byDirectory: [] }, 'anything')).toEqual([]);
  });
});

describe('ledgerState', () => {
  const populatedLedger: CostLedgerReadModel = {
    scopeLabel: 'VIMES-hosted work on this host',
    priceTableDate: '2026-07-01',
    grandTotal: rollup(),
    directories: [directory({ directoryPath: '/p', label: 'p' })],
    spendHistory: { grand: [], byDirectory: [] },
    byAttributionSkill: [],
    byAttributionAgent: [],
  };

  it('is disabled when ingestion is off', () => {
    expect(ledgerState({ ingestionEnabled: false, ledger: null })).toBe('disabled');
    expect(ledgerState(null)).toBe('disabled');
  });

  it('is empty when ingestion is on but no directories exist', () => {
    const empty: CostLedgerBody = {
      ingestionEnabled: true,
      ledger: { ...populatedLedger, directories: [] },
    };
    expect(ledgerState(empty)).toBe('empty');
  });

  it('is populated with at least one directory node', () => {
    expect(ledgerState({ ingestionEnabled: true, ledger: populatedLedger })).toBe('populated');
  });
});

describe('attributionRows', () => {
  it('sorts by priced dollars descending and labels the absent bucket', () => {
    const groups: AttributionView[] = [
      { key: '', totals: rollup({ priced: money(20_000_000, '$0.02') }) }, // 2 cents
      { key: 'code-review', totals: rollup({ priced: money(90_000_000, '$0.09') }) }, // 9 cents
    ];
    const rows = attributionRows(groups);
    expect(rows.map((row) => row.label)).toEqual(['code-review', ABSENT_ATTRIBUTION_LABEL]);
    // D38: `.usd` is `formatMoney`'d from `nanoDollars`, not the wire string.
    expect(rows[0]!.usd).toBe('$0.09');
  });

  it('carries un-known badges through for a bucket', () => {
    const rows = attributionRows([
      { key: 'skill-x', totals: rollup({ tokensByStatus: counts({ unpriced: 5000 }) }) },
    ]);
    expect(rows[0]!.unknownBadges.map((badge) => badge.status)).toEqual(['unpriced']);
  });
});

describe('formatTokenCount', () => {
  it('renders compact locale-free counts', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(12_300)).toBe('12.3k');
    expect(formatTokenCount(12_000)).toBe('12k');
    expect(formatTokenCount(4_500_000)).toBe('4.5M');
  });
});

// D38 — money at DISPLAY precision (2 dp). See costDisplay.ts's formatMoney
// docstring for the full rationale; these are the 7 pinned assertions from the
// unit's work order.
describe('formatMoney', () => {
  it('renders whole and normal amounts at exactly 2 dp (assertion 1)', () => {
    expect(formatMoney(5_000_000_000)).toBe('$5.00'); // whole dollars
    expect(formatMoney(12_350_000_000)).toBe('$12.35'); // normal amount, the doc's own example
    expect(formatMoney(1_000_000_000)).toBe('$1.00');
  });

  it('rounds half-up, never truncates (assertion 2)', () => {
    // The pinned $0.999999 -> $1.00 case: string-slicing would yield $0.99
    // (an understatement); round-half-up on whole cents yields $1.00.
    expect(formatMoney(999_999_000)).toBe('$1.00');
    // An x.xx5 boundary: 1.5 cents rounds up to 2 cents, not down to 1.
    expect(formatMoney(15_000_000)).toBe('$0.02');
  });

  it('a non-zero sub-cent amount renders <$0.01, a true zero renders $0.00, and the two stay distinct (assertion 3)', () => {
    expect(formatMoney(1)).toBe('<$0.01'); // smallest possible non-zero amount
    expect(formatMoney(9_999_999)).toBe('<$0.01'); // just under one cent
    expect(formatMoney(0)).toBe('$0.00'); // a true zero
    expect(formatMoney(1)).not.toBe(formatMoney(0)); // distinguishable, not the same string
  });

  it('hostile inputs render $0.00, never a throw and never NaN (assertion 4, I8)', () => {
    expect(formatMoney(-100)).toBe('$0.00');
    expect(formatMoney(Number.NaN)).toBe('$0.00');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('$0.00');
    expect(formatMoney(Number.NEGATIVE_INFINITY)).toBe('$0.00');
    expect(formatMoney(null)).toBe('$0.00');
    expect(formatMoney(undefined)).toBe('$0.00');
    // Absent field: a MoneyAmount-shaped object missing `nanoDollars` entirely,
    // the way a call site's optional-chained `x?.priced?.nanoDollars` would
    // genuinely produce `undefined` rather than a typed value.
    const moneyMissingField: Partial<MoneyAmount> = {};
    expect(formatMoney(moneyMissingField.nanoDollars)).toBe('$0.00');
    expect(() => formatMoney(Number.NaN)).not.toThrow();
    expect(formatMoney(Number.NaN)).not.toContain('NaN');
  });

  it('has no locale dependence — no thousands separators, deterministic across calls (assertion 5)', () => {
    // toLocaleString/Intl would insert grouping commas for a 4-digit dollar
    // amount; this module never calls either (module header + design-principles).
    expect(formatMoney(1_234_567_000_000_000)).toBe('$1234567.00');
    expect(formatMoney(1_234_567_000_000_000)).toBe(formatMoney(1_234_567_000_000_000));
  });
});

describe('spendAxisMax', () => {
  it("returns the series max, at display precision, reading the SAME nanoDollars heightPercent derives from (assertion 6)", () => {
    const bars = spendBars([
      point('2026-07-19', 10_000_000, '$0.01'),
      point('2026-07-20', 100_000_000, '$0.10'),
    ]);
    expect(spendAxisMax(bars)).toEqual({ usd: '$0.10', nanoDollars: 100_000_000 });
  });

  it('returns null (harmless for the view) for an empty series (assertion 6)', () => {
    expect(spendAxisMax([])).toBeNull();
    expect(spendAxisMax(null)).toBeNull();
    expect(spendAxisMax(undefined)).toBeNull();
  });

  it('returns null rather than a fabricated axis for an all-zero series (assertion 6)', () => {
    const bars = spendBars([point('2026-07-20', 0, '$0.00'), point('2026-07-21', 0, '$0.00')]);
    expect(spendAxisMax(bars)).toBeNull();
  });
});

// ═══ D37 — rendering the directory rollup ═══════════════════════════════════

// The reported lab layout: projects → infrastructure → vimes → packages → daemon,
// plus a sibling category, plus the outside bucket.
const LAB_TREE: DirectoryView[] = [
  directory({
    directoryPath: '/p',
    label: 'projects',
    depth: 0,
    sessions: [session('root-sess', { directoryPath: '/p', label: 'projects' })],
    children: [
      directory({
        directoryPath: '/p/games',
        label: 'games',
        depth: 1,
        children: [directory({ directoryPath: '/p/games/dongfu', label: 'dongfu', depth: 2 })],
      }),
      directory({
        directoryPath: '/p/infrastructure',
        label: 'infrastructure',
        depth: 1,
        children: [
          directory({
            directoryPath: '/p/infrastructure/vimes',
            label: 'vimes',
            depth: 2,
            sessions: [
              session('vimes-sess', {
                directoryPath: '/p/infrastructure/vimes',
                label: 'the ledger rewrite',
                name: 'the ledger rewrite',
                agents: [agent('parent', [agent('child')])],
              }),
            ],
            children: [
              directory({
                directoryPath: '/p/infrastructure/vimes/packages',
                label: 'packages',
                depth: 3,
                children: [
                  directory({
                    directoryPath: '/p/infrastructure/vimes/packages/daemon',
                    label: 'daemon',
                    depth: 4,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  }),
  directory({
    directoryPath: '<outside-project-roots>',
    label: '<outside-project-roots>',
    depth: 0,
    insideProjectRoots: false,
    sessions: [session('outside-sess', { directoryPath: '<outside-project-roots>', label: 'scratch' })],
  }),
];

describe('flattenDirectoryNodes', () => {
  it('walks the forest pre-order, parents before their children', () => {
    expect(flattenDirectoryNodes(LAB_TREE).map((node) => node.directoryPath)).toEqual([
      '/p',
      '/p/games',
      '/p/games/dongfu',
      '/p/infrastructure',
      '/p/infrastructure/vimes',
      '/p/infrastructure/vimes/packages',
      '/p/infrastructure/vimes/packages/daemon',
      '<outside-project-roots>',
    ]);
  });

  it('is total: null / undefined / a non-array all yield []', () => {
    expect(flattenDirectoryNodes(null)).toEqual([]);
    expect(flattenDirectoryNodes(undefined)).toEqual([]);
    expect(flattenDirectoryNodes({} as unknown as DirectoryView[])).toEqual([]);
  });
});

describe('defaultExpandedKeys — a useful depth, collapsed below it', () => {
  it('expands nodes above the default depth only, so a phone sees root → category → repo', () => {
    const keys = defaultExpandedKeys(LAB_TREE);
    expect(DEFAULT_EXPANDED_DIRECTORY_DEPTH).toBe(2);
    expect(keys).toEqual([
      directoryRowKey('/p'),
      directoryRowKey('/p/games'),
      directoryRowKey('/p/infrastructure'),
      directoryRowKey('<outside-project-roots>'),
    ]);
    // Not the depth-2 repo node — `vimes` is visible but its subdirectories are
    // one tap away rather than dumped on the screen.
    expect(keys).not.toContain(directoryRowKey('/p/infrastructure/vimes'));
    // …and never a SESSION key: drilling into agents is always deliberate.
    expect(keys.every((key) => key.startsWith('dir:'))).toBe(true);
  });

  it('a childless, session-less node is not offered as expandable', () => {
    expect(defaultExpandedKeys([directory({ directoryPath: '/empty' })])).toEqual([]);
  });
});

describe('ledgerTreeRows — the flat render list', () => {
  it('shows only the top-level nodes when nothing is expanded', () => {
    const rows = ledgerTreeRows(LAB_TREE, new Set());
    expect(rows.map((row) => row.key)).toEqual([
      directoryRowKey('/p'),
      directoryRowKey('<outside-project-roots>'),
    ]);
    expect(rows[0]).toMatchObject({ kind: 'directory', depth: 0, expandable: true, expanded: false });
  });

  it('an expanded directory lists its OWN sessions first, then its child directories', () => {
    const rows = ledgerTreeRows(LAB_TREE, new Set([directoryRowKey('/p')]));
    expect(rows.map((row) => row.key)).toEqual([
      directoryRowKey('/p'),
      sessionRowKey('/p', 'root-sess'),
      directoryRowKey('/p/games'),
      directoryRowKey('/p/infrastructure'),
      directoryRowKey('<outside-project-roots>'),
    ]);
    // A session renders one indent level below its directory.
    expect(rows[1]).toMatchObject({ kind: 'session', depth: 1 });
  });

  it('expanding to the default depth reveals the repo node the old grouping hid', () => {
    const rows = ledgerTreeRows(LAB_TREE, new Set(defaultExpandedKeys(LAB_TREE)));
    const visiblePaths = rows
      .filter((row) => row.kind === 'directory')
      .map((row) => (row.kind === 'directory' ? row.directory.directoryPath : ''));
    expect(visiblePaths).toContain('/p/infrastructure/vimes');
    expect(visiblePaths).toContain('/p/games/dongfu');
    // …but not its subdirectories, which are collapsed below the default depth.
    expect(visiblePaths).not.toContain('/p/infrastructure/vimes/packages');
  });

  it('an expanded session emits its agents, indented by their own nesting depth', () => {
    const expanded = new Set([
      directoryRowKey('/p'),
      directoryRowKey('/p/infrastructure'),
      directoryRowKey('/p/infrastructure/vimes'),
      sessionRowKey('/p/infrastructure/vimes', 'vimes-sess'),
    ]);
    const rows = ledgerTreeRows(LAB_TREE, expanded);
    const agentRows = rows.filter((row) => row.kind === 'agent');
    expect(agentRows.map((row) => (row.kind === 'agent' ? row.agent.agentId : ''))).toEqual([
      'parent',
      'child',
    ]);
    // vimes is depth 2 → its session is 3 → its top-level agent is 4, child 5.
    expect(agentRows.map((row) => row.depth)).toEqual([4, 5]);
  });

  it('a session with no agents is not expandable, and expanding it emits nothing extra', () => {
    const expanded = new Set([directoryRowKey('/p'), sessionRowKey('/p', 'root-sess')]);
    const rows = ledgerTreeRows(LAB_TREE, expanded);
    const sessionRow = rows.find((row) => row.kind === 'session')!;
    expect(sessionRow).toMatchObject({ expandable: false, expanded: false });
    expect(rows.some((row) => row.kind === 'agent')).toBe(false);
  });

  it('every session row carries a NON-BLANK label — a leaf never renders empty', () => {
    const rows = ledgerTreeRows(LAB_TREE, new Set(flattenDirectoryNodes(LAB_TREE).map((node) => directoryRowKey(node.directoryPath))));
    const sessionRows = rows.filter((row) => row.kind === 'session');
    expect(sessionRows.length).toBeGreaterThan(0);
    for (const row of sessionRows) {
      expect(row.kind === 'session' && row.session.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('is total: a null tree renders no rows rather than throwing', () => {
    expect(ledgerTreeRows(null, new Set())).toEqual([]);
    expect(ledgerTreeRows(undefined, new Set())).toEqual([]);
  });

  it('survives a very deep chain without recursing (I8)', () => {
    let deepest = directory({ directoryPath: '/p/d2000', label: 'd2000', depth: 2_000 });
    for (let depth = 1_999; depth >= 0; depth -= 1) {
      deepest = directory({
        directoryPath: `/p/d${depth}`,
        label: `d${depth}`,
        depth,
        children: [deepest],
      });
    }
    const allKeys = new Set(flattenDirectoryNodes([deepest]).map((node) => directoryRowKey(node.directoryPath)));
    expect(ledgerTreeRows([deepest], allKeys)).toHaveLength(2_001);
  });
});

describe('directorySelectOptions — the selector offers the SAME nodes the tree shows', () => {
  it('offers every directory node, in the tree order, keyed by its path', () => {
    const options = directorySelectOptions(LAB_TREE);
    expect(options.map((option) => option.directoryPath)).toEqual(
      flattenDirectoryNodes(LAB_TREE).map((node) => node.directoryPath),
    );
    // The full path is the label: a bare `vimes` would be ambiguous between two
    // roots, and a <select> collapses whitespace so indenting cannot fix that.
    expect(options.find((option) => option.directoryPath === '/p/infrastructure/vimes')).toEqual({
      directoryPath: '/p/infrastructure/vimes',
      label: '/p/infrastructure/vimes',
      depth: 2,
    });
  });

  it('is total for a missing tree', () => {
    expect(directorySelectOptions(null)).toEqual([]);
  });
});
