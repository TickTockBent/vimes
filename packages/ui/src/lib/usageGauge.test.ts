import { describe, expect, it } from 'vitest';
import {
  buildUsageGaugeModel,
  type BindingSelection,
} from './usageGauge.js';
import {
  formatBurnRate,
  formatProjectedExhaustion,
  formatResetCountdown,
  type DerivedMeter,
  type DerivedUsageBody,
} from './meterDisplay.js';

const NOW_MS = Date.parse('2026-07-24T12:00:00.000Z');
const OBSERVED_NOW_ISO = '2026-07-24T12:00:00.000Z';
const STALE_AFTER_MS = 10 * 60 * 1000;

// A fresh meter observed one minute ago (ageMs inside the band), as the derived
// endpoint serves it. Overridable per case.
function meter(overrides: Partial<DerivedMeter> = {}): DerivedMeter {
  return {
    meterId: 'endpoint:session',
    kind: 'rolling-window',
    percent: 42,
    severity: null,
    isActive: false,
    resetsAt: '2026-07-24T14:30:00.000Z',
    source: 'endpoint',
    observedAt: '2026-07-24T11:59:00.000Z',
    ageMs: 60_000,
    burnRatePercentPerHour: 12.5,
    projectedExhaustion: null,
    projectedExhaustionReason: 'burn-rate-unknown',
    ...overrides,
  };
}

function body(meters: DerivedMeter[], overrides: Partial<DerivedUsageBody> = {}): DerivedUsageBody {
  return { observedNow: OBSERVED_NOW_ISO, staleAfterMs: STALE_AFTER_MS, pollIntervalMs: 60_000, meters, ...overrides };
}

describe('buildUsageGaugeModel — binding selection', () => {
  it('leads with the meter the source flagged isActive (its judgement wins)', () => {
    const model = buildUsageGaugeModel(
      body([
        meter({ meterId: 'endpoint:weekly', kind: 'weekly-cap', percent: 61, isActive: false }),
        meter({ meterId: 'endpoint:session', percent: 82, isActive: true }),
      ]),
      NOW_MS,
    );
    expect(model.bindingSelection).toBe<BindingSelection>('active');
    expect(model.binding?.meterId).toBe('endpoint:session');
    expect(model.binding?.displayPercent).toBe(82);
    // The flag lands on the selected row and nowhere else.
    expect(model.constraints.filter((c) => c.isBinding)).toHaveLength(1);
    expect(model.constraints.find((c) => c.isBinding)?.meterId).toBe('endpoint:session');
  });

  it('falls back to the highest CONFIDENT (fresh) percent when no isActive is set', () => {
    const model = buildUsageGaugeModel(
      body([
        meter({ meterId: 'a', percent: 40, isActive: false }),
        meter({ meterId: 'b', percent: 70, isActive: false }),
        meter({ meterId: 'c', percent: 55, isActive: false }),
      ]),
      NOW_MS,
    );
    expect(model.bindingSelection).toBe<BindingSelection>('fallback-highest');
    expect(model.binding?.meterId).toBe('b');
    expect(model.binding?.displayPercent).toBe(70);
    expect(model.binding?.isBinding).toBe(true);
  });

  it('falls back to the first meter when no isActive AND nothing is confident (all stale)', () => {
    const model = buildUsageGaugeModel(
      body([
        meter({ meterId: 'a', percent: 40, isActive: false, ageMs: STALE_AFTER_MS + 1 }),
        meter({ meterId: 'b', percent: 70, isActive: false, ageMs: STALE_AFTER_MS + 1 }),
      ]),
      NOW_MS,
    );
    expect(model.bindingSelection).toBe<BindingSelection>('fallback-first');
    expect(model.binding?.meterId).toBe('a');
    // Stale → no confident percent to show.
    expect(model.binding?.displayPercent).toBeNull();
    expect(model.binding?.valueLabel).toBe('stale');
  });

  it('empty meters → binding null, selection none, no fake gauge', () => {
    const model = buildUsageGaugeModel(body([]), NOW_MS);
    expect(model.binding).toBeNull();
    expect(model.constraints).toEqual([]);
    expect(model.bindingSelection).toBe<BindingSelection>('none');
    expect(model.meterCount).toBe(0);
  });

  it('null body (nothing fetched yet) → empty honest model', () => {
    const model = buildUsageGaugeModel(null, NOW_MS);
    expect(model.binding).toBeNull();
    expect(model.constraints).toEqual([]);
    expect(model.bindingSelection).toBe<BindingSelection>('none');
    expect(model.meterCount).toBe(0);
  });

  it('preserves the daemon binding-first order verbatim (never re-sorts)', () => {
    const model = buildUsageGaugeModel(
      body([
        meter({ meterId: 'first', percent: 10, isActive: true }),
        meter({ meterId: 'second', percent: 90, isActive: false }),
        meter({ meterId: 'third', percent: 50, isActive: false }),
      ]),
      NOW_MS,
    );
    expect(model.constraints.map((c) => c.meterId)).toEqual(['first', 'second', 'third']);
    // isActive wins even though 'second' has a higher percent.
    expect(model.binding?.meterId).toBe('first');
  });
});

