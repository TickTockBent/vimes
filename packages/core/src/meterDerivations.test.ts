import { describe, expect, it } from 'vitest';
import {
  burnRatePercentPerHour,
  evaluateHeadroomGate,
  evaluateMeterAlerts,
  headroomPercent,
  meterFreshness,
  projectedExhaustion,
  projectedExhaustionWithReason,
  rememberMeterAlert,
  samplesSinceLastReset,
  WINDOW_IDENTITY_TOLERANCE_MS_PREVIEW,
  type MeterAlertMemory,
} from './meterDerivations.js';
import type { MeterAlertPayload } from './events.js';
import { METER_HISTORY_LIMIT, type MeterHistorySample, type MetersState } from './projections/meters.js';
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

// ---------------------------------------------------------------------------
// slice 5 step 4a — exhaustion reasons + threshold alerts
// ---------------------------------------------------------------------------

// ⟨tune 80% PREVIEW⟩ / ⟨tune 90% PREVIEW⟩ — defined HERE, in the test file, on
// purpose. Rule 0.2: core pins no threshold, so `thresholds` is always supplied
// by the caller and these numbers never leak into packages/core/src.
const PREVIEW_THRESHOLDS_FOR_TESTS = [80, 90];

const FIVE_MINUTES_MS_ALERTS = 5 * 60 * 1000;
const NOON_MS = Date.parse('2026-07-21T12:00:00.000Z');

function isoAt(minutesFromNoon: number): string {
  return new Date(NOON_MS + minutesFromNoon * 60_000).toISOString();
}

function stateWithHistory(meter: MeterRecord, history: MeterHistorySample[]): MetersState {
  return { meters: { [meter.meterId]: meter }, history: { [meter.meterId]: history } };
}

// ── JITTERED `resets_at` — binding on every alert-path test below ────────────
//
// FINDING 2026-07-21 (SHIPPED, calibration.md): the endpoint RECOMPUTES
// `resets_at` on every request, so one window reports many slightly different
// instants. Every test here used to build `resetsAt` from a clean fixed ISO
// literal, which is why 833 tests could not fail on a bug that sent 33 push
// notifications for one crossing. A fixture tidier than production tests
// something other than production — so no alert-path test may use a clean
// literal again.
//
// These are the REAL microsecond suffixes observed live. The last entry exceeds
// one whole second on purpose: the 15:20 dump held `15:19:59.779964`,
// `15:19:59.801817` and `15:20:00.814087` for ONE window, so any fix that only
// truncates to whole seconds (or tolerates exactly 1 s) is still broken.
const OBSERVED_JITTER_MICROSECONDS = [
  374_302, 418_056, 375_408, 900_385, 746_564, 779_964, 801_817, 1_814_087,
];

// Deterministic (rule 0.3): the offset is a function of the poll index alone —
// no clock, no randomness. Produces the live wire shape, six fractional digits
// and an explicit `+00:00` offset.
function jitteredResetsAt(baseIso: string, pollIndex: number): string {
  const jitterMicroseconds =
    OBSERVED_JITTER_MICROSECONDS[pollIndex % OBSERVED_JITTER_MICROSECONDS.length]!;
  const jitteredIso = new Date(
    Date.parse(baseIso) + Math.floor(jitterMicroseconds / 1000),
  ).toISOString();
  const subMillisecondMicroseconds = String(jitterMicroseconds % 1000).padStart(3, '0');
  return `${jitteredIso.slice(0, 23)}${subMillisecondMicroseconds}+00:00`;
}

// The five payloads from the production incident, verbatim: ONE window, five
// consecutive polls, five different strings (spread 0.526 s).
const LIVE_INCIDENT_RESETS_AT_ONE_WINDOW = [
  '2026-07-21T20:39:59.374302+00:00',
  '2026-07-21T20:39:59.418056+00:00',
  '2026-07-21T20:39:59.375408+00:00',
  '2026-07-21T20:39:59.900385+00:00',
  '2026-07-21T20:39:59.746564+00:00',
] as const;

// The 15:20 rollover dump, verbatim: ONE window, and the jitter CROSSES A WHOLE
// SECOND (spread 1.034 s).
const LIVE_RESETS_AT_ACROSS_A_WHOLE_SECOND = [
  '2026-07-21T15:19:59.779964+00:00',
  '2026-07-21T15:19:59.801817+00:00',
  '2026-07-21T15:20:00.814087+00:00',
] as const;

describe('projectedExhaustionWithReason (a null was five different facts)', () => {
  const risingHistory: MeterHistorySample[] = [sampleAt(-60, 40), sampleAt(0, 50)];

  it('names resets-first where the old function only said null', () => {
    const meter = endpointMeter({
      percent: 50,
      observedAt: isoAt(0),
      resetsAt: isoAt(60),
    });
    const reasoned = projectedExhaustionWithReason(meter, risingHistory, isoAt(0));
    expect(reasoned).toEqual({ at: null, reason: 'resets-first' });
    // ...and the old function's output is UNCHANGED by the refactor.
    expect(projectedExhaustion(meter, risingHistory, isoAt(0))).toBeNull();
  });

  it('projects a real instant when the window outlasts the projection', () => {
    const meter = endpointMeter({
      percent: 50,
      observedAt: isoAt(0),
      resetsAt: isoAt(360),
    });
    // 10 %/h burn, 50 points of headroom → five hours out.
    const reasoned = projectedExhaustionWithReason(meter, risingHistory, isoAt(0));
    expect(reasoned).toEqual({ at: isoAt(300), reason: 'projected' });
    expect(projectedExhaustion(meter, risingHistory, isoAt(0))).toBe(reasoned.at);
  });

  it('distinguishes every other cause a bare null used to hide', () => {
    const cases: Array<{
      label: string;
      meter: MeterRecord | null;
      history: MeterHistorySample[];
      reason: string;
    }> = [
      { label: 'never sampled', meter: null, history: risingHistory, reason: 'meter-never-observed' },
      {
        label: 'sampled without a percentage',
        meter: endpointMeter({ percent: null, observedAt: isoAt(0) }),
        history: risingHistory,
        reason: 'percent-unobserved',
      },
      {
        label: 'already at the cap',
        meter: endpointMeter({ percent: 100, observedAt: isoAt(0) }),
        history: risingHistory,
        reason: 'already-exhausted',
      },
      {
        label: 'unparseable observation',
        meter: endpointMeter({ percent: 50, observedAt: 'not-a-timestamp' }),
        history: risingHistory,
        reason: 'observation-unusable',
      },
      {
        label: 'only one sample in the window',
        meter: endpointMeter({ percent: 50, observedAt: isoAt(0) }),
        history: [sampleAt(0, 50)],
        reason: 'burn-rate-unknown',
      },
      {
        label: 'flat usage never reaches the cap',
        meter: endpointMeter({ percent: 50, observedAt: isoAt(0) }),
        history: [sampleAt(-60, 50), sampleAt(0, 50)],
        reason: 'burn-rate-non-positive',
      },
    ];
    for (const testCase of cases) {
      const reasoned = projectedExhaustionWithReason(testCase.meter, testCase.history, isoAt(0));
      expect(reasoned.reason, testCase.label).toBe(testCase.reason);
      expect(reasoned.at, testCase.label).toBeNull();
      // Rule 0.4: the old function's answer is byte-identical for every case.
      expect(projectedExhaustion(testCase.meter, testCase.history, isoAt(0)), testCase.label).toBeNull();
    }
  });
});

