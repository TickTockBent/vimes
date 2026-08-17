import { describe, expect, it } from 'vitest';
import {
  compareVersionToFloor,
  patchReleasesAheadOfEvidence,
  reportCliVersionCheck,
} from './versionCompare.js';

// ─── D73's comparator, alone (S16·U1) ────────────────────────────────────────
//
// Everything here is pure: no daemon, no probe, no clock. The app-level wiring
// (which probe feeds which pin, which stream the event lands on) is asserted in
// hookIngress.test.ts; what is asserted HERE is the decision itself and every word
// it produces, because a boot line nobody can read is a guard nobody obeys.

describe('compareVersionToFloor — NUMERIC, never lexicographic', () => {
  it('THE TRAP: 2.1.9 is BELOW 2.1.224 (a string compare says the opposite)', () => {
    // The single most load-bearing case in the file. The CLI's patch number is
    // already past 200, so a lexicographic comparator would have declared newer
    // releases "older than the floor" the moment the segment lengths diverged.
    expect(compareVersionToFloor('2.1.9', '2.1.224')).toBe('lt');
    expect('2.1.9' > '2.1.224').toBe(true);
  });

  it('orders within a segment in both directions', () => {
    expect(compareVersionToFloor('2.1.223', '2.1.224')).toBe('lt');
    expect(compareVersionToFloor('2.1.225', '2.1.224')).toBe('gte');
    expect(compareVersionToFloor('2.0.999', '2.1.0')).toBe('lt');
    expect(compareVersionToFloor('3.0.0', '2.1.224')).toBe('gte');
    expect(compareVersionToFloor('1.9.9', '2.0.0')).toBe('lt');
  });

  it('EQUAL is gte — the floor question is binary, and being exactly on the floor passes it', () => {
    expect(compareVersionToFloor('2.1.224', '2.1.224')).toBe('gte');
    expect(compareVersionToFloor('0.0.0', '0.0.0')).toBe('gte');
  });

  it('compares tuples of unequal length with the missing tail read as zero', () => {
    // `2.1` is EQUAL to `2.1.0` and BELOW `2.1.1` — the reading that makes a
    // short version an honest answer rather than an ambiguous one.
    expect(compareVersionToFloor('2.1', '2.1.0')).toBe('gte');
    expect(compareVersionToFloor('2.1', '2.1.1')).toBe('lt');
    expect(compareVersionToFloor('2.1.0.0', '2.1')).toBe('gte');
    expect(compareVersionToFloor('2.1.224', '2.1')).toBe('gte');
    expect(compareVersionToFloor('2', '2.0.1')).toBe('lt');
  });

  it('leading zeros are read as numbers, not as different strings', () => {
    expect(compareVersionToFloor('2.01.224', '2.1.224')).toBe('gte');
    expect(compareVersionToFloor('02.1.223', '2.1.224')).toBe('lt');
  });

  it('MALFORMED input answers `unknown` on either side — it never throws and never guesses', () => {
    const malformedVersions = [
      '2.1.x',
      '2.1.224-beta.1',
      'v2.1.224',
      '2..224',
      '2.1.',
      'unknown',
      '',
      ' 2.1.224',
      '2.1.224 ',
      '-1.0.0',
      '1e3.0.0',
    ];
    for (const malformedVersion of malformedVersions) {
      expect(compareVersionToFloor(malformedVersion, '2.1.224'), malformedVersion).toBe('unknown');
      expect(compareVersionToFloor('2.1.224', malformedVersion), malformedVersion).toBe('unknown');
    }
    expect(compareVersionToFloor(null, '2.1.224')).toBe('unknown');
    expect(compareVersionToFloor('2.1.224', null)).toBe('unknown');
    expect(compareVersionToFloor(undefined, undefined)).toBe('unknown');
  });
});

describe('patchReleasesAheadOfEvidence — D73s "how far ahead of our EVIDENCE?" number', () => {
  it('counts patch releases within one major.minor', () => {
    expect(patchReleasesAheadOfEvidence('2.1.232', '2.1.224')).toBe(8);
    expect(patchReleasesAheadOfEvidence('2.1.225', '2.1.224')).toBe(1);
  });

  it('is null when the box is NOT ahead — a zero or a negative is not news', () => {
    expect(patchReleasesAheadOfEvidence('2.1.224', '2.1.224')).toBeNull();
    expect(patchReleasesAheadOfEvidence('2.1.210', '2.1.224')).toBeNull();
  });

  it('NEVER crosses a major or minor boundary — a subtracted patch there is a fabricated statistic', () => {
    expect(patchReleasesAheadOfEvidence('2.2.0', '2.1.224')).toBeNull();
    expect(patchReleasesAheadOfEvidence('3.0.5', '2.1.224')).toBeNull();
    expect(patchReleasesAheadOfEvidence('2.2.230', '2.1.224')).toBeNull();
  });

  it('is null when either side is unparseable, absent, or has no patch segment at all', () => {
    expect(patchReleasesAheadOfEvidence('2.1.x', '2.1.224')).toBeNull();
    expect(patchReleasesAheadOfEvidence('2.1.232', undefined)).toBeNull();
    expect(patchReleasesAheadOfEvidence(null, '2.1.224')).toBeNull();
    expect(patchReleasesAheadOfEvidence('2.1', '2.1.224')).toBeNull();
    expect(patchReleasesAheadOfEvidence('2.1.232', '2.1')).toBeNull();
  });
});

