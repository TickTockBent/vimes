import { describe, expect, it } from 'vitest';
import { clampTextareaHeight, type TextareaMetrics } from './textareaGrow.js';

const metrics: TextareaMetrics = {
  lineHeightPx: 20,
  verticalChromePx: 16, // e.g. 8px top + 8px bottom padding
  minRows: 1,
  maxRows: 5,
};

describe('clampTextareaHeight', () => {
  it('floors at minRows when content is shorter than one line', () => {
    expect(clampTextareaHeight(10, metrics)).toEqual({ heightPx: 36, overflowing: false });
  });

  it('grows to fit content between min and max rows', () => {
    // 3 lines of content -> 3*20 + 16 = 76
    expect(clampTextareaHeight(76, metrics)).toEqual({ heightPx: 76, overflowing: false });
  });

  it('grows exactly to the max-rows boundary without overflowing', () => {
    // 5 lines -> 5*20 + 16 = 116, exactly maxRows
    expect(clampTextareaHeight(116, metrics)).toEqual({ heightPx: 116, overflowing: false });
  });

  it('caps at maxRows and reports overflow beyond the boundary', () => {
    // 8 lines of content requested, but capped at 5
    expect(clampTextareaHeight(176, metrics)).toEqual({ heightPx: 116, overflowing: true });
  });

  it('is stable (idempotent) on heightPx when re-clamping an already-clamped height', () => {
    // Re-feeding the clamped output back in as a new scrollHeight must not
    // creep the height further — the returned px is always the final,
    // settled value regardless of whether it arrived there via natural
    // content growth or a prior clamp.
    const first = clampTextareaHeight(300, metrics);
    const second = clampTextareaHeight(first.heightPx, metrics);
    expect(second.heightPx).toBe(first.heightPx);
  });

  it('treats zero scrollHeight as empty content, still floors at minRows', () => {
    expect(clampTextareaHeight(0, metrics)).toEqual({ heightPx: 36, overflowing: false });
  });
});
