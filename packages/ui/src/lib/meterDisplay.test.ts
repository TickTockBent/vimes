import { describe, expect, it } from 'vitest';
import {
  deriveMeterRow,
  formatBurnRate,
  formatObservationAge,
  formatProjectedExhaustion,
  formatResetCountdown,
  freshnessFromAge,
  meterFreshness,
  meterLabel,
  refreshNotice,
  usageStripModel,
  ELEVATED_PERCENT_PREVIEW,
  HIGH_PERCENT_PREVIEW,
  type DerivedMeter,
  type DerivedUsageBody,
  type MeterRowContext,
  type UsageRefreshOutcome,
  type UsageSnapshot,
} from './meterDisplay.js';

const NOW_MS = Date.parse('2026-07-21T12:00:00.000Z');
const STALE_AFTER_MS = 10 * 60 * 1000;

// A meter observed one minute ago, as the DERIVED endpoint serves it.
function record(overrides: Partial<DerivedMeter> = {}): DerivedMeter {
  return {
    meterId: 'endpoint:session',
    kind: 'rolling-window',
    percent: 29,
    severity: 'normal',
    isActive: false,
    resetsAt: '2026-07-21T15:19:59.000Z',
    source: 'endpoint',
    observedAt: '2026-07-21T11:59:00.000Z',
    ageMs: 60_000,
    ...overrides,
  };
}

// No local elapsed time yet: the response just landed.
function context(overrides: Partial<MeterRowContext> = {}): MeterRowContext {
  return { nowMs: NOW_MS, staleAfterMs: STALE_AFTER_MS, elapsedSinceResponseMs: 0, ...overrides };
}

describe('freshnessFromAge — the band is the SERVER\'s, and a missing band is unknown', () => {
  it('is fresh inside the band and stale one millisecond past it', () => {
    expect(freshnessFromAge(STALE_AFTER_MS - 1, STALE_AFTER_MS)).toBe('fresh');
    expect(freshnessFromAge(STALE_AFTER_MS, STALE_AFTER_MS)).toBe('fresh');
    expect(freshnessFromAge(STALE_AFTER_MS + 1, STALE_AFTER_MS)).toBe('stale');
  });

  it('HEADLINE: a null band (poller disabled) is UNKNOWN — never eternally fresh, never instantly stale', () => {
    expect(freshnessFromAge(0, null)).toBe('unknown');
    expect(freshnessFromAge(1_000, null)).toBe('unknown');
    expect(freshnessFromAge(365 * 24 * 3600_000, null)).toBe('unknown');
    // Specifically NOT the two wrong answers a 0 or an infinite band would give.
    expect(freshnessFromAge(1_000, null)).not.toBe('fresh');
    expect(freshnessFromAge(1_000, null)).not.toBe('stale');
  });

  it('is unknown when the age itself is unknowable', () => {
    expect(freshnessFromAge(null, STALE_AFTER_MS)).toBe('unknown');
  });

  it('treats a negative age (source clock ahead) as fresh, not stale', () => {
    expect(freshnessFromAge(-30_000, STALE_AFTER_MS)).toBe('fresh');
  });
});

