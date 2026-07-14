import { describe, expect, it } from 'vitest';
import { initialKeyboardOffsetState, reduceKeyboardOffset, type ViewportEvent } from './keyboardOffset.js';

function change(overrides: Partial<Omit<ViewportEvent, 'type'>>): ViewportEvent {
  return {
    type: 'visualViewportChange',
    layoutViewportHeightPx: 800,
    visualViewportHeightPx: 800,
    visualViewportOffsetTopPx: 0,
    ...overrides,
  };
}

describe('reduceKeyboardOffset', () => {
  it('starts at zero offset', () => {
    expect(initialKeyboardOffsetState).toEqual({ offsetPx: 0 });
  });

  it('reports zero offset when the visual viewport matches the layout viewport (keyboard closed)', () => {
    const state = reduceKeyboardOffset(initialKeyboardOffsetState, change({}));
    expect(state).toEqual({ offsetPx: 0 });
  });

  it('reports the keyboard height as offset when the visual viewport shrinks from the bottom', () => {
    const state = reduceKeyboardOffset(
      initialKeyboardOffsetState,
      change({ visualViewportHeightPx: 500 }), // 300px keyboard, layout viewport unmoved
    );
    expect(state).toEqual({ offsetPx: 300 });
  });

  it('accounts for visualViewport offsetTop (page scrolled within the visual viewport)', () => {
    const state = reduceKeyboardOffset(
      initialKeyboardOffsetState,
      change({ visualViewportHeightPx: 500, visualViewportOffsetTopPx: 50 }),
    );
    expect(state).toEqual({ offsetPx: 250 });
  });

  it('clamps to zero rather than going negative (resizes-content already handled it)', () => {
    // Some browsers report the visual viewport as *taller* than
    // window.innerHeight in edge cases (zoom/rounding) — never push the
    // composer down.
    const state = reduceKeyboardOffset(initialKeyboardOffsetState, change({ visualViewportHeightPx: 820 }));
    expect(state).toEqual({ offsetPx: 0 });
  });

  it('returns the same state reference when the computed offset is unchanged (no needless re-render)', () => {
    const opened = reduceKeyboardOffset(initialKeyboardOffsetState, change({ visualViewportHeightPx: 500 }));
    const again = reduceKeyboardOffset(opened, change({ visualViewportHeightPx: 500 }));
    expect(again).toBe(opened);
  });

  it('tracks the keyboard closing back to zero', () => {
    const opened = reduceKeyboardOffset(initialKeyboardOffsetState, change({ visualViewportHeightPx: 500 }));
    const closed = reduceKeyboardOffset(opened, change({}));
    expect(closed).toEqual({ offsetPx: 0 });
  });

  it('ignores unknown event types and returns the same state', () => {
    const unknown = { type: 'other' } as unknown as ViewportEvent;
    expect(reduceKeyboardOffset(initialKeyboardOffsetState, unknown)).toBe(initialKeyboardOffsetState);
  });
});
