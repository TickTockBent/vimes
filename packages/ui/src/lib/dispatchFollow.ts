// S9 — the seam between "task dispatched" and "session is live".
//
// The client only receives live events for streams it is SUBSCRIBED to. A
// task dispatch is a plain HTTP POST (`dispatchTask`, vimesStore.ts) — it
// neither subscribes to the new session's stream nor refreshes the sessions
// list, so a brand-new `session_created` lands on an unsubscribed stream and
// is invisible until a manual reload. The store already solves this exact
// problem for discovery (the WS 'discovered' handler calls
// `scheduleSessionsRefresh()`); this is the same fix for a dispatch.
//
// This function makes ONLY the decision — "does this response mean a new
// session came alive, and if so, which one" — so the store's glue can act on
// a plain string | null rather than re-deriving the guard inline, and so the
// guard itself is testable (TaskBoardView.vue reuses it to decide whether the
// dispatch notice grows a link to the new session, for the same reason).
//
// ⚠ THE GUARD IS DELIBERATELY STRICT (I8 posture, total — never throws):
//   • status must be the dispatcher's actual success envelope (200) — a 404
//     (unknown task) or any other status carries no attempt to trust.
//   • body.result.outcome must be the literal string 'spawned'. `resumed`
//     reattaches to a session that (by definition) already exists — it is not
//     new, and is deliberately excluded here even though it also carries an
//     appSessionId. `deferred`/`refused`/`spawn-failed`/`resume-failed`/
//     `worktree-failed`/anything unrecognised spawn nothing.
//   • body.result.appSessionId must be a non-empty string.
// Anything else — a malformed body, a non-object, a missing field, the wrong
// type — returns null. No property access here can throw: every step is a
// `typeof` check before it is used.
export function sessionToSubscribeAfterDispatch(status: number, body: unknown): string | null {
  if (status !== 200) {
    return null;
  }
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const envelope = body as Record<string, unknown>;
  const result = envelope.result;
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const resultRecord = result as Record<string, unknown>;
  if (resultRecord.outcome !== 'spawned') {
    return null;
  }
  const appSessionId = resultRecord.appSessionId;
  return typeof appSessionId === 'string' && appSessionId.length > 0 ? appSessionId : null;
}
