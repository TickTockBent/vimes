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
  name: string | null;
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
