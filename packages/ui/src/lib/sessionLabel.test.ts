import { describe, expect, it } from 'vitest';
import {
  formatSessionFallbackLabel,
  formatSessionTimestamp,
  resolveSessionLabel,
  stripDispatchBoilerplate,
} from './sessionLabel.js';
import { sessionLabelFor, type SessionView } from './costDisplay.js';

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

// ⚠ ASSERTION 13, RE-ANCHORED (S16·U5, THE DELETION). The defect this case
// exists to remove was two label sources disagreeing about what a session is
// called. It used to prove that THROUGH `deriveSessionRow` — the session list's
// row model — because the list was the second caller. The list died with
// SessionListView this slice, and `lib/sessionRow.ts` died with it, so the
// old shape of the claim ("these two DERIVERS agree") has nothing left to
// compare and would have to be softened or deleted.
//
// It is neither. The claim that actually mattered is principle 9's: there is
// ONE answer to "what is this session called?", and every surface reaches it
// through `resolveSessionLabel`. So the agreement is asserted DIRECTLY against
// the ladder now — the SAME session facts, the SAME offset, and the SAME
// expected strings, byte for byte as they read before the deletion. The
// surviving second caller is the cost ledger's `sessionLabelFor`, which is
// `resolveSessionLabel` fed the ledger's own field names; the tree renders the
// ladder directly (TreeView's `sessionLabelOf`), which is what this describe
// now models.
describe('the cost ledger and the label ladder agree, for the same session', () => {
  const SESSION_ID = 'd85bc8f8-3b39-4a74-88b7-65caaa31deef';
  const FIRST_SEEN_AT = '2026-07-19T23:25:51.371Z';
  const CWD = '/home/ticktockbent/projects/content/death';

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
    // A non-ledger surface sees the two fields separately; the ledger sees the
    // daemon's already-resolved `name ?? derivedTitle`. Same ladder, same
    // offset (0 here — both sides just need to AGREE), same answer.
    const ladderLabel = resolveSessionLabel(
      {
        sessionId: SESSION_ID,
        name: null,
        derivedTitle: title,
        earliestActivityAt: FIRST_SEEN_AT,
      },
      0,
    );
    expect(sessionLabelFor(ledgerSession(title), 0)).toBe(ladderLabel);
  });

  // ⚠ THE REGRESSION PIN, KEPT — its INTENT survives the deletion even though
  // one of its two subjects did not. It used to read "NEITHER view falls back
  // to the cwd basename", and it proved the list half through `row.cwdTail`:
  // `death` was the parent directory's own label in the ledger AND the row's
  // own cwd tail in the list, so neither view could use it as an identity.
  //
  // The ladder now has NO CWD INPUT AT ALL — `SessionLabelInputs` carries id,
  // name, derivedTitle and earliestActivityAt, and nothing else — so the claim
  // sharpens rather than weakens: the bottom rung answers timestamp·shortId, a
  // directory word is not a thing it can reach for, and `CWD` is present in
  // this describe purely as the ledger's grouping fact. The expectation string
  // is unchanged, verbatim.
  it('the fallback rung answers timestamp · shortId, never a directory word', () => {
    expect(sessionLabelFor(ledgerSession(null), 0)).not.toBe('death');
    expect(sessionLabelFor(ledgerSession(null), 0)).toBe('Jul 19 23:25 · d85bc8f8');
    expect(
      resolveSessionLabel(
        { sessionId: SESSION_ID, name: null, derivedTitle: null, earliestActivityAt: FIRST_SEEN_AT },
        0,
      ),
    ).toBe('Jul 19 23:25 · d85bc8f8');
    // The ledger's own directory fact, stated so the pin still names what it is
    // guarding against: this string is a REAL basename in this fixture, and no
    // label above may equal it.
    expect(CWD.split('/').at(-1)).toBe('death');
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
