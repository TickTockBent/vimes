import { describe, expect, it } from 'vitest';
import {
  decideReenterOffset,
  deriveTerminalRow,
  deriveTerminalRows,
  formatRelativeTime,
  type TerminalListItem,
} from './terminalList.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');

function item(overrides: Partial<TerminalListItem> = {}): TerminalListItem {
  return {
    terminalId: 't-1',
    cwd: '/home/wes/projects/vimes',
    lastActivityAt: '2026-01-01T12:00:00.000Z',
    resilient: false,
    subscriberCount: 0,
    ...overrides,
  };
}

describe('formatRelativeTime', () => {
  it('shows "just now" for sub-45s idle', () => {
    expect(formatRelativeTime(NOW, '2026-01-01T11:59:30.000Z')).toBe('just now');
  });

  it('rounds to minutes under an hour', () => {
    expect(formatRelativeTime(NOW, '2026-01-01T11:55:00.000Z')).toBe('5m ago');
  });

  it('rounds to hours under a day', () => {
    expect(formatRelativeTime(NOW, '2026-01-01T09:00:00.000Z')).toBe('3h ago');
  });

  it('rounds to days beyond 24h', () => {
    expect(formatRelativeTime(NOW, '2025-12-30T12:00:00.000Z')).toBe('2d ago');
  });

  it('clamps clock skew (a future timestamp) to "just now" rather than a negative value', () => {
    expect(formatRelativeTime(NOW, '2026-01-01T12:05:00.000Z')).toBe('just now');
  });

  it('returns "unknown" for an unparseable timestamp', () => {
    expect(formatRelativeTime(NOW, 'not-a-date')).toBe('unknown');
  });
});

describe('deriveTerminalRow', () => {
  it('derives the cwd tail, watched flag, resilient state, and relative label', () => {
    const row = deriveTerminalRow(
      item({ cwd: '/home/wes/projects/vimes', resilient: true, subscriberCount: 2, lastActivityAt: '2026-01-01T11:50:00.000Z' }),
      NOW,
    );
    expect(row).toEqual({
      terminalId: 't-1',
      cwd: '/home/wes/projects/vimes',
      cwdTail: 'vimes',
      resilient: true,
      watched: true,
      lastActiveLabel: '10m ago',
    });
  });

  it('marks a shell with zero subscribers as not watched', () => {
    expect(deriveTerminalRow(item({ subscriberCount: 0 }), NOW).watched).toBe(false);
  });
});

describe('deriveTerminalRows', () => {
  it('orders most-recently-active first, breaking ties by terminalId', () => {
    const rows = deriveTerminalRows(
      [
        item({ terminalId: 't-old', lastActivityAt: '2026-01-01T10:00:00.000Z' }),
        item({ terminalId: 't-new', lastActivityAt: '2026-01-01T11:59:00.000Z' }),
        item({ terminalId: 't-tie-b', lastActivityAt: '2026-01-01T11:00:00.000Z' }),
        item({ terminalId: 't-tie-a', lastActivityAt: '2026-01-01T11:00:00.000Z' }),
      ],
      NOW,
    );
    expect(rows.map((row) => row.terminalId)).toEqual(['t-new', 't-tie-a', 't-tie-b', 't-old']);
  });

  it('does not mutate its input', () => {
    const input = [item({ terminalId: 'a' }), item({ terminalId: 'b' })];
    const snapshot = input.map((entry) => entry.terminalId);
    deriveTerminalRows(input, NOW);
    expect(input.map((entry) => entry.terminalId)).toEqual(snapshot);
  });
});

describe('decideReenterOffset', () => {
  it('subscribes from 0 when there is no stored offset (fresh page load / navigate-return)', () => {
    expect(decideReenterOffset(null)).toBe(0);
    expect(decideReenterOffset(undefined)).toBe(0);
  });

  it('passes a real stored offset through', () => {
    expect(decideReenterOffset(1234)).toBe(1234);
  });

  it('treats a negative offset as 0 (defensive)', () => {
    expect(decideReenterOffset(-5)).toBe(0);
  });
});
