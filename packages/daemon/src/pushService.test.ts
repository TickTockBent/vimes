import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHORT_SESSION_ID_BASE_LENGTH } from '@vimes/core';
import {
  DEFAULT_PUSH_TTL_SECONDS,
  buildPushPayload,
  isValidPushSubscription,
  loadOrCreateVapidKeys,
  reasonBody,
  urgencyForAttentionReason,
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
    const payload = buildPushPayload({
      appSessionId: 'app-1234abcd',
      name: 'Dongfu build',
      reason: 'gate',
      estateSessionIds: ['app-1234abcd'],
    });
    expect(payload.title).toBe('Dongfu build');
    expect(payload.url).toBe('/#/session/app-1234abcd');
    expect(payload.body).toBe(reasonBody('gate'));
  });

  // S14·U3 (D79): the fallback is the SHORT ID at the engine's base width, not
  // the unowned `slice(0, 8)` this call site used to carry.
  it('falls back to the D79 short id when the session is unnamed', () => {
    const payload = buildPushPayload({
      appSessionId: 'abcdefgh-rest',
      name: null,
      reason: 'completed',
      estateSessionIds: ['abcdefgh-rest', 'zzzz-other'],
    });
    expect(payload.title).toBe('abcd');
    expect(payload.title.length).toBe(SHORT_SESSION_ID_BASE_LENGTH);
    expect(payload.url).toBe('/#/session/abcdefgh-rest');
  });

  // ⚠ THE WHOLE REASON THE BARE SLICE HAD TO GO. Two sessions sharing a prefix
  // used to produce two notifications with the SAME title; the estate-aware
  // renderer extends the colliding group instead, so the human can tell which
  // session is asking.
  it('EXTENDS the handle when the estate holds a colliding prefix (the defect the slice had)', () => {
    const estateSessionIds = ['abcd1111-one', 'abcd2222-two'];
    const first = buildPushPayload({
      appSessionId: 'abcd1111-one',
      name: null,
      reason: 'gate',
      estateSessionIds,
    });
    const second = buildPushPayload({
      appSessionId: 'abcd2222-two',
      name: null,
      reason: 'gate',
      estateSessionIds,
    });
    expect(first.title).not.toBe(second.title);
    expect(first.title.length).toBeGreaterThan(SHORT_SESSION_ID_BASE_LENGTH);
    // A bare `slice(0, 8)` would have produced 'abcd1111' / 'abcd2222' here and
    // an 8-wide handle for the uncolliding case above — the width is the
    // engine's now, and it is a function of the estate.
    expect(first.title).toBe('abcd1');
    expect(second.title).toBe('abcd2');
  });

  // The estate is whole-estate by declaration (F4), but a trigger for a session
  // the passed estate omits must still render a handle rather than a blank or a
  // raw uuid — the union in `buildPushPayload` is what makes that true.
  it('still renders a handle for a session the passed estate omits', () => {
    const payload = buildPushPayload({
      appSessionId: 'ffff9999-missing',
      name: null,
      reason: 'stale',
      estateSessionIds: ['0000-other'],
    });
    expect(payload.title).toBe('ffff');
  });

  it('gives a distinct one-liner per attention reason', () => {
    // Includes the rule-0.5-reserved reasons ('rate-limited' slice 5, 'brake'
    // slice 7) — no setter emits them yet, but reasonBody must already be
    // exhaustive over the widened AttentionReason value space.
    const reasons = ['gate', 'question', 'completed', 'stale', 'quarantined', 'rate-limited', 'brake'] as const;
    const bodies = reasons.map((reason) => reasonBody(reason));
    expect(new Set(bodies).size).toBe(reasons.length);
  });

  it('builds a correct push payload for the reserved rate-limited reason (rule 0.5)', () => {
    const payload = buildPushPayload({
      appSessionId: 'app-rl-0001',
      name: 'rl session',
      reason: 'rate-limited',
      estateSessionIds: ['app-rl-0001'],
    });
    expect(payload).toEqual({
      title: 'rl session',
      body: reasonBody('rate-limited'),
      url: '/#/session/app-rl-0001',
    });
  });
});

describe('urgencyForAttentionReason (D29 — high wakes the radio, routine does not)', () => {
  it('is HIGH only for the "human needed now" reasons (blocking + reserved action)', () => {
    // gate/question block on the human; rate-limited/brake are rule-0.5-reserved
    // action-required reasons. All wake a dozing device.
    for (const reason of ['gate', 'question', 'rate-limited', 'brake'] as const) {
      expect(urgencyForAttentionReason(reason)).toBe('high');
    }
  });

  it('is NORMAL for the informational reasons — "this is merely true" costs no battery', () => {
    for (const reason of ['completed', 'stale', 'quarantined'] as const) {
      expect(urgencyForAttentionReason(reason)).toBe('normal');
    }
  });
});

describe('DEFAULT_PUSH_TTL_SECONDS (bounded, sane — not web-push four weeks)', () => {
  it('is positive and far below web-push default four weeks', () => {
    const fourWeeksSeconds = 4 * 7 * 24 * 60 * 60;
    expect(DEFAULT_PUSH_TTL_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_PUSH_TTL_SECONDS).toBeLessThan(fourWeeksSeconds);
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
