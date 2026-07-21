import { describe, expect, it } from 'vitest';
import {
  SLICE_5B_PRICE_TABLE,
  PRICE_TABLE_EFFECTIVE_DATE,
  buildPriceTable,
  deriveModelRateSet,
  dollarsPerMTokToNanoPerToken,
  applyCacheMultiplier,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  normalizeModelToKey,
  nanoDollarsToMicroDollars,
  formatUsd,
  type ModelRateSet,
} from './priceTable.js';

// The PINNED table, transcribed as literals directly from calibration.md
// ("PINNED … the slice-5b price table", Wes, 2026-07-21), in nano-dollars per
// token (= $/MTok × 1000). These are the DERIVED cells the doc pins; asserting
// the code reproduces them means a typo in a base rate OR the multiplier logic
// fails the derivation, not just the arithmetic.
const EXPECTED_NANO_PER_TOKEN: Record<
  string,
  {
    input: number;
    output: number;
    write5m: number;
    write1h: number;
    read: number;
    validated: boolean;
  }
> = {
  // $/MTok:            15.00   75.00   18.75    30.00    1.50
  'claude-opus-4-8': { input: 15000, output: 75000, write5m: 18750, write1h: 30000, read: 1500, validated: true },
  // $/MTok:             3.00   15.00    3.75     6.00    0.30
  'claude-sonnet-5': { input: 3000, output: 15000, write5m: 3750, write1h: 6000, read: 300, validated: true },
  // $/MTok:             1.00    5.00    1.25     2.00    0.10
  'claude-haiku-4-5': { input: 1000, output: 5000, write5m: 1250, write1h: 2000, read: 100, validated: true },
  // $/MTok:            10.00   50.00   12.50    20.00    1.00
  'claude-fable-5': { input: 10000, output: 50000, write5m: 12500, write1h: 20000, read: 1000, validated: true },
  // $/MTok:             3.00   15.00    3.75     6.00    0.30  (UNVALIDATED — analogy)
  'claude-sonnet-4-6': { input: 3000, output: 15000, write5m: 3750, write1h: 6000, read: 300, validated: false },
};

function rateSetFor(modelKey: string): ModelRateSet {
  const rateSet = SLICE_5B_PRICE_TABLE.rateSetsByModelKey.get(modelKey);
  if (rateSet === undefined) {
    throw new Error(`missing rate set for ${modelKey}`);
  }
  return rateSet;
}

describe('the pinned price table derives exactly from the signed base numbers', () => {
  it('pins the effective date 2026-07-21', () => {
    expect(SLICE_5B_PRICE_TABLE.effectiveDate).toBe('2026-07-21');
    expect(PRICE_TABLE_EFFECTIVE_DATE).toBe('2026-07-21');
  });

  it('reproduces every DERIVED cell from the doc (a typo in a derived cell fails)', () => {
    for (const [modelKey, expected] of Object.entries(EXPECTED_NANO_PER_TOKEN)) {
      const rateSet = rateSetFor(modelKey);
      expect(rateSet.inputNanoPerToken, `${modelKey} input`).toBe(expected.input);
      expect(rateSet.outputNanoPerToken, `${modelKey} output`).toBe(expected.output);
      expect(rateSet.cacheWrite5mNanoPerToken, `${modelKey} 5m`).toBe(expected.write5m);
      expect(rateSet.cacheWrite1hNanoPerToken, `${modelKey} 1h`).toBe(expected.write1h);
      expect(rateSet.cacheReadNanoPerToken, `${modelKey} read`).toBe(expected.read);
      expect(rateSet.validated, `${modelKey} validated`).toBe(expected.validated);
    }
  });

  it('has exactly the five signed-off models and no others', () => {
    expect([...SLICE_5B_PRICE_TABLE.rateSetsByModelKey.keys()].sort()).toEqual(
      Object.keys(EXPECTED_NANO_PER_TOKEN).sort(),
    );
  });

  it('every stored rate is an exact integer (no float dust)', () => {
    for (const rateSet of SLICE_5B_PRICE_TABLE.rateSetsByModelKey.values()) {
      expect(Number.isInteger(rateSet.inputNanoPerToken)).toBe(true);
      expect(Number.isInteger(rateSet.outputNanoPerToken)).toBe(true);
      expect(Number.isInteger(rateSet.cacheWrite5mNanoPerToken)).toBe(true);
      expect(Number.isInteger(rateSet.cacheWrite1hNanoPerToken)).toBe(true);
      expect(Number.isInteger(rateSet.cacheReadNanoPerToken)).toBe(true);
    }
  });

  it('sonnet-5 is billed standard $3/$15, and the documented $2/$10 would differ', () => {
    const sonnet5 = rateSetFor('claude-sonnet-5');
    // Billed-standard (encoded), per the C2 rule-0.1 finding.
    expect(sonnet5.inputNanoPerToken).toBe(3000);
    expect(sonnet5.outputNanoPerToken).toBe(15000);
    // The documented intro price would have derived DIFFERENT (wrong) cells —
    // proving the finding is encoded, not latent.
    const documentedIntro = deriveModelRateSet({
      modelKey: 'x',
      baseInputDollarsPerMTok: 2.0,
      outputDollarsPerMTok: 10.0,
      validated: true,
      note: '',
    });
    expect(documentedIntro.inputNanoPerToken).not.toBe(sonnet5.inputNanoPerToken);
    expect(documentedIntro.inputNanoPerToken).toBe(2000);
    expect(documentedIntro.outputNanoPerToken).toBe(10000);
  });

  it('sonnet-4-6 is priced but flagged unvalidated (analogy only)', () => {
    const sonnet46 = rateSetFor('claude-sonnet-4-6');
    expect(sonnet46.validated).toBe(false);
    expect(sonnet46.note).toContain('UNVALIDATED');
  });
});

