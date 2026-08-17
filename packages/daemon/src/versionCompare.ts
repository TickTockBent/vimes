// ─── D73 — the CLI version check, as a pure decision (S16·U1) ────────────────
//
// The check this file replaces was EXACT EQUALITY against one pinned version. It
// fired on every forward auto-update and almost never mattered: five consecutive
// uninformative boot warnings against one unmoved pin (2.1.224 pinned; observed
// walked .226 → .227 → .228 → .231 → .232). A guard that always fires trains its
// reader to ignore it, which launders the one time it matters.
//
// D73 replaced it with the two questions actually worth asking, and this module
// answers both with no I/O, no clock and no guessing (rule 0.3 — app.ts holds the
// probes and the streams; every WORD below is decided here and asserted here):
//
//   1. **The FLOOR** — "is the CLI OLDER than what we have verified against?"
//      That, and only that, is a warning.
//   2. **The LAST-VERIFIED marker** — "how far ahead of our EVIDENCE are we
//      running?" That is INFO, never a warning, and it is the number that decides
//      when a verification spike is due.
//
// ⚠ **NUMERIC, NEVER LEXICOGRAPHIC.** `'2.1.9' < '2.1.24'` is TRUE numerically and
// FALSE as strings, and the CLI's patch number is already past 200 — a string
// compare would have declared every future release "older than the floor" the
// moment the segment lengths diverged. This is the single most load-bearing line
// of the whole unit.
//
// ⚠ **UNKNOWN IS AN ANSWER, NOT A FAILURE** (D73 rider (b)). Nothing here throws
// and nothing here guesses. A probe that answered nothing, and a version string
// that will not parse, are their own reported states — the 2026-08-10 blind
// auto-start went unremarked precisely because a null observation fell through a
// comparison and looked like a pass.

// The three-value comparison result. There is no `gt`: the floor question is
// binary ("older than evidence, or not"), and inventing a fourth value would
// invite a caller to treat `gt` and `eq` differently when D73 says they are the
// same answer.
export type VersionComparison = 'lt' | 'gte' | 'unknown';

// A dotted-numeric version, segment by segment — or `null` when the string is not
// one. Deliberately strict: every segment must be digits only, so `2.1.224-beta`,
// `v2.1.224`, `2.1.x` and `''` all parse to `null` and travel onward as `unknown`
// rather than being coerced into a number that was never in the string.
function parseDottedNumericSegments(rawVersion: string | null | undefined): number[] | null {
  if (rawVersion === null || rawVersion === undefined || rawVersion === '') {
    return null;
  }
  const segments = rawVersion.split('.');
  const parsedSegments: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) {
      return null;
    }
    const segmentValue = Number(segment);
    if (!Number.isSafeInteger(segmentValue)) {
      return null;
    }
    parsedSegments.push(segmentValue);
  }
  return parsedSegments;
}

/**
 * Is `observedVersion` BELOW `floorVersion`?
 *
 * Tuples of unequal length compare element-wise with the missing tail read as
 * zero, so `2.1` is BELOW `2.1.1` and EQUAL to `2.1.0` — the reading that makes
 * `2.1` an honest answer rather than an ambiguous one. Either side unparseable
 * ⇒ `unknown`; the caller reports that state rather than passing it off as ok.
 */
export function compareVersionToFloor(
  observedVersion: string | null | undefined,
  floorVersion: string | null | undefined,
): VersionComparison {
  const observedSegments = parseDottedNumericSegments(observedVersion);
  const floorSegments = parseDottedNumericSegments(floorVersion);
  if (observedSegments === null || floorSegments === null) {
    return 'unknown';
  }
  const segmentCount = Math.max(observedSegments.length, floorSegments.length);
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const observedSegment = observedSegments[segmentIndex] ?? 0;
    const floorSegment = floorSegments[segmentIndex] ?? 0;
    if (observedSegment < floorSegment) {
      return 'lt';
    }
    if (observedSegment > floorSegment) {
      return 'gte';
    }
  }
  return 'gte';
}

/**
 * How many PATCH releases the observed version is ahead of the last-verified
 * marker — D73's "how far ahead of our evidence are we running?" number.
 *
 * ⚠ **NEVER COMPUTED ACROSS A MAJOR OR MINOR BOUNDARY.** `2.2.0` is not "N patch
 * releases" ahead of `2.1.224` by any arithmetic that means anything; a subtracted
 * patch number there would be a fabricated statistic on a boot line, which is
 * exactly the sort of confident-and-wrong number rule 0.7 exists to keep out.
 * A boundary crossing, an unparseable side, or a version that is not AHEAD at all
 * ⇒ `null`, and the caller simply omits the clause.
 */
export function patchReleasesAheadOfEvidence(
  observedVersion: string | null | undefined,
  lastVerifiedVersion: string | null | undefined,
): number | null {
  const observedSegments = parseDottedNumericSegments(observedVersion);
  const lastVerifiedSegments = parseDottedNumericSegments(lastVerifiedVersion);
  if (observedSegments === null || lastVerifiedSegments === null) {
    return null;
  }
  // Both sides must name a major, a minor AND a patch. A two-segment version has
  // no patch number to be ahead by.
  if (observedSegments.length < 3 || lastVerifiedSegments.length < 3) {
    return null;
  }
  if (observedSegments[0] !== lastVerifiedSegments[0] || observedSegments[1] !== lastVerifiedSegments[1]) {
    return null;
  }
  const patchDelta = observedSegments[2]! - lastVerifiedSegments[2]!;
  return patchDelta > 0 ? patchDelta : null;
}