describe('meterFreshness (observedAt fallback, still server-anchored)', () => {
  it('is fresh inside the staleness window and stale past it', () => {
    expect(meterFreshness('2026-07-21T11:55:00.000Z', NOW_MS, STALE_AFTER_MS)).toBe('fresh');
    expect(meterFreshness('2026-07-21T11:50:00.000Z', NOW_MS, STALE_AFTER_MS)).toBe('fresh');
    expect(meterFreshness('2026-07-21T11:49:59.999Z', NOW_MS, STALE_AFTER_MS)).toBe('stale');
  });

  it('is unknown — not stale and not fresh — with no parseable observedAt', () => {
    expect(meterFreshness(null, NOW_MS, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness(undefined, NOW_MS, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness('', NOW_MS, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness('not-a-timestamp', NOW_MS, STALE_AFTER_MS)).toBe('unknown');
  });

  it('is unknown when now itself is not a finite epoch, or when there is no band', () => {
    expect(meterFreshness('2026-07-21T11:59:00.000Z', Number.NaN, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness('2026-07-21T11:59:00.000Z', null, STALE_AFTER_MS)).toBe('unknown');
    expect(meterFreshness('2026-07-21T11:59:00.000Z', NOW_MS, null)).toBe('unknown');
  });
});

describe('formatObservationAge — the age is ALWAYS visible', () => {
  it('formats seconds', () => {
    expect(formatObservationAge(11_000)).toBe('updated 11s ago');
    expect(formatObservationAge(59_999)).toBe('updated 59s ago');
  });

  it('formats minutes', () => {
    expect(formatObservationAge(4 * 60_000)).toBe('updated 4m ago');
    expect(formatObservationAge(59 * 60_000)).toBe('updated 59m ago');
  });

  it('formats hours with minutes', () => {
    expect(formatObservationAge(2 * 3600_000 + 14 * 60_000)).toBe('updated 2h 14m ago');
  });

  it('formats past a day', () => {
    expect(formatObservationAge(50 * 3600_000)).toBe('updated 2d 2h ago');
  });

  it('renders a NEGATIVE age (source clock ahead of ours) as "just now", never as a negative duration', () => {
    expect(formatObservationAge(-1)).toBe('updated just now');
    expect(formatObservationAge(-45_000)).toBe('updated just now');
    expect(formatObservationAge(-45_000)).not.toContain('-');
  });

  it('says the age is UNKNOWN rather than omitting the line, when it cannot be computed', () => {
    expect(formatObservationAge(null)).toBe('age unknown');
    expect(formatObservationAge(Number.NaN)).toBe('age unknown');
  });

  it('rounds sub-second ages to "just now" rather than claiming 0s', () => {
    expect(formatObservationAge(0)).toBe('updated just now');
    expect(formatObservationAge(999)).toBe('updated just now');
    expect(formatObservationAge(1_000)).toBe('updated 1s ago');
  });
});

describe('THE INTEGRITY RULE — a non-fresh observation never renders as a current number', () => {
  it('HEADLINE: a stale record that still HOLDS a real percent yields displayPercent null', () => {
    const staleRow = deriveMeterRow(record({ percent: 64, ageMs: 3 * 3600_000 }), context());
    expect(staleRow.freshness).toBe('stale');
    // The last known figure exists in the record and is NOT surfaced.
    expect(staleRow.displayPercent).toBeNull();
    expect(staleRow.tone).toBe('unknown');
    // …but the age is, so the user can SEE why.
    expect(staleRow.ageLabel).toBe('updated 3h 0m ago');
  });

  it('an unageable observation yields unknown freshness and no number, percent notwithstanding', () => {
    const unknownRow = deriveMeterRow(record({ percent: 52, observedAt: 'whenever', ageMs: null }), context());
    expect(unknownRow.freshness).toBe('unknown');
    expect(unknownRow.displayPercent).toBeNull();
    expect(unknownRow.ageLabel).toBe('age unknown');
  });

  it('a null staleAfterMs makes EVERY row unknown, and no figure is rendered', () => {
    const row = deriveMeterRow(record({ percent: 29, ageMs: 1_000 }), context({ staleAfterMs: null }));
    expect(row.freshness).toBe('unknown');
    expect(row.displayPercent).toBeNull();
  });

  it('an absent percent on a FRESH record is null, and specifically NOT 0', () => {
    const absentPercentRow = deriveMeterRow(record({ percent: undefined }), context());
    expect(absentPercentRow.freshness).toBe('fresh');
    expect(absentPercentRow.displayPercent).toBeNull();
    expect(absentPercentRow.displayPercent).not.toBe(0);
    expect(absentPercentRow.tone).toBe('unknown');
  });

  it('a null percent is unknown, while a genuine 0 percent renders as 0', () => {
    expect(deriveMeterRow(record({ percent: null }), context()).displayPercent).toBeNull();
    const zeroRow = deriveMeterRow(record({ percent: 0 }), context());
    expect(zeroRow.displayPercent).toBe(0);
    expect(zeroRow.tone).toBe('normal');
  });

  it('a non-finite percent is unknown, never a rendered figure', () => {
    expect(deriveMeterRow(record({ percent: Number.NaN }), context()).displayPercent).toBeNull();
    expect(deriveMeterRow(record({ percent: Number.POSITIVE_INFINITY }), context()).displayPercent).toBeNull();
  });

  it('clamps and rounds an out-of-range percent rather than rendering nonsense', () => {
    expect(deriveMeterRow(record({ percent: 140 }), context()).displayPercent).toBe(100);
    expect(deriveMeterRow(record({ percent: -5 }), context()).displayPercent).toBe(0);
    expect(deriveMeterRow(record({ percent: 63.6 }), context()).displayPercent).toBe(64);
  });

  it('renders a freshly-rolled window (0% with NO resetsAt) calmly, not as an error', () => {
    // Observed live 2026-07-21: at rollover the endpoint DROPS resets_at.
    const rolledRow = deriveMeterRow(record({ percent: 0, resetsAt: null }), context());
    expect(rolledRow.displayPercent).toBe(0);
    expect(rolledRow.freshness).toBe('fresh');
    expect(rolledRow.resetLabel).toBeNull();
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

  it('is null when resetsAt is absent, unparseable, or there is no anchored now', () => {
    expect(formatResetCountdown(null, NOW_MS)).toBeNull();
    expect(formatResetCountdown(undefined, NOW_MS)).toBeNull();
    expect(formatResetCountdown('soon', NOW_MS)).toBeNull();
    expect(formatResetCountdown('2026-07-21T14:14:00.000Z', null)).toBeNull();
  });

  it('is locale-free: identical output regardless of the ambient TZ offset in the input', () => {
    // Same instant, two spellings — the formatter reads epochs, not locales.
    expect(formatResetCountdown('2026-07-21T14:14:00.000Z', NOW_MS)).toBe(
      formatResetCountdown('2026-07-21T09:14:00.000-05:00', NOW_MS),
    );
  });
});

describe('formatBurnRate — null is UNKNOWN, never 0', () => {
  it('renders a rate', () => {
    expect(formatBurnRate(12.4)).toBe('12%/h');
    expect(formatBurnRate(3.27)).toBe('3.3%/h');
  });

  it('HEADLINE: an absent rate says unknown, and specifically never 0%/h', () => {
    expect(formatBurnRate(null)).toBe('burn rate unknown');
    expect(formatBurnRate(undefined)).toBe('burn rate unknown');
    expect(formatBurnRate(Number.NaN)).toBe('burn rate unknown');
    expect(formatBurnRate(null)).not.toContain('0');
  });

  it('distinguishes an OBSERVED non-positive rate from an unknown one', () => {
    expect(formatBurnRate(0)).toBe('not rising');
    expect(formatBurnRate(-2)).toBe('not rising');
  });
});

describe('formatProjectedExhaustion — the reason is translated, the enum is never shown', () => {
  it('renders a real projection as a countdown', () => {
    expect(formatProjectedExhaustion('2026-07-21T14:30:00.000Z', 'projected', NOW_MS)).toBe(
      'projected to run out in 2h 30m',
    );
  });

  it('renders a projection already in the past without a negative duration', () => {
    expect(formatProjectedExhaustion('2026-07-21T11:00:00.000Z', 'projected', NOW_MS)).toBe(
      'projected to run out now',
    );
  });

  it('HEADLINE: resets-first is REASSURING and says so; burn-rate-unknown is merely uninformative', () => {
    expect(formatProjectedExhaustion(null, 'resets-first', NOW_MS)).toBe('resets before you run out');
    expect(formatProjectedExhaustion(null, 'burn-rate-unknown', NOW_MS)).toBe('not enough samples to project yet');
    // Two different situations, two different sentences — not one shared "unknown".
    expect(formatProjectedExhaustion(null, 'resets-first', NOW_MS)).not.toBe(
      formatProjectedExhaustion(null, 'burn-rate-unknown', NOW_MS),
    );
  });

  it('translates every reason in the daemon vocabulary and never renders the raw enum', () => {
    const reasons = [
      'meter-never-observed',
      'percent-unobserved',
      'already-exhausted',
      'observation-unusable',
      'burn-rate-unknown',
      'burn-rate-non-positive',
      'resets-first',
    ] as const;
    for (const reason of reasons) {
      const label = formatProjectedExhaustion(null, reason, NOW_MS);
      expect(label).not.toContain(reason);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('degrades a reason word we have never seen to an honest generic phrase (rule 0.6)', () => {
    expect(formatProjectedExhaustion(null, 'iguana_necktie', NOW_MS)).toBe('no exhaustion projection');
    expect(formatProjectedExhaustion(null, null, NOW_MS)).toBe('no exhaustion projection');
    expect(formatProjectedExhaustion(null, undefined, NOW_MS)).toBe('no exhaustion projection');
  });
});

describe('tone', () => {
  it('prefers the server severity over the local preview bands', () => {
    // 12% would band as 'normal', but the server says critical — the server wins.
    expect(deriveMeterRow(record({ percent: 12, severity: 'critical' }), context()).tone).toBe('high');
    // 95% would band as 'high', but the server says normal — the server wins.
    expect(deriveMeterRow(record({ percent: 95, severity: 'normal' }), context()).tone).toBe('normal');
  });

  it('falls back to the unpinned preview bands when severity is absent or unrecognized', () => {
    const banded = (percent: number, severity: string | null) =>
      deriveMeterRow(record({ percent, severity }), context()).tone;
    expect(banded(ELEVATED_PERCENT_PREVIEW - 1, null)).toBe('normal');
    expect(banded(ELEVATED_PERCENT_PREVIEW, null)).toBe('elevated');
    expect(banded(HIGH_PERCENT_PREVIEW, null)).toBe('high');
    expect(banded(HIGH_PERCENT_PREVIEW, 'iguana_necktie')).toBe('high');
  });

  it('passes severity through raw and never invents one', () => {
    expect(deriveMeterRow(record({ severity: 'iguana_necktie' }), context()).severity).toBe('iguana_necktie');
    expect(deriveMeterRow(record({ severity: null }), context()).severity).toBeNull();
    expect(deriveMeterRow(record({ severity: undefined }), context()).severity).toBeNull();
  });
});

describe('deriveMeterRow', () => {
  it('marks only an explicitly active record as binding', () => {
    expect(deriveMeterRow(record({ isActive: true }), context()).isBinding).toBe(true);
    expect(deriveMeterRow(record({ isActive: false }), context()).isBinding).toBe(false);
    expect(deriveMeterRow(record({ isActive: null }), context()).isBinding).toBe(false);
    expect(deriveMeterRow(record({ isActive: undefined }), context()).isBinding).toBe(false);
  });

  it('carries no absolute usage figure at all (D26 — the source reports percentages only)', () => {
    const row = deriveMeterRow(record(), context());
    expect(Object.keys(row).sort()).toEqual([
      'ageLabel',
      'ageMs',
      'burnRateLabel',
      'displayPercent',
      'exhaustionLabel',
      'freshness',
      'isBinding',
      'label',
      'meterId',
      'resetLabel',
      'severity',
      'tone',
    ]);
    // Nothing that could be read as tokens or dollars appears in any label.
    const renderedText = `${row.ageLabel} ${row.burnRateLabel} ${row.exhaustionLabel} ${row.resetLabel ?? ''}`;
    expect(renderedText).not.toMatch(/\$|token/i);
  });

  it('advances the daemon-measured age by the LOCAL elapsed time, and only by that', () => {
    const row = deriveMeterRow(record({ ageMs: 60_000 }), context({ elapsedSinceResponseMs: 15_000 }));
    expect(row.ageMs).toBe(75_000);
    expect(row.ageLabel).toBe('updated 1m ago');
  });

  it('falls back to observedAt against the ANCHORED now when the daemon supplied no ageMs', () => {
    const row = deriveMeterRow(record({ ageMs: undefined }), context());
    expect(row.ageMs).toBe(60_000);
  });

  it('goes stale ON SCREEN as local time passes, with no new fetch', () => {
    const justFetched = deriveMeterRow(record({ ageMs: 60_000 }), context({ elapsedSinceResponseMs: 0 }));
    expect(justFetched.freshness).toBe('fresh');
    expect(justFetched.displayPercent).toBe(29);
    const muchLater = deriveMeterRow(record({ ageMs: 60_000 }), context({ elapsedSinceResponseMs: 30 * 60_000 }));
    expect(muchLater.freshness).toBe('stale');
    expect(muchLater.displayPercent).toBeNull();
  });
});

describe('usageStripModel — the server-anchored clock', () => {
  const body: DerivedUsageBody = {
    observedNow: '2026-07-21T12:00:00.000Z',
    staleAfterMs: STALE_AFTER_MS,
    pollIntervalMs: 300_000,
    meters: [
      record({ meterId: 'endpoint:weekly_scoped:Fable', kind: 'weekly-cap', scope: 'Fable', percent: 64, isActive: true }),
      record({ meterId: 'endpoint:session', percent: 29, isActive: false }),
      record({ meterId: 'endpoint:weekly_all', kind: 'weekly-cap', scope: null, percent: 52, isActive: false }),
    ],
  };
  const snapshot: UsageSnapshot = { body, receivedAtLocalMs: 1_000_000 };

  it('preserves the DAEMON ordering verbatim — it never re-sorts', () => {
    const model = usageStripModel(snapshot, 1_000_000);
    expect(model.rows.map((row) => row.meterId)).toEqual([
      'endpoint:weekly_scoped:Fable',
      'endpoint:session',
      'endpoint:weekly_all',
    ]);
    expect(model.rows[0]?.isBinding).toBe(true);
    expect(model.rows[0]?.label).toBe('Weekly (Fable)');
    expect(model.rows[0]?.displayPercent).toBe(64);
  });

  it('HEADLINE: a browser clock hours out of step CANNOT make a stale reading look fresh', () => {
    // The reading is 40 minutes old per the daemon — well past the 10m band.
    const staleBody: DerivedUsageBody = { ...body, meters: [record({ ageMs: 40 * 60_000 })] };
    // Three wildly different local clocks, all reading the same snapshot at the
    // moment it landed. Only the DIFFERENCE of two local readings is ever used.
    for (const localClockOrigin of [0, 1_000_000, Date.parse('2031-01-01T00:00:00.000Z')]) {
      const skewed = usageStripModel(
        { body: staleBody, receivedAtLocalMs: localClockOrigin },
        localClockOrigin,
      );
      expect(skewed.rows[0]?.freshness).toBe('stale');
      expect(skewed.rows[0]?.displayPercent).toBeNull();
      expect(skewed.rows[0]?.ageLabel).toBe('updated 40m ago');
    }
  });

  it('never lets a backwards local clock jump make a reading grow YOUNGER', () => {
    const rewound = usageStripModel(snapshot, snapshot.receivedAtLocalMs - 5 * 60_000);
    expect(rewound.rows[0]?.ageMs).toBe(60_000);
  });

  it('a null staleAfterMs flags the missing band and makes every row unknown', () => {
    const noBand = usageStripModel({ body: { ...body, staleAfterMs: null }, receivedAtLocalMs: 0 }, 0);
    expect(noBand.freshnessBandMissing).toBe(true);
    expect(noBand.rows.every((row) => row.freshness === 'unknown')).toBe(true);
    expect(noBand.rows.every((row) => row.displayPercent === null)).toBe(true);
    // The ages are still shown — losing the band does not hide how old things are.
    expect(noBand.rows.every((row) => row.ageLabel !== 'age unknown')).toBe(true);
  });

  it('treats a response that omits staleAfterMs entirely the same way — no local second opinion', () => {
    const omitted = usageStripModel({ body: { ...body, staleAfterMs: undefined }, receivedAtLocalMs: 0 }, 0);
    expect(omitted.freshnessBandMissing).toBe(true);
    expect(omitted.rows.every((row) => row.freshness === 'unknown')).toBe(true);
  });

  it('returns an empty list — not a fabricated zero meter — when there is nothing to show', () => {
    expect(usageStripModel(null, 0).rows).toEqual([]);
    expect(usageStripModel(undefined, 0).rows).toEqual([]);
    expect(usageStripModel({ body: {}, receivedAtLocalMs: 0 }, 0).rows).toEqual([]);
    expect(usageStripModel({ body: { meters: [] }, receivedAtLocalMs: 0 }, 0).rows).toEqual([]);
    expect(usageStripModel({ body: { meters: null }, receivedAtLocalMs: 0 }, 0).rows).toEqual([]);
  });

  it('anchors countdowns to observedNow, not to the local clock', () => {
    const model = usageStripModel(snapshot, snapshot.receivedAtLocalMs + 60_000);
    // 3h19m59s from observedNow, minus the 60s that have elapsed locally.
    expect(model.nowMs).toBe(NOW_MS + 60_000);
    expect(model.rows[1]?.resetLabel).toBe('resets in 3h 18m');
  });

  it('survives an unparseable observedNow without inventing a clock', () => {
    const model = usageStripModel({ body: { ...body, observedNow: 'whenever' }, receivedAtLocalMs: 0 }, 0);
    expect(model.nowMs).toBeNull();
    // Ages still work (they come from the daemon's ageMs); countdowns abstain.
    expect(model.rows[0]?.ageLabel).toBe('updated 1m ago');
    expect(model.rows[0]?.resetLabel).toBeNull();
  });
});

describe('refreshNotice — a throttled or failed refresh is NEVER presented as a successful one', () => {
  function outcome(overrides: Partial<UsageRefreshOutcome> = {}): UsageRefreshOutcome {
    return {
      polled: true,
      throttled: false,
      failureReason: null,
      httpStatus: null,
      nextForcedPollAt: null,
      retryAfterMs: null,
      ...overrides,
    };
  }

  it('reports a real poll as a refresh', () => {
    const notice = refreshNotice(outcome());
    expect(notice?.tone).toBe('success');
    expect(notice?.message).toBe('Refreshed from the usage endpoint.');
  });

  it('HEADLINE: throttled does NOT claim a refresh, and says when the next one is available', () => {
    const notice = refreshNotice(outcome({ polled: false, throttled: true, retryAfterMs: 45_000 }));
    expect(notice?.tone).toBe('throttled');
    expect(notice?.message).toContain('Not refreshed');
    expect(notice?.message).toContain('45s');
    expect(notice?.message).not.toContain('Refreshed from');
  });

  it('handles a throttled response with no retryAfterMs without fabricating a wait', () => {
    const notice = refreshNotice(outcome({ polled: false, throttled: true, retryAfterMs: null }));
    expect(notice?.tone).toBe('throttled');
    expect(notice?.message).toBe('Not refreshed: polled a moment ago.');
  });

  it('HEADLINE: a failure says so, and says the ages below are unchanged', () => {
    const notice = refreshNotice(outcome({ failureReason: 'unauthorized', httpStatus: 401 }));
    expect(notice?.tone).toBe('failed');
    expect(notice?.message).toContain('Refresh failed');
    expect(notice?.message).toContain('HTTP 401');
    expect(notice?.message).toContain('unchanged');
  });

  it('degrades an unrecognized failure reason honestly (rule 0.6)', () => {
    const notice = refreshNotice(outcome({ failureReason: 'brand-new-failure' }));
    expect(notice?.tone).toBe('failed');
    expect(notice?.message).toContain('the refresh failed');
  });

  it('never claims success when nothing actually happened', () => {
    const notice = refreshNotice(outcome({ polled: false }));
    expect(notice?.tone).toBe('failed');
    expect(notice?.message).toBe('Refresh did not run.');
  });

  it('is null before any refresh has been attempted', () => {
    expect(refreshNotice(null)).toBeNull();
    expect(refreshNotice(undefined)).toBeNull();
  });
});
