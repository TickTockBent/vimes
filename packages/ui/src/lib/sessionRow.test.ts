import { describe, expect, it } from 'vitest';
import { deriveSessionRow } from './sessionRow.js';
import type { SessionRecord } from './types.js';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    appSessionId: 'app-12345678-abcd',
    channel: 'sdk',
    cwd: '/home/wes/projects/games/dongfu',
    liveness: 'running',
    needsAttention: null,
    name: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('deriveSessionRow', () => {
  it('falls back to an appSessionId prefix when name is null', () => {
    const row = deriveSessionRow(makeSession({ name: null, appSessionId: 'app-12345678-abcd' }));
    expect(row.label).toBe('app-1234');
  });

  it('prefers the session name when present', () => {
    const row = deriveSessionRow(makeSession({ name: 'dongfu build' }));
    expect(row.label).toBe('dongfu build');
  });

  it('takes the last path segment as the cwd tail', () => {
    const row = deriveSessionRow(makeSession({ cwd: '/home/wes/projects/games/dongfu' }));
    expect(row.cwdTail).toBe('dongfu');
  });

  it('handles a trailing-slash cwd', () => {
    const row = deriveSessionRow(makeSession({ cwd: '/home/wes/projects/games/dongfu/' }));
    expect(row.cwdTail).toBe('dongfu');
  });

  it.each([
    ['spawning', 'bg-sky-500 text-white'],
    ['running', 'bg-emerald-500 text-white'],
    ['dormant', 'bg-slate-400 text-white'],
    ['interrupted', 'bg-amber-500 text-white'],
    ['dead', 'bg-rose-600 text-white'],
  ] as const)('gives %s a distinct color class', (liveness, colorClass) => {
    const row = deriveSessionRow(makeSession({ liveness }));
    expect(row.livenessLabel).toBe(liveness);
    expect(row.livenessColorClass).toBe(colorClass);
  });

  it('interrupted is amber (scope requirement)', () => {
    const row = deriveSessionRow(makeSession({ liveness: 'interrupted' }));
    expect(row.livenessColorClass).toContain('amber');
  });

  it('hides the attention badge when needsAttention is null', () => {
    const row = deriveSessionRow(makeSession({ needsAttention: null }));
    expect(row.attention).toEqual({ visible: false });
  });

  it('shows the attention badge with its reason when needsAttention is set', () => {
    const row = deriveSessionRow(
      makeSession({ needsAttention: { reason: 'gate', since: '2026-01-01T00:01:00.000Z' } }),
    );
    expect(row.attention).toEqual({ visible: true, reason: 'gate', label: 'needs a decision' });
  });

  it('an interrupted session can simultaneously need attention', () => {
    const row = deriveSessionRow(
      makeSession({
        liveness: 'interrupted',
        needsAttention: { reason: 'stale', since: '2026-01-01T00:01:00.000Z' },
      }),
    );
    expect(row.livenessLabel).toBe('interrupted');
    expect(row.attention).toEqual({ visible: true, reason: 'stale', label: 'went quiet' });
  });
});
