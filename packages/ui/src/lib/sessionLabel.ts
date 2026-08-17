// ─── Q3: THE session identity ladder for this client — ONE function ──────────
//
// ⚠ **THIS FILE EXISTS SO THERE IS EXACTLY ONE ANSWER TO "WHAT IS THIS SESSION
// CALLED?" IN THE UI.** The defect that produced it was two label sources
// disagreeing: the session list rendered `name ?? shortId` while the cost ledger
// rendered `name → cwd basename → shortId`, so the same session appeared under
// two different names in two views, and the ledger's middle rung restated its
// own parent directory ("a `death` folder containing three more rows called
// `death`"). Both consumers now call `resolveSessionLabel` — adding a third
// spelling anywhere is the drift principle 9 warns about.
//
// `@vimes/core` is deliberately NOT a dependency of packages/ui (see the header
// of lib/types.ts), so the ladder is RESTATED here rather than imported, in the
// same posture as `costDisplay.ts`'s `NANO_DOLLARS_PER_CENT` and `taskBoard.ts`'s
// stage vocabulary. The authority is `packages/core/src/sessionIdentity.ts`;
// keep the two in step, and keep this file the only copy on this side.
//
// Deterministic and locale-free: no `Intl`, no `toLocaleString`, no ambient
// `Date`. The formatter takes an injected `utcOffsetMinutes: number`
// (positive = EAST of UTC; EDT is -240) and does the calendar arithmetic with
// it deterministically — a pure function of (input, offset) reads the same
// wherever it runs.
//
// ⚠ **AMENDED (S15-F10, 2026-08-17): the old absolute "no Date at all" rule
// was the right property, wrongly scoped.** It banned `Date` outright to keep
// the file from reading the AMBIENT clock or the AMBIENT locale — but
// applying that ban to timestamp arithmetic on the INPUT meant every label
// rendered the ISO string's UTC digits verbatim, so a session spawned 08:02
// EDT showed as "Aug 17 12:02" for every viewer. The property that actually
// matters is "no ambient clock, no locale" — `new Date()` with no argument,
// `Date.prototype.getTimezoneOffset`, and any `Intl`/`toLocaleString` call
// stay banned INSIDE this file; `Date.UTC` / `new Date(epochMs)` used only as
// a calendar calculator on values this file was HANDED (the parsed input
// instant, the injected offset) are fine, because the result is still a pure
// function of its arguments, not of when or where it runs. The caller (a
// view, never this file) supplies the real offset via
// `-new Date().getTimezoneOffset()`.

// How many leading characters of a session id make the short id. Long enough to
// tell two uuids apart at a glance, short enough for a phone row.
export const SHORT_SESSION_ID_LENGTH = 8;

// Shown when a session has no usable id at all (never seen live; printable, so a
// row can never render blank).
export const UNKNOWN_SESSION_LABEL = '<unknown-session>';

// Fixed month names, indexed by month number minus one. A TABLE, not
// `toLocaleString` — see the header.
const MONTH_ABBREVIATIONS: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const ISO_TIMESTAMP_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

// U+00B7 MIDDLE DOT — printable and visually quiet; never a control byte.
const FALLBACK_LABEL_SEPARATOR = ' · ';

// Zero-pads a calendar field to 2 digits, matching the original slice-the-ISO
// digit style (`matched[3]`/`[4]`/`[5]` were always 2 characters). Never fed a
// value outside 0-59 by this file's own callers.
function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * `Jul 19 23:25` from an ISO instant, shifted by `utcOffsetMinutes` (positive
 * = EAST of UTC; EDT is -240), or null when the string is not a recognizable
 * instant. S15-F10: the log stores UTC, but the VIEWER is not on the UTC
 * meridian — this renders the instant AS the viewer's local clock would read
 * it, which is the reading that is actually useful, not merely "the same
 * everywhere" (that was the old, wrong bar).
 */
