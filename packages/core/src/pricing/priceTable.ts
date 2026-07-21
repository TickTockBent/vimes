// ─── slice 5b step 2 — the dated price table AS DATA (PURE, packages/core) ────
//
// The signed-off, Gate-D-pinned slice-5b price table (calibration.md,
// "PINNED … the slice-5b price table", Wes, 2026-07-21), plus the exact-integer
// arithmetic that turns it into per-token rates. Rule 0.3: no clock, no
// randomness, no I/O — pure data and pure functions.
//
// NUMBERS ARE PINNED. Do not invent, round, or "correct" any base rate: they
// were calibrated by Spike C2 (all 11 buckets reconciled to $0.000000) and
// signed off. If a rate looks wrong, that is a FINDING for a human — not an edit.
//
// ── the integer unit ─────────────────────────────────────────────────────────
// Money lives internally in NANO-DOLLARS (10^-9 USD), always integer. A per-token
// rate is stored as nano-dollars-per-token = ($/MTok × 1000): every pinned cell
// (incl. 18.75, 12.50, 0.30, 0.10) is an exact integer under that scale, so the
// whole pricing sum is pure integer arithmetic and the C2 fixture reconciles to
// $0.000000 with zero residual. Float dollars would never reconcile.

export const NANO_DOLLARS_PER_DOLLAR = 1_000_000_000;
export const NANO_DOLLARS_PER_MICRO_DOLLAR = 1_000;
// $/MTok → nano-dollars-per-token. ($/1e6 tokens) as nano = ($ × 1e9) / 1e6 = $ × 1000.
const NANO_DOLLARS_PER_TOKEN_PER_DOLLAR_PER_MTOK = 1_000;

// ── the cache multipliers, as EXACT rationals (never floats) ──────────────────
// Confirmed against first-party billing (C2 + Fable-1h closed exact): a cache
// write/read rate is a multiple of the model's BASE INPUT rate. Kept as
// numerator/denominator so the derived per-token rate stays an exact integer and
// a non-integer result is a loud error, not a silent round.
export interface CacheMultiplier {
  readonly numerator: number;
  readonly denominator: number;
}
export const CACHE_WRITE_5M_MULTIPLIER: CacheMultiplier = { numerator: 5, denominator: 4 }; // ×1.25
export const CACHE_WRITE_1H_MULTIPLIER: CacheMultiplier = { numerator: 2, denominator: 1 }; // ×2.00
export const CACHE_READ_MULTIPLIER: CacheMultiplier = { numerator: 1, denominator: 10 }; // ×0.10

// ── the pinned base numbers ($/MTok) — the single source of truth ─────────────
// Only the two INDEPENDENTLY-pinned rates (base input, output) are stored per
// model; the three cache tiers are DERIVED from base input by the multipliers
// above, so there is no hand-typed derived cell to mistype. Output is independent
// (5× input on every current model, but stored explicitly, not derived).
export interface PinnedModelBasePrice {
  readonly modelKey: string;
  readonly baseInputDollarsPerMTok: number;
  readonly outputDollarsPerMTok: number;
  // FALSE = priced by same-family analogy only (must surface as "$ (unvalidated)"
  // downstream), never as a billing-confirmed figure.
  readonly validated: boolean;
  readonly note: string;
}

// The corpus is restated at ONE validated snapshot (2026-07-21); historical
// per-date rates are deliberately NOT modelled (Wes signed this off). The schema
// is effective-dated (rule 0.5) so a future validated historical row can drop in.
export const PRICE_TABLE_EFFECTIVE_DATE = '2026-07-21';

export const PINNED_MODEL_BASE_PRICES: readonly PinnedModelBasePrice[] = [
  {
    modelKey: 'claude-opus-4-8',
    baseInputDollarsPerMTok: 15.0,
    outputDollarsPerMTok: 75.0,
    validated: true,
    note: 'validated (C2, frac 0.801)',
  },
  {
    modelKey: 'claude-sonnet-5',
    baseInputDollarsPerMTok: 3.0,
    outputDollarsPerMTok: 15.0,
    validated: true,
    // Rule 0.7: BILLED standard $3/$15 today, NOT the documented $2/$10 intro.
    note: 'validated — BILLED standard, not the documented $2/$10 intro',
  },
  {
    modelKey: 'claude-haiku-4-5',
    baseInputDollarsPerMTok: 1.0,
    outputDollarsPerMTok: 5.0,
    validated: true,
    note: 'validated (C2, exact fixture)',
  },
  {
    modelKey: 'claude-fable-5',
    baseInputDollarsPerMTok: 10.0,
    outputDollarsPerMTok: 50.0,
    validated: true,
    note: 'validated (C2 + Fable-1h closed exact)',
  },
  {
    modelKey: 'claude-sonnet-4-6',
    baseInputDollarsPerMTok: 3.0,
    outputDollarsPerMTok: 15.0,
    validated: false,
    note: 'UNVALIDATED — retired 2026-06-30, $23.57 by analogy only',
  },
];

