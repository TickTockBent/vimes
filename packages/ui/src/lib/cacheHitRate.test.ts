import { describe, expect, it } from 'vitest';
import { cacheHitRatePercent } from './cacheHitRate.js';

// Assertion 11 (Q4): the relocated helper produces the SAME rounded/clamped
// value it did on the badge — these are the badge's own edge cases, carried to
// the helper's new home byte-for-byte.
describe('cacheHitRatePercent (relocated from cacheBadge)', () => {
  it('rounds at the 0% edge', () => {
    expect(cacheHitRatePercent(0)).toBe(0);
  });

  it('rounds at the 50% edge', () => {
    expect(cacheHitRatePercent(0.5)).toBe(50);
  });

  it('rounds at the 100% edge', () => {
    expect(cacheHitRatePercent(1)).toBe(100);
  });

  it('rounds a mid value to the nearest whole percent', () => {
    expect(cacheHitRatePercent(0.9314)).toBe(93);
  });

  it('clamps a non-finite hit rate (defensive) to 0', () => {
    expect(cacheHitRatePercent(NaN)).toBe(0);
    expect(cacheHitRatePercent(Infinity)).toBe(0);
  });

  it('clamps an out-of-range hit rate (defensive) into 0..100', () => {
    expect(cacheHitRatePercent(-0.2)).toBe(0);
    expect(cacheHitRatePercent(1.2)).toBe(100);
  });
});
