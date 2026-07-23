// The layout-resolution contract (desktop phase 3, part 1). Pure arithmetic:
// no `window`, no `localStorage`, no clock — every assertion here holds for any
// (width, override) pair, deterministically, without a browser.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT_BREAKPOINTS,
  MAX_PANELS,
  panelCountForWidth,
  resolvePanelCount,
  shouldShowSidebar,
  SIDEBAR_MIN_WIDTH_PX,
  type LayoutBreakpoint,
} from './layoutMode.js';

// ── the default table itself ─────────────────────────────────────────────────

describe('DEFAULT_LAYOUT_BREAKPOINTS / MAX_PANELS', () => {
  it('is ordered ascending by minWidthPx', () => {
    for (let i = 1; i < DEFAULT_LAYOUT_BREAKPOINTS.length; i++) {
      expect(DEFAULT_LAYOUT_BREAKPOINTS[i]!.minWidthPx).toBeGreaterThan(
        DEFAULT_LAYOUT_BREAKPOINTS[i - 1]!.minWidthPx,
      );
    }
  });

  it('MAX_PANELS is the largest panels value in the default table (3)', () => {
    expect(MAX_PANELS).toBe(3);
    expect(Math.max(...DEFAULT_LAYOUT_BREAKPOINTS.map((b) => b.panels))).toBe(MAX_PANELS);
  });

  it('matches D39’s stated lean defaults: phone<768→1, tablet[768,1280)→2, desktop>=1280→3', () => {
    expect(DEFAULT_LAYOUT_BREAKPOINTS).toEqual([
      { minWidthPx: 0, panels: 1 },
      { minWidthPx: 768, panels: 2 },
      { minWidthPx: 1280, panels: 3 },
    ]);
  });
});

// ── ASSERTION 6: panelCountForWidth boundaries ────────────────────────────────

describe('panelCountForWidth', () => {
  it('a width below the smallest breakpoint → 1, never 0', () => {
    expect(panelCountForWidth(-1)).toBe(1);
    expect(panelCountForWidth(0)).toBe(1);
    expect(panelCountForWidth(320)).toBe(1);
    expect(panelCountForWidth(767)).toBe(1);
  });

  it('boundary convention is `>=` minWidth: exactly at 768 already reads as tablet (2)', () => {
    expect(panelCountForWidth(768)).toBe(2);
    expect(panelCountForWidth(1000)).toBe(2);
    expect(panelCountForWidth(1279)).toBe(2);
  });

  it('boundary convention is `>=` minWidth: exactly at 1280 already reads as desktop (3)', () => {
    expect(panelCountForWidth(1280)).toBe(3);
  });

  it('a huge width → MAX_PANELS', () => {
    expect(panelCountForWidth(10_000)).toBe(MAX_PANELS);
    expect(panelCountForWidth(Number.MAX_SAFE_INTEGER)).toBe(MAX_PANELS);
  });

  it('honours a custom breakpoint table instead of the default', () => {
    const customTable: readonly LayoutBreakpoint[] = [
      { minWidthPx: 0, panels: 1 },
      { minWidthPx: 500, panels: 5 },
    ];
    expect(panelCountForWidth(0, customTable)).toBe(1);
    expect(panelCountForWidth(499, customTable)).toBe(1);
    expect(panelCountForWidth(500, customTable)).toBe(5);
    expect(panelCountForWidth(999_999, customTable)).toBe(5);
  });

  it('a custom table with no zero-floor entry still floors at 1 below its smallest breakpoint', () => {
    const noZeroFloor: readonly LayoutBreakpoint[] = [{ minWidthPx: 320, panels: 2 }];
    expect(panelCountForWidth(0, noZeroFloor)).toBe(1);
    expect(panelCountForWidth(319, noZeroFloor)).toBe(1);
    expect(panelCountForWidth(320, noZeroFloor)).toBe(2);
  });
});

// ── ASSERTION 7: a valid override wins outright ───────────────────────────────

describe('resolvePanelCount — a valid override wins', () => {
  it('an override of 1..MAX_PANELS is returned verbatim, regardless of width', () => {
    for (let override = 1; override <= MAX_PANELS; override++) {
      // Width says 1 panel (phone), override says otherwise — override wins.
      expect(resolvePanelCount(320, override)).toBe(override);
      // Width says MAX_PANELS (desktop), override still wins.
      expect(resolvePanelCount(10_000, override)).toBe(override);
    }
  });
});

// ── ASSERTION 8: invalid overrides are IGNORED, not clamped ──────────────────