describe('evaluateMeterAlerts (edge-triggered — a meter that cries wolf costs more than it gives)', () => {
  it('fires once on the crossing and stays silent for three more polls above the line', () => {
    const observations = [82, 84, 85, 86];
    const history: MeterHistorySample[] = [];
    let memory: MeterAlertMemory = {};
    const emittedThresholds: number[] = [];

    observations.forEach((percent, pollIndex) => {
      const observedAt = isoAt(pollIndex * 10);
      history.push({ observedAt, percent });
      // Jittered per poll, as the real endpoint does — the same window reported
      // with a different `resets_at` string every time.
      const meter = endpointMeter({
        percent,
        observedAt,
        resetsAt: jitteredResetsAt(isoAt(300), pollIndex),
      });
      const alerts = evaluateMeterAlerts(
        stateWithHistory(meter, history),
        memory,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        observedAt,
        FIVE_MINUTES_MS_ALERTS,
      );
      for (const alert of alerts) {
        emittedThresholds.push(alert.thresholdPercent);
        memory = rememberMeterAlert(memory, alert);
      }
    });

    expect(emittedThresholds).toEqual([80]);
  });

  it('carries the observation that triggered it, not "now"', () => {
    const observedAt = isoAt(0);
    const observedResetsAt = jitteredResetsAt(isoAt(300), 0);
    const meter = endpointMeter({
      percent: 83,
      observedAt,
      resetsAt: observedResetsAt,
      scope: 'model.Fable',
    });
    const [alert] = evaluateMeterAlerts(
      stateWithHistory(meter, [{ observedAt, percent: 83 }]),
      {},
      PREVIEW_THRESHOLDS_FOR_TESTS,
      isoAt(2),
      FIVE_MINUTES_MS_ALERTS,
    );
    expect(alert).toEqual({
      meterId: 'session',
      thresholdPercent: 80,
      observedPercent: 83,
      kind: 'rolling-window',
      scope: 'model.Fable',
      // The alert carries the window identity EXACTLY as observed, jitter and
      // all — the tolerance lives in the comparison, never in the recorded value.
      resetsAt: observedResetsAt,
      observedAt,
      disposition: 'notify',
    });
  });

  it('re-arms after a window reset signalled by a DROP in percent', () => {
    const history: MeterHistorySample[] = [
      { observedAt: isoAt(0), percent: 82 },
      { observedAt: isoAt(10), percent: 85 },
      // The rollover: the window emptied.
      { observedAt: isoAt(20), percent: 5 },
      { observedAt: isoAt(30), percent: 81 },
    ];
    const meter = endpointMeter({
      percent: 81,
      observedAt: isoAt(30),
      resetsAt: jitteredResetsAt(isoAt(300), 7),
    });
    // SAME window on the fired alert — but reported with different jitter, as the
    // endpoint really does. Only the percent-drop signal is under test, so the
    // `resetsAt` signal must read these two strings as one window.
    const staleWindowMemory: MeterAlertMemory = {
      session: [
        { thresholdPercent: 80, resetsAt: jitteredResetsAt(isoAt(300), 0), observedAt: isoAt(0) },
      ],
    };
    const alerts = evaluateMeterAlerts(
      stateWithHistory(meter, history),
      staleWindowMemory,
      PREVIEW_THRESHOLDS_FOR_TESTS,
      isoAt(30),
      FIVE_MINUTES_MS_ALERTS,
    );
    expect(alerts.map((alert) => alert.thresholdPercent)).toEqual([80]);

    // Control: an alert fired INSIDE the current window still suppresses.
    const currentWindowMemory: MeterAlertMemory = {
      session: [
        { thresholdPercent: 80, resetsAt: jitteredResetsAt(isoAt(300), 3), observedAt: isoAt(25) },
      ],
    };
    expect(
      evaluateMeterAlerts(
        stateWithHistory(meter, history),
        currentWindowMemory,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(30),
        FIVE_MINUTES_MS_ALERTS,
      ),
    ).toEqual([]);
  });

  it('re-arms after a window reset signalled by a CHANGED resetsAt', () => {
    // Percent never drops, so the only reset evidence is the source's own
    // resetsAt moving to the next window.
    const history: MeterHistorySample[] = [
      { observedAt: isoAt(0), percent: 82 },
      { observedAt: isoAt(10), percent: 85 },
    ];
    const meter = endpointMeter({
      percent: 85,
      observedAt: isoAt(10),
      resetsAt: jitteredResetsAt(isoAt(600), 2),
    });
    const priorWindowMemory: MeterAlertMemory = {
      session: [
        { thresholdPercent: 80, resetsAt: jitteredResetsAt(isoAt(300), 5), observedAt: isoAt(0) },
      ],
    };
    expect(
      evaluateMeterAlerts(
        stateWithHistory(meter, history),
        priorWindowMemory,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(10),
        FIVE_MINUTES_MS_ALERTS,
      ).map((alert) => alert.thresholdPercent),
    ).toEqual([80]);

    // Control: the SAME window — differently jittered — keeps the alert binding.
    const sameWindowMemory: MeterAlertMemory = {
      session: [
        { thresholdPercent: 80, resetsAt: jitteredResetsAt(isoAt(600), 7), observedAt: isoAt(0) },
      ],
    };
    expect(
      evaluateMeterAlerts(
        stateWithHistory(meter, history),
        sameWindowMemory,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(10),
        FIVE_MINUTES_MS_ALERTS,
      ),
    ).toEqual([]);
  });

  // THE HEADLINE TEST. Waking someone's phone over a number we cannot vouch for
  // is the lying meter pillar 4 forbids — and it is worse than silence, because
  // the human acts on it.
  it('NEVER alerts on a non-fresh observation, however alarming the number', () => {
    const staleMeter = endpointMeter({
      percent: 99,
      observedAt: isoAt(0),
      resetsAt: jitteredResetsAt(isoAt(300), 1),
    });
    expect(
      evaluateMeterAlerts(
        stateWithHistory(staleMeter, [{ observedAt: isoAt(0), percent: 99 }]),
        {},
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(6), // six minutes on a five-minute staleness window
        FIVE_MINUTES_MS_ALERTS,
      ),
    ).toEqual([]);

    const unknownFreshnessMeter = endpointMeter({ percent: 99, observedAt: 'not-a-timestamp' });
    expect(
      evaluateMeterAlerts(
        stateWithHistory(unknownFreshnessMeter, []),
        {},
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(0),
        FIVE_MINUTES_MS_ALERTS,
      ),
    ).toEqual([]);
  });

  it('treats an absent percent as unknown — not as 0, and not as 100', () => {
    const observedAt = isoAt(0);
    for (const [absentPercentIndex, absentPercent] of [null, undefined].entries()) {
      const meter = endpointMeter({
        percent: absentPercent,
        observedAt,
        resetsAt: jitteredResetsAt(isoAt(300), absentPercentIndex),
      });
      // Thresholds at BOTH ends: a 0-collapse would cross 0, a 100-collapse
      // would cross 100. Neither may fire.
      expect(
        evaluateMeterAlerts(
          stateWithHistory(meter, [{ observedAt, percent: null }]),
          {},
          [0, 80, 100],
          observedAt,
          FIVE_MINUTES_MS_ALERTS,
        ),
      ).toEqual([]);
    }
  });

  it('emits ONE alert for the highest threshold when a poll jumps across several', () => {
    const observedAt = isoAt(0);
    const jumpingHistory: MeterHistorySample[] = [
      { observedAt: isoAt(-10), percent: 70 },
      { observedAt, percent: 92 },
    ];
    const meter = endpointMeter({
      percent: 92,
      observedAt,
      resetsAt: jitteredResetsAt(isoAt(300), 0),
    });
    const alerts = evaluateMeterAlerts(
      stateWithHistory(meter, jumpingHistory),
      {},
      PREVIEW_THRESHOLDS_FOR_TESTS,
      observedAt,
      FIVE_MINUTES_MS_ALERTS,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.thresholdPercent).toBe(90);
    expect(alerts[0]!.observedPercent).toBe(92);

    // BOTH thresholds count as fired afterwards: the 80 line must not buzz on a
    // later poll just because it was skipped over on this one.
    const memoryAfterJump = rememberMeterAlert({}, alerts[0]!);
    const laterObservedAt = isoAt(10);
    const laterHistory = [...jumpingHistory, { observedAt: laterObservedAt, percent: 93 }];
    const laterMeter = endpointMeter({
      percent: 93,
      observedAt: laterObservedAt,
      // Same window, next poll, different string.
      resetsAt: jitteredResetsAt(isoAt(300), 1),
    });
    expect(
      evaluateMeterAlerts(
        stateWithHistory(laterMeter, laterHistory),
        memoryAfterJump,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        laterObservedAt,
        FIVE_MINUTES_MS_ALERTS,
      ),
    ).toEqual([]);
  });

  it('emits at most one alert per meter and orders output deterministically', () => {
    const observedAt = isoAt(0);
    const state: MetersState = {
      meters: {
        weekly_scoped: endpointMeter({
          meterId: 'weekly_scoped',
          kind: 'weekly-cap',
          percent: 95,
          observedAt,
          resetsAt: jitteredResetsAt(isoAt(600), 4),
        }),
        session: endpointMeter({
          meterId: 'session',
          percent: 91,
          observedAt,
          resetsAt: jitteredResetsAt(isoAt(300), 2),
        }),
      },
      history: {},
    };
    const alerts = evaluateMeterAlerts(
      state,
      {},
      PREVIEW_THRESHOLDS_FOR_TESTS,
      observedAt,
      FIVE_MINUTES_MS_ALERTS,
    );
    expect(alerts.map((alert) => alert.meterId)).toEqual(['session', 'weekly_scoped']);
    expect(alerts.map((alert) => alert.thresholdPercent)).toEqual([90, 90]);
  });

  // Rule 0.5 reservation: 'hold' is slice-7 brake vocabulary. Slice 5 has NO
  // code path that sets it, and this sweep is the standing proof.
  it("only ever emits disposition 'notify' — nothing in core sets the reserved 'hold'", () => {
    const observedAt = isoAt(0);
    const emittedDispositions = new Set<string>();
    for (const [percentIndex, percent] of [80, 85, 90, 99, 100, 140].entries()) {
      const meter = endpointMeter({
        percent,
        observedAt,
        resetsAt: jitteredResetsAt(isoAt(300), percentIndex),
      });
      for (const alert of evaluateMeterAlerts(
        stateWithHistory(meter, [{ observedAt, percent }]),
        {},
        PREVIEW_THRESHOLDS_FOR_TESTS,
        observedAt,
        FIVE_MINUTES_MS_ALERTS,
      )) {
        emittedDispositions.add(alert.disposition);
      }
    }
    expect([...emittedDispositions]).toEqual(['notify']);
  });
});

