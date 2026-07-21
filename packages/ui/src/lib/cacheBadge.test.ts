import { describe, expect, it } from 'vitest';
import {
  deriveCacheBadge,
  formatTokenCount,
  ttlTierLabel,
  ttlTierTone,
  type CacheObservabilityRecord,
  type CacheTtlTier,
} from './cacheBadge.js';

function record(overrides: Partial<CacheObservabilityRecord> = {}): CacheObservabilityRecord {
  return {
    appSessionId: 's-1',
    sampleCount: 3,
    cacheReadTokens: 39_000,
    cacheCreateTokens: 2_900,
    inputTokens: 500,
    outputTokens: 800,
    cacheHitRate: 0.5,
    ttlTier: '1h',
    serviceTier: 'standard',
    countedMessageIds: ['m-1', 'm-2', 'm-3'],
    ...overrides,
  };
}

describe('deriveCacheBadge', () => {
  it('returns null when there is no record for the session (no badge shown)', () => {
    expect(deriveCacheBadge(undefined)).toBeNull();
  });

  it('derives ttlTier, rounded hitRatePercent, raw serviceTier, and tokensLabel from a record', () => {
    const badge = deriveCacheBadge(record());
    expect(badge).toEqual({
      ttlTier: '1h',
      hitRatePercent: 50,
      serviceTier: 'standard',
      tokensLabel: '39.0k read / 2.9k new',
    });
  });

  it('passes serviceTier through raw, including null (D24 — no fabricated bucket label)', () => {
    expect(deriveCacheBadge(record({ serviceTier: null }))?.serviceTier).toBeNull();
    expect(deriveCacheBadge(record({ serviceTier: 'batch' }))?.serviceTier).toBe('batch');
  });

  it('rounds hit rate at the 0% edge', () => {
    expect(deriveCacheBadge(record({ cacheHitRate: 0 }))?.hitRatePercent).toBe(0);
  });

  it('rounds hit rate at the 50% edge', () => {
    expect(deriveCacheBadge(record({ cacheHitRate: 0.5 }))?.hitRatePercent).toBe(50);
  });

  it('rounds hit rate at the 100% edge', () => {
    expect(deriveCacheBadge(record({ cacheHitRate: 1 }))?.hitRatePercent).toBe(100);
  });

  it('clamps a non-finite hit rate (defensive) to 0', () => {
    expect(deriveCacheBadge(record({ cacheHitRate: NaN }))?.hitRatePercent).toBe(0);
  });

  it('clamps an out-of-range hit rate (defensive) into 0..100', () => {
    expect(deriveCacheBadge(record({ cacheHitRate: -0.2 }))?.hitRatePercent).toBe(0);
    expect(deriveCacheBadge(record({ cacheHitRate: 1.2 }))?.hitRatePercent).toBe(100);
  });

  it.each<CacheTtlTier>(['1h', '5m', 'mixed', 'none'])('passes ttlTier %s through unchanged', (tier) => {
    expect(deriveCacheBadge(record({ ttlTier: tier }))?.ttlTier).toBe(tier);
  });
});

describe('ttlTierLabel', () => {
  it('gives each tier a short human label', () => {
    expect(ttlTierLabel('1h')).toBe('1h cache');
    expect(ttlTierLabel('5m')).toBe('5m cache');
    expect(ttlTierLabel('mixed')).toBe('mixed');
    expect(ttlTierLabel('none')).toBe('no cache');
  });
});

describe('ttlTierTone', () => {
  it('maps each tier to a distinct semantic tone key (1h warm/green, 5m amber, mixed sky, none slate)', () => {
    expect(ttlTierTone('1h')).toBe('green');
    expect(ttlTierTone('5m')).toBe('amber');
    expect(ttlTierTone('mixed')).toBe('sky');
    expect(ttlTierTone('none')).toBe('slate');
  });
});

describe('formatTokenCount', () => {
  it('shows raw whole numbers under 1000', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('rounds a fractional sub-1000 value to a whole number', () => {
    expect(formatTokenCount(499.6)).toBe('500');
  });

  it('switches to a one-decimal "k" suffix at 1000', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
  });

  it('formats a larger count to one decimal', () => {
    expect(formatTokenCount(39_000)).toBe('39.0k');
    expect(formatTokenCount(2_900)).toBe('2.9k');
  });
});
