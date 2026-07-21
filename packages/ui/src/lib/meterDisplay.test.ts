import { describe, expect, it } from 'vitest';
import {
  deriveMeterRow,
  deriveMeterRows,
  formatResetCountdown,
  meterFreshness,
  meterLabel,
  ELEVATED_PERCENT_PREVIEW,
  HIGH_PERCENT_PREVIEW,
  METER_STALE_AFTER_MS_PREVIEW,
  type MeterRecord,
  type MetersState,
} from './meterDisplay.js';

const NOW_MS = Date.parse('2026-07-21T12:00:00.000Z');
const STALE_AFTER_MS = 10 * 60 * 1000;

function record(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    meterId: 'endpoint:session',
    kind: 'rolling-window',
    percent: 29,
    severity: 'normal',
    isActive: false,
    resetsAt: '2026-07-21T15:19:59.000Z',
    source: 'endpoint',
    observedAt: '2026-07-21T11:59:00.000Z',
    ...overrides,
  };
}

describe('meterFreshness', () => {
  it('is fresh inside the staleness window', () => {
    expect(meterFreshness('2026-07-21T11:55:00.000Z', NOW_MS, STALE_AFTER_MS)).toBe('fresh');
  });

  it('is fresh exactly at the staleness boundary (only elapsed age PAST it is stale)', () => {
    expect(meterFreshness('2026-07-21T11:50:00.000Z', NOW_MS, STALE_AFTER_MS)).toBe('fresh');
  });

  it('is stale one millisecond past the boundary', () => {
    expect(meterFreshness('2026-07-21T11:49:59.999Z', NOW_MS, STALE_AFTER_MS)).toBe('stale');
  });

  it('treats a future-dated observation (clock skew) as fresh, not stale', () => {
    expect(meterFreshness('2026-07-21T12:30:00.000Z', NOW_MS, STALE_AFTER_MS)).toBe('fresh');
  });

  it('is unknown — not stale and not fresh — with no parseable observedAt', () => {
    expect(meterFreshness(null, NOW_MS, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness(undefined, NOW_MS, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness('', NOW_MS, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness('not-a-timestamp', NOW_MS, STALE_AFTER_MS)).toBe('unknown');
  });

  it('is unknown when now itself is not a finite epoch', () => {
    expect(meterFreshness('2026-07-21T11:59:00.000Z', Number.NaN, STALE_AFTER_MS)).toBe('unknown');
  });
});

describe('THE INTEGRITY RULE — a non-fresh observation never renders as a current number', () => {
  it('HEADLINE: a stale record that still HOLDS a real percent yields displayPercent null', () => {
    const staleRow = deriveMeterRow(
      record({ percent: 64, observedAt: '2026-07-21T09:00:00.000Z' }),
      NOW_MS,
      STALE_AFTER_MS,
    );
    expect(staleRow.freshness).toBe('stale');
    // The last known figure exists in the record and is NOT surfaced.
    expect(staleRow.displayPercent).toBeNull();
    expect(staleRow.tone).toBe('unknown');
  });

  it('an unparseable observedAt yields unknown freshness and no number, percent notwithstanding', () => {
    const unknownRow = deriveMeterRow(record({ percent: 52, observedAt: 'whenever' }), NOW_MS, STALE_AFTER_MS);
    expect(unknownRow.freshness).toBe('unknown');
    expect(unknownRow.displayPercent).toBeNull();
  });

  it('an absent percent on a FRESH record is null, and specifically NOT 0', () => {
    const absentPercentRow = deriveMeterRow(record({ percent: undefined }), NOW_MS, STALE_AFTER_MS);
    expect(absentPercentRow.freshness).toBe('fresh');
    expect(absentPercentRow.displayPercent).toBeNull();
    expect(absentPercentRow.displayPercent).not.toBe(0);
    expect(absentPercentRow.tone).toBe('unknown');
  });

  it('a null percent is unknown, while a genuine 0 percent renders as 0', () => {
    expect(deriveMeterRow(record({ percent: null }), NOW_MS, STALE_AFTER_MS).displayPercent).toBeNull();
    const zeroRow = deriveMeterRow(record({ percent: 0 }), NOW_MS, STALE_AFTER_MS);
    expect(zeroRow.displayPercent).toBe(0);
    expect(zeroRow.tone).toBe('normal');
  });

  it('a non-finite percent is unknown, never a rendered figure', () => {
    expect(deriveMeterRow(record({ percent: Number.NaN }), NOW_MS, STALE_AFTER_MS).displayPercent).toBeNull();
    expect(deriveMeterRow(record({ percent: Number.POSITIVE_INFINITY }), NOW_MS, STALE_AFTER_MS).displayPercent).toBeNull();
  });

  it('clamps and rounds an out-of-range percent rather than rendering nonsense', () => {
    expect(deriveMeterRow(record({ percent: 140 }), NOW_MS, STALE_AFTER_MS).displayPercent).toBe(100);
    expect(deriveMeterRow(record({ percent: -5 }), NOW_MS, STALE_AFTER_MS).displayPercent).toBe(0);
    expect(deriveMeterRow(record({ percent: 63.6 }), NOW_MS, STALE_AFTER_MS).displayPercent).toBe(64);
  });
});

describe('meterLabel', () => {
  it('labels the rolling window as the 5-hour session', () => {
    expect(meterLabel(record({ kind: 'rolling-window', scope: null }))).toBe('5-hour session');
  });

  it('labels an unscoped weekly cap as all models', () => {
    expect(meterLabel(record({ meterId: 'endpoint:weekly_all', kind: 'weekly-cap', scope: null }))).toBe(
      'Weekly (all models)',
    );
    expect(meterLabel(record({ meterId: 'endpoint:weekly_all', kind: 'weekly-cap', scope: undefined }))).toBe(
      'Weekly (all models)',
    );
    expect(meterLabel(record({ meterId: 'endpoint:weekly_all', kind: 'weekly-cap', scope: '  ' }))).toBe(
      'Weekly (all models)',
    );
  });

  it('labels a scoped weekly cap with its scope', () => {
    expect(meterLabel(record({ meterId: 'endpoint:weekly_scoped:Fable', kind: 'weekly-cap', scope: 'Fable' }))).toBe(
      'Weekly (Fable)',
    );
  });

  it('labels the monthly credit', () => {
    expect(meterLabel(record({ meterId: 'endpoint:monthly', kind: 'monthly-credit', scope: null }))).toBe(
      'Monthly credit',
    );
  });

  it('falls back to a readable label derived from meterId for an unknown kind, never throwing', () => {
    expect(meterLabel(record({ meterId: 'endpoint:seven_day_cowork', kind: 'brand-new-kind', scope: null }))).toBe(
      'Seven day cowork',
    );
    expect(meterLabel(record({ meterId: 'endpoint:tangelo', kind: 'brand-new-kind', scope: 'Fable' }))).toBe(
      'Tangelo (Fable)',
    );
    expect(meterLabel(record({ meterId: '', kind: 'brand-new-kind', scope: null }))).toBe('Usage');
  });
});

describe('formatResetCountdown', () => {
  it('formats days and hours', () => {
    expect(formatResetCountdown('2026-07-23T15:00:00.000Z', NOW_MS)).toBe('resets in 2d 3h');
  });

  it('formats hours and minutes', () => {
    expect(formatResetCountdown('2026-07-21T14:14:00.000Z', NOW_MS)).toBe('resets in 2h 14m');
  });

  it('formats minutes alone under an hour', () => {
    expect(formatResetCountdown('2026-07-21T12:41:00.000Z', NOW_MS)).toBe('resets in 41m');
  });

  it('formats sub-minute remainders without claiming zero', () => {
    expect(formatResetCountdown('2026-07-21T12:00:30.000Z', NOW_MS)).toBe('resets in <1m');
  });

  it('says resetting when already past, including exactly at the reset instant', () => {
    expect(formatResetCountdown('2026-07-21T11:00:00.000Z', NOW_MS)).toBe('resetting…');
    expect(formatResetCountdown('2026-07-21T12:00:00.000Z', NOW_MS)).toBe('resetting…');
  });

  it('is null when resetsAt is absent or unparseable', () => {
    expect(formatResetCountdown(null, NOW_MS)).toBeNull();
    expect(formatResetCountdown(undefined, NOW_MS)).toBeNull();
    expect(formatResetCountdown('soon', NOW_MS)).toBeNull();
  });

  it('is locale-free: identical output regardless of the ambient TZ offset in the input', () => {
    // Same instant, two spellings — the formatter reads epochs, not locales.
    expect(formatResetCountdown('2026-07-21T14:14:00.000Z', NOW_MS)).toBe(
      formatResetCountdown('2026-07-21T09:14:00.000-05:00', NOW_MS),
    );
  });
});

describe('tone', () => {
  it('prefers the server severity over the local preview bands', () => {
    // 12% would band as 'normal', but the server says critical — the server wins.
    expect(deriveMeterRow(record({ percent: 12, severity: 'critical' }), NOW_MS, STALE_AFTER_MS).tone).toBe('high');
    // 95% would band as 'high', but the server says normal — the server wins.
    expect(deriveMeterRow(record({ percent: 95, severity: 'normal' }), NOW_MS, STALE_AFTER_MS).tone).toBe('normal');
  });

  it('falls back to the unpinned preview bands when severity is absent or unrecognized', () => {
    const banded = (percent: number, severity: string | null) =>
      deriveMeterRow(record({ percent, severity }), NOW_MS, STALE_AFTER_MS).tone;
    expect(banded(ELEVATED_PERCENT_PREVIEW - 1, null)).toBe('normal');
    expect(banded(ELEVATED_PERCENT_PREVIEW, null)).toBe('elevated');
    expect(banded(HIGH_PERCENT_PREVIEW, null)).toBe('high');
    expect(banded(HIGH_PERCENT_PREVIEW, 'iguana_necktie')).toBe('high');
  });

  it('passes severity through raw and never invents one', () => {
    expect(deriveMeterRow(record({ severity: 'iguana_necktie' }), NOW_MS, STALE_AFTER_MS).severity).toBe(
      'iguana_necktie',
    );
    expect(deriveMeterRow(record({ severity: null }), NOW_MS, STALE_AFTER_MS).severity).toBeNull();
    expect(deriveMeterRow(record({ severity: undefined }), NOW_MS, STALE_AFTER_MS).severity).toBeNull();
  });
});

describe('deriveMeterRow', () => {
  it('marks only an explicitly active record as binding', () => {
    expect(deriveMeterRow(record({ isActive: true }), NOW_MS, STALE_AFTER_MS).isBinding).toBe(true);
    expect(deriveMeterRow(record({ isActive: false }), NOW_MS, STALE_AFTER_MS).isBinding).toBe(false);
    expect(deriveMeterRow(record({ isActive: null }), NOW_MS, STALE_AFTER_MS).isBinding).toBe(false);
    expect(deriveMeterRow(record({ isActive: undefined }), NOW_MS, STALE_AFTER_MS).isBinding).toBe(false);
  });

  it('carries no absolute usage figure at all (D26 — the source reports percentages only)', () => {
    const row = deriveMeterRow(record(), NOW_MS, STALE_AFTER_MS);
    expect(Object.keys(row).sort()).toEqual([
      'displayPercent',
      'freshness',
      'isBinding',
      'label',
      'meterId',
      'resetLabel',
      'severity',
      'tone',
    ]);
  });
});

describe('deriveMeterRows', () => {
  const metersState: MetersState = {
    meters: {
      'endpoint:weekly_all': record({
        meterId: 'endpoint:weekly_all',
        kind: 'weekly-cap',
        scope: null,
        percent: 52,
        isActive: false,
      }),
      'endpoint:session': record({ meterId: 'endpoint:session', percent: 29, isActive: false }),
      'endpoint:weekly_scoped:Fable': record({
        meterId: 'endpoint:weekly_scoped:Fable',
        kind: 'weekly-cap',
        scope: 'Fable',
        percent: 64,
        isActive: true,
      }),
    },
  };

  it('puts the BINDING meter first, then orders the rest by meterId', () => {
    const rows = deriveMeterRows(metersState, NOW_MS, STALE_AFTER_MS);
    expect(rows.map((row) => row.meterId)).toEqual([
      'endpoint:weekly_scoped:Fable',
      'endpoint:session',
      'endpoint:weekly_all',
    ]);
    const leadRow = rows[0];
    expect(leadRow?.isBinding).toBe(true);
    expect(leadRow?.label).toBe('Weekly (Fable)');
    expect(leadRow?.displayPercent).toBe(64);
  });

  it('is stable: no binding meter still yields a deterministic meterId order', () => {
    const noBinding: MetersState = {
      meters: {
        'endpoint:weekly_all': record({ meterId: 'endpoint:weekly_all', isActive: false }),
        'endpoint:session': record({ meterId: 'endpoint:session', isActive: false }),
      },
    };
    expect(deriveMeterRows(noBinding, NOW_MS, STALE_AFTER_MS).map((row) => row.meterId)).toEqual([
      'endpoint:session',
      'endpoint:weekly_all',
    ]);
  });

  it('does not jitter between fetches when key insertion order changes', () => {
    const reordered: MetersState = {
      meters: {
        'endpoint:session': record({ meterId: 'endpoint:session', percent: 29, isActive: false }),
        'endpoint:weekly_scoped:Fable': record({
          meterId: 'endpoint:weekly_scoped:Fable',
          kind: 'weekly-cap',
          scope: 'Fable',
          percent: 64,
          isActive: true,
        }),
        'endpoint:weekly_all': record({
          meterId: 'endpoint:weekly_all',
          kind: 'weekly-cap',
          scope: null,
          percent: 52,
          isActive: false,
        }),
      },
    };
    expect(deriveMeterRows(reordered, NOW_MS, STALE_AFTER_MS).map((row) => row.meterId)).toEqual(
      deriveMeterRows(metersState, NOW_MS, STALE_AFTER_MS).map((row) => row.meterId),
    );
  });

  it('returns an empty list — not a fabricated zero meter — when there is nothing to show', () => {
    expect(deriveMeterRows(undefined, NOW_MS, STALE_AFTER_MS)).toEqual([]);
    expect(deriveMeterRows(null, NOW_MS, STALE_AFTER_MS)).toEqual([]);
    expect(deriveMeterRows({}, NOW_MS, STALE_AFTER_MS)).toEqual([]);
    expect(deriveMeterRows({ meters: {} }, NOW_MS, STALE_AFTER_MS)).toEqual([]);
    expect(deriveMeterRows({ meters: null }, NOW_MS, STALE_AFTER_MS)).toEqual([]);
  });

  it('shows every meter as unknown when the whole projection has gone stale', () => {
    const rows = deriveMeterRows(metersState, NOW_MS + 24 * 60 * 60 * 1000, STALE_AFTER_MS);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.freshness === 'stale')).toBe(true);
    expect(rows.every((row) => row.displayPercent === null)).toBe(true);
  });

  it('exposes the staleness window as an UNPINNED preview constant', () => {
    expect(METER_STALE_AFTER_MS_PREVIEW).toBe(600_000);
  });
});