// ---------------------------------------------------------------------------
// slice 5 step 4a FIX — bounded history must not masquerade as a window reset
// (FINDING 2026-07-21, docs/calibration.md)
// ---------------------------------------------------------------------------

const WEEKLY_POLL_INTERVAL_MS = 5 * 60 * 1000;
const WEEKLY_STALE_AFTER_MS = 11 * 60 * 1000;
const WEEKLY_RESETS_AT = '2026-07-27T00:00:00.000Z';
const WEEKLY_METER_ID = 'endpoint:weekly_all';

// A full, saturated history buffer whose percent only ever RISES: the window
// demonstrably has not rolled over, and no reset boundary exists inside the
// retained span. At METER_HISTORY_LIMIT samples and a 5-minute cadence this
// spans only ~5h20m, however long the meter's real window is.
function saturatedRisingWeeklyState(
  latestObservedAtMs: number,
  latestPercent: number,
  resetsAtBaseIso: string = WEEKLY_RESETS_AT,
  // Which observed jitter suffix this poll's `resets_at` carries. Weekly caps
  // are jittered by the endpoint exactly like the session meter is.
  resetsAtJitterIndex = 0,
): MetersState {
  const history: MeterHistorySample[] = [];
  for (let samplesBack = METER_HISTORY_LIMIT - 1; samplesBack >= 0; samplesBack -= 1) {
    history.push({
      observedAt: new Date(latestObservedAtMs - samplesBack * WEEKLY_POLL_INTERVAL_MS).toISOString(),
      percent: latestPercent - samplesBack * 0.01,
    });
  }
  const weeklyMeter = endpointMeter({
    meterId: WEEKLY_METER_ID,
    kind: 'weekly-cap',
    percent: latestPercent,
    resetsAt: jitteredResetsAt(resetsAtBaseIso, resetsAtJitterIndex),
    observedAt: new Date(latestObservedAtMs).toISOString(),
  });
  return { meters: { [WEEKLY_METER_ID]: weeklyMeter }, history: { [WEEKLY_METER_ID]: history } };
}

