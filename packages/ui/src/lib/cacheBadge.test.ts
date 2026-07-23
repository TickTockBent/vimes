import { describe, expect, it } from 'vitest';
import {
  cacheBadgeChipLabel,
  cacheWarmth,
  cacheWarmthTone,
  deriveCacheBadge,
  formatTokenCount,
  ttlTierLabel,
  ttlTierTone,
  type CacheObservabilityRecord,
  type CacheTtlTier,
} from './cacheBadge.js';

// A fixed observed write time and a `now` derived by adding an explicit age, so
// every warmth case reads as plain arithmetic. The ISO carries a `Z` offset, so
// Date.parse is timezone-independent — the ages below are the same in every
// ambient TZ/locale (assertion 8).
const OBSERVED_AT = '2026-01-01T00:00:00.000Z';
const OBSERVED_AT_MS = Date.parse(OBSERVED_AT);
function nowAfter(ageMs: number): number {
  return OBSERVED_AT_MS + ageMs;
}
const ONE_HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 300_000;

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
    latestBlockAt: OBSERVED_AT,
    countedMessageIds: ['m-1', 'm-2', 'm-3'],
    ...overrides,
  };
}

describe('deriveCacheBadge', () => {
  it('returns null when there is no record for the session (no badge shown)', () => {
    expect(deriveCacheBadge(undefined)).toBeNull();
  });

  it('derives ttlTier, raw serviceTier, latestBlockAt, and tokensLabel from a record', () => {
    const badge = deriveCacheBadge(record());
    expect(badge).toEqual({
      ttlTier: '1h',
      serviceTier: 'standard',
      latestBlockAt: OBSERVED_AT,
      tokensLabel: '39.0k read / 2.9k new',
    });
  });

  // Assertion 10: the badge no longer exposes a hit rate at all.
  it('no longer exposes hitRatePercent (Q4 — hit rate left the badge)', () => {
    const badge = deriveCacheBadge(record());
    expect(badge).not.toBeNull();
    expect(badge).not.toHaveProperty('hitRatePercent');
    expect(Object.keys(badge!)).toEqual(['ttlTier', 'serviceTier', 'latestBlockAt', 'tokensLabel']);
  });

  it('passes serviceTier through raw, including null (D24 — no fabricated bucket label)', () => {
    expect(deriveCacheBadge(record({ serviceTier: null }))?.serviceTier).toBeNull();
    expect(deriveCacheBadge(record({ serviceTier: 'batch' }))?.serviceTier).toBe('batch');
  });

  it('carries latestBlockAt through, including null (older daemon / never observed)', () => {
    expect(deriveCacheBadge(record({ latestBlockAt: null }))?.latestBlockAt).toBeNull();
  });

  it.each<CacheTtlTier>(['1h', '5m', 'mixed', 'none'])('passes ttlTier %s through unchanged', (tier) => {
    expect(deriveCacheBadge(record({ ttlTier: tier }))?.ttlTier).toBe(tier);
  });
});

