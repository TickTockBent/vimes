// Pure derivation for the cache-observability badge (session list row / stream
// header) — joins the step-2 cache-observability projection
// (GET /api/projections/cache-observability) to a session by appSessionId. No
// Vue, no DOM, no I/O: every branch is unit-tested without a browser.
//
// D24 (binding): the billing bucket is NOT derivable yet — this lib exposes
// the RAW serviceTier string only, never a fabricated "5h window" / "$100
// automation" label. Rule 0.5 (binding): no cache-vandal warning lives here —
// that machinery is RESERVED, with no consumer in the MVP UI (docs/slice-4.md
// "Step-4 scope call").

// The byte-free shape GET /api/projections/cache-observability returns per
// session (mirrors the core's CacheObservabilityRecord — packages/core/src/
// projections/cacheObservability.ts).
export type CacheTtlTier = '1h' | '5m' | 'mixed' | 'none';

export interface CacheObservabilityRecord {
  appSessionId: string;
  sampleCount: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  inputTokens: number;
  outputTokens: number;
  // 0..1 — the projection's own division; never recomputed here.
  cacheHitRate: number;
  ttlTier: CacheTtlTier;
  // Raw service_tier string, or null when never observed. D24: shown as-is,
  // never classified into a billing bucket.
  serviceTier: string | null;
  countedMessageIds: string[];
}

export interface CacheBadge {
  ttlTier: CacheTtlTier;
  // Rounded 0..100 (Math.round(cacheHitRate * 100), clamped defensively).
  hitRatePercent: number;
  // Raw serviceTier passthrough (D24) — never a fabricated bucket label.
  serviceTier: string | null;
  // Compact token summary, e.g. "39.0k read / 2.9k new".
  tokensLabel: string;
}

// Semantic tone key — the template maps this to a color class; this lib never
// touches Tailwind/CSS (that mapping is the view's job, per the step-4 spec).
export type CacheTtlTone = 'green' | 'amber' | 'sky' | 'slate';

const TTL_TIER_LABEL: Readonly<Record<CacheTtlTier, string>> = {
  '1h': '1h cache',
  '5m': '5m cache',
  mixed: 'mixed',
  none: 'no cache',
};

const TTL_TIER_TONE: Readonly<Record<CacheTtlTier, CacheTtlTone>> = {
  '1h': 'green',
  '5m': 'amber',
  mixed: 'sky',
  none: 'slate',
};

export function ttlTierLabel(tier: CacheTtlTier): string {
  return TTL_TIER_LABEL[tier];
}

export function ttlTierTone(tier: CacheTtlTier): CacheTtlTone {
  return TTL_TIER_TONE[tier];
}

// Deterministic, locale-free compact token count: "999" under 1000, else a
// one-decimal "k" suffix ("1.0k", "39.0k"). No Intl/toLocaleString (rule 0.3
// determinism carries into the UI's pure derivations too).
export function formatTokenCount(tokens: number): string {
  const wholeTokens = Math.round(tokens);
  if (wholeTokens < 1000) {
    return `${wholeTokens}`;
  }
  return `${(wholeTokens / 1000).toFixed(1)}k`;
}

function tokensLabel(record: CacheObservabilityRecord): string {
  return `${formatTokenCount(record.cacheReadTokens)} read / ${formatTokenCount(record.cacheCreateTokens)} new`;
}

// Rounded hit-rate percent, clamped to 0..100 (defensive against an
// out-of-range or non-finite upstream value — the projection's own division
// is trusted, but a badge never renders a nonsensical percent).
function hitRatePercent(cacheHitRate: number): number {
  if (!Number.isFinite(cacheHitRate)) {
    return 0;
  }
  const rounded = Math.round(cacheHitRate * 100);
  return Math.min(100, Math.max(0, rounded));
}

// null when there's no record for this session yet (no usage_block observed) —
// the row shows no badge rather than a fabricated zero.
export function deriveCacheBadge(record: CacheObservabilityRecord | undefined): CacheBadge | null {
  if (record === undefined) {
    return null;
  }
  return {
    ttlTier: record.ttlTier,
    hitRatePercent: hitRatePercent(record.cacheHitRate),
    serviceTier: record.serviceTier,
    tokensLabel: tokensLabel(record),
  };
}