describe('evaluateMeterAlerts across a bounded history (absence of a reset is not a reset)', () => {
  const weeklyThresholds = [80];
  const firstObservationMs = Date.parse('2026-07-21T12:00:00.000Z');
  const sixHoursLaterMs = firstObservationMs + 6 * 60 * 60 * 1000;

  function fireFirstWeeklyAlert(): MeterAlertMemory {
    const firstState = saturatedRisingWeeklyState(firstObservationMs, 82);
    const firstAlerts = evaluateMeterAlerts(
      firstState,
      {},
      weeklyThresholds,
      new Date(firstObservationMs).toISOString(),
      WEEKLY_STALE_AFTER_MS,
    );
    expect(firstAlerts).toHaveLength(1);
    let memory: MeterAlertMemory = {};
    for (const alert of firstAlerts) {
      memory = rememberMeterAlert(memory, alert);
    }
    return memory;
  }

  // THE FINDING. A weekly meter parked above the line would otherwise re-alert
  // every ~5h20m — once per turnover of the sample buffer — forever.
  it('does NOT re-alert a weekly threshold when the buffer turned over but the window did not', () => {
    const memoryFromFirstCrossing = fireFirstWeeklyAlert();
    // Six hours on: every retained sample is now NEWER than the fired alert, but
    // the window is unchanged and percent has only risen. Nothing reset —
    // `resets_at` is merely re-jittered, and index 7 crosses a whole second.
    const laterState = saturatedRisingWeeklyState(sixHoursLaterMs, 84, WEEKLY_RESETS_AT, 7);
    expect(
      evaluateMeterAlerts(
        laterState,
        memoryFromFirstCrossing,
        weeklyThresholds,
        new Date(sixHoursLaterMs).toISOString(),
        WEEKLY_STALE_AFTER_MS,
      ),
    ).toEqual([]);
  });

  // The mirror: abstaining must not make alerts permanent.
  it('DOES re-alert the same weekly meter once resetsAt moves to the next window', () => {
    const memoryFromFirstCrossing = fireFirstWeeklyAlert();
    const rolledOverState = saturatedRisingWeeklyState(
      sixHoursLaterMs,
      84,
      '2026-08-03T00:00:00.000Z',
      3,
    );
    expect(
      evaluateMeterAlerts(
        rolledOverState,
        memoryFromFirstCrossing,
        weeklyThresholds,
        new Date(sixHoursLaterMs).toISOString(),
        WEEKLY_STALE_AFTER_MS,
      ).map((alert) => alert.thresholdPercent),
    ).toEqual([80]);
  });

  // Positive evidence still re-arms: the case that already worked keeps working.
  it('DOES re-alert when a genuine percent DROP sits inside the retained history', () => {
    const memoryFromFirstCrossing = fireFirstWeeklyAlert();
    const stateWithObservedDrop = saturatedRisingWeeklyState(
      sixHoursLaterMs,
      84,
      WEEKLY_RESETS_AT,
      5,
    );
    const retainedHistory = stateWithObservedDrop.history[WEEKLY_METER_ID]!;
    // Plant the rollover mid-buffer: everything after it is the new window, and
    // the fired alert (older still) falls before that observed window start.
    const dropIndex = Math.floor(retainedHistory.length / 2);
    retainedHistory[dropIndex] = { observedAt: retainedHistory[dropIndex]!.observedAt, percent: 3 };
    expect(
      evaluateMeterAlerts(
        stateWithObservedDrop,
        memoryFromFirstCrossing,
        weeklyThresholds,
        new Date(sixHoursLaterMs).toISOString(),
        WEEKLY_STALE_AFTER_MS,
      ).map((alert) => alert.thresholdPercent),
    ).toEqual([80]);
  });

  it('stays suppressed for a meter with NO history at all and an unchanged resetsAt', () => {
    const historylessMeter = endpointMeter({
      meterId: WEEKLY_METER_ID,
      kind: 'weekly-cap',
      percent: 84,
      resetsAt: jitteredResetsAt(WEEKLY_RESETS_AT, 6),
      observedAt: new Date(sixHoursLaterMs).toISOString(),
    });
    const historylessState: MetersState = {
      meters: { [WEEKLY_METER_ID]: historylessMeter },
      history: { [WEEKLY_METER_ID]: [] },
    };
    const memoryFromEarlierCrossing: MeterAlertMemory = {
      [WEEKLY_METER_ID]: [
        {
          thresholdPercent: 80,
          resetsAt: jitteredResetsAt(WEEKLY_RESETS_AT, 0),
          observedAt: new Date(firstObservationMs).toISOString(),
        },
      ],
    };
    expect(
      evaluateMeterAlerts(
        historylessState,
        memoryFromEarlierCrossing,
        weeklyThresholds,
        new Date(sixHoursLaterMs).toISOString(),
        WEEKLY_STALE_AFTER_MS,
      ),
    ).toEqual([]);
  });

  // The fix widened the ONE reset detector's return rather than adding a second
  // one, so the other consumers of that detector must be bit-for-bit unmoved.
  it('leaves burnRatePercentPerHour, samplesSinceLastReset and projectedExhaustion outputs unchanged', () => {
    const risingHistory = [sampleAt(0, 10), sampleAt(30, 20), sampleAt(60, 30)];
    expect(burnRatePercentPerHour(risingHistory, '2026-07-21T13:00:00.000Z')).toBe(20);

    const historyWithReset = [sampleAt(0, 80), sampleAt(30, 90), sampleAt(60, 5), sampleAt(90, 15)];
    expect(burnRatePercentPerHour(historyWithReset, '2026-07-21T14:00:00.000Z')).toBe(20);
    expect(
      samplesSinceLastReset(historyWithReset, '2026-07-21T14:00:00.000Z').map((sample) => sample.percent),
    ).toEqual([5, 15]);
    // No reset in the span: the segment is still EVERYTHING held, unchanged.
    expect(
      samplesSinceLastReset(risingHistory, '2026-07-21T13:00:00.000Z').map((sample) => sample.percent),
    ).toEqual([10, 20, 30]);

    const projectingMeter = endpointMeter({
      percent: 50,
      observedAt: isoAt(0),
      resetsAt: '2026-07-27T00:00:00.000Z',
    });
    expect(projectedExhaustion(projectingMeter, [sampleAt(-60, 40), sampleAt(0, 50)], isoAt(0))).toBe(
      '2026-07-21T17:00:00.000Z',
    );
  });
});

