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
  type MeterAlertMemory,
} from './meterDerivations.js';
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
      const meter = endpointMeter({ percent, observedAt, resetsAt: isoAt(300) });
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
    const meter = endpointMeter({ percent: 83, observedAt, resetsAt: isoAt(300), scope: 'model.Fable' });
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
      resetsAt: isoAt(300),
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
    const meter = endpointMeter({ percent: 81, observedAt: isoAt(30), resetsAt: isoAt(300) });
    // Same resetsAt on the fired alert, so ONLY the percent-drop signal is under test.
    const staleWindowMemory: MeterAlertMemory = {
      session: [{ thresholdPercent: 80, resetsAt: isoAt(300), observedAt: isoAt(0) }],
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
      session: [{ thresholdPercent: 80, resetsAt: isoAt(300), observedAt: isoAt(25) }],
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
    const meter = endpointMeter({ percent: 85, observedAt: isoAt(10), resetsAt: isoAt(600) });
    const priorWindowMemory: MeterAlertMemory = {
      session: [{ thresholdPercent: 80, resetsAt: isoAt(300), observedAt: isoAt(0) }],
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

    // Control: the SAME resetsAt keeps the alert binding.
    const sameWindowMemory: MeterAlertMemory = {
      session: [{ thresholdPercent: 80, resetsAt: isoAt(600), observedAt: isoAt(0) }],
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
    const staleMeter = endpointMeter({ percent: 99, observedAt: isoAt(0), resetsAt: isoAt(300) });
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
    for (const absentPercent of [null, undefined]) {
      const meter = endpointMeter({ percent: absentPercent, observedAt, resetsAt: isoAt(300) });
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
    const meter = endpointMeter({ percent: 92, observedAt, resetsAt: isoAt(300) });
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
      resetsAt: isoAt(300),
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
        weekly_scoped: endpointMeter({ meterId: 'weekly_scoped', kind: 'weekly-cap', percent: 95, observedAt }),
        session: endpointMeter({ meterId: 'session', percent: 91, observedAt }),
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
    for (const percent of [80, 85, 90, 99, 100, 140]) {
      const meter = endpointMeter({ percent, observedAt, resetsAt: isoAt(300) });
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
  resetsAt: string = WEEKLY_RESETS_AT,
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
    resetsAt,
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
    // resetsAt is unchanged and percent has only risen. Nothing reset.
    const laterState = saturatedRisingWeeklyState(sixHoursLaterMs, 84);
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
    const stateWithObservedDrop = saturatedRisingWeeklyState(sixHoursLaterMs, 84);
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
      resetsAt: WEEKLY_RESETS_AT,
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
          resetsAt: WEEKLY_RESETS_AT,
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
