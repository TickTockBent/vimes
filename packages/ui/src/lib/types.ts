// Minimal hand-duplicated shapes mirroring packages/core/src/schemas.ts and
// events.ts. @vimes/core is not a sanctioned dependency of this package (see
// checkpoint), so the wire/projection shapes this client actually reads are
// re-declared narrowly here rather than imported.

export type Liveness = 'spawning' | 'running' | 'dormant' | 'interrupted' | 'dead';
export type AttentionReason = 'gate' | 'question' | 'completed' | 'stale' | 'quarantined';

export interface SessionRecord {
  appSessionId: string;
  channel: 'sdk' | 'pty';
  cwd: string;
  liveness: Liveness;
  needsAttention: { reason: AttentionReason; since: string } | null;
  name: string | null;
  createdAt: string;
}

export interface EventRecord {
  eventId: string;
  seq: number;
  stream: string;
  ts: string;
  type: string;
  payload: unknown;
}
