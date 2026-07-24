import { describe, expect, it } from 'vitest';
import type { CacheObservabilityRecord } from './cacheBadge.js';
import { contextTokens } from './contextFill.js';

// A full record with the given latestContextTokens; every other field is filled
// with an inert value so the test exercises only the field under test.
function recordWithContext(
  latestContextTokens: CacheObservabilityRecord['latestContextTokens'],
): CacheObservabilityRecord {
  return {
    appSessionId: 'app-1',
    sampleCount: 1,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitRate: 0,
    ttlTier: 'none',
    serviceTier: null,
    latestBlockAt: null,
    latestContextTokens,
    countedMessageIds: [],
  };
}

describe('contextTokens', () => {
  it('returns null for an undefined record (no session record yet)', () => {
    expect(contextTokens(undefined)).toBeNull();
  });

  it('returns null when latestContextTokens is null (no block / pre-field daemon)', () => {
    expect(contextTokens(recordWithContext(null))).toBeNull();
  });

  it('returns null when latestContextTokens is absent (older daemon, field undefined)', () => {
    // An older daemon's record simply lacks the key; the mirror is optional so
    // this must degrade to "unknown", never throw.
    const older = recordWithContext(null);
    delete (older as { latestContextTokens?: unknown }).latestContextTokens;
    expect(contextTokens(older)).toBeNull();
  });

  it('sums the three input-side counts (input + cacheRead + cacheCreation)', () => {
    const record = recordWithContext({
      inputTokens: 40,
      cacheReadTokens: 118_000,
      cacheCreationTokens: 5_000,
    });
    expect(contextTokens(record)).toBe(123_040);
  });

  it('returns 0 (NOT null) for a genuinely observed zero-token block', () => {
    // A real observed empty is distinct from "unobserved" — the two must not
    // collapse to the same value.
    const record = recordWithContext({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(contextTokens(record)).toBe(0);
  });
});