// ─── The boot report: every state, and the exact words it produces ───────────

describe('reportCliVersionCheck — the five states', () => {
  const FLOOR = '2.1.224';
  const LAST_VERIFIED = '2.1.224';

  it('BELOW the floor: the one real warning, carrying the journald grep phrase', () => {
    const report = reportCliVersionCheck({
      channel: 'pty',
      observedVersion: '2.1.9',
      floorVersion: FLOOR,
      lastVerifiedVersion: LAST_VERIFIED,
    });
    expect(report.state).toBe('below-floor');
    expect(report.warning).toBe(
      'vimes-daemon: CLI runtime drift (pty) — observed 2.1.9 is BELOW the verified floor 2.1.224',
    );
    expect(report.infoLine).toBe(
      'vimes-daemon: claude runtime — pty running 2.1.9, floor 2.1.224, last verified 2.1.224',
    );
  });

  it('AT or ABOVE the floor: silent, with the distance from evidence on the info line', () => {
    const report = reportCliVersionCheck({
      channel: 'pty',
      observedVersion: '2.1.232',
      floorVersion: FLOOR,
      lastVerifiedVersion: LAST_VERIFIED,
    });
    expect(report.state).toBe('at-or-above-floor');
    expect(report.warning).toBeNull();
    expect(report.infoLine).toBe(
      'vimes-daemon: claude runtime — pty running 2.1.232, floor 2.1.224, last verified 2.1.224 (+8 patch releases ahead of evidence)',
    );
  });

  it('UNKNOWN: a probe that answered nothing is its own state, never a silent pass (rider (b))', () => {
    const report = reportCliVersionCheck({
      channel: 'pty',
      observedVersion: null,
      floorVersion: FLOOR,
      lastVerifiedVersion: LAST_VERIFIED,
    });
    expect(report.state).toBe('unknown');
    expect(report.warning).toBe(
      'vimes-daemon: CLI runtime drift (pty) — CLI version UNKNOWN, the probe answered nothing; floor 2.1.224 NOT CHECKED',
    );
    expect(report.infoLine).toBe(
      'vimes-daemon: claude runtime — pty running (unknown), floor 2.1.224, last verified 2.1.224',
    );
  });

  it('UNPARSEABLE: the same warning family, because unparseable is not ok', () => {
    const report = reportCliVersionCheck({
      channel: 'pty',
      observedVersion: '2.1.x-nightly',
      floorVersion: FLOOR,
      lastVerifiedVersion: LAST_VERIFIED,
    });
    expect(report.state).toBe('unparseable');
    expect(report.warning).toBe(
      'vimes-daemon: CLI runtime drift (pty) — CLI version UNPARSEABLE (observed "2.1.x-nightly"); floor 2.1.224 NOT CHECKED',
    );
  });

  it('REPORT-ONLY: no floor pinned means no warning in ANY state, including unknown', () => {
    for (const observedVersion of ['2.1.9', '2.1.232', null, 'garbage']) {
      const report = reportCliVersionCheck({
        channel: 'sdk',
        observedVersion,
        floorVersion: undefined,
        lastVerifiedVersion: undefined,
      });
      expect(report.state, String(observedVersion)).toBe('report-only');
      expect(report.warning, String(observedVersion)).toBeNull();
    }
    expect(
      reportCliVersionCheck({
        channel: 'sdk',
        observedVersion: '2.1.207',
        floorVersion: undefined,
        lastVerifiedVersion: undefined,
      }).infoLine,
    ).toBe('vimes-daemon: claude runtime — sdk running 2.1.207, floor (unset), last verified (unset)');
  });

  it('BOTH CHANNELS RUN THE SAME CODE (rider (a)) — only the channel word and the binary clause differ', () => {
    const sharedInput = {
      observedVersion: '2.1.9',
      floorVersion: FLOOR,
      lastVerifiedVersion: LAST_VERIFIED,
    } as const;
    const ptyReport = reportCliVersionCheck({ channel: 'pty', ...sharedInput });
    const sdkReport = reportCliVersionCheck({ channel: 'sdk', ...sharedInput, binaryPath: '/vendored/claude' });
    expect(sdkReport.state).toBe(ptyReport.state);
    // The binary rides along on the sdk channel only, because an sdk surprise is
    // usually the vendored binary moving rather than a deliberate pin change.
    expect(sdkReport.warning).toBe(`${ptyReport.warning!.replace('(pty)', '(sdk)')} binary=/vendored/claude`);
    expect(ptyReport.warning).not.toContain('binary=');
  });

  it('an UNRESOLVED sdk binary says so rather than leaving the slot blank', () => {
    const report = reportCliVersionCheck({
      channel: 'sdk',
      observedVersion: null,
      floorVersion: '2.1.207',
      lastVerifiedVersion: '2.1.207',
      binaryPath: null,
    });
    expect(report.warning).toContain('binary=(unresolved)');
    expect(report.infoLine).toContain('binary=(unresolved)');
  });
});