// ---------------------------------------------------------------------------
// slice 5 — `resets_at` JITTER (FINDING 2026-07-21, SHIPPED: 33 notifications
// for one 80% crossing). docs/calibration.md.
//
// The bug's whole nature is that the fixtures were too tidy: every alert-path
// test built `resetsAt` from a clean fixed ISO literal, so 833 tests could not
// fail on it. This block is the direct property, driven by the REAL payloads.
// ---------------------------------------------------------------------------

const JITTER_METER_ID = 'endpoint:session';
const JITTER_STALE_AFTER_MS = 11 * 60 * 1000;
const JITTER_POLL_INTERVAL_MS = 5 * 60 * 1000;
// The live daemon ran ONE threshold on the day of the incident, and all 33
// `meter_alert` events carried `thresholdPercent: 80`. Replays of the incident
// use that configuration, so a second alert can only mean a spurious re-arm.
const INCIDENT_THRESHOLDS = [80];

// The production incident's observed percentages, in order: 81, 82, 87, 87, 88,
// then 91 twenty-two times, then 94 five times. Monotonically non-decreasing
// throughout — the percent-drop signal correctly said "same window" the entire
// time and was overruled by jitter in the other signal.
const PRODUCTION_INCIDENT_PERCENTS: readonly number[] = [
  81,
  82,
  87,
  87,
  88,
  ...Array.from({ length: 22 }, () => 91),
  ...Array.from({ length: 5 }, () => 94),
  // Carried a little further than the incident itself, still never dropping.
  95,
  96,
  97,
  98,
  99,
];

// Replay N polls of one meter that never drops below the threshold and whose
// `resets_at` is re-jittered every poll, and return every threshold that fired.
function replayJitteredPolls(
  percentSequence: readonly number[],
  resetsAtSequence: readonly string[],
  thresholds: number[] = PREVIEW_THRESHOLDS_FOR_TESTS,
): number[] {
  const history: MeterHistorySample[] = [];
  const firedThresholds: number[] = [];
  let memory: MeterAlertMemory = {};

  percentSequence.forEach((percent, pollIndex) => {
    const observedAt = new Date(NOON_MS + pollIndex * JITTER_POLL_INTERVAL_MS).toISOString();
    history.push({ observedAt, percent });
    const meter = endpointMeter({
      meterId: JITTER_METER_ID,
      percent,
      observedAt,
      resetsAt: resetsAtSequence[pollIndex % resetsAtSequence.length]!,
    });
    for (const alert of evaluateMeterAlerts(
      stateWithHistory(meter, history),
      memory,
      thresholds,
      observedAt,
      JITTER_STALE_AFTER_MS,
    )) {
      firedThresholds.push(alert.thresholdPercent);
      memory = rememberMeterAlert(memory, alert);
    }
  });

  return firedThresholds;
}

