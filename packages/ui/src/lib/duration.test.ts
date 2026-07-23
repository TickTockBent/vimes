import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration.js';

// The one shared elapsed-span formatter (meterDisplay + cacheBadge both call it).
// Locale-free and deterministic: these exact strings hold in every TZ/locale.
describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('renders whole minutes under an hour', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(26 * 60_000)).toBe('26m');
    expect(formatDuration(59 * 60_000)).toBe('59m');
  });

  it('renders hours and minutes under a day', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
  });

  it('renders days and hours', () => {
    expect(formatDuration(24 * 3_600_000)).toBe('1d 0h');
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h');
  });

  it('floors partial units (no rounding up)', () => {
    expect(formatDuration(1_999)).toBe('1s');
    expect(formatDuration(119_999)).toBe('1m');
  });
});
