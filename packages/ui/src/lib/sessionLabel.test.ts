import { describe, expect, it } from 'vitest';
import {
  formatSessionFallbackLabel,
  formatSessionTimestamp,
  resolveSessionLabel,
} from './sessionLabel.js';
import { sessionLabelFor, type SessionView } from './costDisplay.js';
import { deriveSessionRow } from './sessionRow.js';
import type { SessionRecord } from './types.js';

// ─── Q3 assertion 13 — ONE ladder, and the two consumers that share it ───────

describe('resolveSessionLabel: the ladder', () => {
  it('name beats derivedTitle beats the fallback', () => {
    const shared = { sessionId: 'a1b2c3d4-e5f6', earliestActivityAt: '2026-07-19T23:25:00.000Z' };
    expect(resolveSessionLabel({ ...shared, name: 'the ledger rewrite', derivedTitle: 'auto' })).toBe(
      'the ledger rewrite',
    );
    expect(resolveSessionLabel({ ...shared, name: null, derivedTitle: 'auto' })).toBe('auto');
    expect(resolveSessionLabel({ ...shared, name: null, derivedTitle: null })).toBe(
      'Jul 19 23:25 · a1b2c3d4',
    );
  });

  it('a blank at any rung falls through; the result is never empty', () => {
    expect(resolveSessionLabel({ sessionId: 'a1b2c3d4', name: '  ', derivedTitle: '\t' })).toBe('a1b2c3d4');
    expect(resolveSessionLabel({ sessionId: '' }).length).toBeGreaterThan(0);
  });

  it('formats the timestamp from the ISO string, and drops one it cannot read', () => {
    expect(formatSessionTimestamp('2026-07-19T23:25:51.371Z')).toBe('Jul 19 23:25');
    expect(formatSessionTimestamp('2026-13-19T23:25:51.371Z')).toBeNull();
    expect(formatSessionTimestamp('sometime tuesday')).toBeNull();
    expect(formatSessionFallbackLabel('a1b2c3d4-e5f6', 'sometime tuesday')).toBe('a1b2c3d4');
  });

  it('is identical under every ambient TZ and locale (no Intl, no toLocaleString)', () => {
    const originalTimeZone = process.env.TZ;
    try {
      const labels = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'].map((timeZone) => {
        process.env.TZ = timeZone;
        return formatSessionFallbackLabel('a1b2c3d4-e5f6', '2026-07-19T23:25:51.371Z');
      });
      expect(new Set(labels).size).toBe(1);
      expect(labels[0]).toBe('Jul 19 23:25 · a1b2c3d4');
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
  });
});

// ⚠ ASSERTION 13. The defect this change exists to remove was two label sources
// disagreeing about what a session is called. Both surfaces now route through
// `resolveSessionLabel`, and this case proves it by feeding them the SAME facts
// and demanding the SAME string — including the rung that used to differ.
describe('the session list and the cost ledger agree, for the same session', () => {
  const SESSION_ID = 'd85bc8f8-3b39-4a74-88b7-65caaa31deef';
  const FIRST_SEEN_AT = '2026-07-19T23:25:51.371Z';
  const CWD = '/home/ticktockbent/projects/content/death';

  function listRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      appSessionId: SESSION_ID,
      channel: 'sdk',
      cwd: CWD,
      liveness: 'running',
      needsAttention: null,
      name: null,
      createdAt: FIRST_SEEN_AT,
      ...overrides,
    };
  }

  function ledgerSession(title: string | null): SessionView {
    return {
      sessionId: SESSION_ID,
      directoryPath: CWD,
      cwd: CWD,
      title,
      earliestRowTimestamp: FIRST_SEEN_AT,
      // Core's own resolution rides on the wire; the UI must not read it.
      label: 'SERVER LABEL THAT MUST NOT BE RENDERED',
      own: { priced: { nanoDollars: 0, usd: '$0' }, unvalidated: { nanoDollars: 0, usd: '$0' }, statusCounts: { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 }, tokensByStatus: { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 }, rowCount: 0 },
      subtree: { priced: { nanoDollars: 0, usd: '$0' }, unvalidated: { nanoDollars: 0, usd: '$0' }, statusCounts: { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 }, tokensByStatus: { priced: 0, unpriced: 0, unpriceable: 0, flagged: 0 }, rowCount: 0 },
      agents: [],
    };
  }

  it.each([
    ['a human name', 'sort out the death ledger'],
    ['a system-derived title', 'Look at the development plan and write next-steps.md'],
    ['neither (the fallback)', null],
  ])('%s produces one label in both views', (_label, title) => {
    // The list sees the two fields separately; the ledger sees the daemon's
    // already-resolved `name ?? derivedTitle`. Same ladder, same answer.
    const listLabel = deriveSessionRow(
      listRecord(title === null ? {} : { derivedTitle: title }),
    ).label;
    expect(sessionLabelFor(ledgerSession(title))).toBe(listLabel);
  });

  // ⚠ THE REGRESSION PIN, both views at once. `death` is the parent directory's
  // own label in the ledger and the row's own `cwdTail` in the list, so neither
  // view may use it as a session identity.
  it('NEITHER view falls back to the cwd basename', () => {
    const row = deriveSessionRow(listRecord());
    expect(row.cwdTail).toBe('death');
    expect(row.label).not.toBe('death');
    expect(sessionLabelFor(ledgerSession(null))).not.toBe('death');
    expect(sessionLabelFor(ledgerSession(null))).toBe('Jul 19 23:25 · d85bc8f8');
  });

  it('the ledger renders its OWN resolution, never the server-supplied label string', () => {
    expect(sessionLabelFor(ledgerSession(null))).not.toContain('SERVER LABEL');
  });
});
