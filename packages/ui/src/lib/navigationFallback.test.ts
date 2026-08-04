import { describe, expect, it } from 'vitest';
import { decideNavigationResponse } from './navigationFallback.js';

describe('decideNavigationResponse', () => {
  it('serves the cached shell when the navigation fetch rejected (network down)', () => {
    expect(decideNavigationResponse({ fetchRejected: true })).toBe('cached-shell');
  });

  it('serves the cached shell on 5xx (tunnel/origin error page — the 502 case)', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(decideNavigationResponse({ fetchRejected: false, status })).toBe('cached-shell');
    }
  });

  it('passes a healthy navigation through to the network', () => {
    expect(decideNavigationResponse({ fetchRejected: false, status: 200 })).toBe('network');
  });

  it('passes 4xx through — Access login flow must never be masked by the shell', () => {
    expect(decideNavigationResponse({ fetchRejected: false, status: 401 })).toBe('network');
    expect(decideNavigationResponse({ fetchRejected: false, status: 403 })).toBe('network');
    expect(decideNavigationResponse({ fetchRejected: false, status: 404 })).toBe('network');
  });
});
