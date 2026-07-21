// Pure cache-observability classifiers over a raw `usage_block` `usage` object
// (rule 0.3 — no clocks, randomness, or I/O). The `usage` object is a loose
// passthrough (usageBlockPayloadSchema tolerates unknown upstream fields), so
// every field is guarded: missing or non-numeric values read as 0, and the
// billing bucket is NEVER fabricated (D24 — only `service_tier` is captured raw).
//
// Verified against the real Spike-C sample (docs/calibration.md, rule 0.7):
//   cache_creation: { ephemeral_1h_input_tokens: 2909, ephemeral_5m_input_tokens: 0 }
//   cache_read_input_tokens: 39044, cache_creation_input_tokens: 2909
//   input_tokens: 2, output_tokens: 2, service_tier: "standard"
//   → ttlTier '1h', hitRate ≈ 0.93.

// The observed TTL tier of a usage block. '1h'/'5m' are single-tier caches,
// 'mixed' is both present, 'none' is neither (or the fields absent). D24: this
// is the ONLY classification derived here — the billing bucket is deferred.
export type TtlTier = '1h' | '5m' | 'mixed' | 'none';

export interface CacheTokenTotals {
  cacheReadTokens: number;
  cacheCreateTokens: number;
  inputTokens: number;
  outputTokens: number;
}

// Coerce an unknown field to a finite non-negative-safe number, else 0. NaN and
// non-numbers (strings, null, objects) all fall through to 0, so a malformed
// upstream usage object never poisons the accumulated totals.
function readNumericField(source: Record<string, unknown>, fieldName: string): number {
  const rawValue = source[fieldName];
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue;
  }
  return 0;
}

// The `cache_creation` sub-object, or an empty object when absent/non-object, so
// callers can read the ephemeral tier fields without null checks.
function readCacheCreationDetail(usage: Record<string, unknown>): Record<string, unknown> {
  const cacheCreation = usage['cache_creation'];
  if (typeof cacheCreation === 'object' && cacheCreation !== null) {
    return cacheCreation as Record<string, unknown>;
  }
  return {};
}

// Classify the observed cache TTL tier from the ephemeral_1h/5m creation counts
// (spike-C rule): 1h>0 && 5m==0 → '1h'; 5m>0 && 1h==0 → '5m'; both>0 → 'mixed';
// both==0 (or the fields absent) → 'none'.
export function classifyTtlTier(usage: Record<string, unknown>): TtlTier {
  const cacheCreationDetail = readCacheCreationDetail(usage);
  const ephemeralOneHourTokens = readNumericField(cacheCreationDetail, 'ephemeral_1h_input_tokens');
  const ephemeralFiveMinuteTokens = readNumericField(
    cacheCreationDetail,
    'ephemeral_5m_input_tokens',
  );
  const hasOneHour = ephemeralOneHourTokens > 0;
  const hasFiveMinute = ephemeralFiveMinuteTokens > 0;
  if (hasOneHour && hasFiveMinute) {
    return 'mixed';
  }
  if (hasOneHour) {
    return '1h';
  }
  if (hasFiveMinute) {
    return '5m';
  }
  return 'none';
}

// Read the four token counts a cache-observability record accumulates. Each is 0
// when absent or non-numeric.
export function readCacheTokens(usage: Record<string, unknown>): CacheTokenTotals {
  return {
    cacheReadTokens: readNumericField(usage, 'cache_read_input_tokens'),
    cacheCreateTokens: readNumericField(usage, 'cache_creation_input_tokens'),
    inputTokens: readNumericField(usage, 'input_tokens'),
    outputTokens: readNumericField(usage, 'output_tokens'),
  };
}

// Cache hit rate = cacheReadTokens / (cacheReadTokens + cacheCreateTokens +
// inputTokens). Divide-by-zero (a block with no cache/input tokens) guards to 0.
// Full precision is kept — canonicalJson serializes it deterministically; no
// locale formatting (which would be nondeterministic across environments).
export function cacheHitRate(tokens: CacheTokenTotals): number {
  const denominator = tokens.cacheReadTokens + tokens.cacheCreateTokens + tokens.inputTokens;
  if (denominator <= 0) {
    return 0;
  }
  return tokens.cacheReadTokens / denominator;
}

// The raw `service_tier` string (D24 — captured, never mapped to a billing
// bucket), or null when absent or not a string.
export function readServiceTier(usage: Record<string, unknown>): string | null {
  const serviceTier = usage['service_tier'];
  return typeof serviceTier === 'string' ? serviceTier : null;
}
