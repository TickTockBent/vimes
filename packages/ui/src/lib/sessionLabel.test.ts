import { describe, expect, it } from 'vitest';
import {
  formatSessionFallbackLabel,
  formatSessionTimestamp,
  resolveSessionLabel,
  stripDispatchBoilerplate,
} from './sessionLabel.js';
import { sessionLabelFor, type SessionView } from './costDisplay.js';
import { deriveSessionRow } from './sessionRow.js';
import type { SessionRecord } from './types.js';

// ─── Q3 assertion 13 — ONE ladder, and the two consumers that share it ───────

describe('resolveSessionLabel: the ladder', () => {
  it('name beats derivedTitle beats the fallback', () => {
    const shared = { sessionId: 'a1b2c3d4-e5f6', earliestActivityAt: '2026-07-19T23:25:00.000Z' };
    expect(
      resolveSessionLabel({ ...shared, name: 'the ledger rewrite', derivedTitle: 'auto' }, 0),
    ).toBe('the ledger rewrite');
    expect(resolveSessionLabel({ ...shared, name: null, derivedTitle: 'auto' }, 0)).toBe('auto');
    expect(resolveSessionLabel({ ...shared, name: null, derivedTitle: null }, 0)).toBe(
      'Jul 19 23:25 · a1b2c3d4',
    );
  });

  it('a blank at any rung falls through; the result is never empty', () => {
    expect(resolveSessionLabel({ sessionId: 'a1b2c3d4', name: '  ', derivedTitle: '\t' }, 0)).toBe(
      'a1b2c3d4',
    );
    expect(resolveSessionLabel({ sessionId: '' }, 0).length).toBeGreaterThan(0);
  });

  it('formats the timestamp from the ISO string, and drops one it cannot read', () => {
    expect(formatSessionTimestamp('2026-07-19T23:25:51.371Z', 0)).toBe('Jul 19 23:25');
    expect(formatSessionTimestamp('2026-13-19T23:25:51.371Z', 0)).toBeNull();
    expect(formatSessionTimestamp('sometime tuesday', 0)).toBeNull();
    expect(formatSessionFallbackLabel('a1b2c3d4-e5f6', 'sometime tuesday', 0)).toBe('a1b2c3d4');
  });

  // ⚠ S15-F10 SIGN-PIN. The bug: "Aug 17 12:02" rendered for a spawn that
  // actually happened 08:02 EDT — the ladder showed the UTC digits verbatim.
  // `utcOffsetMinutes` is positive = EAST of UTC; EDT is -240. This is the
  // exact vector the fix unit (S15·U8) was signed off against.
  it('S15-F10 sign-pin: EDT (-240) renders the shifted local time, not the UTC digits', () => {
    expect(formatSessionTimestamp('2026-08-17T12:02:26Z', -240)).toBe('Aug 17 08:02');
  });

  // ⚠ Rollover is real arithmetic, not string slicing — an offset can cross a
  // midnight, a month, or a year boundary.
  describe('S15-F10 rollover', () => {
    it('negative-offset midnight cross: UTC 02:00 shifts to the PREVIOUS day', () => {
      // 2026-08-17T02:00Z at EDT (-240) is 2026-08-16T22:00 local.
      expect(formatSessionTimestamp('2026-08-17T02:00:00Z', -240)).toBe('Aug 16 22:00');
    });

    it('positive-offset cross: UTC 23:30 shifts to the NEXT day', () => {
      // 2026-08-17T23:30Z at JST (+540) is 2026-08-18T08:30 local.
      expect(formatSessionTimestamp('2026-08-17T23:30:00Z', 540)).toBe('Aug 18 08:30');
    });

    it('year boundary: Jan 1 00:30Z at EDT (-240) shifts to Dec 31 of the PRIOR year', () => {
      expect(formatSessionTimestamp('2026-01-01T00:30:00Z', -240)).toBe('Dec 31 20:30');
    });
  });

  it('is identical under every ambient TZ and locale, for a FIXED offset (no Intl, no toLocaleString)', () => {
    const originalTimeZone = process.env.TZ;
    try {
      const labels = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'].map((timeZone) => {
        process.env.TZ = timeZone;
        return formatSessionFallbackLabel('a1b2c3d4-e5f6', '2026-07-19T23:25:51.371Z', 0);
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
    // already-resolved `name ?? derivedTitle`. Same ladder, same offset (0
    // here — both sides just need to AGREE), same answer.
    const listLabel = deriveSessionRow(
      listRecord(title === null ? {} : { derivedTitle: title }),
      0,
    ).label;
    expect(sessionLabelFor(ledgerSession(title), 0)).toBe(listLabel);
  });

  // ⚠ THE REGRESSION PIN, both views at once. `death` is the parent directory's
  // own label in the ledger and the row's own `cwdTail` in the list, so neither
  // view may use it as a session identity.
  it('NEITHER view falls back to the cwd basename', () => {
    const row = deriveSessionRow(listRecord(), 0);
    expect(row.cwdTail).toBe('death');
    expect(row.label).not.toBe('death');
    expect(sessionLabelFor(ledgerSession(null), 0)).not.toBe('death');
    expect(sessionLabelFor(ledgerSession(null), 0)).toBe('Jul 19 23:25 · d85bc8f8');
  });

  it('the ledger renders its OWN resolution, never the server-supplied label string', () => {
    expect(sessionLabelFor(ledgerSession(null), 0)).not.toContain('SERVER LABEL');
  });
});

// ─── D91 prong (ii) — S16-A1: stripping dispatched-worker briefing boilerplate
//
// Real briefing shapes are drawn from packages/core/src/tasks/
// stageInstruction.ts: all four dispatch variants open with the stem
// `You are a worker session that VIMES dispatched`; the generic/implement/
// progress variants embed the real task title after a `Task:      ` marker,
// the plan/review variants never do.
describe('stripDispatchBoilerplate: D91 prong (ii)', () => {
  const DISPATCH_STEM = 'You are a worker session that VIMES dispatched';

  it('stem + Task: <title> → the title, recovered and trimmed', () => {
    const briefing = `${DISPATCH_STEM} to make progress.\n\n  Task:      Surface the drift risk  `;
    expect(briefing.length).toBeLessThan(120);
    expect(stripDispatchBoilerplate(briefing)).toBe('Surface the drift risk');
  });

  // ⚠ THE DOUBLED LIVE SAMPLE. A task whose OWN title begins "Task:" produces
  // a briefing that reads `Task:      Task: surf…` — taking the LAST marker
  // would eat the real title's own leading "Task:" instead of the briefing's
  // label prefix, so this function takes the FIRST marker on purpose.
  it('doubled "Task: Task: surf" shape → first-marker rule keeps the real title intact', () => {
    const briefing = `${DISPATCH_STEM} to make progress on one task.\n\n  Task:      Task: surf`;
    expect(stripDispatchBoilerplate(briefing)).toBe('Task: surf');
  });

  it('stem with no Task: marker (the plan/review variant shape) → null', () => {
    const planBriefing =
      `${DISPATCH_STEM} to PLAN one task. You are in plan mode: investigate directly ` +
      'and produce a plan — do not implement anything yet.';
    expect(stripDispatchBoilerplate(planBriefing)).toBeNull();
  });

  it('non-boilerplate derivedTitle → returned byte-identical (the passthrough half of S16-A1)', () => {
    const humanShapedTitle = 'Look at the development plan and write next-steps.md';
    expect(stripDispatchBoilerplate(humanShapedTitle)).toBe(humanShapedTitle);
  });

  it('cap-hit input (length ≥ 120, the auto-titler truncation bound) carries a trailing …', () => {
    const capHitBriefing = `${DISPATCH_STEM} to make progress. Task:      Surface th`.padEnd(120, ' ');
    expect(capHitBriefing).toHaveLength(120);
    expect(stripDispatchBoilerplate(capHitBriefing)).toBe('Surface th…');
  });

  it('short input (length < 120) recovers the same title with no trailing …', () => {
    const shortBriefing = `${DISPATCH_STEM} to make progress. Task:      Surface th`;
    expect(shortBriefing.length).toBeLessThan(120);
    expect(stripDispatchBoilerplate(shortBriefing)).toBe('Surface th');
  });

  it('resolveSessionLabel: a null strip result falls through to the timestamp fallback rung', () => {
    const planBriefing =
      `${DISPATCH_STEM} to REVIEW one task's implementation independently. You did not ` +
      'write this code — judge it fresh against the acceptance criteria below.';
    expect(
      resolveSessionLabel(
        {
          sessionId: 'a1b2c3d4-e5f6',
          name: null,
          derivedTitle: planBriefing,
          earliestActivityAt: '2026-07-19T23:25:00.000Z',
        },
        0,
      ),
    ).toBe('Jul 19 23:25 · a1b2c3d4');
  });

  // D91: named sessions bypass the fallback entirely — the `name` rung is
  // UNTOUCHED by this change, so a boilerplate derivedTitle beside a real
  // name must never leak through the stripper at all.
  it('resolveSessionLabel: a named session ignores a boilerplate derivedTitle — the NAME wins', () => {
    const boilerplateWithNoTaskMarker = `${DISPATCH_STEM} to PLAN one task.`;
    expect(
      resolveSessionLabel(
        {
          sessionId: 'a1b2c3d4-e5f6',
          name: 'sort out the death ledger',
          derivedTitle: boilerplateWithNoTaskMarker,
          earliestActivityAt: '2026-07-19T23:25:00.000Z',
        },
        0,
      ),
    ).toBe('sort out the death ledger');
  });
});
