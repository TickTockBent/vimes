import { describe, expect, it } from 'vitest';
import { notificationViewFrom, parsePushPayload } from './pushNotification.js';

describe('parsePushPayload', () => {
  it('parses a complete { title, body, url } payload', () => {
    const raw = JSON.stringify({ title: 'Dongfu build', body: 'Waiting for your approval', url: '/#/session/app-1' });
    expect(parsePushPayload(raw)).toEqual({
      title: 'Dongfu build',
      body: 'Waiting for your approval',
      url: '/#/session/app-1',
    });
  });

  it('returns null for malformed JSON or a missing/blank field', () => {
    expect(parsePushPayload('not json')).toBeNull();
    expect(parsePushPayload(JSON.stringify({ title: 'x', body: 'y' }))).toBeNull();
    expect(parsePushPayload(JSON.stringify({ title: '', body: 'y', url: '/z' }))).toBeNull();
    expect(parsePushPayload(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parsePushPayload(JSON.stringify(null))).toBeNull();
  });
});

describe('notificationViewFrom', () => {
  it('uses the parsed payload when valid', () => {
    const raw = JSON.stringify({ title: 'T', body: 'B', url: '/#/session/s' });
    expect(notificationViewFrom(raw)).toEqual({ title: 'T', body: 'B', url: '/#/session/s' });
  });

  it('falls back to a generic notification (no deep link) when absent or malformed', () => {
    expect(notificationViewFrom(undefined).url).toBeNull();
    expect(notificationViewFrom('garbage').title).toBe('VIMES');
    expect(notificationViewFrom('garbage').url).toBeNull();
  });
});
