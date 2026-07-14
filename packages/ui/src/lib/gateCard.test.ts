import { describe, expect, it } from 'vitest';
import { deriveGateCards } from './gateCard.js';
import type { EventRecord } from './types.js';

function makeEvent(overrides: Partial<EventRecord> & Pick<EventRecord, 'seq' | 'type' | 'payload'>): EventRecord {
  return {
    eventId: `e${overrides.seq}`,
    stream: 'app-1',
    ts: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const EMPTY = new Set<string>();

describe('deriveGateCards', () => {
  it('produces no cards from an empty transcript', () => {
    expect(deriveGateCards([], EMPTY)).toEqual([]);
  });

  it('fired: a gate_fired event surfaces an active card in the fired state', () => {
    const events = [
      makeEvent({ seq: 1, type: 'gate_fired', payload: { appSessionId: 'app-1', prompt: 'Run rm -rf?', requestId: 'req-1' } }),
    ];
    expect(deriveGateCards(events, EMPTY)).toEqual([
      { requestId: 'req-1', appSessionId: 'app-1', prompt: 'Run rm -rf?', status: 'fired' },
    ]);
  });

  it('answering: a locally-sent gate_response marks the card answering before the server confirms', () => {
    const events = [
      makeEvent({ seq: 1, type: 'gate_fired', payload: { appSessionId: 'app-1', prompt: 'Run rm -rf?', requestId: 'req-1' } }),
    ];
    const cards = deriveGateCards(events, new Set(['req-1']));
    expect(cards).toEqual([{ requestId: 'req-1', appSessionId: 'app-1', prompt: 'Run rm -rf?', status: 'answering' }]);
  });

  it('cleared: a matching attention_cleared removes the card entirely', () => {
    const events = [
      makeEvent({ seq: 1, type: 'gate_fired', payload: { appSessionId: 'app-1', prompt: 'Run rm -rf?', requestId: 'req-1' } }),
      makeEvent({ seq: 2, type: 'attention_cleared', payload: { appSessionId: 'app-1', cause: 'gate_answered' } }),
    ];
    expect(deriveGateCards(events, new Set(['req-1']))).toEqual([]);
  });

  it('a later gate_fired for the same session replaces the earlier one', () => {
    const events = [
      makeEvent({ seq: 1, type: 'gate_fired', payload: { appSessionId: 'app-1', prompt: 'first', requestId: 'req-1' } }),
      makeEvent({ seq: 2, type: 'attention_cleared', payload: { appSessionId: 'app-1', cause: 'gate_answered' } }),
      makeEvent({ seq: 3, type: 'gate_fired', payload: { appSessionId: 'app-1', prompt: 'second', requestId: 'req-2' } }),
    ];
    expect(deriveGateCards(events, EMPTY)).toEqual([
      { requestId: 'req-2', appSessionId: 'app-1', prompt: 'second', status: 'fired' },
    ]);
  });

  it('ignores malformed gate_fired payloads without throwing', () => {
    const events = [
      makeEvent({ seq: 1, type: 'gate_fired', payload: { appSessionId: 'app-1' } }), // missing prompt/requestId
      makeEvent({ seq: 2, type: 'gate_fired', payload: 'not-an-object' }),
      makeEvent({ seq: 3, type: 'gate_fired', payload: null }),
    ];
    expect(() => deriveGateCards(events, EMPTY)).not.toThrow();
    expect(deriveGateCards(events, EMPTY)).toEqual([]);
  });

  it('ignores an attention_cleared with a malformed payload', () => {
    const events = [
      makeEvent({ seq: 1, type: 'gate_fired', payload: { appSessionId: 'app-1', prompt: 'p', requestId: 'req-1' } }),
      makeEvent({ seq: 2, type: 'attention_cleared', payload: { cause: 'gate_answered' } }), // missing appSessionId
    ];
    expect(deriveGateCards(events, EMPTY)).toEqual([
      { requestId: 'req-1', appSessionId: 'app-1', prompt: 'p', status: 'fired' },
    ]);
  });

  it('ignores unrelated event types', () => {
    const events = [
      makeEvent({ seq: 1, type: 'message', payload: { appSessionId: 'app-1', role: 'user', content: 'hi' } }),
      makeEvent({ seq: 2, type: 'run_completed', payload: { appSessionId: 'app-1' } }),
    ];
    expect(deriveGateCards(events, EMPTY)).toEqual([]);
  });
});
