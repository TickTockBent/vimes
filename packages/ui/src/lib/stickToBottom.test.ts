import { describe, expect, it } from 'vitest';
import { shouldStick } from './stickToBottom.js';

const THRESHOLD_PX = 64;

describe('shouldStick', () => {
  it('is true when scrolled exactly to the bottom', () => {
    // scrollTop + viewport === scrollHeight
    expect(shouldStick(1000, 800, 1800, THRESHOLD_PX)).toBe(true);
  });

  it('is true when within the threshold of the bottom (near-bottom tolerance)', () => {
    // 40px from the bottom, threshold 64 → still counts as stuck.
    expect(shouldStick(960, 800, 1800, THRESHOLD_PX)).toBe(true);
  });

  it('is FALSE when scrolled up beyond the threshold (the don\'t-yank case)', () => {
    // 300px from the bottom, well past the 64px tolerance: the reader is
    // reading history and must NOT be pulled back down.
    expect(shouldStick(700, 800, 1800, THRESHOLD_PX)).toBe(false);
  });

  it('is true exactly at the threshold boundary (=== scrollHeight - threshold)', () => {
    // scrollTop + viewport === scrollHeight - threshold → the >= makes this true.
    expect(shouldStick(936, 800, 1800, THRESHOLD_PX)).toBe(true);
  });

  it('is true when content is shorter than the viewport (scrollHeight <= viewportHeight)', () => {
    expect(shouldStick(0, 800, 300, THRESHOLD_PX)).toBe(true);
  });

  it('does not throw and reads as not-stuck on NaN input', () => {
    // NaN comparisons are always false → "not stuck" → caller won't auto-scroll,
    // the safe degradation. Just must not throw.
    expect(() => shouldStick(NaN, 800, 1800, THRESHOLD_PX)).not.toThrow();
    expect(shouldStick(NaN, 800, 1800, THRESHOLD_PX)).toBe(false);
  });

  it('does not throw on negative inputs', () => {
    expect(() => shouldStick(-100, -1, -5, THRESHOLD_PX)).not.toThrow();
  });
});