// ── the derived per-token integer rate set ────────────────────────────────────
export interface ModelRateSet {
  readonly modelKey: string;
  readonly validated: boolean;
  readonly note: string;
  // All in nano-dollars per token, exact integers.
  readonly inputNanoPerToken: number;
  readonly outputNanoPerToken: number;
  readonly cacheWrite5mNanoPerToken: number;
  readonly cacheWrite1hNanoPerToken: number;
  readonly cacheReadNanoPerToken: number;
}

// $/MTok → integer nano-dollars per token, asserting exactness (a fractional
// nano-per-token would mean a mistyped base rate — surfaced loudly, not rounded).
export function dollarsPerMTokToNanoPerToken(dollarsPerMTok: number): number {
  const nanoPerToken = dollarsPerMTok * NANO_DOLLARS_PER_TOKEN_PER_DOLLAR_PER_MTOK;
  if (!Number.isInteger(nanoPerToken)) {
    throw new Error(
      `pinned base rate ${dollarsPerMTok} $/MTok is not an exact nano-per-token integer`,
    );
  }
  return nanoPerToken;
}

// baseInputNano × multiplier, kept exact. A non-integer result throws — that can
// only happen if a base rate was mistyped, and a silent round is exactly the
// kind of drift this table exists to refuse.
export function applyCacheMultiplier(
  baseInputNanoPerToken: number,
  multiplier: CacheMultiplier,
): number {
  const scaledNumerator = baseInputNanoPerToken * multiplier.numerator;
  if (scaledNumerator % multiplier.denominator !== 0) {
    throw new Error(
      `cache rate ${baseInputNanoPerToken}×${multiplier.numerator}/${multiplier.denominator} is not exact`,
    );
  }
  return scaledNumerator / multiplier.denominator;
}

export function deriveModelRateSet(basePrice: PinnedModelBasePrice): ModelRateSet {
  const inputNanoPerToken = dollarsPerMTokToNanoPerToken(basePrice.baseInputDollarsPerMTok);
  const outputNanoPerToken = dollarsPerMTokToNanoPerToken(basePrice.outputDollarsPerMTok);
  return {
    modelKey: basePrice.modelKey,
    validated: basePrice.validated,
    note: basePrice.note,
    inputNanoPerToken,
    outputNanoPerToken,
    cacheWrite5mNanoPerToken: applyCacheMultiplier(inputNanoPerToken, CACHE_WRITE_5M_MULTIPLIER),
    cacheWrite1hNanoPerToken: applyCacheMultiplier(inputNanoPerToken, CACHE_WRITE_1H_MULTIPLIER),
    cacheReadNanoPerToken: applyCacheMultiplier(inputNanoPerToken, CACHE_READ_MULTIPLIER),
  };
}

// ── the price table ───────────────────────────────────────────────────────────
export interface PriceTable {
  readonly effectiveDate: string;
  readonly rateSetsByModelKey: ReadonlyMap<string, ModelRateSet>;
}

export function buildPriceTable(
  basePrices: readonly PinnedModelBasePrice[] = PINNED_MODEL_BASE_PRICES,
  effectiveDate: string = PRICE_TABLE_EFFECTIVE_DATE,
): PriceTable {
  const rateSetsByModelKey = new Map<string, ModelRateSet>();
  for (const basePrice of basePrices) {
    rateSetsByModelKey.set(basePrice.modelKey, deriveModelRateSet(basePrice));
  }
  return { effectiveDate, rateSetsByModelKey };
}

// The one pinned, validated snapshot the whole ledger prices against.
export const SLICE_5B_PRICE_TABLE: PriceTable = buildPriceTable();

// ── model-ID normalization (rule 0.6 — IDs drift) ─────────────────────────────
// The corpus carries dated/context suffixes: `claude-haiku-4-5-20251001`,
// `claude-opus-4-8-1m`. Match by LONGEST PREFIX against the known keys: a string
// matches key K when it equals K or begins with `K-`. This absorbs any unknown
// trailing suffix without ever mis-stripping version digits that are part of a
// key (`claude-sonnet-5` and `claude-sonnet-4-6` never collide). Returns the
// matched key, or null when the string is not a known model.
export function normalizeModelToKey(model: string, priceTable: PriceTable): string | null {
  let bestKey: string | null = null;
  for (const modelKey of priceTable.rateSetsByModelKey.keys()) {
    if (model === modelKey || model.startsWith(modelKey + '-')) {
      if (bestKey === null || modelKey.length > bestKey.length) {
        bestKey = modelKey;
      }
    }
  }
  return bestKey;
}

// ── the Money boundary (defined rounding) ─────────────────────────────────────
// Internal sums are exact nano-dollars. Display rounds to micro-dollars (10^-6
// USD, the 6-dp figure C2 reconciles to), round-half-up. Positive-only domain.
export function nanoDollarsToMicroDollars(nanoDollars: number): number {
  return Math.round(nanoDollars / NANO_DOLLARS_PER_MICRO_DOLLAR);
}

export function formatUsd(nanoDollars: number): string {
  const microDollars = nanoDollarsToMicroDollars(nanoDollars);
  return `$${(microDollars / 1_000_000).toFixed(6)}`;
}
