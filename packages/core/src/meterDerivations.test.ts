import { describe, expect, it } from 'vitest';
import {
  burnRatePercentPerHour,
  evaluateHeadroomGate,
  headroomPercent,
  meterFreshness,
  projectedExhaustion,
  samplesSinceLastReset,
} from './meterDerivations.js';
import type { MeterHistorySample, MetersState } from './projections/meters.js';
import type { MeterRecord } from './schemas.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function endpointMeter(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    meterId: 'session',
    kind: 'rolling-window',
    scope: null,
    percent: 40,
    severity: 'normal',
    isActive: true,
    resetsAt: null,
    source: 'endpoint',
    observedAt: '2026-07-21T12:00:00.000Z',
    ...overrides,
  };
}

function sampleAt(minutesFromNoon: number, percent: number | null): MeterHistorySample {
  return {
    observedAt: new Date(Date.parse('2026-07-21T12:00:00.000Z') + minutesFromNoon * 60_000).toISOString(),
    percent,
  };
}

function metersStateWith(...records: MeterRecord[]): MetersState {
  const meters: Record<string, MeterRecord> = {};
  for (const record of records) {
    meters[record.meterId] = record;
  }
  return { meters, history: {} };
}

describe('meterFreshness (derived, never stored — three real states)', () => {
  it('is fresh inside the window and stale past it', () => {
    expect(meterFreshness('2026-07-21T12:00:00.000Z', '2026-07-21T12:04:00.000Z', FIVE_MINUTES_MS)).toBe('fresh');
    expect(meterFreshness('2026-07-21T12:00:00.000Z', '2026-07-21T12:06:00.000Z', FIVE_MINUTES_MS)).toBe('stale');
  });

  it('is unknown — not fresh, not stale — with no parseable observation', () => {
    expect(meterFreshness(null, '2026-07-21T12:00:00.000Z', FIVE_MINUTES_MS)).toBe('unknown');
    expect(meterFreshness(undefined, '2026-07-21T12:00:00.000Z', FIVE_MINUTES_MS)).toBe('unknown');
    expect(meterFreshness('not-a-timestamp', '2026-07-21T12:00:00.000Z', FIVE_MINUTES_MS)).toBe('unknown');
    expect(meterFreshness('2026-07-21T12:00:00.000Z', 'not-a-timestamp', FIVE_MINUTES_MS)).toBe('unknown');
  });

  it('reads a stored `stale: true` flag as no evidence at all — freshness comes from observedAt', () => {
    // D26: the deprecated flag can NEVER make a fresh observation look stale or
    // the reverse; the derivation ignores it entirely.
    const staleFlagged = endpointMeter({ stale: true, observedAt: '2026-07-21T12:00:00.000Z' });
    expect(meterFreshness(staleFlagged.observedAt, '2026-07-21T12:01:00.000Z', FIVE_MINUTES_MS)).toBe('fresh');
  });
});

describe('headroomPercent (null is UNKNOWN, distinct from 0)', () => {
  it('is 100 - percent when the percentage was observed', () => {
    expect(headroomPercent(endpointMeter({ percent: 40 }))).toBe(60);
    expect(headroomPercent(endpointMeter({ percent: 100 }))).toBe(0);
  });

  it('is null (unknown) — NOT 0 — when no percentage was observed', () => {
    expect(headroomPercent(endpointMeter({ percent: null }))).toBeNull();
    // A legacy absolutes-only record is unknown headroom too: D26 forbids
    // inventing a percentage the source never gave.
    expect(headroomPercent({ percent: undefined } as unknown as MeterRecord)).toBeNull();
    expect(headroomPercent(undefined)).toBeNull();
  });

  it('clamps an over-cap percentage to zero headroom, never negative', () => {
    expect(headroomPercent(endpointMeter({ percent: 120 }))).toBe(0);
  });
});

