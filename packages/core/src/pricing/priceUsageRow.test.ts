import { describe, expect, it } from 'vitest';
import { SLICE_5B_PRICE_TABLE, formatUsd } from './priceTable.js';
import {
  priceUsageRow,
  type PriceableUsageRow,
} from './priceUsageRow.js';

// A base row with all price-relevant fields explicit. Tests override what they
// exercise. Modifiers default to the validated set (absent/standard).
function usageRow(overrides: Partial<PriceableUsageRow>): PriceableUsageRow {
  return {
    model: 'claude-haiku-4-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    speed: null,
    serviceTier: null,
    inferenceGeo: null,
    ...overrides,
  };
}

describe('C2 haiku-1h reconciliation — the headline (must be exact)', () => {
  // calibration.md: input 10 + output 39 + 1h-write 25,172 on haiku → $0.050549,
  // zero residual in integer units.
  const c2Row = usageRow({
    model: 'claude-haiku-4-5',
    inputTokens: 10,
    outputTokens: 39,
    cacheCreation1hInputTokens: 25_172,
    cacheCreationInputTokens: 25_172, // aggregate == split (all 1h)
  });

  it('prices to exactly 50,549,000 nano-dollars ($0.050549), zero residual', () => {
    const priced = priceUsageRow(c2Row, SLICE_5B_PRICE_TABLE);
    expect(priced.status).toBe('priced');
    // 10×1000 + 39×5000 + 25172×2000 = 10000 + 195000 + 50344000
    expect(priced.amountNanoDollars).toBe(50_549_000);
    expect(formatUsd(priced.amountNanoDollars!)).toBe('$0.050549');
    // Exact: the internal sum is a whole number of micro-dollars, no rounding.
    expect(priced.amountNanoDollars! % 1000).toBe(0);
  });

  it('carries the price-table date and validated provenance', () => {
    const priced = priceUsageRow(c2Row, SLICE_5B_PRICE_TABLE);
    expect(priced.priceTableDate).toBe('2026-07-21');
    expect(priced.modelMatched).toBe('claude-haiku-4-5');
    expect(priced.validated).toBe(true);
  });

  it('SABOTAGE: pricing that cache-creation at 5m instead of 1h gives $0.031670 (~37% low)', () => {
    // The tier split is load-bearing: mis-tiering the same tokens to 5m under-prices.
    const misTiered = usageRow({
      model: 'claude-haiku-4-5',
      inputTokens: 10,
      outputTokens: 39,
      cacheCreation5mInputTokens: 25_172,
      cacheCreationInputTokens: 25_172,
    });
    const priced = priceUsageRow(misTiered, SLICE_5B_PRICE_TABLE);
    // 10×1000 + 39×5000 + 25172×1250 = 31,670,000
    expect(priced.amountNanoDollars).toBe(31_670_000);
    expect(formatUsd(priced.amountNanoDollars!)).toBe('$0.031670');
    // And it is genuinely lower — the engine does NOT do this to a real 1h row.
    expect(priceUsageRow(c2Row, SLICE_5B_PRICE_TABLE).amountNanoDollars).toBeGreaterThan(
      priced.amountNanoDollars!,
    );
  });
});

describe('sonnet-5 is billed standard $3/$15, and $2/$10 would be wrong', () => {
  const row = usageRow({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 1_000_000 });
  it('prices 1M in + 1M out at $3 + $15 = $18.000000', () => {
    const priced = priceUsageRow(row, SLICE_5B_PRICE_TABLE);
    // 1e6×3000 + 1e6×15000 = 18e9 nano
    expect(priced.amountNanoDollars).toBe(18_000_000_000);
    expect(formatUsd(priced.amountNanoDollars!)).toBe('$18.000000');
  });
  it('the documented intro $2/$10 would give $12.000000 — a different, wrong number', () => {
    const introTotalNano = 1_000_000 * 2000 + 1_000_000 * 10000;
    expect(formatUsd(introTotalNano)).toBe('$12.000000');
    expect(introTotalNano).not.toBe(18_000_000_000);
  });
});

describe('multiplier correctness through the pricing path (opus base $15)', () => {
  it('5m write = 1.25× base input per token', () => {
    const priced = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', cacheCreation5mInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }),
      SLICE_5B_PRICE_TABLE,
    );
    // 1e6 × 18750 = 18.75e9
    expect(priced.amountNanoDollars).toBe(18_750_000_000);
  });
  it('1h write = 2.00× base input per token', () => {
    const priced = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', cacheCreation1hInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.amountNanoDollars).toBe(30_000_000_000);
  });
  it('cache read = 0.10× base input per token', () => {
    const priced = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', cacheReadInputTokens: 1_000_000 }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.amountNanoDollars).toBe(1_500_000_000);
  });
});

