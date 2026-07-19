import { describe, expect, it } from 'vitest';
import {
  derivePushState,
  isBellActionable,
  isEnableTap,
  pushStateLabel,
  type PushEnvironment,
} from './pushState.js';

function env(overrides: Partial<PushEnvironment>): PushEnvironment {
  return { supported: true, permission: 'default', subscribed: false, ...overrides };
}

describe('derivePushState', () => {
  it('is unsupported when the browser lacks the push stack (regardless of the rest)', () => {
    expect(derivePushState(env({ supported: false }))).toBe('unsupported');
    expect(derivePushState(env({ supported: false, permission: 'granted', subscribed: true }))).toBe('unsupported');
  });

  it('is denied when permission is denied', () => {
    expect(derivePushState(env({ permission: 'denied' }))).toBe('denied');
    expect(derivePushState(env({ permission: 'denied', subscribed: true }))).toBe('denied');
  });

  it('is off at default permission, or granted-but-not-yet-subscribed', () => {
    expect(derivePushState(env({ permission: 'default' }))).toBe('off');
    expect(derivePushState(env({ permission: 'granted', subscribed: false }))).toBe('off');
  });

  it('is on only when granted AND subscribed', () => {
    expect(derivePushState(env({ permission: 'granted', subscribed: true }))).toBe('on');
  });
});

describe('bell helpers', () => {
  it('labels every state distinctly', () => {
    const labels = (['unsupported', 'denied', 'off', 'on'] as const).map(pushStateLabel);
    expect(new Set(labels).size).toBe(4);
  });

  it('only off/on are actionable; only off is an enable tap', () => {
    expect(isBellActionable('off')).toBe(true);
    expect(isBellActionable('on')).toBe(true);
    expect(isBellActionable('denied')).toBe(false);
    expect(isBellActionable('unsupported')).toBe(false);
    expect(isEnableTap('off')).toBe(true);
    expect(isEnableTap('on')).toBe(false);
  });
});