describe('burnRatePercentPerHour (reset-aware)', () => {
  it('is a plain slope over a monotonically rising window', () => {
    const history = [sampleAt(0, 10), sampleAt(30, 20), sampleAt(60, 30)];
    expect(burnRatePercentPerHour(history, '2026-07-21T13:00:00.000Z')).toBe(20);
  });

  it('starts a NEW segment at a reset (a DROP in percent) instead of a negative slope', () => {
    // 80 → 90 → reset → 5 → 15 over the half hour after the reset = 20 pts/hour.
    const history = [sampleAt(0, 80), sampleAt(30, 90), sampleAt(60, 5), sampleAt(90, 15)];
    const rate = burnRatePercentPerHour(history, '2026-07-21T14:00:00.000Z');
    expect(rate).toBe(20);
    expect(rate).toBeGreaterThan(0);
    expect(samplesSinceLastReset(history, '2026-07-21T14:00:00.000Z').map((sample) => sample.percent)).toEqual([5, 15]);
  });

  it('is null (unknown) — NOT 0 — with fewer than two usable samples in the current window', () => {
    expect(burnRatePercentPerHour([], '2026-07-21T13:00:00.000Z')).toBeNull();
    expect(burnRatePercentPerHour([sampleAt(0, 10)], '2026-07-21T13:00:00.000Z')).toBeNull();
    // A reset as the newest sample leaves a one-sample window: unknown, not 0.
    expect(burnRatePercentPerHour([sampleAt(0, 90), sampleAt(30, 4)], '2026-07-21T13:00:00.000Z')).toBeNull();
    // Percent-less samples carry no rate.
    expect(burnRatePercentPerHour([sampleAt(0, null), sampleAt(30, null)], '2026-07-21T13:00:00.000Z')).toBeNull();
    // Two samples at the same instant span no time.
    expect(burnRatePercentPerHour([sampleAt(0, 10), sampleAt(0, 20)], '2026-07-21T13:00:00.000Z')).toBeNull();
  });

  it('reports a genuinely flat window as 0 — an observed rate, not an unknown one', () => {
    expect(burnRatePercentPerHour([sampleAt(0, 30), sampleAt(60, 30)], '2026-07-21T13:00:00.000Z')).toBe(0);
  });

  it('ignores samples observed after the injected now, and is order-independent', () => {
    const outOfOrder = [sampleAt(60, 30), sampleAt(0, 10), sampleAt(600, 99)];
    expect(burnRatePercentPerHour(outOfOrder, '2026-07-21T13:00:00.000Z')).toBe(20);
  });
});

describe('projectedExhaustion', () => {
  it('projects forward from the observation at the current burn rate', () => {
    // 10% at 12:00 → 40% at 13:00 is 30 pts/hour; 60 points of headroom remain,
    // so exhaustion is 2 hours after the 13:00 observation.
    const history = [sampleAt(0, 10), sampleAt(30, 20), sampleAt(60, 40)];
    const meter = endpointMeter({ percent: 40, observedAt: '2026-07-21T13:00:00.000Z' });
    expect(burnRatePercentPerHour(history, '2026-07-21T13:00:00.000Z')).toBe(30);
    expect(projectedExhaustion(meter, history, '2026-07-21T13:00:00.000Z')).toBe('2026-07-21T15:00:00.000Z');
  });

  it('returns null when the window RESETS before the projection lands', () => {
    const history = [sampleAt(0, 10), sampleAt(30, 20), sampleAt(60, 40)];
    const meter = endpointMeter({
      percent: 40,
      observedAt: '2026-07-21T13:00:00.000Z',
      resetsAt: '2026-07-21T14:00:00.000Z',
    });
    // Exhaustion would be 16:00, an hour after the window rolls over: a window
    // that resets first never exhausts — say so rather than inventing a time.
    expect(projectedExhaustion(meter, history, '2026-07-21T13:00:00.000Z')).toBeNull();
  });

  it('returns null when the rate is unknown, non-positive, or the meter is already full', () => {
    const risingHistory = [sampleAt(0, 10), sampleAt(60, 30)];
    expect(projectedExhaustion(endpointMeter({ percent: 40 }), [], '2026-07-21T13:00:00.000Z')).toBeNull();
    expect(
      projectedExhaustion(endpointMeter({ percent: 40 }), [sampleAt(0, 40), sampleAt(60, 40)], '2026-07-21T13:00:00.000Z'),
    ).toBeNull();
    expect(projectedExhaustion(endpointMeter({ percent: 100 }), risingHistory, '2026-07-21T13:00:00.000Z')).toBeNull();
    expect(projectedExhaustion(endpointMeter({ percent: null }), risingHistory, '2026-07-21T13:00:00.000Z')).toBeNull();
    expect(projectedExhaustion(null, risingHistory, '2026-07-21T13:00:00.000Z')).toBeNull();
  });
});