describe('evaluateMeterAlerts against a JITTERED resets_at (the shipped 33-notification bug)', () => {
  // THE HEADLINE PROPERTY. This is the production incident, replayed: a rising
  // percent above the line, never dropping, with the endpoint handing back a
  // different `resets_at` string on every poll. One crossing is one alert.
  it('fires EXACTLY ONCE across 33 polls of a rising percent with re-jittered resets_at', () => {
    expect(PRODUCTION_INCIDENT_PERCENTS.length).toBeGreaterThanOrEqual(33);
    expect(
      replayJitteredPolls(
        PRODUCTION_INCIDENT_PERCENTS,
        LIVE_INCIDENT_RESETS_AT_ONE_WINDOW,
        // The production configuration on the day: ONE line, at 80. All 33
        // events carried thresholdPercent 80.
        INCIDENT_THRESHOLDS,
      ),
    ).toEqual([80]);
  });

  // The same property against the OTHER real dump, whose jitter crosses a whole
  // second — the shape that defeats "just truncate to whole seconds".
  it('fires exactly once when the jitter straddles a whole-second boundary', () => {
    expect(
      replayJitteredPolls(
        PRODUCTION_INCIDENT_PERCENTS,
        LIVE_RESETS_AT_ACROSS_A_WHOLE_SECOND,
        INCIDENT_THRESHOLDS,
      ),
    ).toEqual([80]);
    // Guard the fixture itself: these really are on opposite sides of a second.
    expect(LIVE_RESETS_AT_ACROSS_A_WHOLE_SECOND[0].slice(0, 19)).not.toBe(
      LIVE_RESETS_AT_ACROSS_A_WHOLE_SECOND[2].slice(0, 19),
    );
  });

  // The tolerance's own edges, expressed against the exported band rather than
  // against a number copied into the test (rule 0.2 — nothing is pinned here).
  it('reads a gap just inside the band as one window and just outside it as two', () => {
    const firedObservedAt = isoAt(0);
    const laterObservedAt = isoAt(10);
    const baseResetsAtMs = Date.parse(isoAt(300));
    const memoryFor = (resetsAt: string): MeterAlertMemory => ({
      [JITTER_METER_ID]: [{ thresholdPercent: 80, resetsAt, observedAt: firedObservedAt }],
    });
    const risingHistory: MeterHistorySample[] = [
      { observedAt: firedObservedAt, percent: 82 },
      { observedAt: laterObservedAt, percent: 85 },
    ];
    const evaluateAgainst = (firedResetsAt: string, currentResetsAt: string): number[] => {
      const meter = endpointMeter({
        meterId: JITTER_METER_ID,
        percent: 85,
        observedAt: laterObservedAt,
        resetsAt: currentResetsAt,
      });
      return evaluateMeterAlerts(
        stateWithHistory(meter, risingHistory),
        memoryFor(firedResetsAt),
        PREVIEW_THRESHOLDS_FOR_TESTS,
        laterObservedAt,
        JITTER_STALE_AFTER_MS,
      ).map((alert) => alert.thresholdPercent);
    };
    const baseResetsAtIso = new Date(baseResetsAtMs).toISOString();
    const justInsideBandIso = new Date(
      baseResetsAtMs + WINDOW_IDENTITY_TOLERANCE_MS_PREVIEW,
    ).toISOString();
    const justOutsideBandIso = new Date(
      baseResetsAtMs + WINDOW_IDENTITY_TOLERANCE_MS_PREVIEW + 1,
    ).toISOString();
    expect(evaluateAgainst(baseResetsAtIso, justInsideBandIso)).toEqual([]);
    expect(evaluateAgainst(baseResetsAtIso, justOutsideBandIso)).toEqual([80]);
  });

  // GENUINE ROLLOVER, SHAPE 1 — the one observed live at 15:20: percent falls to
  // zero and `resets_at` DISAPPEARS entirely. Absence is not a near-value, so the
  // tolerance must not swallow it.
  it('still re-arms when the window really rolls over and resets_at VANISHES', () => {
    const rolloverHistory: MeterHistorySample[] = [
      { observedAt: isoAt(0), percent: 88 },
      { observedAt: isoAt(5), percent: 91 },
      // 15:21:27Z in the live dump: percent 0, no resets_at at all.
      { observedAt: isoAt(10), percent: 0 },
      { observedAt: isoAt(15), percent: 84 },
    ];
    const meterAfterRollover = endpointMeter({
      meterId: JITTER_METER_ID,
      percent: 84,
      observedAt: isoAt(15),
      resetsAt: null,
    });
    const memoryFromPriorWindow: MeterAlertMemory = {
      [JITTER_METER_ID]: [
        {
          thresholdPercent: 80,
          resetsAt: LIVE_RESETS_AT_ACROSS_A_WHOLE_SECOND[0],
          observedAt: isoAt(0),
        },
      ],
    };
    expect(
      evaluateMeterAlerts(
        stateWithHistory(meterAfterRollover, rolloverHistory),
        memoryFromPriorWindow,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(15),
        JITTER_STALE_AFTER_MS,
      ).map((alert) => alert.thresholdPercent),
    ).toEqual([80]);
  });

  // GENUINE ROLLOVER, SHAPE 2 — the percent DROP, with `resets_at` still present
  // and jittered on both sides. The drop alone must re-arm; the tolerance must
  // not make the alert permanent.
  it('still re-arms on an observed percent DROP while resets_at keeps jittering', () => {
    const rolloverHistory: MeterHistorySample[] = [
      { observedAt: isoAt(0), percent: 88 },
      { observedAt: isoAt(5), percent: 91 },
      { observedAt: isoAt(10), percent: 0 },
      { observedAt: isoAt(15), percent: 84 },
    ];
    const meterAfterRollover = endpointMeter({
      meterId: JITTER_METER_ID,
      percent: 84,
      observedAt: isoAt(15),
      resetsAt: LIVE_INCIDENT_RESETS_AT_ONE_WINDOW[3],
    });
    const memoryFromPriorWindow: MeterAlertMemory = {
      [JITTER_METER_ID]: [
        {
          thresholdPercent: 80,
          // Same window by the tolerance — so ONLY the drop can re-arm here.
          resetsAt: LIVE_INCIDENT_RESETS_AT_ONE_WINDOW[0],
          observedAt: isoAt(0),
        },
      ],
    };
    expect(
      evaluateMeterAlerts(
        stateWithHistory(meterAfterRollover, rolloverHistory),
        memoryFromPriorWindow,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(15),
        JITTER_STALE_AFTER_MS,
      ).map((alert) => alert.thresholdPercent),
    ).toEqual([80]);
  });

  // GENUINE ROLLOVER, SHAPE 3 — the window returning from zero: `resets_at` was
  // absent and comes BACK. null↔non-null is a hard change, never a near-value.
  it('still re-arms when resets_at REAPPEARS after a window sat at zero', () => {
    const returningHistory: MeterHistorySample[] = [
      { observedAt: isoAt(0), percent: 82 },
      { observedAt: isoAt(5), percent: 85 },
    ];
    const meterWithResetsAtBack = endpointMeter({
      meterId: JITTER_METER_ID,
      percent: 85,
      observedAt: isoAt(5),
      resetsAt: LIVE_INCIDENT_RESETS_AT_ONE_WINDOW[1],
    });
    const memoryFromTheZeroWindow: MeterAlertMemory = {
      [JITTER_METER_ID]: [{ thresholdPercent: 80, resetsAt: null, observedAt: isoAt(0) }],
    };
    expect(
      evaluateMeterAlerts(
        stateWithHistory(meterWithResetsAtBack, returningHistory),
        memoryFromTheZeroWindow,
        PREVIEW_THRESHOLDS_FOR_TESTS,
        isoAt(5),
        JITTER_STALE_AFTER_MS,
      ).map((alert) => alert.thresholdPercent),
    ).toEqual([80]);
  });

  // The fixture guard the finding demands: if anyone ever re-tidies these back
  // into one clean literal, this goes red rather than going quiet.
  it('keeps its fixtures UNTIDY — the real payloads differ from each other', () => {
    expect(new Set(LIVE_INCIDENT_RESETS_AT_ONE_WINDOW).size).toBe(5);
    expect(new Set(LIVE_RESETS_AT_ACROSS_A_WHOLE_SECOND).size).toBe(3);
    const jitteredAcrossPolls = OBSERVED_JITTER_MICROSECONDS.map((_, pollIndex) =>
      jitteredResetsAt(isoAt(300), pollIndex),
    );
    expect(new Set(jitteredAcrossPolls).size).toBe(OBSERVED_JITTER_MICROSECONDS.length);
  });
});

// ---------------------------------------------------------------------------
// slice 5 step 4a FIX 2 — THE LIVE INCIDENT, replayed from the event log
// (FINDING 2026-07-21 SHIPPED, docs/calibration.md: 33 alerts, one crossing)
// ---------------------------------------------------------------------------
//
// Every row below is VERBATIM from `~/.vimes/events.db` — the `meter_sample`
// events for `endpoint:session` between 18:03:44Z and 20:48:44Z on 2026-07-21,
// the run that woke Wes's phone 33 times. Nothing is rounded, nothing is
// tidied, and the `resets_at` strings are exactly the ones the endpoint sent:
// they wander by up to 1.877 s across one window and straddle a whole second
// (`20:39:59.085393` … `20:40:00.613064`).
//
// This is the fixture the finding demands. The suite could not fail on this bug
// because every alert-path fixture was cleaner than production.

interface LiveMeterPoll {
  observedAt: string;
  percent: number;
  resetsAt: string | null;
}

