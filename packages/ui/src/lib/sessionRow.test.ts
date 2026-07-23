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
  it('falls back to createdAt + a short id when there is no name and no derived title', () => {
    const row = deriveSessionRow(makeSession({ name: null, appSessionId: 'app-12345678-abcd' }));
    expect(row.label).toBe('Jan 01 00:00 · app-1234');
  });

  it('prefers the session name when present', () => {
    const row = deriveSessionRow(makeSession({ name: 'dongfu build' }));
    expect(row.label).toBe('dongfu build');
  });

  // Q3: the ladder is `name` → `derivedTitle` → fallback, and the FIRST rung is
  // human-only. The auto-titler never writes `name`, so a human rename cannot be
  // overwritten — this asserts the display half of that invariant.
  it('a derived title beats the fallback, and a human name beats the derived title', () => {
    expect(deriveSessionRow(makeSession({ name: null, derivedTitle: 'fix the ledger' })).label).toBe(
      'fix the ledger',
    );
    expect(
      deriveSessionRow(makeSession({ name: 'dongfu build', derivedTitle: 'fix the ledger' })).label,
    ).toBe('dongfu build');
  });

  // ⚠ THE REGRESSION PIN, list side: the row already shows `cwdTail` separately,
  // so a label that repeats it says nothing. This is the same defect the cost
  // ledger had, in the other view.
  it('the label never falls back to the cwd basename', () => {
    const row = deriveSessionRow(makeSession({ name: null, cwd: '/home/wes/projects/content/death' }));
    expect(row.cwdTail).toBe('death');
    expect(row.label).not.toBe('death');
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

  // D10 custody + action availability.
  it('defaults to host custody (no badge, no adopt) when custody is absent', () => {
    const row = deriveSessionRow(makeSession({ custody: undefined }));
    expect(row.custody).toBe('host');
    expect(row.mirrored).toBe(false);
    expect(row.canAdopt).toBe(false);
    expect(row.canRename).toBe(true);
  });

  it('a mirrored (external) session gets the mirrored flag + adopt, and is never killable', () => {
    const row = deriveSessionRow(makeSession({ custody: 'external', liveness: 'interrupted' }));
    expect(row.mirrored).toBe(true);
    expect(row.canAdopt).toBe(true);
    expect(row.canKill).toBe(false); // we do not own the process
    expect(row.canRename).toBe(true); // renaming a mirror is fine
  });

  it('a host session is killable only while it has a live process (running / spawning)', () => {
    expect(deriveSessionRow(makeSession({ custody: 'host', liveness: 'running' })).canKill).toBe(true);
    expect(deriveSessionRow(makeSession({ custody: 'host', liveness: 'spawning' })).canKill).toBe(true);
    expect(deriveSessionRow(makeSession({ custody: 'host', liveness: 'dormant' })).canKill).toBe(false);
    expect(deriveSessionRow(makeSession({ custody: 'host', liveness: 'interrupted' })).canKill).toBe(false);
    expect(deriveSessionRow(makeSession({ custody: 'host', liveness: 'dead' })).canKill).toBe(false);
  });
});
