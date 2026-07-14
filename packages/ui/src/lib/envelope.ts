import type { EventRecord } from './types.js';

// WS protocol v0/v0.1 (packages/daemon/src/wsHub.ts is the source of truth).
// zod is not a sanctioned dep here, so parsing is hand-rolled tolerant guards
// mirroring the daemon's safeParse discipline: malformed/unrecognized input
// returns null rather than throwing.

export type ClientEnvelope =
  | { op: 'subscribe'; stream: string; lastSeq: number }
  | { op: 'unsubscribe'; stream: string }
  | { op: 'send'; appSessionId: string; text: string }
  | { op: 'gate_response'; appSessionId: string; requestId: string; response: 'allow' | 'deny' }
  | { op: 'resume'; appSessionId: string }
  | { op: 'spawn'; channel: 'sdk' | 'pty'; cwd: string; name?: string };

export type ServerEnvelope =
  | { op: 'subscribed'; stream: string; head: number }
  | { op: 'event'; event: EventRecord }
  | { op: 'refused'; refusedOp: string; reason: string }
  | { op: 'error'; reason: string }
  | { op: 'spawned'; appSessionId: string };

export function serializeClientEnvelope(envelope: ClientEnvelope): string {
  return JSON.stringify(envelope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEventRecord(value: unknown): value is EventRecord {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.stream === 'string' &&
    typeof value.ts === 'string' &&
    typeof value.type === 'string' &&
    'payload' in value
  );
}

// Tolerant parse: never throws. Unknown ops, missing fields, or non-JSON
// input all fall through to null so the caller can drop the frame silently
// (the daemon side already validated the ops it sends; this is defense in
// depth against a mismatched/future server, not a trust boundary).
export function parseServerEnvelope(raw: string): ServerEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.op !== 'string') {
    return null;
  }
  switch (parsed.op) {
    case 'subscribed':
      return typeof parsed.stream === 'string' && typeof parsed.head === 'number'
        ? { op: 'subscribed', stream: parsed.stream, head: parsed.head }
        : null;
    case 'event':
      return isEventRecord(parsed.event) ? { op: 'event', event: parsed.event } : null;
    case 'refused':
      return typeof parsed.refusedOp === 'string' && typeof parsed.reason === 'string'
        ? { op: 'refused', refusedOp: parsed.refusedOp, reason: parsed.reason }
        : null;
    case 'error':
      return typeof parsed.reason === 'string' ? { op: 'error', reason: parsed.reason } : null;
    case 'spawned':
      return typeof parsed.appSessionId === 'string' ? { op: 'spawned', appSessionId: parsed.appSessionId } : null;
    default:
      return null;
  }
}
