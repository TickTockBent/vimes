import { describe, expect, it } from 'vitest';
import { parseServerEnvelope, serializeClientEnvelope } from './envelope.js';

describe('serializeClientEnvelope', () => {
  it('serializes a subscribe envelope', () => {
    const json = serializeClientEnvelope({ op: 'subscribe', stream: 'app-1', lastSeq: 0 });
    expect(JSON.parse(json)).toEqual({ op: 'subscribe', stream: 'app-1', lastSeq: 0 });
  });

  it('serializes a spawn envelope with an optional name omitted', () => {
    const json = serializeClientEnvelope({ op: 'spawn', channel: 'pty', cwd: '/tmp/x' });
    expect(JSON.parse(json)).toEqual({ op: 'spawn', channel: 'pty', cwd: '/tmp/x' });
  });
});

describe('parseServerEnvelope', () => {
  it('parses a subscribed envelope', () => {
    const envelope = parseServerEnvelope(JSON.stringify({ op: 'subscribed', stream: 'app-1', head: 5 }));
    expect(envelope).toEqual({ op: 'subscribed', stream: 'app-1', head: 5 });
  });

  it('parses an event envelope carrying an EventRecord', () => {
    const event = { eventId: 'e1', seq: 1, stream: 'app-1', ts: '2026-01-01T00:00:00.000Z', type: 'message', payload: { role: 'user', content: 'hi' } };
    const envelope = parseServerEnvelope(JSON.stringify({ op: 'event', event }));
    expect(envelope).toEqual({ op: 'event', event });
  });

  it('parses a refused envelope', () => {
    const envelope = parseServerEnvelope(JSON.stringify({ op: 'refused', refusedOp: 'spawn', reason: 'cwd-outside-project-roots' }));
    expect(envelope).toEqual({ op: 'refused', refusedOp: 'spawn', reason: 'cwd-outside-project-roots' });
  });

  it('parses an error envelope', () => {
    const envelope = parseServerEnvelope(JSON.stringify({ op: 'error', reason: 'malformed-json' }));
    expect(envelope).toEqual({ op: 'error', reason: 'malformed-json' });
  });

  it('parses a spawned envelope', () => {
    const envelope = parseServerEnvelope(JSON.stringify({ op: 'spawned', appSessionId: 'app-9' }));
    expect(envelope).toEqual({ op: 'spawned', appSessionId: 'app-9' });
  });

  it('tolerates malformed JSON without throwing', () => {
    expect(() => parseServerEnvelope('{not json')).not.toThrow();
    expect(parseServerEnvelope('{not json')).toBeNull();
  });

  it('tolerates a non-object JSON value', () => {
    expect(parseServerEnvelope('"just a string"')).toBeNull();
    expect(parseServerEnvelope('42')).toBeNull();
    expect(parseServerEnvelope('null')).toBeNull();
  });

  it('tolerates an unknown op', () => {
    expect(parseServerEnvelope(JSON.stringify({ op: 'mystery' }))).toBeNull();
  });

  it('tolerates a known op with missing/wrong-typed fields', () => {
    expect(parseServerEnvelope(JSON.stringify({ op: 'subscribed', stream: 'app-1' }))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify({ op: 'event', event: { seq: 1 } }))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify({ op: 'refused', refusedOp: 'send' }))).toBeNull();
    expect(parseServerEnvelope(JSON.stringify({ op: 'spawned', appSessionId: 42 }))).toBeNull();
  });
});