describe('evaluateHeadroomGate (I10 groundwork — unknown is NOT pass)', () => {
  const freshNow = '2026-07-21T12:01:00.000Z';

  it('passes only when a fresh observation shows enough headroom', () => {
    const state = metersStateWith(endpointMeter({ percent: 40 }));
    const result = evaluateHeadroomGate({ meterId: 'session', pct: 50 }, state, freshNow, FIVE_MINUTES_MS);
    expect(result.verdict).toBe('pass');
    expect(result.headroomPercent).toBe(60);
    expect(result.freshness).toBe('fresh');
  });

  it('fails when a fresh observation shows too little headroom', () => {
    const state = metersStateWith(endpointMeter({ percent: 95 }));
    const result = evaluateHeadroomGate({ meterId: 'session', pct: 20 }, state, freshNow, FIVE_MINUTES_MS);
    expect(result.verdict).toBe('fail');
    expect(result.headroomPercent).toBe(5);
  });

  it('is UNKNOWN — never pass — when the percentage was never observed', () => {
    const state = metersStateWith(endpointMeter({ percent: null }));
    const result = evaluateHeadroomGate({ meterId: 'session', pct: 20 }, state, freshNow, FIVE_MINUTES_MS);
    expect(result.verdict).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
    expect(result.reason).toBe('percent-unobserved');
    expect(result.headroomPercent).toBeNull();
  });

  it('is UNKNOWN — never pass, and never a number — when the observation is stale', () => {
    const state = metersStateWith(endpointMeter({ percent: 5 }));
    const result = evaluateHeadroomGate(
      { meterId: 'session', pct: 20 },
      state,
      '2026-07-21T12:30:00.000Z',
      FIVE_MINUTES_MS,
    );
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toBe('observation-stale');
    expect(result.freshness).toBe('stale');
    // A stale number is never handed back as if current.
    expect(result.headroomPercent).toBeNull();
  });

  it('is UNKNOWN — never pass — for a meter that was never observed at all', () => {
    const result = evaluateHeadroomGate(
      { meterId: 'weekly_all', pct: 0 },
      metersStateWith(endpointMeter()),
      freshNow,
      FIVE_MINUTES_MS,
    );
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toBe('meter-never-observed');
    // Even a zero-headroom requirement does not pass on an unobserved meter.
    expect(result.verdict).not.toBe('pass');
  });

  it('never returns pass for any unknown-shaped meter, across a sweep', () => {
    const unobservableMeters: MeterRecord[] = [
      endpointMeter({ percent: null }),
      endpointMeter({ percent: null, observedAt: '2026-07-21T00:00:00.000Z' }),
      endpointMeter({ percent: 1, observedAt: 'not-a-timestamp' }),
    ];
    for (const meter of unobservableMeters) {
      const verdict = evaluateHeadroomGate(
        { meterId: 'session', pct: 1 },
        metersStateWith(meter),
        freshNow,
        FIVE_MINUTES_MS,
      ).verdict;
      expect(verdict).toBe('unknown');
    }
  });
});
