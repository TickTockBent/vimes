import { describe, expect, it } from 'vitest';
import { partitionSessionsByRecency } from './sessionListPartition.js';

// A fixed "now" and rows built by SUBTRACTING an explicit age, so every case
// reads as plain arithmetic — same convention cacheBadge.test.ts uses. The ISO
// carries a `Z` offset, so Date.parse is timezone-independent.
const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
function createdAgeMs(ageMs: number): string {
  return new Date(NOW_MS - ageMs).toISOString();
}

const ONE_DAY_MS = 86_400_000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

interface TestRow {
  id: string;
  createdAt: string;
  live?: boolean;
  flagged?: boolean;
}

function row(id: string, ageMs: number, overrides: Partial<TestRow> = {}): TestRow {
  return { id, createdAt: createdAgeMs(ageMs), ...overrides };
}

function ids(rows: readonly TestRow[]): string[] {
  return rows.map((r) => r.id);
}

describe('partitionSessionsByRecency', () => {
  it('assertion 1: rows newer than the window are visible; older ones go to older', () => {
    const rows = [
      row('a', ONE_DAY_MS), // 1 day old — recent
      row('b', SEVEN_DAYS_MS + ONE_DAY_MS), // 8 days old — older
    ];
    const result = partitionSessionsByRecency(rows, NOW_MS, {
      recencyWindowMs: SEVEN_DAYS_MS,
      minVisible: 0,
    });
    expect(ids(result.visible)).toEqual(['a']);
    expect(ids(result.older)).toEqual(['b']);
  });

  it('assertion 2: the floor — 20 all-old rows, minVisible 12 → 12 visible / 8 older', () => {
    // All 20 rows are well outside a 7-day window, oldest last (newest-first
    // input order, as the view provides it).
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(`r${index}`, SEVEN_DAYS_MS + ONE_DAY_MS * (index + 1)),
    );
    const result = partitionSessionsByRecency(rows, NOW_MS, {
      recencyWindowMs: SEVEN_DAYS_MS,
      minVisible: 12,
    });
    expect(result.visible).toHaveLength(12);
    expect(result.older).toHaveLength(8);
    // The floor promotes the FRESHEST remaining rows (r0..r11 are the least
    // old of the 20), not an arbitrary subset.
    expect(ids(result.visible)).toEqual(rows.slice(0, 12).map((r) => r.id));
    expect(ids(result.older)).toEqual(rows.slice(12).map((r) => r.id));
  });

  it('assertion 3: fewer rows than minVisible → all visible, older empty', () => {
    const rows = [row('a', 0), row('b', SEVEN_DAYS_MS * 2)];
    const result = partitionSessionsByRecency(rows, NOW_MS, {
      recencyWindowMs: SEVEN_DAYS_MS,
      minVisible: 12,
    });
    expect(result.visible).toHaveLength(2);
    expect(result.older).toHaveLength(0);
  });

  it('assertion 4: zero rows → both empty, never throws', () => {
    expect(() =>
      partitionSessionsByRecency([], NOW_MS, { recencyWindowMs: SEVEN_DAYS_MS, minVisible: 12 }),
    ).not.toThrow();
    const result = partitionSessionsByRecency([], NOW_MS, { recencyWindowMs: SEVEN_DAYS_MS, minVisible: 12 });
    expect(result.visible).toEqual([]);
    expect(result.older).toEqual([]);
  });

  it('assertion 5: order preserved newest-first in both partitions', () => {
    // Interleaved recent/old rows, still newest-first overall — the partition
    // must not resort, only filter.
    const rows = [
      row('a', ONE_DAY_MS), // recent
      row('b', SEVEN_DAYS_MS + ONE_DAY_MS), // old
      row('c', 2 * ONE_DAY_MS), // recent
      row('d', SEVEN_DAYS_MS + 2 * ONE_DAY_MS), // old
    ];
    const result = partitionSessionsByRecency(rows, NOW_MS, {
      recencyWindowMs: SEVEN_DAYS_MS,
      minVisible: 0,
    });
    expect(ids(result.visible)).toEqual(['a', 'c']);
    expect(ids(result.older)).toEqual(['b', 'd']);
  });

  it('assertion 6: deterministic — same rows + same nowMs → same split, no clock read inside', () => {
    const rows = [row('a', ONE_DAY_MS), row('b', SEVEN_DAYS_MS + ONE_DAY_MS)];
    const config = { recencyWindowMs: SEVEN_DAYS_MS, minVisible: 0 };
    const first = partitionSessionsByRecency(rows, NOW_MS, config);
    const second = partitionSessionsByRecency(rows, NOW_MS, config);
    expect(ids(first.visible)).toEqual(ids(second.visible));
    expect(ids(first.older)).toEqual(ids(second.older));
  });

  it('assertion 7: the boundary — age exactly recencyWindowMs lands in older (< window is the recent side)', () => {
    const rows = [row('exact', SEVEN_DAYS_MS), row('justUnder', SEVEN_DAYS_MS - 1)];
    const result = partitionSessionsByRecency(rows, NOW_MS, {
      recencyWindowMs: SEVEN_DAYS_MS,
      minVisible: 0,
    });
    expect(ids(result.visible)).toEqual(['justUnder']);
    expect(ids(result.older)).toEqual(['exact']);
  });

  it('assertion 8: an isAlwaysVisible-flagged old row lands in visible regardless of age', () => {
    const rows = [
      row('recent', ONE_DAY_MS),
      row('oldButLive', SEVEN_DAYS_MS * 3, { live: true }),
      row('plainOld', SEVEN_DAYS_MS * 3),
    ];
    const result = partitionSessionsByRecency(rows, NOW_MS, {
      recencyWindowMs: SEVEN_DAYS_MS,
      minVisible: 0,
      isAlwaysVisible: (r) => r.live === true,
    });
    expect(ids(result.visible)).toEqual(['recent', 'oldButLive']);
    expect(ids(result.older)).toEqual(['plainOld']);
  });

  it('an unparseable createdAt reads as infinitely old rather than throwing', () => {
    const rows = [row('bad', 0, { createdAt: 'not-a-date' })];
    expect(() =>
      partitionSessionsByRecency(rows, NOW_MS, { recencyWindowMs: SEVEN_DAYS_MS, minVisible: 0 }),
    ).not.toThrow();
    const result = partitionSessionsByRecency(rows, NOW_MS, { recencyWindowMs: SEVEN_DAYS_MS, minVisible: 0 });
    expect(result.older).toHaveLength(1);
    expect(result.visible).toHaveLength(0);
  });
});
