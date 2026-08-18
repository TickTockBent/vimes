import { describe, expect, it } from 'vitest';
import {
  cacheHitRate,
  classifyTtlTier,
  readCacheTokens,
  readServiceTier,
} from './cacheClassification.js';

// The real Spike-C sample (docs/calibration.md, rule 0.7 verify-row): a live
// 1h-tier, ~93%-warm usage block observed in the deployed events.db.
const spikeCUsage: Record<string, unknown> = {
  cache_creation: { ephemeral_1h_input_tokens: 2909, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 2909,
  cache_read_input_tokens: 39044,
  input_tokens: 2,
  output_tokens: 2,
  service_tier: 'standard',
};

describe('classifyTtlTier', () => {
  it("classifies the real Spike-C sample as '1h' (1h>0, 5m==0)", () => {
    expect(classifyTtlTier(spikeCUsage)).toBe('1h');
  });

  it("classifies 5m>0 && 1h==0 as '5m'", () => {
    expect(
      classifyTtlTier({
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 512 },
      }),
    ).toBe('5m');
  });

  it("classifies both>0 as 'mixed'", () => {
    expect(
      classifyTtlTier({
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 200 },
      }),
    ).toBe('mixed');
  });

  it("classifies both==0 as 'none'", () => {
    expect(
      classifyTtlTier({
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
    ).toBe('none');
  });

  it("classifies a missing cache_creation object as 'none'", () => {
    expect(classifyTtlTier({ input_tokens: 5 })).toBe('none');
  });

  it("treats a non-object cache_creation as 'none'", () => {
    expect(classifyTtlTier({ cache_creation: 'unexpected-string' })).toBe('none');
  });

  it("treats non-numeric ephemeral fields as 0 → 'none'", () => {
    expect(
      classifyTtlTier({
        cache_creation: { ephemeral_1h_input_tokens: 'nan', ephemeral_5m_input_tokens: null },
      }),
    ).toBe('none');
  });
});

describe('readCacheTokens', () => {
  it('reads the four token counts from the Spike-C sample', () => {
    expect(readCacheTokens(spikeCUsage)).toEqual({
      cacheReadTokens: 39044,
      cacheCreateTokens: 2909,
      inputTokens: 2,
      outputTokens: 2,
    });
  });

  it('reads missing/non-numeric fields as 0', () => {
    expect(readCacheTokens({ cache_read_input_tokens: 'oops', output_tokens: 7 })).toEqual({
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      inputTokens: 0,
      outputTokens: 7,
    });
  });
});

describe('cacheHitRate', () => {
  it('is ≈0.93 for the real Spike-C sample (39044 read / 2911 new)', () => {
    const hitRate = cacheHitRate(readCacheTokens(spikeCUsage));
    expect(hitRate).toBeCloseTo(39044 / (39044 + 2909 + 2), 10);
    expect(hitRate).toBeGreaterThan(0.92);
    expect(hitRate).toBeLessThan(0.94);
  });

  it('guards divide-by-zero to 0 when no cache/input tokens', () => {
    expect(
      cacheHitRate({
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        inputTokens: 0,
        outputTokens: 100,
      }),
    ).toBe(0);
  });

  it('is deterministic (full precision, no locale formatting)', () => {
    const tokens = { cacheReadTokens: 1, cacheCreateTokens: 2, inputTokens: 0, outputTokens: 0 };
    expect(cacheHitRate(tokens)).toBe(1 / 3);
  });
});

describe('readServiceTier', () => {
  it("captures the raw service_tier string ('standard') — D24, no bucket derivation", () => {
    expect(readServiceTier(spikeCUsage)).toBe('standard');
  });

  it('returns null when service_tier is absent', () => {
    expect(readServiceTier({ input_tokens: 5 })).toBeNull();
  });

  it('returns null when service_tier is not a string', () => {
    expect(readServiceTier({ service_tier: 42 })).toBeNull();
  });
});
