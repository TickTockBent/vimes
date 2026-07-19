import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPushPayload,
  isValidPushSubscription,
  loadOrCreateVapidKeys,
  reasonBody,
  vapidKeyPath,
} from './pushService.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-push-svc-'));

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('loadOrCreateVapidKeys — generate once, load thereafter, mode 600', () => {
  it('generates a keypair on first call, writes vapid.json mode 600, and reuses it', () => {
    const dataDir = mkdtempSync(join(temporaryDirectory, 'gen-'));
    const first = loadOrCreateVapidKeys(dataDir);
    expect(typeof first.publicKey).toBe('string');
    expect(first.publicKey.length).toBeGreaterThan(0);
    expect(typeof first.privateKey).toBe('string');
    expect(first.privateKey.length).toBeGreaterThan(0);

    // The stored file is mode 600 — the private key is signing material.
    const stats = statSync(vapidKeyPath(dataDir));
    expect(stats.mode & 0o777).toBe(0o600);

    // A second call loads the SAME keys (never regenerates), so the public key the
    // client subscribed against is stable across boots.
    const second = loadOrCreateVapidKeys(dataDir);
    expect(second).toEqual(first);
  });
});

describe('buildPushPayload / reasonBody (pure)', () => {
  it('uses the session name as the title and deep-links to the session', () => {
    const payload = buildPushPayload({ appSessionId: 'app-1234abcd', name: 'Dongfu build', reason: 'gate' });
    expect(payload.title).toBe('Dongfu build');
    expect(payload.url).toBe('/#/session/app-1234abcd');
    expect(payload.body).toBe(reasonBody('gate'));
  });

  it('falls back to an id prefix when the session is unnamed', () => {
    const payload = buildPushPayload({ appSessionId: 'abcdefgh-rest', name: null, reason: 'completed' });
    expect(payload.title).toBe('abcdefgh');
    expect(payload.url).toBe('/#/session/abcdefgh-rest');
  });

  it('gives a distinct one-liner per attention reason', () => {
    const reasons = ['gate', 'question', 'completed', 'stale', 'quarantined'] as const;
    const bodies = reasons.map((reason) => reasonBody(reason));
    expect(new Set(bodies).size).toBe(reasons.length);
  });
});

describe('isValidPushSubscription (loose, rule 0.6)', () => {
  it('accepts an endpoint URL + keys object', () => {
    expect(
      isValidPushSubscription({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } }),
    ).toBe(true);
  });

  it('rejects a missing/blank endpoint, a non-URL endpoint, or a missing keys object', () => {
    expect(isValidPushSubscription({ keys: {} })).toBe(false);
    expect(isValidPushSubscription({ endpoint: '', keys: {} })).toBe(false);
    expect(isValidPushSubscription({ endpoint: 'not a url', keys: {} })).toBe(false);
    expect(isValidPushSubscription({ endpoint: 'https://push.example.com/abc' })).toBe(false);
    expect(isValidPushSubscription({ endpoint: 'https://push.example.com/abc', keys: 'nope' })).toBe(false);
    expect(isValidPushSubscription(null)).toBe(false);
    expect(isValidPushSubscription('nope')).toBe(false);
  });
});
