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

// ─── D91 prong (ii): stripping dispatched-worker briefing boilerplate ────────
//
// `packages/core/src/tasks/stageInstruction.ts` builds four dispatch-briefing
// variants (generic/implement, plan, review, progress), and ALL FOUR open
// with this exact stem before diverging. Restated rather than imported —
// `@vimes/core` is deliberately NOT a dependency of packages/ui (see this
// file's header); same posture as costDisplay.ts's `NANO_DOLLARS_PER_CENT`.
// ⚠ DRIFT RISK, stated rather than discovered: if the briefing stem in
// stageInstruction.ts ever changes, this stripper goes quietly INERT — every
// derivedTitle simply fails the stem check and falls through to the
// timestamp fallback rung. Labels regress to the pre-D91 "sea of identical
// boilerplate" for dispatched workers, but nothing throws and nothing is
// visibly broken; that is an accepted failure mode, not a silent one.
const DISPATCH_BRIEFING_STEM = 'You are a worker session that VIMES dispatched';

// The generic/implement/progress variants embed the real task title after a
// `Task:` marker (padded with spaces, e.g. `Task:      ${label}`); the
// plan/review variants carry no such marker at all.
const DISPATCH_TASK_MARKER = 'Task:';

// Restated from core's `SESSION_TITLE_MAX_LENGTH` (packages/core/src/
// sessionIdentity.ts) for the same reason as `DISPATCH_BRIEFING_STEM` above —
// keep the two in step. This is the auto-titler's single-line collapse cap:
// hitting it mid-word truncates the recovered task fragment, so a result
// derived from a capped-length input gets a trailing `…` to say so.
const DERIVED_TITLE_CAP_LENGTH = 120;

/**
 * Recovers the real task title out of a dispatched worker's `derivedTitle`,
 * or reports that nothing usable survived (D91 prong ii).
 *
 * - Not boilerplate (does not start with the dispatch stem) → returned
 *   UNCHANGED, byte-identical. This is the common case for orchestrator
 *   sessions and anything else that never went through stageInstruction.ts.
 * - Boilerplate, with a `Task:` marker → everything after the FIRST marker,
 *   trimmed. FIRST on purpose, not last: a task legitimately titled
 *   "Task: surf…" produces a briefing that reads `Task:      Task: surf…`,
 *   and taking the LAST marker would eat the real title's own leading
 *   "Task:" instead of just the briefing's label prefix.
 * - Boilerplate, no marker (or nothing left after trimming) → null. The
 *   plan/review/progress-without-marker variants land here; the caller falls
 *   through to the timestamp rung exactly as an absent title does today.
 */
export function stripDispatchBoilerplate(derivedTitle: string): string | null {
  if (!derivedTitle.startsWith(DISPATCH_BRIEFING_STEM)) {
    return derivedTitle;
  }
  const markerIndex = derivedTitle.indexOf(DISPATCH_TASK_MARKER);
  if (markerIndex === -1) {
    return null;
  }
  const recoveredTitle = derivedTitle.slice(markerIndex + DISPATCH_TASK_MARKER.length).trim();
  if (recoveredTitle.length === 0) {
    return null;
  }
  return derivedTitle.length >= DERIVED_TITLE_CAP_LENGTH ? `${recoveredTitle}…` : recoveredTitle;
}

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
 * `name` → `derivedTitle (boilerplate-stripped)` → the distinguishing
 * fallback.
 *
 * ⚠ **NO CWD-BASENAME RUNG. DO NOT ADD ONE.** The cost ledger groups by
 * directory (D37), so a session's cwd basename is its parent node's own label —
 * the rung carried zero information and read as "the same project listed
 * several times within a single folder". A blank value at any rung falls
 * through; the result is never blank.
 *
 * The `derivedTitle` rung passes through `stripDispatchBoilerplate` (D91
 * prong ii, 2026-08-17) before it is accepted: a dispatched worker's title is
 * the auto-titler's single-line collapse of its `stageInstruction.ts`
 * briefing, and the briefing's own opening sentence crowds out (or entirely
 * swallows) the real task title. A non-null strip result is this rung's
 * answer as-is; a null result (no task fragment survived) falls through to
 * the timestamp fallback exactly as an absent title does today. The `name`
 * rung above is UNTOUCHED by this — a human-supplied name is never
 * second-guessed (D91: named sessions bypass the fallback entirely).
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
    const strippedTitle = stripDispatchBoilerplate(derivedTitle.trim());
    if (strippedTitle !== null) {
      return strippedTitle;
    }
  }
  return formatSessionFallbackLabel(inputs.sessionId, inputs.earliestActivityAt, utcOffsetMinutes);
}
