// Pure derivation for the cache-observability badge (session list row / stream
// header) — joins the step-2 cache-observability projection
// (GET /api/projections/cache-observability) to a session by appSessionId. No
// Vue, no DOM, no I/O: every branch is unit-tested without a browser.
//
// Q4: the badge shows observed WARMTH, never a hit rate. Hit rate was a tuning
// diagnostic the operator cannot move; it has been relocated to lib/cacheHitRate
// .ts (its cost-ledger home is blocked on a session-key join — see that file).
// Warmth answers a real decision — resume this session or spawn fresh? — but
// VIMES cannot OBSERVE cache state; warmth is INFERRED from the last-observed
// write's age vs the observed TTL tier. So this lib presents OBSERVED FACTS
// (age + tier) and lets warm/cold *styling* follow from the arithmetic; it never
// renders a countdown / "expires in" — that would be a fabricated certainty,
// since activity re-writes the cache and extends it (pillar 4).
//
// THE CLOCK BOUNDARY (rule 0.3): `deriveCacheBadge` is now-free and only carries
// the observed `latestBlockAt` through; `cacheWarmth` takes `now` INJECTED (the
// view's ticking clock, exactly as the usage meters inject theirs) and does the
// age arithmetic. Two pure functions, the clock never read inside either.
//
// D24 (binding): the billing bucket is NOT derivable yet — this lib exposes
// the RAW serviceTier string only, never a fabricated "5h window" / "$100
// automation" label. Rule 0.5 (binding): no cache-vandal warning lives here —
// that machinery is RESERVED, with no consumer in the MVP UI (docs/slice-4.md
// "Step-4 scope call").

import { formatDuration } from './duration.js';

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
  // The event ts (ISO string) of the MOST RECENTLY OBSERVED usage_block, or null
  // until one is observed / from an older daemon that predates the field. The
  // UI ages this against its own `now` to infer warmth (mirrors core).
  latestBlockAt: string | null;
  countedMessageIds: string[];
}

export interface CacheBadge {
  ttlTier: CacheTtlTier;
  // Raw serviceTier passthrough (D24) — never a fabricated bucket label.
  serviceTier: string | null;
  // Carried through now-free (rule 0.3); `cacheWarmth` ages it against an
  // injected clock. Null when unobserved / from a pre-field daemon.
  latestBlockAt: string | null;
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

// null when there's no record for this session yet (no usage_block observed) —
// the row shows no badge rather than a fabricated zero. NOW-FREE: it carries the
// observed `latestBlockAt` through untouched; warmth is computed by `cacheWarmth`
// against an injected clock, so this function stays deterministic under replay.
export function deriveCacheBadge(record: CacheObservabilityRecord | undefined): CacheBadge | null {
  if (record === undefined) {
    return null;
  }
  return {
    ttlTier: record.ttlTier,
    serviceTier: record.serviceTier,
    latestBlockAt: record.latestBlockAt,
    tokensLabel: tokensLabel(record),
  };
}

// ── Cache warmth (Q4) ────────────────────────────────────────────────────────
// Warmth is INFERRED, never observed: how long since the last observed cache
// write, judged against the observed TTL tier's own duration.

// The window each tier's cache stays warm, in ms. `mixed` uses the SHORTER (5m)
// window on purpose — the honest conservative read: a mixed session has at least
// one 5m write that may already be cold, so we do not claim the longer 1h window
// for it. `none` has no cache and thus no warmth window (null).
const ONE_HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 300_000;
function warmthCutoffMs(ttlTier: CacheTtlTier): number | null {
  switch (ttlTier) {
    case '1h':
      return ONE_HOUR_MS;
    case '5m':
      return FIVE_MINUTES_MS;
    case 'mixed':
      return FIVE_MINUTES_MS; // conservative: judge a mixed session by its 5m write
    case 'none':
      return null; // no cache written → no warmth to infer
  }
}

// 'warm'/'cold' are the inferred verdict; 'unknown' is "tier known but the write
// time isn't observable" (an older daemon predating latestBlockAt — show the
// tier, never a fabricated age); 'none' is no cache written.
export type CacheWarmthState = 'warm' | 'cold' | 'unknown' | 'none';

export interface CacheWarmth {
  state: CacheWarmthState;
  // now − latestBlockAt. Null when there is no age to compute ('none'/'unknown').
  ageMs: number | null;
  warm: boolean;
  // Observed-age line ("26m ago" / "just now"), or null when there is no age to
  // show. The user-facing BASIS for the warm/cold styling (Q4: show the basis,
  // not just a verdict).
  ageLabel: string | null;
}

// Epoch ms for an ISO timestamp, or null when absent/unparseable. Never throws.
// (Same tiny guard meterDisplay uses on its observedAt; the shared piece worth
// unifying — the "26m" formatter — lives in duration.ts.)
function parseIsoToEpochMs(isoTimestamp: string | null): number | null {
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return null;
  }
  const epochMs = Date.parse(isoTimestamp);
  return Number.isFinite(epochMs) ? epochMs : null;
}

