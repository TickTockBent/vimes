import { describe, expect, it } from 'vitest';
import {
  RECONNECT_PROBE_THRESHOLD,
  decideReconnectAction,
  shouldProbeHealth,
} from './reconnectDecision.js';

describe('shouldProbeHealth', () => {
  it('probes only at/after the threshold of consecutive failures', () => {
    expect(RECONNECT_PROBE_THRESHOLD).toBe(2);
    expect(shouldProbeHealth(0)).toBe(false);
    expect(shouldProbeHealth(1)).toBe(false);
    expect(shouldProbeHealth(2)).toBe(true);
    expect(shouldProbeHealth(5)).toBe(true);
  });
});

describe('decideReconnectAction', () => {
  it('keeps retrying when fetch itself failed (daemon unreachable, not Access)', () => {
    expect(decideReconnectAction({ fetchFailed: true })).toBe('keep-retrying');
  });

  it('reloads when the probe was redirected (Access login bounce)', () => {
    expect(decideReconnectAction({ fetchFailed: false, redirected: true, ok: false, status: 302 })).toBe('reload');
  });

  it('reloads on an opaque / opaqueredirect response', () => {
    expect(decideReconnectAction({ fetchFailed: false, type: 'opaque' })).toBe('reload');
    expect(decideReconnectAction({ fetchFailed: false, type: 'opaqueredirect' })).toBe('reload');
  });

  it('reloads on any non-OK status', () => {
    expect(decideReconnectAction({ fetchFailed: false, ok: false, status: 403, type: 'basic' })).toBe('reload');
  });

  it('keeps retrying on a clean 200 (auth fine, WS trouble is transient)', () => {
    expect(decideReconnectAction({ fetchFailed: false, ok: true, redirected: false, type: 'basic', status: 200 })).toBe(
      'keep-retrying',
    );
  });
});