// ─── The boot report, one channel at a time ──────────────────────────────────
//
// Both channels — the PATH `claude` the PTY escape hatch runs, and the binary the
// Agent SDK vendors — go through THIS function and no other. D73 rider (a): the
// semantics land on both pins, and the code treats the two identically. The
// production ASYMMETRY is data, not code: the SDK pins stay unset for now, which
// this function reads as "report, never assert" — today's SDK posture exactly.

export type CliVersionCheckState =
  // No floor pinned for this channel: there is nothing to be below, so nothing
  // warns. The info line still reports what was observed.
  | 'report-only'
  // Observed is older than the verified floor. THE ONE REAL WARNING.
  | 'below-floor'
  // Observed is at or ahead of the floor. Silent; the info line carries the
  // distance-from-evidence number.
  | 'at-or-above-floor'
  // The probe answered nothing — the blind auto-start path (2026-08-10). Its own
  // reported state, never a silent pass (D73 rider (b)).
  | 'unknown'
  // The probe answered something that will not parse as a dotted-numeric version.
  // Same family as `unknown`: unparseable ≠ ok.
  | 'unparseable';

export interface CliVersionCheckReport {
  readonly state: CliVersionCheckState;
  // The stderr line, or null when this channel has nothing to warn about. Every
  // non-null value contains the exact phrase `CLI runtime drift` — see below.
  readonly warning: string | null;
  // The stdout line. ALWAYS present for a probed channel: the honest statement of
  // what is running is the report half, and it is owed in every state.
  readonly infoLine: string;
}

// ⚠ **THE JOURNALD GREP CONTRACT.** The deploy procedure greps the boot output for
// exactly `CLI runtime drift`. Both warn paths — older-than-floor AND unknown —
// carry that phrase verbatim so the operator's muscle memory still finds them.
// The info line is new text and free of the contract.
const DRIFT_GREP_PHRASE = 'CLI runtime drift';

// Placeholders, spelled out rather than left blank: a boot line with an empty slot
// reads like a bug in the daemon instead of an unset pin.
const UNKNOWN_VERSION_TEXT = '(unknown)';
const UNSET_PIN_TEXT = '(unset)';

export function reportCliVersionCheck(input: {
  // Names the channel in every line this function emits. 'pty' | 'sdk' matches the
  // `runtime_drift_observed` payload's own channel vocabulary — one spelling.
  readonly channel: 'pty' | 'sdk';
  readonly observedVersion: string | null;
  readonly floorVersion: string | undefined;
  readonly lastVerifiedVersion: string | undefined;
  // SDK channel only: an SDK-channel surprise is usually the vendored binary
  // moving under us rather than a deliberate pin change, so the warning names the
  // resolved path. Omitted entirely for the PTY channel.
  readonly binaryPath?: string | null;
}): CliVersionCheckReport {
  const { channel, observedVersion, floorVersion, lastVerifiedVersion } = input;
  const binaryClause =
    input.binaryPath === undefined ? '' : ` binary=${input.binaryPath ?? '(unresolved)'}`;
  const patchesAhead = patchReleasesAheadOfEvidence(observedVersion, lastVerifiedVersion);
  const evidenceClause =
    patchesAhead === null ? '' : ` (+${patchesAhead} patch releases ahead of evidence)`;
  const infoLine =
    `vimes-daemon: claude runtime — ${channel} running ${observedVersion ?? UNKNOWN_VERSION_TEXT}, ` +
    `floor ${floorVersion ?? UNSET_PIN_TEXT}, last verified ${lastVerifiedVersion ?? UNSET_PIN_TEXT}` +
    `${evidenceClause}${binaryClause}`;

  // An UNPINNED channel is reported and nothing else. There is nothing to drift
  // from, and this is the branch that preserves the SDK channel's shipped posture
  // while the SDK pins stay unset (rule 0.2 — an unpinned channel has nothing to
  // assert against).
  if (floorVersion === undefined) {
    return { state: 'report-only', warning: null, infoLine };
  }

  if (observedVersion === null) {
    return {
      state: 'unknown',
      warning:
        `vimes-daemon: ${DRIFT_GREP_PHRASE} (${channel}) — CLI version UNKNOWN, the probe answered ` +
        `nothing; floor ${floorVersion} NOT CHECKED${binaryClause}`,
      infoLine,
    };
  }

  const comparison = compareVersionToFloor(observedVersion, floorVersion);
  if (comparison === 'unknown') {
    return {
      state: 'unparseable',
      warning:
        `vimes-daemon: ${DRIFT_GREP_PHRASE} (${channel}) — CLI version UNPARSEABLE (observed ` +
        `"${observedVersion}"); floor ${floorVersion} NOT CHECKED${binaryClause}`,
      infoLine,
    };
  }
  if (comparison === 'lt') {
    return {
      state: 'below-floor',
      warning:
        `vimes-daemon: ${DRIFT_GREP_PHRASE} (${channel}) — observed ${observedVersion} is BELOW the ` +
        `verified floor ${floorVersion}${binaryClause}`,
      infoLine,
    };
  }
  return { state: 'at-or-above-floor', warning: null, infoLine };
}
