// ─── S15·U1 — the tree's affecting-types set (slice-15.md §0 recon, §4 A3) ────
//
// Moved out of `vimesStore.ts` so the tree (and the store) share ONE source of
// record for "what can move the sessions projection" without the store's own
// superset having to be reconstructed by hand wherever something needs it —
// and, just as important, WITHOUT this lib depending on the store (which would
// drag pinia into what is otherwise a plain node test, the same reason every
// other module in this directory stays framework-free).

// Event types that can move the sessions projection (liveness/attention
// badges on the home list) — seen on a subscribed stream, they schedule a
// throttled REST re-fetch rather than trying to patch the projection locally
// (scope: "keep it simple ... correctness first").
export const SESSIONS_AFFECTING_TYPES = new Set([
  'session_created',
  'liveness_changed',
  'gate_fired',
  'question_asked',
  'run_completed',
  'watchdog_stale',
  'task_quarantined',
  'seen',
  'attention_cleared',
  // v0.2 (D10): custody/name transitions move the home list too.
  'session_adopted',
  'session_renamed',
  // Slice 6 step 6b (D5/D30): `correction_queued` sets `pendingCorrectionAt`
  // and `correction_delivered` clears it back to null on the sessions
  // projection (packages/core/src/projections/sessions.ts). WITHOUT these two
  // in the set, the correction indicator would only appear or clear whenever
  // some OTHER session-affecting event happened to trigger a refresh — an
  // operator could send a steer, watch a completely quiet composer (no gate,
  // no liveness change, nothing), and reasonably conclude it vanished. These
  // events themselves must trigger the refresh, not ride along on one.
  'correction_queued',
  'correction_delivered',
]);

// Everything that can move the sessions projection can move the tree — the
// tree embeds session leaves — PLUS the events that reshape the forest
// itself: the three E2 node events and the project registry lifecycle
// (roots are composed from projects, F1).
export const TREE_AFFECTING_TYPES: ReadonlySet<string> = new Set([
  ...SESSIONS_AFFECTING_TYPES,
  'node_created',
  'node_closed',
  'session_attached_to_node',
  'project_created',
  'project_updated',
  'project_archived',
]);