// 18:03 → 20:38: percent rises 78 → 94 MONOTONICALLY, so the percent-drop
// signal abstains for the whole run and `resetsAt` is provably the sole cause.
const LIVE_SESSION_POLLS_ONE_WINDOW: readonly LiveMeterPoll[] = [
  { observedAt: '2026-07-21T18:03:44.199Z', percent: 78, resetsAt: '2026-07-21T20:40:00.408142+00:00' },
  { observedAt: '2026-07-21T18:04:15.183Z', percent: 78, resetsAt: '2026-07-21T20:40:00.488268+00:00' },
  { observedAt: '2026-07-21T18:08:14.185Z', percent: 81, resetsAt: '2026-07-21T20:39:59.374302+00:00' },
  { observedAt: '2026-07-21T18:08:44.198Z', percent: 82, resetsAt: '2026-07-21T20:39:59.418056+00:00' },
  { observedAt: '2026-07-21T18:13:44.199Z', percent: 87, resetsAt: '2026-07-21T20:39:59.375408+00:00' },
  { observedAt: '2026-07-21T18:14:16.554Z', percent: 87, resetsAt: '2026-07-21T20:39:59.900385+00:00' },
  { observedAt: '2026-07-21T18:16:39.519Z', percent: 88, resetsAt: '2026-07-21T20:39:59.746564+00:00' },
  { observedAt: '2026-07-21T18:28:44.200Z', percent: 91, resetsAt: '2026-07-21T20:40:00.398757+00:00' },
  { observedAt: '2026-07-21T18:32:35.887Z', percent: 91, resetsAt: '2026-07-21T20:39:59.085393+00:00' },
  { observedAt: '2026-07-21T18:38:44.199Z', percent: 91, resetsAt: '2026-07-21T20:39:59.422687+00:00' },
  { observedAt: '2026-07-21T18:43:44.199Z', percent: 91, resetsAt: '2026-07-21T20:40:00.393012+00:00' },
  { observedAt: '2026-07-21T18:48:44.201Z', percent: 91, resetsAt: '2026-07-21T20:40:00.463237+00:00' },
  { observedAt: '2026-07-21T18:53:44.200Z', percent: 91, resetsAt: '2026-07-21T20:40:00.373139+00:00' },
  { observedAt: '2026-07-21T18:58:44.201Z', percent: 91, resetsAt: '2026-07-21T20:40:00.403540+00:00' },
  { observedAt: '2026-07-21T19:03:44.202Z', percent: 91, resetsAt: '2026-07-21T20:40:00.445663+00:00' },
  { observedAt: '2026-07-21T19:08:44.201Z', percent: 91, resetsAt: '2026-07-21T20:40:00.406885+00:00' },
  { observedAt: '2026-07-21T19:11:32.012Z', percent: 91, resetsAt: '2026-07-21T20:40:00.354152+00:00' },
  { observedAt: '2026-07-21T19:13:44.203Z', percent: 91, resetsAt: '2026-07-21T20:40:00.584196+00:00' },
  { observedAt: '2026-07-21T19:18:44.204Z', percent: 91, resetsAt: '2026-07-21T20:40:00.452377+00:00' },
  { observedAt: '2026-07-21T19:23:44.204Z', percent: 91, resetsAt: '2026-07-21T20:40:00.382230+00:00' },
  { observedAt: '2026-07-21T19:28:44.204Z', percent: 91, resetsAt: '2026-07-21T20:40:00.396697+00:00' },
  { observedAt: '2026-07-21T19:33:44.204Z', percent: 91, resetsAt: '2026-07-21T20:40:00.487153+00:00' },
  { observedAt: '2026-07-21T19:38:44.208Z', percent: 91, resetsAt: '2026-07-21T20:40:00.383604+00:00' },
  { observedAt: '2026-07-21T19:43:44.208Z', percent: 91, resetsAt: '2026-07-21T20:40:00.460951+00:00' },
  { observedAt: '2026-07-21T19:48:44.208Z', percent: 91, resetsAt: '2026-07-21T20:40:00.403094+00:00' },
  { observedAt: '2026-07-21T19:53:44.209Z', percent: 91, resetsAt: '2026-07-21T20:40:00.496197+00:00' },
  { observedAt: '2026-07-21T19:58:44.211Z', percent: 91, resetsAt: '2026-07-21T20:40:00.457116+00:00' },
  { observedAt: '2026-07-21T20:03:44.212Z', percent: 91, resetsAt: '2026-07-21T20:40:00.613064+00:00' },
  { observedAt: '2026-07-21T20:08:44.211Z', percent: 91, resetsAt: '2026-07-21T20:40:00.456470+00:00' },
  { observedAt: '2026-07-21T20:13:44.211Z', percent: 91, resetsAt: '2026-07-21T20:40:00.490933+00:00' },
  { observedAt: '2026-07-21T20:18:44.213Z', percent: 94, resetsAt: '2026-07-21T20:40:00.396162+00:00' },
  { observedAt: '2026-07-21T20:23:44.214Z', percent: 94, resetsAt: '2026-07-21T20:40:00.410549+00:00' },
  { observedAt: '2026-07-21T20:28:44.213Z', percent: 94, resetsAt: '2026-07-21T20:40:00.382701+00:00' },
  { observedAt: '2026-07-21T20:33:44.215Z', percent: 94, resetsAt: '2026-07-21T20:40:00.417617+00:00' },
  { observedAt: '2026-07-21T20:38:44.215Z', percent: 94, resetsAt: '2026-07-21T20:40:00.411096+00:00' },
];

// The genuine rollover that ENDED that window, exactly as observed: percent
// falls to 0 and `resets_at` DISAPPEARS, and only on the NEXT poll does the new
// window's instant appear, ~5 h out.
const LIVE_SESSION_POLLS_AFTER_ROLLOVER: readonly LiveMeterPoll[] = [
  { observedAt: '2026-07-21T20:43:44.217Z', percent: 0, resetsAt: null },
  { observedAt: '2026-07-21T20:48:44.218Z', percent: 4, resetsAt: '2026-07-22T01:39:59.793006+00:00' },
];

// The OTHER real rollover the same day (15:20), kept because it is the shape the
// budget-wall profile models: 71 → 0 with the field vanishing.
const LIVE_SESSION_POLLS_1520_ROLLOVER: readonly LiveMeterPoll[] = [
  { observedAt: '2026-07-21T15:11:27.599Z', percent: 71, resetsAt: '2026-07-21T15:19:59.801817+00:00' },
  { observedAt: '2026-07-21T15:16:27.598Z', percent: 71, resetsAt: '2026-07-21T15:20:00.814087+00:00' },
  { observedAt: '2026-07-21T15:21:27.598Z', percent: 0, resetsAt: null },
  { observedAt: '2026-07-21T15:26:27.600Z', percent: 0, resetsAt: null },
];

const LIVE_SESSION_METER_ID = 'endpoint:session';
// What the daemon actually derives from a 5-minute poll interval
// (`deriveStaleAfterMs`): interval + 30 s of slack. Every poll below is
// evaluated at its own `observedAt`, so nothing here is ever stale.
const LIVE_STALE_AFTER_MS = 5 * 60 * 1000 + 30_000;
const LIVE_ALERT_THRESHOLDS = [80];

