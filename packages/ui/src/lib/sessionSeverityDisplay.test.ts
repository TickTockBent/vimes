import { describe, expect, it } from 'vitest';
import type { AttentionSeverity, TreeSession } from '@vimes/core';
import { rollupWorstDisplay, sessionRowTreatment, severityDisplayOf } from './sessionSeverityDisplay.js';

// Every member of the severity union, driven as DATA rather than hardcoded
// per-test — same idiom as core's sessionSeverity.test.ts EVERY_LIVENESS list.
// If core adds a member to AttentionSeverity, the compile-time `never` check
// in severityDisplayOf catches the switch, and this list (now missing an
// entry vs. the type) catches the test's own blind spot.
const ALL_SEVERITIES: AttentionSeverity[] = ['gate_fired', 'error', 'waiting_input', 'working', 'idle'];

// The pinned table, written out as data (slice-15.md §3b) — a row silently
// re-priced in the implementation fails against THIS, not against a vague
// "looks right" read of the switch statement.
const PINNED_TABLE: Record<AttentionSeverity, { tone: string; glyph: string }> = {
  gate_fired: { tone: 'warn', glyph: '!' },
  error: { tone: 'crit', glyph: '×' },
  waiting_input: { tone: 'warn', glyph: '?' },
  working: { tone: 'accent', glyph: '*' },
  idle: { tone: 'dim', glyph: '·' },
};

function baseSession(overrides: Partial<TreeSession> = {}): TreeSession {
  return {
    appSessionId: 'sess-a',
    shortId: 'sess',
    name: null,
    derivedTitle: null,
    liveness: 'running',
    needsAttention: null,
    seenAt: null,
    custody: 'host',
    severity: 'working',
    overlays: {},
    createdAt: '2026-08-12T09:00:00.000Z',
    ...overrides,
  };
}

describe('severityDisplayOf', () => {
  it('A2: every member of the severity union maps to the pinned table', () => {
    for (const severity of ALL_SEVERITIES) {
      expect(severityDisplayOf(severity)).toEqual(PINNED_TABLE[severity]);
    }
  });

  it('gate_fired and waiting_input share the warn tone but differ by glyph', () => {
    expect(severityDisplayOf('gate_fired').tone).toBe('warn');
    expect(severityDisplayOf('waiting_input').tone).toBe('warn');
    expect(severityDisplayOf('gate_fired').glyph).not.toBe(severityDisplayOf('waiting_input').glyph);
  });

  it('A2: throws at runtime on a forged value outside the union', () => {
    expect(() => severityDisplayOf('bogus-severity' as AttentionSeverity)).toThrow();
  });
});

describe('rollupWorstDisplay', () => {
  it('null (empty subtree) renders the explicit quiet branch: dim / middle-dot', () => {
    expect(rollupWorstDisplay(null)).toEqual({ tone: 'dim', glyph: '·' });
  });

  it('a non-null worst renders identically to severityDisplayOf for that severity', () => {
    for (const severity of ALL_SEVERITIES) {
      expect(rollupWorstDisplay(severity)).toEqual(severityDisplayOf(severity));
    }
  });
});

describe('sessionRowTreatment', () => {
  it('A4: seenAt set AND severity gate_fired -> tone warn, glyph !, seen: true (seen does not quiet a live gate)', () => {
    const seenGateSession = baseSession({
      severity: 'gate_fired',
      needsAttention: { reason: 'gate', since: '2026-08-13T00:00:00.000Z' },
      seenAt: '2026-08-13T00:05:00.000Z',
    });
    expect(sessionRowTreatment(seenGateSession)).toEqual({ tone: 'warn', glyph: '!', seen: true });
  });

  it('A4: seenAt null, severity idle -> seen: false, tone dim', () => {
    const unseenIdleSession = baseSession({ severity: 'idle', seenAt: null });
    const treatment = sessionRowTreatment(unseenIdleSession);
    expect(treatment.seen).toBe(false);
    expect(treatment.tone).toBe('dim');
  });

  it('A4: the seen channel provably cannot bend the severity channel — tone/glyph match severityDisplayOf across seen AND unseen for every severity', () => {
    for (const severity of ALL_SEVERITIES) {
      const unseen = sessionRowTreatment(baseSession({ severity, seenAt: null }));
      const seen = sessionRowTreatment(baseSession({ severity, seenAt: '2026-08-13T00:00:00.000Z' }));
      const expectedDisplay = severityDisplayOf(severity);

      expect(unseen.tone).toBe(expectedDisplay.tone);
      expect(unseen.glyph).toBe(expectedDisplay.glyph);
      expect(seen.tone).toBe(expectedDisplay.tone);
      expect(seen.glyph).toBe(expectedDisplay.glyph);

      // The only field seenAt is allowed to move.
      expect(unseen.seen).toBe(false);
      expect(seen.seen).toBe(true);
    }
  });
});
