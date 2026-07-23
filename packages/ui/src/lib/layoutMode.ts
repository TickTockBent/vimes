// How many panels the viewport renders, resolved from a width and an optional
// per-device override (desktop phase 3, part 1, D39 #2). Pure arithmetic only —
// no `window`, no `localStorage`, no DOM. The composable that actually reads
// `window.innerWidth` and the stored override is shell-unit glue (next unit);
// this module exists so that glue has nothing left to get wrong: every branch
// here is a plain function of its inputs, unit-tested without a browser.
//
// WHY THIS IS A SEPARATE FILE FROM panelStack.ts. The stack (how many panels
// exist) and the layout (how many panels the viewport can show at once) are
// different axes — D39 is explicit that a stack can hold more panels than are
// ever rendered; the shell renders the trailing N of the stack, where N comes
// from here. Mixing the two would let a layout change accidentally reshape
// navigation state, which is exactly the kind of coupling the `lib/` split
// exists to prevent.

// D39 #2: N is chosen by a width breakpoint, with a per-device user override
// that wins when valid. `minWidthPx` is the lower bound (inclusive — see
// `panelCountForWidth`) of the range that resolves to `panels`.
export interface LayoutBreakpoint {
  readonly minWidthPx: number;
  readonly panels: number;
}

// Presentation constants, NOT a ⟨tune⟩ band (no Gate-D calibration owed here —
// these are shape decisions, not thresholds tuned against live behaviour).
// Table is ORDERED ASCENDING by minWidthPx and kept as data specifically so a
// later ultra-wide tier (e.g. 4 panels >= 1920) is a one-line edit, not a
// rewrite of the resolution logic. Lean defaults, matching D39's phone/tablet/
// desktop table (design-directions.md):
//   phone   < 768px          -> 1 (today's single-panel behaviour, unchanged)
//   tablet  [768px, 1280px)  -> 2
//   desktop >= 1280px        -> 3
// 768/1280 are the common phone/tablet and tablet/desktop boundaries (the same
// pair Tailwind's default `md`/`xl` breakpoints use) — picked as a reasonable
// off-the-shelf convention, not measured against any device in the fleet. If
// the lived-with shell (next unit) feels wrong at these edges, the fix is
// editing this table, not the resolution functions below.
export const DEFAULT_LAYOUT_BREAKPOINTS: readonly LayoutBreakpoint[] = [
  { minWidthPx: 0, panels: 1 },
  { minWidthPx: 768, panels: 2 },
  { minWidthPx: 1280, panels: 3 },
];

// The largest `panels` value in the default table. Exported so callers (the
// shell's override UI, this module's own validation) never hand-copy the `3` —
// if the table grows a wider tier, this constant tracks it automatically.
export const MAX_PANELS: number = Math.max(
  ...DEFAULT_LAYOUT_BREAKPOINTS.map((breakpoint) => breakpoint.panels),
);

// The width-only computation: walk the table (ascending) and keep the LAST
// breakpoint whose minWidthPx <= width — i.e. the boundary convention is `>=`
// minWidth, so a width exactly AT a boundary already belongs to the wider
// tier. A width below the smallest breakpoint (or negative, or on a table with
// no zero-floor entry) falls back to 1 — the "never 0" floor, mirroring
// popPanel's "never empty" floor in panelStack.ts: there is always at least
// one panel on screen.
export function panelCountForWidth(
  width: number,
  breakpoints: readonly LayoutBreakpoint[] = DEFAULT_LAYOUT_BREAKPOINTS,
): number {
  let resolvedPanelCount = 1;
  for (const breakpoint of breakpoints) {
    if (width >= breakpoint.minWidthPx) {
      resolvedPanelCount = breakpoint.panels;
    }
  }
  return resolvedPanelCount;
}

// A stored/override value is VALID only if it is an integer in [1, MAX_PANELS].
// Kept as its own predicate so resolvePanelCount's branch reads as one
// sentence, and so a future caller (e.g. the shell's override picker,
// validating a value before it writes to localStorage) can reuse the exact
// same rule rather than re-deriving it.
function isValidPanelOverride(override: number | null): override is number {
  return (
    override !== null &&
    Number.isInteger(override) &&
    override >= 1 &&
    override <= MAX_PANELS
  );
}

// The full resolution D39 #2 describes: a valid override WINS outright; an
// invalid one is IGNORED — not clamped — and the width computation decides.
//
// WHY IGNORED, NOT CLAMPED. A stored override is device-local presentation
// state (D39 #2: localStorage, never an event-log/projection input), which
// means it can go stale or corrupt without anything upstream noticing — a
// table edit that lowers MAX_PANELS, a hand-edited devtools value, a future
// bug that persists 0 or 9. Clamping a corrupt `9` down to `3` would make that
// corruption LOOK like a deliberate, honoured choice — the UI would silently
// keep behaving as if someone asked for the max. Ignoring it instead falls
// back to the width computation, which is always a sane, freshly-derived
// answer for the viewport actually in front of the user. Same posture as
// panelStack's "degrade, don't crash" rule, aimed at "degrade to a fresh
// default, don't honour garbage" here.
//
// A non-finite width (NaN, +-Infinity) short-circuits straight to 1, before it
// ever reaches panelCountForWidth's `>=` comparisons — `NaN >= 0` is false for
// every breakpoint, which would already fall through to 1, but the explicit
// check keeps that guarantee independent of the table's shape (e.g. a future
// breakpoint with a negative minWidthPx would otherwise change the answer).
export function resolvePanelCount(
  width: number,
  override: number | null,
  breakpoints: readonly LayoutBreakpoint[] = DEFAULT_LAYOUT_BREAKPOINTS,
): number {
  if (isValidPanelOverride(override)) {
    return override;
  }
  if (!Number.isFinite(width)) {
    return 1;
  }
  return panelCountForWidth(width, breakpoints);
}

// ── the sidebar threshold (D39 #3) ───────────────────────────────────────────
//
// D39 #3 renders the session list (stack[0]) as ambient left-hand chrome — a
// fixed-width sidebar — instead of as a panel column, but ONLY at true desktop
// width. Below this the current panel paradigm stands: the session list is a
// normal panel in the flex row (phone at N=1, tablet at N=2). Tablet
// [768, 1280) deliberately keeps that paradigm for this POC — a sidebar wants
// real horizontal room to be "ambient" rather than cramping the content, and a
// 1024px-ish tablet does not have it to spare. So the sidebar switches on at the
// SAME 1280 boundary the desktop (3-panel) tier begins at: sidebar ⇔ desktop.
//
// This is a PRESENTATION constant, not a ⟨tune⟩ band — a shape decision (which
// layout paradigm at which width), not a threshold calibrated against live
// behaviour, so no Gate-D pin is owed. It is a plain function of width, unit-
// tested without a browser, exactly like panelCountForWidth above.
export const SIDEBAR_MIN_WIDTH_PX = 1280; // = the desktop breakpoint

// True only at desktop width. A non-finite width (NaN, ±Infinity) short-circuits
// to false the same way resolvePanelCount floors non-finite width to 1 — a
// degenerate viewport gets the simplest paradigm (the panel row), never the
// sidebar, since `NaN >= n` is false anyway but the explicit guard keeps that
// answer independent of the constant's value.
export function shouldShowSidebar(width: number): boolean {
  if (!Number.isFinite(width)) {
    return false;
  }
  return width >= SIDEBAR_MIN_WIDTH_PX;
}
