import { describe, expect, it } from 'vitest';
import {
  attributionRows,
  formatMoney,
  formatTokenCount,
  hasUnknownTokens,
  ledgerState,
  seriesForSelection,
  spendAxisMax,
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