describe('multiplier correctness on a checkable base', () => {
  // Opus base input = 15000 nano/token makes the arithmetic legible.
  const opusInput = 15000;
  it('5m = 1.25× base input', () => {
    expect(applyCacheMultiplier(opusInput, CACHE_WRITE_5M_MULTIPLIER)).toBe(18750);
    expect(18750 / opusInput).toBe(1.25);
  });
  it('1h = 2.00× base input', () => {
    expect(applyCacheMultiplier(opusInput, CACHE_WRITE_1H_MULTIPLIER)).toBe(30000);
    expect(30000 / opusInput).toBe(2.0);
  });
  it('read = 0.10× base input', () => {
    expect(applyCacheMultiplier(opusInput, CACHE_READ_MULTIPLIER)).toBe(1500);
    expect(1500 / opusInput).toBe(0.1);
  });
  it('throws on a base rate that does not scale to an exact integer', () => {
    // 1 nano/token × 5/4 is not an integer — a mistyped base surfaces loudly.
    expect(() => applyCacheMultiplier(1, CACHE_WRITE_5M_MULTIPLIER)).toThrow();
  });
});

describe('dollarsPerMTokToNanoPerToken', () => {
  it('scales $/MTok by 1000 to nano-per-token', () => {
    expect(dollarsPerMTokToNanoPerToken(15)).toBe(15000);
    expect(dollarsPerMTokToNanoPerToken(0.3)).toBe(300);
  });
  it('throws on a non-integer nano result', () => {
    expect(() => dollarsPerMTokToNanoPerToken(0.0001)).toThrow();
  });
});

describe('normalizeModelToKey (rule 0.6 — IDs drift)', () => {
  const table = buildPriceTable();
  it('matches an exact key', () => {
    expect(normalizeModelToKey('claude-haiku-4-5', table)).toBe('claude-haiku-4-5');
  });
  it('absorbs a dated suffix', () => {
    expect(normalizeModelToKey('claude-haiku-4-5-20251001', table)).toBe('claude-haiku-4-5');
  });
  it('absorbs a context-window suffix', () => {
    expect(normalizeModelToKey('claude-opus-4-8-1m', table)).toBe('claude-opus-4-8');
  });
  it('never collides sonnet-5 with sonnet-4-6', () => {
    expect(normalizeModelToKey('claude-sonnet-5', table)).toBe('claude-sonnet-5');
    expect(normalizeModelToKey('claude-sonnet-4-6', table)).toBe('claude-sonnet-4-6');
  });
  it('returns null for an unknown model', () => {
    expect(normalizeModelToKey('gpt-4o', table)).toBeNull();
    expect(normalizeModelToKey('claude-sonnet', table)).toBeNull();
  });
});

describe('the Money boundary', () => {
  it('rounds nano to micro-dollars, half up', () => {
    expect(nanoDollarsToMicroDollars(50_549_000)).toBe(50_549);
    expect(nanoDollarsToMicroDollars(1_500)).toBe(2); // 1.5 micro → 2
    expect(nanoDollarsToMicroDollars(1_499)).toBe(1);
  });
  it('formats a 6-dp USD figure', () => {
    expect(formatUsd(50_549_000)).toBe('$0.050549');
    expect(formatUsd(0)).toBe('$0.000000');
  });
});
