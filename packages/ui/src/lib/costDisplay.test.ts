import { describe, expect, it } from 'vitest';
import {
  attributionRows,
  formatTokenCount,
  hasUnknownTokens,
  ledgerState,
  seriesForSelection,
  spendBars,
  unknownTokenBadges,
  unvalidatedNote,
  ABSENT_ATTRIBUTION_LABEL,
  type AttributionView,
  type CostLedgerBody,
  type CostLedgerReadModel,
  type MoneyAmount,
  type PriceStatusCountsView,
  type RollupView,
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

  it('renders the verbatim usd string when unvalidated money exists', () => {
    expect(unvalidatedNote(rollup({ unvalidated: money(1_230_000_000, '$1.23') }))).toBe('incl. $1.23 unvalidated');
  });
});

describe('spendBars', () => {
  it('is empty for no points', () => {
    expect(spendBars([])).toEqual([]);
    expect(spendBars(null)).toEqual([]);
  });

  it('normalizes heights to the tallest day and keeps a real small day visible', () => {
    const bars = spendBars([
      point('2026-07-19', 100_000, '$0.01'),
      point('2026-07-20', 1_000_000, '$0.10'),
      point('2026-07-21', 500, '$0.00'),
    ]);
    expect(bars[1]!.heightPercent).toBe(100); // tallest
    expect(bars[0]!.heightPercent).toBe(10);
    // A real but tiny day is floored to a visible minimum, never 0.
    expect(bars[2]!.heightPercent).toBeGreaterThan(0);
    // Dollar strings are passed through verbatim, never recomputed.
    expect(bars.map((bar) => bar.usd)).toEqual(['$0.01', '$0.10', '$0.00']);
  });

  it('keeps every bar flat at 0 for an all-zero series (no divide-by-zero)', () => {
    const bars = spendBars([point('2026-07-20', 0, '$0.00'), point('2026-07-21', 0, '$0.00')]);
    expect(bars.map((bar) => bar.heightPercent)).toEqual([0, 0]);
  });
});

describe('seriesForSelection', () => {
  const history = {
    grand: [point('2026-07-20', 1_000_000, '$0.10')],
    byProject: [{ projectKey: 'vimes', points: [point('2026-07-20', 600_000, '$0.06')] }],
  };

  it('returns the grand series for a null selection', () => {
    expect(seriesForSelection(history, null)).toBe(history.grand);
  });

  it('returns the matching project series', () => {
    expect(seriesForSelection(history, 'vimes')).toEqual(history.byProject[0]!.points);
  });

  it('returns empty for a project with no series rather than misattributing grand', () => {
    expect(seriesForSelection(history, 'no-such-project')).toEqual([]);
  });
});

describe('ledgerState', () => {
  const populatedLedger: CostLedgerReadModel = {
    scopeLabel: 'VIMES-hosted work on this host',
    priceTableDate: '2026-07-01',
    grandTotal: rollup(),
    projects: [
      {
        projectKey: 'vimes',
        insideProjectRoots: true,
        own: rollup(),
        subtree: rollup(),
        sessions: [],
      },
    ],
    spendHistory: { grand: [], byProject: [] },
    byAttributionSkill: [],
    byAttributionAgent: [],
  };

  it('is disabled when ingestion is off', () => {
    expect(ledgerState({ ingestionEnabled: false, ledger: null })).toBe('disabled');
    expect(ledgerState(null)).toBe('disabled');
  });

  it('is empty when ingestion is on but no projects exist', () => {
    const empty: CostLedgerBody = {
      ingestionEnabled: true,
      ledger: { ...populatedLedger, projects: [] },
    };
    expect(ledgerState(empty)).toBe('empty');
  });

  it('is populated with at least one project', () => {
    expect(ledgerState({ ingestionEnabled: true, ledger: populatedLedger })).toBe('populated');
  });
});

describe('attributionRows', () => {
  it('sorts by priced dollars descending and labels the absent bucket', () => {
    const groups: AttributionView[] = [
      { key: '', totals: rollup({ priced: money(200_000, '$0.02') }) },
      { key: 'code-review', totals: rollup({ priced: money(900_000, '$0.09') }) },
    ];
    const rows = attributionRows(groups);
    expect(rows.map((row) => row.label)).toEqual(['code-review', ABSENT_ATTRIBUTION_LABEL]);
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