describe('resolvePanelCount — invalid overrides are ignored, width decides', () => {
  const INVALID_OVERRIDES: ReadonlyArray<{ label: string; value: number | null }> = [
    { label: 'null', value: null },
    { label: '0', value: 0 },
    { label: 'MAX_PANELS+1', value: MAX_PANELS + 1 },
    { label: '2.5 (non-integer)', value: 2.5 },
    { label: 'NaN', value: NaN },
    { label: '-1', value: -1 },
    { label: 'Infinity', value: Infinity },
  ];

  for (const { label, value } of INVALID_OVERRIDES) {
    it(`${label} is ignored — falls back to the width computation`, () => {
      expect(resolvePanelCount(320, value)).toBe(panelCountForWidth(320));
      expect(resolvePanelCount(1000, value)).toBe(panelCountForWidth(1000));
      expect(resolvePanelCount(10_000, value)).toBe(panelCountForWidth(10_000));
    });
  }

  it('is NOT clamped: an out-of-range override does not snap to the nearest legal value', () => {
    // If clamping were happening, MAX_PANELS+1 at a phone-width viewport would
    // land on MAX_PANELS (the "nearest legal value" reading), not on the
    // phone's width-computed 1. Ignoring lands on 1; clamping would land on 3.
    const outOfRangeOverride = MAX_PANELS + 1;
    expect(resolvePanelCount(320, outOfRangeOverride)).toBe(1);
    expect(resolvePanelCount(320, outOfRangeOverride)).not.toBe(MAX_PANELS);

    // And a negative override at a desktop-width viewport lands on the width's
    // 3 (ignored), not on 1 (which a "clamp to nearest legal value" reading of
    // a value below the range would produce).
    expect(resolvePanelCount(10_000, -5)).toBe(MAX_PANELS);
    expect(resolvePanelCount(10_000, -5)).not.toBe(1);
  });
});

// ── ASSERTION 9: non-finite width → 1 ────────────────────────────────────────

describe('resolvePanelCount — a non-finite width falls back to 1', () => {
  it('NaN width, no override → 1', () => {
    expect(resolvePanelCount(NaN, null)).toBe(1);
  });

  it('+Infinity / -Infinity width, no override → 1', () => {
    expect(resolvePanelCount(Infinity, null)).toBe(1);
    expect(resolvePanelCount(-Infinity, null)).toBe(1);
  });

  it('a non-finite width never produces NaN or 0', () => {
    const result = resolvePanelCount(NaN, null);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).not.toBe(0);
  });

  it('a valid override still wins even when width is non-finite', () => {
    expect(resolvePanelCount(NaN, 2)).toBe(2);
  });
});

// ── the sidebar threshold (D39 #3) ────────────────────────────────────────────

describe('shouldShowSidebar — the desktop sidebar threshold', () => {
  it('SIDEBAR_MIN_WIDTH_PX is the desktop breakpoint (1280)', () => {
    expect(SIDEBAR_MIN_WIDTH_PX).toBe(1280);
  });

  it('below the threshold → false (phone and tablet keep the panel row)', () => {
    expect(shouldShowSidebar(320)).toBe(false); // phone
    expect(shouldShowSidebar(767)).toBe(false); // phone/tablet edge
    expect(shouldShowSidebar(768)).toBe(false); // tablet — no sidebar this POC
    expect(shouldShowSidebar(1024)).toBe(false); // tablet
    expect(shouldShowSidebar(1279)).toBe(false); // just below desktop
  });

  it('at and above the threshold → true (desktop gets the sidebar)', () => {
    expect(shouldShowSidebar(1280)).toBe(true); // exactly at the boundary
    expect(shouldShowSidebar(1281)).toBe(true);
    expect(shouldShowSidebar(1920)).toBe(true);
    expect(shouldShowSidebar(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('a non-finite width → false, never the sidebar', () => {
    expect(shouldShowSidebar(NaN)).toBe(false);
    expect(shouldShowSidebar(Infinity)).toBe(false);
    expect(shouldShowSidebar(-Infinity)).toBe(false);
  });

  it('is stable across repeated calls (no clock/window read)', () => {
    const atThreshold = shouldShowSidebar(SIDEBAR_MIN_WIDTH_PX);
    for (let i = 0; i < 50; i++) {
      expect(shouldShowSidebar(SIDEBAR_MIN_WIDTH_PX)).toBe(atThreshold);
    }
  });
});

// ── ASSERTION 10: determinism ─────────────────────────────────────────────────

describe('determinism — same inputs, same output, no clock/window read', () => {
  it('panelCountForWidth is stable across repeated calls', () => {
    const first = panelCountForWidth(900);
    for (let i = 0; i < 50; i++) {
      expect(panelCountForWidth(900)).toBe(first);
    }
  });

  it('resolvePanelCount is stable across repeated calls, override and width alike', () => {
    const first = resolvePanelCount(900, null);
    const firstWithOverride = resolvePanelCount(900, 2);
    for (let i = 0; i < 50; i++) {
      expect(resolvePanelCount(900, null)).toBe(first);
      expect(resolvePanelCount(900, 2)).toBe(firstWithOverride);
    }
  });
});
