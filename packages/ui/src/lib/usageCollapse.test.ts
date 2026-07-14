import { describe, expect, it } from 'vitest';
import { collapseConsecutiveUsageEvents } from './usageCollapse.js';
import type { EventRecord } from './types.js';

function usageEvent(seq: number, payload: unknown): EventRecord {
  return { eventId: `u${seq}`, seq, stream: 's1', ts: '2026-07-14T00:00:00Z', type: 'usage_block', payload };
}

function messageEvent(seq: number): EventRecord {
  return { eventId: `m${seq}`, seq, stream: 's1', ts: '2026-07-14T00:00:00Z', type: 'message', payload: { role: 'assistant', content: 'hi' } };
}

describe('collapseConsecutiveUsageEvents', () => {
  it('keeps a single usage_block event', () => {
    const events = [usageEvent(1, { input_tokens: 10 })];
    expect(collapseConsecutiveUsageEvents(events)).toEqual(events);
  });

  it('collapses consecutive usage_block events with deep-equal payloads', () => {
    const first = usageEvent(1, { input_tokens: 10, output_tokens: 2 });
    const second = usageEvent(2, { input_tokens: 10, output_tokens: 2 });
    const third = usageEvent(3, { input_tokens: 10, output_tokens: 2 });
    expect(collapseConsecutiveUsageEvents([first, second, third])).toEqual([first]);
  });

  it('keeps each usage_block event whose payload differs from the previous kept one', () => {
    const first = usageEvent(1, { input_tokens: 10 });
    const second = usageEvent(2, { input_tokens: 20 });
    const third = usageEvent(3, { input_tokens: 20 });
    const fourth = usageEvent(4, { input_tokens: 30 });
    expect(collapseConsecutiveUsageEvents([first, second, third, fourth])).toEqual([first, second, fourth]);
  });

  it('collapses across interleaved non-usage events (consecutive among usage_block events, not the raw stream)', () => {
    const first = usageEvent(1, { input_tokens: 10 });
    const between = messageEvent(2);
    const second = usageEvent(3, { input_tokens: 10 });
    expect(collapseConsecutiveUsageEvents([first, between, second])).toEqual([first]);
  });

  it('does not mutate or drop non-usage events from consideration, and returns only usage_block events', () => {
    const message = messageEvent(1);
    const usage = usageEvent(2, { input_tokens: 5 });
    expect(collapseConsecutiveUsageEvents([message, usage])).toEqual([usage]);
  });

  it('treats key-order-different but value-equal payloads as equal', () => {
    const first = usageEvent(1, { a: 1, b: 2 });
    const second = usageEvent(2, { b: 2, a: 1 });
    expect(collapseConsecutiveUsageEvents([first, second])).toEqual([first]);
  });

  it('returns an empty array when there are no usage_block events', () => {
    expect(collapseConsecutiveUsageEvents([messageEvent(1)])).toEqual([]);
  });

  it('returns an empty array for an empty input', () => {
    expect(collapseConsecutiveUsageEvents([])).toEqual([]);
  });
});
