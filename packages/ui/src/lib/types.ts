// Minimal hand-duplicated shapes mirroring packages/core/src/schemas.ts and
// events.ts. @vimes/core is not a sanctioned dependency of this package (see
// checkpoint), so the wire/projection shapes this client actually reads are
// re-declared narrowly here rather than imported.

export type Liveness = 'spawning' | 'running' | 'dormant' | 'interrupted' | 'dead';
// 'rate-limited' and 'brake' are reserved (rule 0.5): no setter emits them
// yet — 'rate-limited' lands with slice 5, 'brake' with slice 7.
export type AttentionReason = 'gate' | 'question' | 'completed' | 'stale' | 'quarantined' | 'rate-limited' | 'brake';
export type Custody = 'host' | 'external';

export interface SessionRecord {
  appSessionId: string;
  channel: 'sdk' | 'pty';
  cwd: string;
  liveness: Liveness;
  needsAttention: { reason: AttentionReason; since: string } | null;
  // HUMAN-supplied, and only ever human-supplied: `session_created` from the
  // spawn op and `session_renamed` from the WS rename op are its only writers.
  // The auto-titler writes `derivedTitle` instead, which is why a user name is
  // never overwritten (Q3 — structural, not a rule).
  name: string | null;
  // SYSTEM-derived from the session's first qualifying user message, written
  // once and never changed. Optional (mirrors packages/core/src/schemas.ts):
  // absent means "no title derived", never `''`.
  derivedTitle?: string;
  createdAt: string;
  // D10: 'external' = a mirrored (read-only) terminal-started/historical session;
  // 'host' = VIMES-owned. Optional here so a projection predating the field (or a
  // hand-built test record) reads as host-owned via deriveSessionRow.
  custody?: Custody;
  // D5/D30: the `ts` of the last `correction_queued` VIMES accepted, cleared to
  // `null` when the matching `correction_delivered` is observed. Optional here
  // (mirrors packages/core/src/schemas.ts) so a projection predating the field
  // reads as "nothing queued" via correctionStatus.ts's deriveCorrectionStatus.
  pendingCorrectionAt?: string | null;
}

export interface EventRecord {
  eventId: string;
  seq: number;
  stream: string;
  ts: string;
  type: string;
  payload: unknown;
}