describe('the four statuses', () => {
  it('unknown model → unpriced, amount is NOT $0 (it is null)', () => {
    const priced = priceUsageRow(
      usageRow({ model: 'gpt-4o', inputTokens: 1_000_000 }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('unpriced');
    expect(priced.amountNanoDollars).toBeNull();
    expect(priced.modelMatched).toBeNull();
  });

  it('<synthetic> → unpriceable', () => {
    const priced = priceUsageRow(usageRow({ model: '<synthetic>' }), SLICE_5B_PRICE_TABLE);
    expect(priced.status).toBe('unpriceable');
    expect(priced.amountNanoDollars).toBeNull();
  });

  it('empty model string → unpriceable (not a model)', () => {
    const priced = priceUsageRow(usageRow({ model: '' }), SLICE_5B_PRICE_TABLE);
    expect(priced.status).toBe('unpriceable');
  });

  it('sonnet-4-6 prices, but the row is tagged unvalidated', () => {
    const priced = priceUsageRow(
      usageRow({ model: 'claude-sonnet-4-6', inputTokens: 1_000_000 }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('priced');
    expect(priced.amountNanoDollars).toBe(3_000_000_000);
    expect(priced.validated).toBe(false);
  });
});

describe('price modifiers are asserted, not defaulted (rule 8)', () => {
  it('speed:null and speed:standard price identically at base', () => {
    const nullRow = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', inputTokens: 1000, speed: null }),
      SLICE_5B_PRICE_TABLE,
    );
    const standardRow = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', inputTokens: 1000, speed: 'standard' }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(nullRow.status).toBe('priced');
    expect(standardRow.status).toBe('priced');
    expect(nullRow.amountNanoDollars).toBe(standardRow.amountNanoDollars);
  });

  it("speed:'fast' → flagged, NOT base-priced (would be a silent 2× misprice on Opus)", () => {
    const priced = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', inputTokens: 1000, speed: 'fast' }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('flagged');
    expect(priced.flagReason).toBe('unvalidated-modifier');
    expect(priced.amountNanoDollars).toBeNull();
    // The model WAS matched — flagged is distinct from unpriced.
    expect(priced.modelMatched).toBe('claude-opus-4-8');
  });

  it('an out-of-set service_tier flags', () => {
    const priced = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', serviceTier: 'batch' }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('flagged');
    expect(priced.flagReason).toBe('unvalidated-modifier');
  });

  it('a genuine routed inference_geo (eu) still flags', () => {
    const priced = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', inferenceGeo: 'eu' }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('flagged');
  });

  it("inference_geo:'not_available' is the geo no-op sentinel → prices at base (FINDING, rule 0.7)", () => {
    // The live corpus carries `inference_geo: "not_available"` on 100% of rows —
    // the CLI's "no geo routing applied" sentinel, not a real premium. Admitted to
    // the validated geo set so the corpus prices; a genuine routed geo (above)
    // still flags. See the finding note in priceUsageRow.ts.
    const priced = priceUsageRow(
      usageRow({ model: 'claude-opus-4-8', inputTokens: 1000, inferenceGeo: 'not_available' }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('priced');
    expect(priced.amountNanoDollars).toBe(15_000_000);
  });
});

describe('cache-tier double-count trap and reconciliation', () => {
  it('prices from the split ONCE when aggregate == 5m + 1h (no double count)', () => {
    const priced = priceUsageRow(
      usageRow({
        model: 'claude-haiku-4-5',
        cacheCreation5mInputTokens: 1000,
        cacheCreation1hInputTokens: 2000,
        cacheCreationInputTokens: 3000, // == split sum
      }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('priced');
    // 1000×1250 (5m) + 2000×2000 (1h) = 1,250,000 + 4,000,000 = 5,250,000.
    // The aggregate is NOT priced (would add 3000×? — double count).
    expect(priced.amountNanoDollars).toBe(5_250_000);
    expect(priced.categories?.cacheWrite5mNanoDollars).toBe(1_250_000);
    expect(priced.categories?.cacheWrite1hNanoDollars).toBe(4_000_000);
  });

  it('aggregate ≠ split sum (untiered residual) → flagged, no guessed tier', () => {
    const priced = priceUsageRow(
      usageRow({
        model: 'claude-haiku-4-5',
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheCreationInputTokens: 2909, // aggregate present, no split — cannot tier
      }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.status).toBe('flagged');
    expect(priced.flagReason).toBe('cache-tier-mismatch');
    expect(priced.amountNanoDollars).toBeNull();
  });
});

describe('integer exactness / rounding at the Money boundary', () => {
  it('the internal sum is exact and the display rounds predictably', () => {
    // 1 haiku input token = 1000 nano = 1 micro-dollar exactly.
    const priced = priceUsageRow(
      usageRow({ model: 'claude-haiku-4-5', inputTokens: 1 }),
      SLICE_5B_PRICE_TABLE,
    );
    expect(priced.amountNanoDollars).toBe(1000);
    expect(formatUsd(1000)).toBe('$0.000001');
  });

  it('a zero-token priced row is genuinely $0 (distinct from a null un-known)', () => {
    const priced = priceUsageRow(usageRow({ model: 'claude-haiku-4-5' }), SLICE_5B_PRICE_TABLE);
    expect(priced.status).toBe('priced');
    expect(priced.amountNanoDollars).toBe(0);
  });
});
