// Seen-on-view logic (D9): viewing a session acks its notification. The Stream
// view sends {op:'seen'} on mount AND whenever the page becomes visible again
// (visibilitychange). A glance while the tab is hidden must NOT ack — only an
// actual visible view does. Pure so the rule is testable without a DOM.

// Whether a visibilitychange to the given state should send `seen`. Only the
// 'visible' state acks — 'hidden' (backgrounded tab / locked phone) does not.
export function shouldSendSeenOnVisibility(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === 'visible';
}

// Whether mounting the Stream view should send `seen`. Mounting the view IS the
// view (D9: viewing acks), so this is unconditional — kept as a named predicate
// so the mount and visibility paths read symmetrically at the call site.
export function shouldSendSeenOnMount(): boolean {
  return true;
}