// "26m ago" from an age span, reusing the ONE shared duration formatter. A span
// under a second — including the negative clock-skew case (now behind the event
// ts) — reads "just now" rather than a nonsensical "-4s ago".
function formatCacheAge(ageMs: number): string {
  if (ageMs < 1000) {
    return 'just now';
  }
  return `${formatDuration(ageMs)} ago`;
}

/**
 * Warmth from the observed last-write ts, the observed tier, and an INJECTED
 * `now` (epoch ms) — the clock is never read inside this pure function (rule
 * 0.3), exactly as the usage meters inject theirs.
 *
 * Boundary: warm when `ageMs < cutoff`, cold when `ageMs >= cutoff` (age exactly
 * equal to the tier duration is COLD).
 */
export function cacheWarmth(
  latestBlockAt: string | null,
  ttlTier: CacheTtlTier,
  nowMs: number,
): CacheWarmth {
  const cutoffMs = warmthCutoffMs(ttlTier);
  if (cutoffMs === null) {
    // 'none': no cache written, no age to show.
    return { state: 'none', ageMs: null, warm: false, ageLabel: null };
  }
  const observedAtMs = parseIsoToEpochMs(latestBlockAt);
  if (observedAtMs === null || !Number.isFinite(nowMs)) {
    // Tier known, write time not observable — show the tier, never an invented age.
    return { state: 'unknown', ageMs: null, warm: false, ageLabel: null };
  }
  const ageMs = nowMs - observedAtMs;
  const warm = ageMs < cutoffMs;
  return { state: warm ? 'warm' : 'cold', ageMs, warm, ageLabel: formatCacheAge(ageMs) };
}

// Warmth → the semantic tone key the views map to a colour class (this lib never
// touches Tailwind). warm = money about to be saved (green); cold = the next
// turn pays full freight (amber, a heads-up); unknown/none = nothing to say
// (slate). Reuses the existing CacheTtlTone keys so no new colour class is needed.
export function cacheWarmthTone(state: CacheWarmthState): CacheTtlTone {
  switch (state) {
    case 'warm':
      return 'green';
    case 'cold':
      return 'amber';
    case 'unknown':
    case 'none':
      return 'slate';
  }
}

/**
 * The compact session-row chip label: tier + observed warmth. Cold shows the
 * word "cold" (an accessible verdict, not colour-only) rather than the age; the
 * age remains available on the chip's title tooltip and in full on the stream
 * detail line. 'unknown'/'none' show the tier alone (no fabricated age).
 */
export function cacheBadgeChipLabel(ttlTier: CacheTtlTier, warmth: CacheWarmth): string {
  const tierLabel = ttlTierLabel(ttlTier);
  switch (warmth.state) {
    case 'warm':
      return `${tierLabel} · ${warmth.ageLabel ?? 'just now'}`;
    case 'cold':
      return `${tierLabel} · cold`;
    case 'unknown':
    case 'none':
      return tierLabel;
  }
}
