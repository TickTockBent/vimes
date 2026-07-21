import { describe, expect, it } from 'vitest';
import type { MeterRecord, MetersState } from '@vimes/core';
import {
  STALE_BAND_SLACK_MS_PREVIEW,
  STALE_POLL_INTERVAL_MULTIPLE_PREVIEW,
  buildDerivedUsage,
  deriveStaleAfterMs,
} from './usageDerived.js';

// ─── The derived usage read model (slice 5 step 4b, deliverable 1) ───────────
//
// Every assertion here is about the same invariant said three ways: NULL MEANS
// UNKNOWN, and nothing degrades to 0. A meter we cannot age, cannot rate, cannot
// project must say so rather than serve a confident number.

const NOW_ISO = '2026-07-21T12:00:00.000Z';
const POLL_INTERVAL_MS = 300_000;

function meterRecord(overrides: Partial<MeterRecord> & Pick<MeterRecord, 'meterId'>): MeterRecord {
  return {
    kind: 'rolling-window',
    percent: 50,
    unit: 'percent',
    source: 'endpoint',
    observedAt: NOW_ISO,
    ...overrides,
  };
}

function metersStateOf(records: MeterRecord[], history: MetersState['history'] = {}): MetersState {
  const meters: Record<string, MeterRecord> = {};
  for (const record of records) {
    meters[record.meterId] = record;
  }
  return { meters, history };
}

describe('staleAfterMs is DERIVED from the poll interval (deliverable 1b)', () => {
  it('is the poll interval times the named multiple, plus the named slack', () => {
    expect(deriveStaleAfterMs(POLL_INTERVAL_MS)).toBe(
      POLL_INTERVAL_MS * STALE_POLL_INTERVAL_MULTIPLE_PREVIEW + STALE_BAND_SLACK_MS_PREVIEW,
    );
  });

  it('CHANGING THE POLL INTERVAL CHANGES THE BAND — the one-source-of-record fix', () => {
    // The recorded finding: the cadence and the stale threshold were two
    // independent constants in two packages with nothing enforcing the
    // relationship, so a single missed poll still read "fresh". This assertion
    // is that relationship, made non-optional.
    const bandAtFiveMinutes = deriveStaleAfterMs(300_000);
    const bandAtOneMinute = deriveStaleAfterMs(60_000);
    expect(bandAtFiveMinutes).not.toBe(bandAtOneMinute);
    expect(bandAtFiveMinutes! - bandAtOneMinute!).toBe(
      (300_000 - 60_000) * STALE_POLL_INTERVAL_MULTIPLE_PREVIEW,
    );
  });

  it('is null — NOT 0, NOT infinite — when the poller is disabled', () => {
    expect(deriveStaleAfterMs(0)).toBeNull();
    expect(deriveStaleAfterMs(-1)).toBeNull();
  });

  it('the band is narrower than two poll intervals, so ONE missed poll is visible', () => {
    // The whole point of the finding: the old 10-minute band over a 5-minute
    // cadence let a silently-failing poller look fresh for two whole cycles.
    expect(deriveStaleAfterMs(POLL_INTERVAL_MS)!).toBeLessThan(POLL_INTERVAL_MS * 2);
  });
});

