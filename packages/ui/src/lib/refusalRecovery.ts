// Pure decision logic for recovering local optimistic UI state ("pending"/
// "in flight" flags a component sets before a server round trip resolves)
// when the round trip ends in a `refused` envelope rather than the expected
// success envelope. Kept pure so the recovery rules are unit-testable
// without a live WebSocket/store.
//
// Bug class this guards against: a component sets a local flag (spinner,
// disabled button) when it sends an op, and only clears it on the matching
// success envelope. If the daemon replies `refused` instead, the flag never
// clears and the affordance hangs forever. See vimesStore.ts's spawn/gate/
// search handling in applyServerEnvelope for where these are wired in.

// ── spawn ──────────────────────────────────────────────────────────────────
// spawnSession tracks a single in-flight spawn (the store's documented
// simplification: only one spawn is ever in flight at a time). Exactly one
// terminal envelope — `spawned` or a `refused` with refusedOp 'spawn' —
// resolves it and clears the pending record, firing exactly one callback.

export interface PendingSpawn {
  onSpawned: (appSessionId: string) => void;
  onRefused: (reason: string) => void;
}

export type SpawnPendingState = PendingSpawn | null;

export interface SpawnPendingResolution {
  next: SpawnPendingState;
  // Set only when a callback should fire — the caller invokes it after
  // committing `next`, so the pending record is already cleared by the time
  // the callback runs (re-entrant spawnSession calls from inside the
  // callback see a clean slate).
  fire: (() => void) | null;
}

// A `spawned` envelope always resolves whatever spawn is pending (there is
// nothing else it could belong to, given the one-in-flight simplification).
export function resolveSpawnedPending(pending: SpawnPendingState, appSessionId: string): SpawnPendingResolution {
  if (pending === null) {
    return { next: null, fire: null };
  }
  return { next: null, fire: () => pending.onSpawned(appSessionId) };
}

// A `refused` envelope only resolves the pending spawn when it is refusing
// the spawn op specifically — a refusal of some other op (e.g. a concurrent
// `send`) must leave the pending spawn untouched.
export function resolveRefusedPending(
  pending: SpawnPendingState,
  refusedOp: string,
  reason: string,
): SpawnPendingResolution {
  if (pending === null || refusedOp !== 'spawn') {
    return { next: pending, fire: null };
  }
  return { next: null, fire: () => pending.onRefused(reason) };
}

// ── gate_response ────────────────────────────────────────────────────────
// answerGate optimistically marks a requestId "answering" (disabling its
// Allow/Deny buttons) before the round trip resolves. Unlike spawn, the wire
// protocol's `refused` envelope carries no requestId to correlate against
// (packages/daemon/src/wsHub.ts's refuse() only sends {refusedOp, reason}),
// and gateCard.ts's own contract is that a session has at most one active
// gate at a time. Given that, the only UI-only-safe recovery from a
// gate_response refusal is to clear every optimistic "answering" flag —
// precise per-request correlation would need a daemon-side wire change
// (out of scope here; see the audit note in the final report).
export function isGateResponseRefusal(refusedOp: string): boolean {
  return refusedOp === 'gate_response';
}

// ── search ───────────────────────────────────────────────────────────────
// startSearch sets searchStatus 'running' before the round trip resolves.
// Like gate_response, a `refused` envelope carries no searchId, but the store
// documents (and the panel assumes) only one search is ever in flight, so a
// 'search' refusal while status is 'running' unambiguously belongs to the
// active search and should surface as an error rather than leaving the
// "Searching…" spinner running forever.
export function shouldSearchRefusalError(searchStatus: string, refusedOp: string): boolean {
  return refusedOp === 'search' && searchStatus === 'running';
}
