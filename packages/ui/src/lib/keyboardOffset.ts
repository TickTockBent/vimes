// Defect 1 fallback (mobile ergonomics): index.html's viewport meta gains
// `interactive-widget=resizes-content`, which Chrome Android >=108 honors by
// shrinking the layout viewport when the on-screen keyboard opens — sticky
// bottom-anchored elements then "just work". Older/other browsers instead
// resize only the *visual* viewport (window.innerHeight stays put while the
// keyboard covers the bottom of the page), so a `position: sticky; bottom: 0`
// composer can end up hidden underneath the keyboard.
//
// window.visualViewport tracks the visual viewport directly, so the gap
// between it and the (unchanged) layout viewport is exactly the keyboard's
// footprint. This module is the pure reducer half of the fallback: it turns
// raw viewport metrics into a composer offset in px. The composable half
// (StreamView.vue) wires window.visualViewport's 'resize'/'scroll' events
// into this reducer and writes the result to a CSS var. No-op (offset stays
// 0) on browsers/devices where resizes-content already handled it, since
// layoutViewportHeightPx and visualViewportHeightPx converge in that case.
export interface KeyboardOffsetState {
  offsetPx: number;
}

export type ViewportEvent = {
  type: 'visualViewportChange';
  /** window.innerHeight at the time of the event — the layout viewport. */
  layoutViewportHeightPx: number;
  /** window.visualViewport.height at the time of the event. */
  visualViewportHeightPx: number;
  /** window.visualViewport.offsetTop at the time of the event. */
  visualViewportOffsetTopPx: number;
};

export const initialKeyboardOffsetState: KeyboardOffsetState = { offsetPx: 0 };

// Pure (state, event) -> state reducer. Each visualViewportChange event
// already carries an absolute snapshot, so the previous state doesn't feed
// into the computation — it's threaded through purely to match the standard
// reducer shape and leave room for future event types (e.g. a reset event)
// without changing the call sites.
export function reduceKeyboardOffset(state: KeyboardOffsetState, event: ViewportEvent): KeyboardOffsetState {
  if (event.type !== 'visualViewportChange') {
    return state;
  }
  const coveredPx = event.layoutViewportHeightPx - event.visualViewportHeightPx - event.visualViewportOffsetTopPx;
  const offsetPx = Math.max(0, Math.round(coveredPx));
  return offsetPx === state.offsetPx ? state : { offsetPx };
}
