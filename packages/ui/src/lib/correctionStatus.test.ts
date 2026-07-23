import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveCorrectionStatus, formatQueuedFor, type CorrectionStatus } from './correctionStatus.js';
import type { SessionRecord } from './types.js';

const NOW_MS = Date.parse('2026-07-22T12:00:00.000Z');

function session(overrides: Partial<Pick<SessionRecord, 'pendingCorrectionAt'>> = {}): Pick<
  SessionRecord,
  'pendingCorrectionAt'
> {
  return { pendingCorrectionAt: null, ...overrides };
}

describe('deriveCorrectionStatus — assertion 1: absent input never throws and never queues', () => {
  it('an undefined session is "none"', () => {
    expect(deriveCorrectionStatus(undefined, NOW_MS)).toEqual<CorrectionStatus>({ kind: 'none' });
  });

  it('a null pendingCorrectionAt is "none"', () => {
    expect(deriveCorrectionStatus(session({ pendingCorrectionAt: null }), NOW_MS)).toEqual<CorrectionStatus>({
      kind: 'none',
    });
  });

  it('an undefined pendingCorrectionAt (field absent) is "none"', () => {
    expect(deriveCorrectionStatus({}, NOW_MS)).toEqual<CorrectionStatus>({ kind: 'none' });
  });
});

describe('deriveCorrectionStatus — assertion 2: a valid timestamp queues, measured against the injected now', () => {
  it('reports elapsedMs from queuedAt to nowMs and nothing else changes', () => {
    const queuedAtIso = '2026-07-22T11:59:30.000Z'; // 30s before NOW_MS
    const status = deriveCorrectionStatus(session({ pendingCorrectionAt: queuedAtIso }), NOW_MS);
    expect(status).toEqual<CorrectionStatus>({ kind: 'queued', queuedAtIso, elapsedMs: 30_000 });
  });

  it('two different nowMs values give two different elapsed values off the SAME queuedAt', () => {
    const queuedAtIso = '2026-07-22T11:59:30.000Z';
    const firstRead = deriveCorrectionStatus(session({ pendingCorrectionAt: queuedAtIso }), NOW_MS);
    const secondRead = deriveCorrectionStatus(session({ pendingCorrectionAt: queuedAtIso }), NOW_MS + 5_000);
    expect(firstRead.kind).toBe('queued');
    expect(secondRead.kind).toBe('queued');
    if (firstRead.kind === 'queued' && secondRead.kind === 'queued') {
      expect(secondRead.elapsedMs - firstRead.elapsedMs).toBe(5_000);
      // Nothing else about the derivation moves with the clock.
      expect(secondRead.queuedAtIso).toBe(firstRead.queuedAtIso);
    }
  });
});

describe('deriveCorrectionStatus — assertion 3 (THE PILLAR-4 CASE): an unparseable timestamp is "none", never a queued NaN', () => {
  it('a garbage string never yields a queued state', () => {
    const status = deriveCorrectionStatus(session({ pendingCorrectionAt: 'not-a-timestamp' }), NOW_MS);
    expect(status).toEqual<CorrectionStatus>({ kind: 'none' });
    expect(status.kind).not.toBe('queued');
  });

  it('an empty string never yields a queued state', () => {
    expect(deriveCorrectionStatus(session({ pendingCorrectionAt: '' }), NOW_MS)).toEqual<CorrectionStatus>({
      kind: 'none',
    });
  });
});

describe('deriveCorrectionStatus — assertion 4: clock skew clamps to 0, never negative', () => {
  it('a pendingCorrectionAt in the future clamps elapsedMs to 0', () => {
    const futureIso = '2026-07-22T12:00:10.000Z'; // 10s AFTER nowMs
    const status = deriveCorrectionStatus(session({ pendingCorrectionAt: futureIso }), NOW_MS);
    expect(status).toEqual<CorrectionStatus>({ kind: 'queued', queuedAtIso: futureIso, elapsedMs: 0 });
    if (status.kind === 'queued') {
      expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('formatQueuedFor — assertion 5: pure, deterministic, seconds/minutes boundaries', () => {
  it('renders 0 as "0s"', () => {
    expect(formatQueuedFor(0)).toBe('0s');
  });

  it('renders sub-minute spans as bare seconds', () => {
    expect(formatQueuedFor(12_000)).toBe('12s');
    expect(formatQueuedFor(59_000)).toBe('59s');
  });

  it('renders the 60s boundary as 1m 00s, not 60s', () => {
    expect(formatQueuedFor(60_000)).toBe('1m 00s');
  });

  it('renders minutes-and-seconds with a zero-padded seconds field', () => {
    expect(formatQueuedFor(185_000)).toBe('3m 05s'); // 3m 05s per the work order's own example
  });

  it('renders a large value without throwing or losing precision', () => {
    expect(formatQueuedFor(3_661_000)).toBe('61m 01s');
  });

  it('is pure: the same input always yields the same output', () => {
    expect(formatQueuedFor(185_000)).toBe(formatQueuedFor(185_000));
  });
});

describe('deriveCorrectionStatus — assertion 6: no clock is read in the module', () => {
  it('calling twice with the SAME nowMs yields identical results (determinism)', () => {
    const queuedAtIso = '2026-07-22T11:59:00.000Z';
    const first = deriveCorrectionStatus(session({ pendingCorrectionAt: queuedAtIso }), NOW_MS);
    const second = deriveCorrectionStatus(session({ pendingCorrectionAt: queuedAtIso }), NOW_MS);
    expect(first).toEqual(second);
  });

  it('the source never calls Date.now() — a direct scan, not just a behavioural inference', () => {
    // The ci-gate grep gate only covers packages/core/src (scripts/ci-gate.sh);
    // this module lives in packages/ui, so the "no clock read here" invariant
    // is enforced locally instead. Reading the .ts SOURCE (not the compiled
    // .js this test otherwise imports) so the check survives however the build
    // step transforms the file.
    const sourcePath = fileURLToPath(new URL('./correctionStatus.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toContain('Date.now(');
  });
});
