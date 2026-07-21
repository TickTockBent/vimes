// ─── slice 5b step 2 — the pure pricing function (PURE, packages/core) ────────
//
// Turn ONE usage row into dollars, exactly, against the signed-off price table.
// Four distinct outcome states, none of which may collapse into "$0 spend":
//
//   priced       — a known model, validated modifiers, tiers reconcile.
//   unpriced     — an unknown model string. NOT free; unknown. amount is null.
//   unpriceable  — `<synthetic>` / empty: not a model at all. amount is null.
//   flagged      — a known model with an OUT-OF-SET price modifier (speed:'fast',
//                  …) or a cache-tier split that does not reconcile with the
//                  aggregate. NEVER silently base-priced. amount is null.
//
// Rule 0.3: pure. No clock, no randomness, no I/O.

import {
  normalizeModelToKey,
  type ModelRateSet,
  type PriceTable,
} from './priceTable.js';

// The minimal input shape — the pricing-relevant fields of the daemon's
// `CostUsageRow` (costCorpus.ts), re-declared here so core does NOT import from
// the daemon (rule 0.3). Take only what pricing needs.
export interface PriceableUsageRow {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  // The AGGREGATE (5m+1h). Used ONLY to reconcile against the split — NEVER
  // priced alongside the split (that double-counts, the part-4 cache-tier trap).
  readonly cacheCreationInputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
  // Rule 8: absent is NOT 'standard'. The validated set is {null, 'standard'};
  // any other value flags the row rather than pricing it at base.
  readonly speed: string | null;
  readonly serviceTier: string | null;
  readonly inferenceGeo: string | null;
}

export type PriceStatus = 'priced' | 'unpriced' | 'unpriceable' | 'flagged';

export type PriceFlagReason =
  // A price modifier (speed / service_tier / inference_geo) outside {null,'standard'}.
  | 'unvalidated-modifier'
  // 5m + 1h split does not equal the cache_creation aggregate (untiered residual):
  // we refuse to guess a tier.
  | 'cache-tier-mismatch';

// Per-category integer nano-dollars — the composable breakdown step 3's rollup
// sums into a tree. Present only for a priced row.
export interface PricedCategoryAmounts {
  readonly inputNanoDollars: number;
  readonly outputNanoDollars: number;
  readonly cacheReadNanoDollars: number;
  readonly cacheWrite5mNanoDollars: number;
  readonly cacheWrite1hNanoDollars: number;
}

export interface PricedRow {
  readonly status: PriceStatus;
  // Integer nano-dollars for a priced row. NULL for unpriced/unpriceable/flagged —
  // an un-known is not $0 spend and must never silently read as 0 in a sum.
  readonly amountNanoDollars: number | null;
  // The price-table date applied (priced rows only); null otherwise. Every priced
  // figure can report the snapshot it used.
  readonly priceTableDate: string | null;
  // The normalized model key matched (priced/flagged); null when unmatched.
  readonly modelMatched: string | null;
  // Provenance: TRUE = billing-validated, FALSE = priced-by-analogy (sonnet-4-6),
  // null = not priced. Lets step 3/4 render "$ (unvalidated)" honestly.
  readonly validated: boolean | null;
  // Why a row is flagged; null unless status === 'flagged'.
  readonly flagReason: PriceFlagReason | null;
  readonly categories: PricedCategoryAmounts | null;
}

const SYNTHETIC_MODEL = '<synthetic>';

// null (absent) and 'standard' both denote "base, no premium modifier applied".
// The sets are PER FIELD so the guard stays as tight as observed truth allows —
// a genuine premium (speed:'fast', service_tier:'batch', a real routed geo) still
// flags, because those really would change the price.
const VALIDATED_SPEED_VALUES: ReadonlySet<string> = new Set(['standard']);
const VALIDATED_SERVICE_TIER_VALUES: ReadonlySet<string> = new Set(['standard']);
// ⚠ FINDING (2026-07-21, rule 0.7 — observed truth over the spec's declared set,
// awaiting sign-off): the work order pinned the validated modifier set as
// {null,'standard'} for all three fields and stated the corpus carries "zero geo".
// The live ledger contradicts that: 20,264/20,264 rows carry
// `inference_geo: "not_available"` — NOT null, NOT 'standard'. That value is the
// CLI's sentinel for "no geographic routing applied", i.e. the geo field's spelling
// of "base": there is no geo premium to charge. It is therefore admitted to the
// validated set as a no-op (a genuine routed geo like 'eu' still flags). Without
// this the engine flags 100% of the corpus and prices $0 — and the C2 corpus
// reconciliation to ~$2,930 necessarily priced these same rows. Recorded loudly,
// not quietly patched: a real routed-geo value must still surface as flagged.
const VALIDATED_INFERENCE_GEO_VALUES: ReadonlySet<string> = new Set([
  'standard',
  'not_available',
]);