export function formatSessionTimestamp(
  isoTimestamp: string | null | undefined,
  utcOffsetMinutes: number,
): string | null {
  if (typeof isoTimestamp !== 'string') {
    return null;
  }
  const matched = ISO_TIMESTAMP_PREFIX_PATTERN.exec(isoTimestamp);
  if (matched === null) {
    return null;
  }
  const inputMonth = Number(matched[2]);
  // Validated against the INPUT's own month, before any shift — an offset can
  // legitimately roll the shifted month over (that's the whole point), but an
  // unparseable month (13+) is a bad string regardless of offset.
  if (MONTH_ABBREVIATIONS[inputMonth - 1] === undefined) {
    return null;
  }
  // Deterministic calendar arithmetic on the INPUT instant + the INJECTED
  // offset (rule 0.3 / S15-F10 header note): `Date.UTC`/`getUTC*` are used
  // here only as a calendar calculator on values this call was handed, never
  // seeded from the ambient clock.
  const inputEpochMs = Date.UTC(
    Number(matched[1]),
    inputMonth - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
  );
  const shifted = new Date(inputEpochMs + utcOffsetMinutes * 60_000);
  const shiftedMonthAbbreviation = MONTH_ABBREVIATIONS[shifted.getUTCMonth()]!;
  return `${shiftedMonthAbbreviation} ${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

/**
 * The bottom rung: **when this session was first seen, and which one it is.**
 *
 * ⚠ Not an edge case — 6 of the 13 sessions in the live event log reach it, and
 * 63 of the 76 sessions in the live cost ledger are unknown to the projection
 * entirely. Both halves are load-bearing: two live sessions were created **one
 * millisecond apart** in the same directory (the time alone collides), and a
 * bare hex id is exactly the unreadable wall the deleted cwd rung was reaching
 * to avoid.
 */
export function formatSessionFallbackLabel(
  sessionId: string,
  earliestActivityAt: string | null | undefined,
  utcOffsetMinutes: number,
): string {
  const shortSessionId =
    sessionId.trim().length > 0 ? sessionId.slice(0, SHORT_SESSION_ID_LENGTH) : UNKNOWN_SESSION_LABEL;
  const formattedTimestamp = formatSessionTimestamp(earliestActivityAt, utcOffsetMinutes);
  return formattedTimestamp === null
    ? shortSessionId
    : `${formattedTimestamp}${FALLBACK_LABEL_SEPARATOR}${shortSessionId}`;
}

export interface SessionLabelInputs {
  readonly sessionId: string;
  // The HUMAN-supplied name, or null. On the cost ledger the daemon has already
  // resolved `name ?? derivedTitle` into one string, which arrives here as
  // `name` with no `derivedTitle` beside it — the ladder is the same either way.
  readonly name?: string | null;
  // The SYSTEM-derived title, or null/absent. Never written over a `name`: the
  // projection's auto-titler does not touch that field at all (Q3).
  readonly derivedTitle?: string | null;
  // The earliest instant this session was observed — `createdAt` in the session
  // list, the earliest cost row's timestamp in the ledger. Fallback only.
  readonly earliestActivityAt?: string | null;
}

/**
 * `name` → `derivedTitle` → the distinguishing fallback.
 *
 * ⚠ **NO CWD-BASENAME RUNG. DO NOT ADD ONE.** The cost ledger groups by
 * directory (D37), so a session's cwd basename is its parent node's own label —
 * the rung carried zero information and read as "the same project listed
 * several times within a single folder". A blank value at any rung falls
 * through; the result is never blank.
 *
 * `utcOffsetMinutes` (positive = EAST of UTC) only matters when the ladder
 * bottoms out at the timestamp rung — S15-F10 — but it is a required
 * parameter, not a default, so every caller states its own reading of the
 * viewer's offset rather than this file guessing an ambient one.
 */
export function resolveSessionLabel(inputs: SessionLabelInputs, utcOffsetMinutes: number): string {
  const humanName = inputs.name;
  if (typeof humanName === 'string' && humanName.trim().length > 0) {
    return humanName.trim();
  }
  const derivedTitle = inputs.derivedTitle;
  if (typeof derivedTitle === 'string' && derivedTitle.trim().length > 0) {
    return derivedTitle.trim();
  }
  return formatSessionFallbackLabel(inputs.sessionId, inputs.earliestActivityAt, utcOffsetMinutes);
}