describe('cacheWarmth', () => {
  // Assertion 6: the warm/cold cutoff and its exact boundary.
  it('1h tier: warm when age < 1h', () => {
    const warmth = cacheWarmth(OBSERVED_AT, '1h', nowAfter(26 * 60_000));
    expect(warmth.state).toBe('warm');
    expect(warmth.warm).toBe(true);
    expect(warmth.ageMs).toBe(26 * 60_000);
    expect(warmth.ageLabel).toBe('26m ago');
  });

  it('1h tier: cold when age >= 1h', () => {
    const warmth = cacheWarmth(OBSERVED_AT, '1h', nowAfter(2 * ONE_HOUR_MS));
    expect(warmth.state).toBe('cold');
    expect(warmth.warm).toBe(false);
    expect(warmth.ageLabel).toBe('2h 0m ago');
  });

  it('1h tier: the boundary is exclusive — age == 1h is COLD, one ms under is WARM', () => {
    expect(cacheWarmth(OBSERVED_AT, '1h', nowAfter(ONE_HOUR_MS)).state).toBe('cold');
    expect(cacheWarmth(OBSERVED_AT, '1h', nowAfter(ONE_HOUR_MS - 1)).state).toBe('warm');
  });

  it('5m tier: warm under 5m, cold at/over 5m', () => {
    expect(cacheWarmth(OBSERVED_AT, '5m', nowAfter(4 * 60_000)).state).toBe('warm');
    expect(cacheWarmth(OBSERVED_AT, '5m', nowAfter(FIVE_MINUTES_MS)).state).toBe('cold');
    expect(cacheWarmth(OBSERVED_AT, '5m', nowAfter(12 * 60_000)).state).toBe('cold');
  });

  // Assertion 7: mixed uses the SHORTER (5m) cutoff — the conservative read.
  it('mixed tier uses the 5m cutoff (warm just under 5m, cold just over)', () => {
    expect(cacheWarmth(OBSERVED_AT, 'mixed', nowAfter(FIVE_MINUTES_MS - 1)).state).toBe('warm');
    expect(cacheWarmth(OBSERVED_AT, 'mixed', nowAfter(FIVE_MINUTES_MS + 1)).state).toBe('cold');
    // A 6-minute-old mixed session would still be "warm" on a 1h cutoff — proving
    // it is judged by 5m, not 1h.
    expect(cacheWarmth(OBSERVED_AT, 'mixed', nowAfter(6 * 60_000)).state).toBe('cold');
  });

  // Assertion 7: none renders no age.
  it('none tier: state none, no age, regardless of any latestBlockAt', () => {
    const warmth = cacheWarmth(OBSERVED_AT, 'none', nowAfter(60_000));
    expect(warmth.state).toBe('none');
    expect(warmth.ageMs).toBeNull();
    expect(warmth.ageLabel).toBeNull();
  });

  // Assertion 9: latestBlockAt null → tier known, no age, never throws.
  it('unknown when the write time is not observable (null / empty / unparseable)', () => {
    for (const ts of [null, '', 'not-a-date']) {
      const warmth = cacheWarmth(ts, '1h', nowAfter(60_000));
      expect(warmth.state).toBe('unknown');
      expect(warmth.ageMs).toBeNull();
      expect(warmth.ageLabel).toBeNull();
    }
  });

  it('unknown when now is not finite (never throws)', () => {
    expect(cacheWarmth(OBSERVED_AT, '1h', NaN).state).toBe('unknown');
  });

  it('a now behind the observed ts (clock skew) reads warm · "just now", never a negative age label', () => {
    const warmth = cacheWarmth(OBSERVED_AT, '1h', nowAfter(-4000));
    expect(warmth.state).toBe('warm');
    expect(warmth.ageLabel).toBe('just now');
  });

  it('sub-second age reads "just now"', () => {
    expect(cacheWarmth(OBSERVED_AT, '1h', nowAfter(500)).ageLabel).toBe('just now');
  });
});

describe('cacheWarmthTone', () => {
  it('maps warmth to a tone key: warm green, cold amber, unknown/none slate', () => {
    expect(cacheWarmthTone('warm')).toBe('green');
    expect(cacheWarmthTone('cold')).toBe('amber');
    expect(cacheWarmthTone('unknown')).toBe('slate');
    expect(cacheWarmthTone('none')).toBe('slate');
  });
});

describe('cacheBadgeChipLabel', () => {
  it('warm shows tier + observed age', () => {
    const warmth = cacheWarmth(OBSERVED_AT, '1h', nowAfter(8 * 60_000));
    expect(cacheBadgeChipLabel('1h', warmth)).toBe('1h cache · 8m ago');
  });

  it('cold shows tier + the word "cold" (accessible, not colour-only)', () => {
    const warmth = cacheWarmth(OBSERVED_AT, '5m', nowAfter(20 * 60_000));
    expect(cacheBadgeChipLabel('5m', warmth)).toBe('5m cache · cold');
  });

  it('none shows the bare "no cache" tier label, no age', () => {
    const warmth = cacheWarmth(OBSERVED_AT, 'none', nowAfter(60_000));
    expect(cacheBadgeChipLabel('none', warmth)).toBe('no cache');
  });

  it('unknown shows the bare tier label, no age', () => {
    const warmth = cacheWarmth(null, '1h', nowAfter(60_000));
    expect(cacheBadgeChipLabel('1h', warmth)).toBe('1h cache');
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