function modifierIsInSet(
  modifierValue: string | null,
  validatedValues: ReadonlySet<string>,
): boolean {
  return modifierValue === null || validatedValues.has(modifierValue);
}

function priceCategories(row: PriceableUsageRow, rateSet: ModelRateSet): PricedCategoryAmounts {
  return {
    inputNanoDollars: row.inputTokens * rateSet.inputNanoPerToken,
    outputNanoDollars: row.outputTokens * rateSet.outputNanoPerToken,
    cacheReadNanoDollars: row.cacheReadInputTokens * rateSet.cacheReadNanoPerToken,
    cacheWrite5mNanoDollars: row.cacheCreation5mInputTokens * rateSet.cacheWrite5mNanoPerToken,
    cacheWrite1hNanoDollars: row.cacheCreation1hInputTokens * rateSet.cacheWrite1hNanoPerToken,
  };
}

export function totalNanoDollars(categories: PricedCategoryAmounts): number {
  return (
    categories.inputNanoDollars +
    categories.outputNanoDollars +
    categories.cacheReadNanoDollars +
    categories.cacheWrite5mNanoDollars +
    categories.cacheWrite1hNanoDollars
  );
}

export function priceUsageRow(row: PriceableUsageRow, priceTable: PriceTable): PricedRow {
  // 1. Unpriceable: `<synthetic>` and the empty model string are not models at
  //    all (the corpus reader excludes `<synthetic>` and emits '' for a missing
  //    model). Never priced, never treated as a real model string.
  if (row.model === SYNTHETIC_MODEL || row.model === '') {
    return {
      status: 'unpriceable',
      amountNanoDollars: null,
      priceTableDate: null,
      modelMatched: null,
      validated: null,
      flagReason: null,
      categories: null,
    };
  }

  // 2. Unknown model → unpriced, NEVER $0. It is a model string we do not know,
  //    which is a surfaced un-known, not free spend.
  const modelKey = normalizeModelToKey(row.model, priceTable);
  if (modelKey === null) {
    return {
      status: 'unpriced',
      amountNanoDollars: null,
      priceTableDate: null,
      modelMatched: null,
      validated: null,
      flagReason: null,
      categories: null,
    };
  }
  const rateSet = priceTable.rateSetsByModelKey.get(modelKey);
  if (rateSet === undefined) {
    // normalizeModelToKey only returns keys present in the table; this is a
    // defensive impossibility, treated as unpriced rather than silently $0.
    return {
      status: 'unpriced',
      amountNanoDollars: null,
      priceTableDate: null,
      modelMatched: modelKey,
      validated: null,
      flagReason: null,
      categories: null,
    };
  }

  // 3. Rule 8: price modifiers are ASSERTED, not defaulted. An out-of-set value
  //    (speed:'fast' would be a silent 2× misprice on Opus) flags the row.
  if (
    !modifierIsInSet(row.speed, VALIDATED_SPEED_VALUES) ||
    !modifierIsInSet(row.serviceTier, VALIDATED_SERVICE_TIER_VALUES) ||
    !modifierIsInSet(row.inferenceGeo, VALIDATED_INFERENCE_GEO_VALUES)
  ) {
    return {
      status: 'flagged',
      amountNanoDollars: null,
      priceTableDate: priceTable.effectiveDate,
      modelMatched: modelKey,
      validated: rateSet.validated,
      flagReason: 'unvalidated-modifier',
      categories: null,
    };
  }

  // 4. Cache-tier reconciliation. Price the SPLIT only (never the aggregate — that
  //    double-counts). The aggregate is a check: 5m + 1h must equal it, else the
  //    row carries an untiered residual and we refuse to guess a tier.
  const splitSum = row.cacheCreation5mInputTokens + row.cacheCreation1hInputTokens;
  if (splitSum !== row.cacheCreationInputTokens) {
    return {
      status: 'flagged',
      amountNanoDollars: null,
      priceTableDate: priceTable.effectiveDate,
      modelMatched: modelKey,
      validated: rateSet.validated,
      flagReason: 'cache-tier-mismatch',
      categories: null,
    };
  }

  // 5. Priced. Exact integer nano-dollars. sonnet-4-6 prices here too but carries
  //    validated:false so step 3/4 can render "$ (unvalidated)".
  const categories = priceCategories(row, rateSet);
  return {
    status: 'priced',
    amountNanoDollars: totalNanoDollars(categories),
    priceTableDate: priceTable.effectiveDate,
    modelMatched: modelKey,
    validated: rateSet.validated,
    flagReason: null,
    categories,
  };
}