// Replays polls the way the daemon does: append to bounded history, project the
// latest record, evaluate at the observation's own instant, fold every alert
// back into the memory. Returns one entry per alert actually emitted.
function replayLivePolls(
  polls: readonly LiveMeterPoll[],
  startingMemory: MeterAlertMemory = {},
  startingHistory: MeterHistorySample[] = [],
): { emittedAlerts: MeterAlertPayload[]; memory: MeterAlertMemory; history: MeterHistorySample[] } {
  const history: MeterHistorySample[] = [...startingHistory];
  let memory = startingMemory;
  const emittedAlerts: MeterAlertPayload[] = [];
  for (const poll of polls) {
    history.push({ observedAt: poll.observedAt, percent: poll.percent });
    while (history.length > METER_HISTORY_LIMIT) {
      history.shift();
    }
    const liveMeter: MeterRecord = {
      meterId: LIVE_SESSION_METER_ID,
      kind: 'rolling-window',
      scope: null,
      percent: poll.percent,
      severity: 'normal',
      isActive: true,
      resetsAt: poll.resetsAt,
      source: 'endpoint',
      observedAt: poll.observedAt,
    };
    const alerts = evaluateMeterAlerts(
      {
        meters: { [LIVE_SESSION_METER_ID]: liveMeter },
        history: { [LIVE_SESSION_METER_ID]: history },
      },
      memory,
      LIVE_ALERT_THRESHOLDS,
      poll.observedAt,
      LIVE_STALE_AFTER_MS,
    );
    for (const alert of alerts) {
      emittedAlerts.push(alert);
      memory = rememberMeterAlert(memory, alert);
    }
  }
  return { emittedAlerts, memory, history };
}

describe('evaluateMeterAlerts against the LIVE incident (33 notifications for one crossing)', () => {
  // THE PROPERTY, asserted directly and against the real wire values: 35 polls,
  // a percent that only ever rises above the line, `resets_at` re-jittered on
  // every single one — ONE alert.
  it('emits exactly ONE alert across 35 real polls with jittered resetsAt and no percent drop', () => {
    const { emittedAlerts } = replayLivePolls(LIVE_SESSION_POLLS_ONE_WINDOW);
    expect(emittedAlerts).toHaveLength(1);
    expect(emittedAlerts[0]).toMatchObject({
      meterId: LIVE_SESSION_METER_ID,
      thresholdPercent: 80,
      // The 18:08:14 crossing — the one alert that was correct on the day.
      observedPercent: 81,
      observedAt: '2026-07-21T18:08:14.185Z',
      resetsAt: '2026-07-21T20:39:59.374302+00:00',
      disposition: 'notify',
    });
  });

  // The fixture must be able to indict the OLD implementation, or it proves
  // nothing: these are the inputs string equality read as 35 different windows.
  it('carries jitter that string equality would read as many windows (the fixture is not tidy)', () => {
    const distinctResetsAtStrings = new Set(
      LIVE_SESSION_POLLS_ONE_WINDOW.map((poll) => poll.resetsAt),
    );
    expect(distinctResetsAtStrings.size).toBe(LIVE_SESSION_POLLS_ONE_WINDOW.length);
    const resetsAtEpochMs = LIVE_SESSION_POLLS_ONE_WINDOW.map((poll) => Date.parse(poll.resetsAt!));
    const observedSpreadMs = Math.max(...resetsAtEpochMs) - Math.min(...resetsAtEpochMs);
    // Over a second, and straddling one: whole-second truncation is NOT a fix.
    expect(observedSpreadMs).toBeGreaterThan(1_000);
    const distinctWholeSeconds = new Set(
      LIVE_SESSION_POLLS_ONE_WINDOW.map((poll) => poll.resetsAt!.slice(0, 19)),
    );
    expect(distinctWholeSeconds.size).toBeGreaterThan(1);
    // ...and it is comfortably inside the tolerance the fix applies.
    expect(observedSpreadMs).toBeLessThan(WINDOW_IDENTITY_TOLERANCE_MS_PREVIEW);
  });

  // GENUINE ROLLOVER, shape as observed at 20:40: percent → 0, `resets_at`
  // vanishes, then the next window's instant appears ~5 h out. The threshold
  // must RE-ARM and fire once more when the new window climbs back over it.
  it('re-arms across the real 20:40 rollover and fires exactly once in the new window', () => {
    const firstWindow = replayLivePolls(LIVE_SESSION_POLLS_ONE_WINDOW);
    expect(firstWindow.emittedAlerts).toHaveLength(1);

    const newWindowClimb: LiveMeterPoll[] = [
      ...LIVE_SESSION_POLLS_AFTER_ROLLOVER,
      // The new window climbing back over the line, jittered against the real
      // post-rollover instant.
      { observedAt: '2026-07-21T21:48:44.000Z', percent: 62, resetsAt: '2026-07-22T01:40:00.104811+00:00' },
      { observedAt: '2026-07-21T21:53:44.000Z', percent: 83, resetsAt: '2026-07-22T01:39:59.512044+00:00' },
      { observedAt: '2026-07-21T21:58:44.000Z', percent: 88, resetsAt: '2026-07-22T01:40:00.331902+00:00' },
    ];
    const secondWindow = replayLivePolls(
      newWindowClimb,
      firstWindow.memory,
      firstWindow.history,
    );
    expect(secondWindow.emittedAlerts).toHaveLength(1);
    expect(secondWindow.emittedAlerts[0]).toMatchObject({
      thresholdPercent: 80,
      observedPercent: 83,
      observedAt: '2026-07-21T21:53:44.000Z',
    });
  });

  // The 15:20 shape, and the harder version of the same question: re-arm with
  // the `resets_at` signal ALONE unavailable in its usual form — the field is
  // simply gone — leaving the vanishing field and the percent drop to carry it.
  it('re-arms across the real 15:20 rollover, where resetsAt DISAPPEARS entirely', () => {
    const alertFiredBeforeRollover: MeterAlertMemory = {
      [LIVE_SESSION_METER_ID]: [
        {
          thresholdPercent: 80,
          resetsAt: '2026-07-21T15:19:59.779964+00:00',
          observedAt: '2026-07-21T15:06:27.599Z',
        },
      ],
    };
    const acrossTheRollover: LiveMeterPoll[] = [
      ...LIVE_SESSION_POLLS_1520_ROLLOVER,
      { observedAt: '2026-07-21T15:31:27.600Z', percent: 84, resetsAt: '2026-07-21T20:39:59.702520+00:00' },
    ];
    const { emittedAlerts } = replayLivePolls(acrossTheRollover, alertFiredBeforeRollover);
    expect(emittedAlerts).toHaveLength(1);
    expect(emittedAlerts[0]).toMatchObject({ thresholdPercent: 80, observedPercent: 84 });
  });
});