describe('buildUsageGaugeModel — THE HONEST-UNKNOWN RULE (pillar 4)', () => {
  it('a STALE meter renders — / "stale" with unknown tone, never 0 or a confident bar', () => {
    const model = buildUsageGaugeModel(
      body([meter({ meterId: 'x', percent: 82, isActive: true, ageMs: STALE_AFTER_MS + 1 })]),
      NOW_MS,
    );
    const vm = model.binding;
    expect(vm?.freshness).toBe('stale');
    expect(vm?.displayPercent).toBeNull();
    expect(vm?.tone).toBe('unknown');
    expect(vm?.valueLabel).toBe('stale');
    // Specifically NOT the confident-zero lie.
    expect(vm?.displayPercent).not.toBe(0);
    expect(vm?.valueLabel).not.toBe('0%');
  });

  it('an UNKNOWN band (poller disabled) collapses every meter to unknown, not fresh/stale', () => {
    const model = buildUsageGaugeModel(
      body([meter({ meterId: 'x', percent: 82, isActive: true })], { staleAfterMs: null }),
      NOW_MS,
    );
    const vm = model.binding;
    expect(vm?.freshness).toBe('unknown');
    expect(vm?.displayPercent).toBeNull();
    expect(vm?.tone).toBe('unknown');
    expect(vm?.valueLabel).toBe('usage unknown');
  });

  it('an unobserved percent (absent) is unknown, never 0 — even while fresh', () => {
    const model = buildUsageGaugeModel(
      body([meter({ meterId: 'x', percent: null, isActive: true })]),
      NOW_MS,
    );
    const vm = model.binding;
    expect(vm?.displayPercent).toBeNull();
    expect(vm?.tone).toBe('unknown');
    expect(vm?.valueLabel).toBe('usage unknown');
  });
});

describe('buildUsageGaugeModel — tone thresholds (fresh, no source severity)', () => {
  it('normal below the elevated band', () => {
    const model = buildUsageGaugeModel(body([meter({ percent: 30, isActive: true })]), NOW_MS);
    expect(model.binding?.tone).toBe('normal');
    expect(model.binding?.displayPercent).toBe(30);
  });

  it('elevated at/above 60 and below 80', () => {
    const model = buildUsageGaugeModel(body([meter({ percent: 65, isActive: true })]), NOW_MS);
    expect(model.binding?.tone).toBe('elevated');
  });

  it('high at/above 80', () => {
    const model = buildUsageGaugeModel(body([meter({ percent: 85, isActive: true })]), NOW_MS);
    expect(model.binding?.tone).toBe('high');
  });

  it("prefers the source's own severity over the local percent band", () => {
    // 30% would read 'normal' locally, but the source says 'critical'.
    const model = buildUsageGaugeModel(
      body([meter({ percent: 30, isActive: true, severity: 'critical' })]),
      NOW_MS,
    );
    expect(model.binding?.tone).toBe('high');
  });
});

describe('buildUsageGaugeModel — formatting passthrough (reuses meterDisplay verbatim)', () => {
  it('reset / burn / exhaustion match the shared helpers against the anchored now', () => {
    const model = buildUsageGaugeModel(
      body([
        meter({
          isActive: true,
          resetsAt: '2026-07-24T14:30:00.000Z',
          burnRatePercentPerHour: 12.5,
          projectedExhaustion: '2026-07-24T14:00:00.000Z',
          projectedExhaustionReason: 'projected',
        }),
      ]),
      NOW_MS,
    );
    const vm = model.binding!;
    expect(vm.resetLabel).toBe(formatResetCountdown('2026-07-24T14:30:00.000Z', NOW_MS));
    expect(vm.burnRateLabel).toBe(formatBurnRate(12.5));
    expect(vm.exhaustionLabel).toBe(
      formatProjectedExhaustion('2026-07-24T14:00:00.000Z', 'projected', NOW_MS),
    );
  });

  it('an absent burn rate says so in words, never 0', () => {
    const model = buildUsageGaugeModel(
      body([meter({ isActive: true, burnRatePercentPerHour: null })]),
      NOW_MS,
    );
    expect(model.binding?.burnRateLabel).toBe('burn rate unknown');
  });

  it('echoes the server-anchored nowMs it was given', () => {
    const model = buildUsageGaugeModel(body([meter({ isActive: true })]), NOW_MS);
    expect(model.nowMs).toBe(NOW_MS);
  });
});
