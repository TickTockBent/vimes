// Defect 2 (mobile ergonomics, docs/... follow-up): the composer was a
// single-line <input>, so multiline prompts scrolled out of view as the user
// typed. Replaced with an auto-growing <textarea> that expands with content
// up to a capped number of visible rows, then scrolls internally beyond that.
//
// Pure clamp helper so the row math is unit-testable without a DOM: given the
// textarea's natural content height (scrollHeight) and the metrics of a
// single line, return the height in px the element should be set to, plus
// whether internal scrolling (overflow-y) is needed because content exceeds
// the cap.
export interface TextareaMetrics {
  /** px height of a single line of text (line-height). */
  lineHeightPx: number;
  /** combined top+bottom padding + border, added on top of line height. */
  verticalChromePx: number;
  /** minimum visible rows (1 = single line). */
  minRows: number;
  /** maximum visible rows before internal scrolling kicks in. */
  maxRows: number;
}

export interface TextareaClamp {
  heightPx: number;
  overflowing: boolean;
}

// scrollHeightPx is the natural (unclamped) content height the browser
// reports for the textarea after resetting height to 'auto' — i.e. what the
// element would need to show all content with no internal scrollbar.
export function clampTextareaHeight(scrollHeightPx: number, metrics: TextareaMetrics): TextareaClamp {
  const { lineHeightPx, verticalChromePx, minRows, maxRows } = metrics;
  const minHeightPx = minRows * lineHeightPx + verticalChromePx;
  const maxHeightPx = maxRows * lineHeightPx + verticalChromePx;
  const wanted = Math.max(scrollHeightPx, minHeightPx);
  if (wanted <= maxHeightPx) {
    return { heightPx: wanted, overflowing: false };
  }
  return { heightPx: maxHeightPx, overflowing: true };
}
