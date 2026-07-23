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
// Deterministic and locale-free: no `Intl`, no `toLocaleString`, no `Date`. The
// timestamp is formatted by SLICING THE ISO STRING, so a session reads the same
// on a phone in Sydney as on the daemon host.

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

/**
 * `Jul 19 23:25` from an ISO instant, or null when the string is not one. Read
 * as written: the log stores UTC, and rendering it as UTC is the only reading
 * that is the same everywhere.
 */
export function formatSessionTimestamp(isoTimestamp: string | null | undefined): string | null {
  if (typeof isoTimestamp !== 'string') {
    return null;
  }
  const matched = ISO_TIMESTAMP_PREFIX_PATTERN.exec(isoTimestamp);
  if (matched === null) {
    return null;
  }
  const monthAbbreviation = MONTH_ABBREVIATIONS[Number(matched[2]) - 1];
  if (monthAbbreviation === undefined) {
    return null;
  }
  return `${monthAbbreviation} ${matched[3]} ${matched[4]}:${matched[5]}`;
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
): string {
  const shortSessionId =
    sessionId.trim().length > 0 ? sessionId.slice(0, SHORT_SESSION_ID_LENGTH) : UNKNOWN_SESSION_LABEL;
  const formattedTimestamp = formatSessionTimestamp(earliestActivityAt);
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
 */
export function resolveSessionLabel(inputs: SessionLabelInputs): string {
  const humanName = inputs.name;
  if (typeof humanName === 'string' && humanName.trim().length > 0) {
    return humanName.trim();
  }
  const derivedTitle = inputs.derivedTitle;
  if (typeof derivedTitle === 'string' && derivedTitle.trim().length > 0) {
    return derivedTitle.trim();
  }
  return formatSessionFallbackLabel(inputs.sessionId, inputs.earliestActivityAt);
}
