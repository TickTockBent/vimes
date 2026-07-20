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
  | { op: 'spawn'; channel: 'sdk' | 'pty'; cwd: string; name?: string }
  // v0.2 (D9/D10) session ops.
  | { op: 'seen'; appSessionId: string }
  | { op: 'clear_attention'; appSessionId: string }
  | { op: 'kill'; appSessionId: string }
  | { op: 'rename'; appSessionId: string; name: string }
  | { op: 'adopt'; appSessionId: string }
  | { op: 'discover' }
  // v0.3 (step 3) push subscription ops. `subscription` is the browser's Push API
  // subscription (PushSubscription.toJSON()); the daemon validates it loose.
  | { op: 'push_subscribe'; subscription: unknown }
  | { op: 'push_unsubscribe'; endpoint: string }
  // v0.4 (slice 3) search ops (wsHub.ts searchEnvelopeSchema). Flags are loose;
  // an unknown flag rides through and is ignored by the rg arg builder (rule 0.6).
  | { op: 'search'; searchId: string; root: string; query: string; flags?: SearchFlags }
  | { op: 'search_cancel'; searchId: string };

export interface SearchFlags {
  caseInsensitive?: boolean;
  word?: boolean;
  regex?: boolean;
}

// One streamed match line and the terminal frames of a search (search.ts).
export interface SearchResultEnvelope {
  op: 'search_result';
  searchId: string;
  file: string;
  line: number;
  col: number;
  submatches: Array<{ start: number; end: number; text: string }>;
}

export type ServerEnvelope =
  | { op: 'subscribed'; stream: string; head: number }
  | { op: 'event'; event: EventRecord }
  | { op: 'refused'; refusedOp: string; reason: string }
  | { op: 'error'; reason: string }
  | { op: 'spawned'; appSessionId: string }
  | { op: 'discovered'; count: number }
  | SearchResultEnvelope
  | { op: 'search_done'; searchId: string; stats: { matched: number; files: number; elapsedMs: number } }
  | { op: 'search_error'; searchId: string; reason: string };

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
    case 'discovered':
      return typeof parsed.count === 'number' ? { op: 'discovered', count: parsed.count } : null;
    case 'search_result':
      return typeof parsed.searchId === 'string' &&
        typeof parsed.file === 'string' &&
        typeof parsed.line === 'number' &&
        typeof parsed.col === 'number' &&
        Array.isArray(parsed.submatches)
        ? {
            op: 'search_result',
            searchId: parsed.searchId,
            file: parsed.file,
            line: parsed.line,
            col: parsed.col,
            submatches: parsed.submatches as SearchResultEnvelope['submatches'],
          }
        : null;
    case 'search_done':
      return typeof parsed.searchId === 'string' && isRecord(parsed.stats)
        ? {
            op: 'search_done',
            searchId: parsed.searchId,
            stats: {
              matched: typeof parsed.stats.matched === 'number' ? parsed.stats.matched : 0,
              files: typeof parsed.stats.files === 'number' ? parsed.stats.files : 0,
              elapsedMs: typeof parsed.stats.elapsedMs === 'number' ? parsed.stats.elapsedMs : 0,
            },
          }
        : null;
    case 'search_error':
      return typeof parsed.searchId === 'string' && typeof parsed.reason === 'string'
        ? { op: 'search_error', searchId: parsed.searchId, reason: parsed.reason }
        : null;
    default:
      return null;
  }
}
