import type { EventRecord } from './types.js';

// D17 (docs/open-questions.md): one turn spans several SDK assistant
// messages (thinking, tool_use, final text), EACH carrying a usage
// snapshot — the daemon emits one usage_block per message, so identical
// snapshots repeat within a turn. The store keeps every event as delivered
// (rule 0.7: the log is honest, that IS what the SDK sent); this is a
// presentation-only collapse — it decides which usage_block events are
// worth a rendered line, without touching the store's event list.
//
// "Consecutive" is judged among usage_block events themselves (in seq
// order), not strict adjacency in the raw stream: message events for the
// same turn are interleaved between usage_block events, so a naive
// back-to-back check would never collapse anything. Callers must pass
// events already sorted by seq (StreamView.vue's `events` computed already
// is).
export function collapseConsecutiveUsageEvents(events: EventRecord[]): EventRecord[] {
  const kept: EventRecord[] = [];
  let previousPayload: unknown;
  let havePrevious = false;
  for (const event of events) {
    if (event.type !== 'usage_block') {
      continue;
    }
    if (havePrevious && deepEqual(event.payload, previousPayload)) {
      continue;
    }
    kept.push(event);
    previousPayload = event.payload;
    havePrevious = true;
  }
  return kept;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    return false;
  }
  if (aIsArray && bIsArray) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key]))
  );
}
