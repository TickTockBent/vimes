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

  it('serializes the v0.4 search ops', () => {
    expect(
      JSON.parse(serializeClientEnvelope({ op: 'search', searchId: 's1', root: '/r', query: 'x', flags: { caseInsensitive: true } })),
    ).toEqual({ op: 'search', searchId: 's1', root: '/r', query: 'x', flags: { caseInsensitive: true } });
    expect(JSON.parse(serializeClientEnvelope({ op: 'search_cancel', searchId: 's1' }))).toEqual({
      op: 'search_cancel',
      searchId: 's1',
    });
  });

  it('serializes term_open with cols/rows (mobile terminal-corruption fix — initial pty size)', () => {
    const json = serializeClientEnvelope({ op: 'term_open', cwd: '/work/project', cols: 42, rows: 18 });
    expect(JSON.parse(json)).toEqual({ op: 'term_open', cwd: '/work/project', cols: 42, rows: 18 });
  });

  it('serializes term_open with cols/rows omitted (unfitted caller — daemon falls back to its default)', () => {
    const json = serializeClientEnvelope({ op: 'term_open', cwd: '/work/project' });
    expect(JSON.parse(json)).toEqual({ op: 'term_open', cwd: '/work/project' });
  });

  it('serializes the v0.2 session ops', () => {
    expect(JSON.parse(serializeClientEnvelope({ op: 'seen', appSessionId: 'a' }))).toEqual({ op: 'seen', appSessionId: 'a' });
    expect(JSON.parse(serializeClientEnvelope({ op: 'clear_attention', appSessionId: 'a' }))).toEqual({ op: 'clear_attention', appSessionId: 'a' });
    expect(JSON.parse(serializeClientEnvelope({ op: 'kill', appSessionId: 'a' }))).toEqual({ op: 'kill', appSessionId: 'a' });
    expect(JSON.parse(serializeClientEnvelope({ op: 'rename', appSessionId: 'a', name: 'n' }))).toEqual({ op: 'rename', appSessionId: 'a', name: 'n' });
    expect(JSON.parse(serializeClientEnvelope({ op: 'adopt', appSessionId: 'a' }))).toEqual({ op: 'adopt', appSessionId: 'a' });
    expect(JSON.parse(serializeClientEnvelope({ op: 'discover' }))).toEqual({ op: 'discover' });
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

  it('parses a discovered envelope carrying a count', () => {
    const envelope = parseServerEnvelope(JSON.stringify({ op: 'discovered', count: 3 }));
    expect(envelope).toEqual({ op: 'discovered', count: 3 });
    // A missing/wrong-typed count falls through to null (tolerant parse).
    expect(parseServerEnvelope(JSON.stringify({ op: 'discovered' }))).toBeNull();
  });

  it('parses the search server ops', () => {
    const result = { op: 'search_result', searchId: 's1', file: '/a.ts', line: 4, col: 2, submatches: [{ start: 2, end: 5, text: 'foo' }] };
    expect(parseServerEnvelope(JSON.stringify(result))).toEqual(result);
    const done = { op: 'search_done', searchId: 's1', stats: { matched: 3, files: 2, elapsedMs: 12 } };
    expect(parseServerEnvelope(JSON.stringify(done))).toEqual(done);
    expect(parseServerEnvelope(JSON.stringify({ op: 'search_error', searchId: 's1', reason: 'ripgrep-unavailable' }))).toEqual({
      op: 'search_error',
      searchId: 's1',
      reason: 'ripgrep-unavailable',
    });
    // A malformed search_result (submatches not an array) falls through to null.
    expect(parseServerEnvelope(JSON.stringify({ op: 'search_result', searchId: 's', file: '/a', line: 1, col: 0, submatches: 'no' }))).toBeNull();
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
