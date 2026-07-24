// Pure geometry predicate for stick-to-bottom auto-scroll. True when the scroll
// position is within `thresholdPx` of the bottom — i.e. the user is "at the
// bottom" and newly-arriving content SHOULD follow them down. False once they
// have scrolled up past the threshold to read history — the caller then leaves
// them where they are (the "don't yank a reader" guarantee).
//
// No DOM, no clock: StreamView.vue reads the live geometry off the real scroller
// and passes it in (rule 0.3 posture, same as the other lib/ helpers). Never
// throws on absurd input (I8) — this is a clamp/compare only, so NaN just
// compares false, which safely reads as "not stuck" (don't auto-scroll) rather
// than an exception.
export function shouldStick(
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  thresholdPx: number,
): boolean {
  // scrollTop + viewportHeight is the pixel offset of the viewport's BOTTOM edge
  // within the content; when it reaches (scrollHeight - threshold) the bottom is
  // within tolerance. Content shorter than the viewport gives scrollHeight <=
  // viewportHeight, so the left side already exceeds the right and this is true —
  // a short stream is always "at the bottom".
  return scrollTop + viewportHeight >= scrollHeight - thresholdPx;
}
