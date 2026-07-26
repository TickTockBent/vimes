import { describe, expect, it } from 'vitest';
import {
  initialUsageBackoffState,
  nextUsageBackoff,
  type UsageBackoffConfig,
  type UsageBackoffState,
} from './usageBackoff.js';

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// Rule 0.2: `maxIntervalMs` and `multiplier` are ⟨tune⟩ PREVIEW placeholders
// (config.ts pins the real defaults). Every assertion below is a RELATION
// (grows, caps, resets, degrades) rather than a pinned millisecond figure —
// these fixture numbers exist only so the relations have something concrete to
// hold between, never as a value under test in their own right.
const BASE_INTERVAL_MS = 300_000; // 5 min, matches config.ts's own default shape
const MAX_INTERVAL_MS = 1_800_000; // 30 min
const MULTIPLIER = 2;

const ENABLED_CONFIG: UsageBackoffConfig = {
  baseIntervalMs: BASE_INTERVAL_MS,
  maxIntervalMs: MAX_INTERVAL_MS,
  multiplier: MULTIPLIER,
};

describe('nextUsageBackoff', () => {
  it('a success from the initial state returns the base interval and the initial state', () => {
    const result = nextUsageBackoff(initialUsageBackoffState, true, ENABLED_CONFIG);
    expect(result.delayMs).toBe(BASE_INTERVAL_MS);
    expect(result.state).toEqual(initialUsageBackoffState);
  });

  it('the first failure already widens the delay past the base interval', () => {
    const result = nextUsageBackoff(initialUsageBackoffState, false, ENABLED_CONFIG);
    expect(result.delayMs).toBeGreaterThan(BASE_INTERVAL_MS);
    expect(result.state.consecutiveFailures).toBe(1);
  });

  it('each consecutive failure grows the delay — monotonic non-decreasing across a failure run', () => {
    let state: UsageBackoffState = initialUsageBackoffState;
    let previousDelayMs = BASE_INTERVAL_MS;
    for (let failureIndex = 0; failureIndex < 10; failureIndex += 1) {
      const result = nextUsageBackoff(state, false, ENABLED_CONFIG);
      expect(result.delayMs).toBeGreaterThanOrEqual(previousDelayMs);
      previousDelayMs = result.delayMs;
      state = result.state;
    }
  });

  it('the delay caps at maxIntervalMs and does not exceed it even after many failures', () => {
    let state: UsageBackoffState = initialUsageBackoffState;
    for (let failureIndex = 0; failureIndex < 50; failureIndex += 1) {
      const result = nextUsageBackoff(state, false, ENABLED_CONFIG);
      expect(result.delayMs).toBeLessThanOrEqual(MAX_INTERVAL_MS);
      state = result.state;
    }
    // The 50th consecutive failure is well past the exponent needed to reach the
    // cap for this fixture (base 300s, x2, cap 1800s reaches it by failure 3) —
    // asserting the FINAL delay lands exactly at the cap proves the growth
    // curve actually plateaus rather than merely staying under a ceiling by
    // coincidence.
    const finalResult = nextUsageBackoff(state, false, ENABLED_CONFIG);
    expect(finalResult.delayMs).toBe(MAX_INTERVAL_MS);
  });

  it('recovery: a run of failures followed by a success drops straight back to the base interval', () => {
    let state: UsageBackoffState = initialUsageBackoffState;
    for (let failureIndex = 0; failureIndex < 5; failureIndex += 1) {
      state = nextUsageBackoff(state, false, ENABLED_CONFIG).state;
    }
    const recovered = nextUsageBackoff(state, true, ENABLED_CONFIG);
    expect(recovered.delayMs).toBe(BASE_INTERVAL_MS);
    expect(recovered.state).toEqual(initialUsageBackoffState);
  });

  it('disabled-degrade: multiplier <= 1 collapses every result to the base interval, win or lose', () => {
    const disabledByMultiplier: UsageBackoffConfig = { ...ENABLED_CONFIG, multiplier: 1 };
    let state: UsageBackoffState = initialUsageBackoffState;
    for (let failureIndex = 0; failureIndex < 20; failureIndex += 1) {
      const result = nextUsageBackoff(state, false, disabledByMultiplier);
      expect(result.delayMs).toBe(BASE_INTERVAL_MS);
      state = result.state;
    }
    const succeeded = nextUsageBackoff(state, true, disabledByMultiplier);
    expect(succeeded.delayMs).toBe(BASE_INTERVAL_MS);
  });

  it('disabled-degrade: maxIntervalMs <= baseIntervalMs collapses every result to the base interval', () => {
    const disabledByCap: UsageBackoffConfig = { ...ENABLED_CONFIG, maxIntervalMs: BASE_INTERVAL_MS };
    let state: UsageBackoffState = initialUsageBackoffState;
    for (let failureIndex = 0; failureIndex < 20; failureIndex += 1) {
      const result = nextUsageBackoff(state, false, disabledByCap);
      expect(result.delayMs).toBe(BASE_INTERVAL_MS);
      state = result.state;
    }
  });

  it('is deterministic: the same state, outcome and config always produce the same result', () => {
    const midRunState: UsageBackoffState = { consecutiveFailures: 3 };
    const first = nextUsageBackoff(midRunState, false, ENABLED_CONFIG);
    const second = nextUsageBackoff(midRunState, false, ENABLED_CONFIG);
    expect(second).toEqual(first);
  });

  it('totality: every delay across a long failure run is finite, in range, and never NaN/Infinity/negative', () => {
    let state: UsageBackoffState = initialUsageBackoffState;
    for (let failureIndex = 0; failureIndex < 200; failureIndex += 1) {
      const result = nextUsageBackoff(state, false, ENABLED_CONFIG);
      expect(Number.isFinite(result.delayMs)).toBe(true);
      expect(Number.isNaN(result.delayMs)).toBe(false);
      expect(result.delayMs).toBeGreaterThanOrEqual(BASE_INTERVAL_MS);
      expect(result.delayMs).toBeLessThanOrEqual(Math.max(BASE_INTERVAL_MS, MAX_INTERVAL_MS));
      state = result.state;
    }
  });

  it('totality: an enormous failure count (Math.pow overflow territory) still yields a finite, capped delay', () => {
    // Directly construct a state with a huge consecutiveFailures — larger than
    // any realistic uptime could accumulate, and large enough that
    // multiplier^consecutiveFailures would be Infinity if computed naively
    // (2^1_000_000 overflows double-precision float).
    const hugeFailureState: UsageBackoffState = { consecutiveFailures: 1_000_000 };
    const result = nextUsageBackoff(hugeFailureState, false, ENABLED_CONFIG);
    expect(Number.isFinite(result.delayMs)).toBe(true);
    expect(Number.isNaN(result.delayMs)).toBe(false);
    expect(result.delayMs).toBe(MAX_INTERVAL_MS);
    expect(result.state.consecutiveFailures).toBe(1_000_001);
  });

  it('totality: a zero baseIntervalMs never produces NaN or a negative delay', () => {
    const zeroBaseConfig: UsageBackoffConfig = { ...ENABLED_CONFIG, baseIntervalMs: 0 };
    const result = nextUsageBackoff(initialUsageBackoffState, false, zeroBaseConfig);
    expect(Number.isFinite(result.delayMs)).toBe(true);
    expect(Number.isNaN(result.delayMs)).toBe(false);
    expect(result.delayMs).toBeGreaterThanOrEqual(0);
  });
});