describe('buildDerivedUsage', () => {
  it('reports the three freshness states, and unknown is neither of the others', () => {
    const staleAfterMs = deriveStaleAfterMs(POLL_INTERVAL_MS)!;
    const state = metersStateOf([
      meterRecord({ meterId: 'a-fresh', observedAt: '2026-07-21T11:59:00.000Z' }),
      meterRecord({
        meterId: 'b-stale',
        observedAt: new Date(Date.parse(NOW_ISO) - staleAfterMs - 1_000).toISOString(),
      }),
      meterRecord({ meterId: 'c-unknown', observedAt: 'not-a-timestamp' }),
    ]);
    const body = buildDerivedUsage({ metersState: state, nowIso: NOW_ISO, pollIntervalMs: POLL_INTERVAL_MS });
    const freshnessById = Object.fromEntries(body.meters.map((meter) => [meter.meterId, meter.freshness]));
    expect(freshnessById).toEqual({ 'a-fresh': 'fresh', 'b-stale': 'stale', 'c-unknown': 'unknown' });
  });

  it('ageMs is null on an unparseable observedAt, and a real number otherwise', () => {
    const state = metersStateOf([
      meterRecord({ meterId: 'a-parseable', observedAt: '2026-07-21T11:58:00.000Z' }),
      meterRecord({ meterId: 'b-broken', observedAt: 'yesterday-ish' }),
    ]);
    const body = buildDerivedUsage({ metersState: state, nowIso: NOW_ISO, pollIntervalMs: POLL_INTERVAL_MS });
    expect(body.meters[0]!.ageMs).toBe(120_000);
    // Null, NOT 0 — "we cannot tell how old this is" is not "this is brand new".
    expect(body.meters[1]!.ageMs).toBeNull();
  });

  it('orders the BINDING meter first, then by meterId — deterministically', () => {
    const state = metersStateOf([
      meterRecord({ meterId: 'zzz-not-binding', isActive: false }),
      meterRecord({ meterId: 'aaa-not-binding', isActive: false }),
      meterRecord({ meterId: 'mmm-binding', isActive: true }),
    ]);
    const firstOrdering = buildDerivedUsage({
      metersState: state,
      nowIso: NOW_ISO,
      pollIntervalMs: POLL_INTERVAL_MS,
    }).meters.map((meter) => meter.meterId);
    const secondOrdering = buildDerivedUsage({
      metersState: state,
      nowIso: NOW_ISO,
      pollIntervalMs: POLL_INTERVAL_MS,
    }).meters.map((meter) => meter.meterId);
    expect(firstOrdering).toEqual(['mmm-binding', 'aaa-not-binding', 'zzz-not-binding']);
    // The list must never jitter between fetches.
    expect(secondOrdering).toEqual(firstOrdering);
  });

  it('with NO meters returns the envelope with an empty array — never a 404-shaped absence', () => {
    const body = buildDerivedUsage({
      metersState: { meters: {}, history: {} },
      nowIso: NOW_ISO,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(body.meters).toEqual([]);
    expect(body.observedNow).toBe(NOW_ISO);
    expect(body.pollIntervalMs).toBe(POLL_INTERVAL_MS);
    expect(body.staleAfterMs).not.toBeNull();
  });

  it('NOTHING DEGRADES TO 0: an unobservable meter serves nulls, not zeros', () => {
    const state = metersStateOf([
      meterRecord({ meterId: 'endpoint:mystery', percent: null, observedAt: NOW_ISO }),
    ]);
    const derivedMeter = buildDerivedUsage({
      metersState: state,
      nowIso: NOW_ISO,
      pollIntervalMs: POLL_INTERVAL_MS,
    }).meters[0]!;
    expect(derivedMeter.headroomPercent).toBeNull();
    expect(derivedMeter.burnRatePercentPerHour).toBeNull();
    expect(derivedMeter.projectedExhaustion).toBeNull();
    expect(derivedMeter.projectedExhaustionReason).toBe('percent-unobserved');
    // Explicitly: none of them is 0.
    expect(derivedMeter.headroomPercent).not.toBe(0);
    expect(derivedMeter.burnRatePercentPerHour).not.toBe(0);
  });

  it('carries every MeterRecord field through verbatim, and adds the derived ones', () => {
    const record = meterRecord({
      meterId: 'endpoint:weekly_scoped:Fable',
      kind: 'weekly-cap',
      scope: 'Fable',
      percent: 64,
      severity: 'normal',
      isActive: true,
      resetsAt: '2026-07-23T16:59:59.000Z',
    });
    const derivedMeter = buildDerivedUsage({
      metersState: metersStateOf([record]),
      nowIso: NOW_ISO,
      pollIntervalMs: POLL_INTERVAL_MS,
    }).meters[0]!;
    for (const [key, value] of Object.entries(record)) {
      expect(derivedMeter[key as keyof typeof derivedMeter]).toEqual(value);
    }
    expect(derivedMeter.headroomPercent).toBe(36);
  });

  it('computes a burn rate and a projected exhaustion when the history supports one', () => {
    const record = meterRecord({
      meterId: 'endpoint:session',
      percent: 60,
      observedAt: NOW_ISO,
      resetsAt: '2026-07-22T00:00:00.000Z',
    });
    const state = metersStateOf(
      [record],
      {
        'endpoint:session': [
          { observedAt: '2026-07-21T10:00:00.000Z', percent: 40 },
          { observedAt: NOW_ISO, percent: 60 },
        ],
      },
    );
    const derivedMeter = buildDerivedUsage({
      metersState: state,
      nowIso: NOW_ISO,
      pollIntervalMs: POLL_INTERVAL_MS,
    }).meters[0]!;
    expect(derivedMeter.burnRatePercentPerHour).toBe(10);
    expect(derivedMeter.projectedExhaustion).toBe('2026-07-21T16:00:00.000Z');
    expect(derivedMeter.projectedExhaustionReason).toBe('projected');
  });

  it('pollIntervalMs === 0 makes EVERY meter unknown, never eternally fresh', () => {
    const state = metersStateOf([
      meterRecord({ meterId: 'endpoint:session', observedAt: NOW_ISO }),
      meterRecord({ meterId: 'endpoint:weekly_all', observedAt: NOW_ISO }),
    ]);
    const body = buildDerivedUsage({ metersState: state, nowIso: NOW_ISO, pollIntervalMs: 0 });
    expect(body.staleAfterMs).toBeNull();
    expect(body.meters.map((meter) => meter.freshness)).toEqual(['unknown', 'unknown']);
    // The ages are still reported: we know HOW OLD it is, we just have no band
    // to judge it against.
    expect(body.meters[0]!.ageMs).toBe(0);
  });
});
