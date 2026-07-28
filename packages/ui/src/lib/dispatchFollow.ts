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
// ⚠ S7·7e — TWO WAYS A TASK ACTION NOW MINTS A SESSION, ONE GUARD. An explicit
// `POST /.../dispatch` is one; a D53 promotion into an active stage is the
// other — the transitions route makes its own dispatch attempt and rides the
// result on a top-level `dispatch` field (see taskApi.ts's
// `ProposeTransitionResponse`), rather than under `result` the way the
// dispatch route does. Both need the identical subscribe-and-refresh glue, so
// both exported functions below share ONE inner check
// (`spawnedSessionIdFromResult`) and differ only in WHERE they look for the
// result object in the envelope.
//
// Each function makes ONLY the decision — "does this response mean a new
// session came alive, and if so, which one" — so the store's glue can act on
// a plain string | null rather than re-deriving the guard inline, and so the
// guard itself is testable (TaskBoardView.vue reuses `describeDispatchResponse`
// on the same re-wrapped shape to decide whether a notice grows a link to the
// new session, for the same reason).
//
// ⚠ THE GUARD IS DELIBERATELY STRICT (I8 posture, total — never throws):
//   • status must be the dispatcher's actual success envelope (200) — a 404
//     (unknown task) or any other status carries no attempt to trust.
//   • the result's `outcome` must be the literal string 'spawned'.
//     `deferred`/`refused`/`spawn-failed`/`worktree-failed`/`in-flight`/
//     anything unrecognised spawn nothing. (`resumed` used to be excluded
//     here too, deliberately, even though it also carried an appSessionId —
//     it reattached to a session that already existed, so it was never
//     "new". D46 removed the daemon's resume path entirely and S7·7e removed
//     the outcome from the union; the string can no longer arrive, and if it
//     somehow did, it would simply fail the `=== 'spawned'` check like any
//     other retired or unrecognised outcome — no special case needed any
//     more.)
//   • the result's `appSessionId` must be a non-empty string.
// Anything else — a malformed body, a non-object, a missing field, the wrong
// type — returns null. No property access here can throw: every step is a
// `typeof` check before it is used.

// The shared inner check, given whatever object CLAIMS to be the dispatch
// result (already extracted from wherever its caller's envelope keeps it).
// Never called directly by a consumer — always through one of the two named
// functions below, so a reader never has to ask "which envelope shape does
// this one read".
function spawnedSessionIdFromResult(result: unknown): string | null {
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

// `POST /api/tasks/:taskId/dispatch` — the result lives under `body.result`.
export function sessionToSubscribeAfterDispatch(status: number, body: unknown): string | null {
  if (status !== 200) {
    return null;
  }
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  return spawnedSessionIdFromResult((body as Record<string, unknown>).result);
}

// `POST /api/tasks/:taskId/transitions` — an accepted promotion into an
// active stage carries the SAME shape of result, but at the TOP LEVEL of the
// envelope as `body.dispatch` (taskApi.ts's `ProposeTransitionResponse`),
// because `body.result` on this route is not a dispatch result at all — it
// does not exist; the accepted envelope carries `task`. Every other accepted
// transition (an outcome edge, a move into a non-active stage) omits the
// `dispatch` key entirely, which `spawnedSessionIdFromResult` handles for
// free: a missing key reads as `undefined`, `typeof undefined !== 'object'`,
// and the guard returns null exactly as it should for "nothing was
// dispatched here".
export function sessionToSubscribeAfterTransition(status: number, body: unknown): string | null {
  if (status !== 200) {
    return null;
  }
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  return spawnedSessionIdFromResult((body as Record<string, unknown>).dispatch);
}
