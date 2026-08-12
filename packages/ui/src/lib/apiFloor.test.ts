import { describe, expect, it } from 'vitest';
import {
  UI_REQUIRED_API_VERSION,
  daemonApiVersionMismatch,
  daemonSupportsCapability,
} from './apiFloor.js';

// S14 U1 / D84: the floor pins to 1 today — sanity-pin so a silent bump is a
// visible diff here, not just in the constant itself.
describe('UI_REQUIRED_API_VERSION', () => {
  it('is pinned to 1', () => {
    expect(UI_REQUIRED_API_VERSION).toBe(1);
  });
});

describe('daemonApiVersionMismatch', () => {
  it('is true when the hello apiVersion is below the floor', () => {
    expect(daemonApiVersionMismatch(UI_REQUIRED_API_VERSION - 1, true)).toBe(true);
    expect(daemonApiVersionMismatch(UI_REQUIRED_API_VERSION - 1, false)).toBe(true);
  });

  it('is false when the hello apiVersion equals the floor', () => {
    expect(daemonApiVersionMismatch(UI_REQUIRED_API_VERSION, true)).toBe(false);
  });

  it('is false when the hello apiVersion is above the floor (daemon newer is fine)', () => {
    expect(daemonApiVersionMismatch(UI_REQUIRED_API_VERSION + 1, true)).toBe(false);
  });

  it('is false when no hello has arrived yet and the connection has not proven itself alive', () => {
    expect(daemonApiVersionMismatch(null, false)).toBe(false);
  });

  // The D84 case this unit exists for: an anchor-frame daemon predates the
  // hello op entirely, so it will NEVER send one — but it responds to a
  // subscribe like any daemon, proving the connection is alive. That
  // combination (still-null apiVersion + proven-alive) is conclusive evidence
  // of a stale daemon, not just an unlucky race against the hello frame.
  it('is true when daemonApiVersion is still null AFTER a successful subscribed ack (anchor-frame daemon, D84)', () => {
    expect(daemonApiVersionMismatch(null, true)).toBe(true);
  });
});

describe('daemonSupportsCapability', () => {
  it('is false when no hello has arrived (daemonApiVersion null), regardless of the capabilities array', () => {
    expect(daemonSupportsCapability(null, ['foo'], 'foo')).toBe(false);
  });

  it('is false when hello arrived but the capability is omitted from the declared set', () => {
    expect(daemonSupportsCapability(1, [], 'foo')).toBe(false);
    expect(daemonSupportsCapability(1, ['bar'], 'foo')).toBe(false);
  });

  it('is true when hello arrived and the capability is present', () => {
    expect(daemonSupportsCapability(1, ['foo'], 'foo')).toBe(true);
  });
});
