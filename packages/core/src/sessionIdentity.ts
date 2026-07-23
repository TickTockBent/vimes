// ─── Q3: what a session is CALLED — one ladder, one derivation, one fallback ──
//
// Wes, 2026-07-23: *"sessions should have a name set, but renamable by the user
// and if a user name has been set the system never automatically changes it."*
//
// ⚠ **THE INVARIANT IS STRUCTURAL, NOT A RULE.** Nothing in this module — and
// nothing that calls it — writes `SessionRecord.name`. That field has exactly
// two writers, `session_created` (from the spawn op's optional name) and
// `session_renamed` (one emitter, `sessionHost.renameSession`, reachable only
// from the WS `rename` op), and both are HUMAN paths. The auto-titler writes
// `derivedTitle` and only `derivedTitle`. So "the system never overwrites a
// user-set name" is not a rule a future change can forget — it is impossible,
// because the code that would do it does not touch that field. No flag is
// needed: `name !== null` already means "a human chose this".
//
// Rule 0.3: pure. No clock, no randomness, no I/O, no locale. Every timestamp is
// an argument, and it is formatted by SLICING THE ISO STRING — never by
// constructing a `Date`, which would make the rendered label depend on the
// ambient `TZ` of whichever process happened to build it.

// ── the display bound ────────────────────────────────────────────────────────
// `sessionHost.renameSession` REJECTS a human name longer than 120 characters.
// A derived title is truncated to the same bound rather than rejected — it is
// derived from arbitrary prose and has no author to hand the error back to — so
// both rungs of the ladder render in the same space at the same sites.
export const SESSION_TITLE_MAX_LENGTH = 120;

// ── the skip list: RECOGNIZED SHAPES, never inferred quality ─────────────────
//
// ⚠ **FRAGILE-ADAPTER BOUNDARY (rule 0.6).** Every string below is a literal
// from SOMEONE ELSE'S format — the Claude Code harness's own wrapper markup,
// observed in the live event log, not documented anywhere we control. When the
// harness changes them this list goes stale silently: the failure mode is a
// slightly worse title, never a crash or a wrong number, which is why it is
// tolerable at all. Keep it named and keep it here; do not scatter the literals.
//
// Measured on the live corpus: session `d85bc8f8`'s FIVE user messages are
// `/compact`, a continuation summary, and three wrapper blocks — every one of
// them skippable, which is exactly why the fallback below is a first-class rung.
export const HARNESS_WRAPPER_TITLE_PREFIXES: readonly string[] = [
  '<local-command-caveat>',
  '<command-name>',
  '<local-command-stdout>',
  '<task-notification>',
  'This session is being continued',
];

// A bare slash command and nothing else: `/compact`, `/clear`, `/context-usage`.
// Anchored at BOTH ends deliberately — "/compact the docs please" is a real
// instruction and a perfectly good title, while `/compact` alone names the
// harness command the operator ran, not the work the session did.
const BARE_SLASH_COMMAND_PATTERN = /^\/[a-z][a-z-]*$/;

// C0 + C1 control characters, including the ESC that `<local-command-stdout>`
// blocks carry (they embed ANSI SGR sequences). Replaced with a space BEFORE
// whitespace collapse, so a label can never smuggle a control byte into a
// terminal, a header, or a log line. Rule 0.8's posture in miniature: bytes from
// someone else's stream are relayed or discarded, never trusted.
const CONTROL_CHARACTERS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * The text of a `message` payload's `content`, which is LOOSE by schema
 * (`messagePayloadSchema` types it `z.unknown()`): the SDK sends a plain string
 * for an operator turn and an array of typed blocks for everything else.
 *
 * ⚠ **AN UNRECOGNIZED SHAPE CONTRIBUTES NOTHING — it is never stringified.**
 * `[object Object]` is not a title, and `JSON.stringify` of a tool result is a
 * wall of JSON. Only blocks that are `{ type: 'text', text: <string> }` count.
 * This is load-bearing on the real corpus, not defensive: 9 of the 13 live
 * sessions have `role:'user'` messages that are ENTIRELY `tool_result` blocks,
 * and two of them have nothing else at all.
 *
 * TOTAL — returns '' for anything it does not recognize, and never throws (I8).
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const candidateBlock = block as { type?: unknown; text?: unknown };
    if (candidateBlock.type === 'text' && typeof candidateBlock.text === 'string') {
      textParts.push(candidateBlock.text);
    }
  }
  return textParts.join(' ');
}

// Control bytes out, every whitespace run to a single space, ends trimmed. A
// title is a one-line label; a pasted multi-line prompt must not smuggle a
// newline into a list row.
function collapseToSingleLine(rawText: string): string {
  return rawText.replace(CONTROL_CHARACTERS_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The title a `message` payload's content would give a session, or **null** when
 * this message is not a title at all.
 *
 * Null is returned for RECOGNIZED SHAPES ONLY (never for "this looks like a bad
 * title" — that is inference, and rule 0.7 says observe before declaring):
 *   • nothing left after control-stripping and trimming (the `tool_result` case);
 *   • a bare slash command;
 *   • a known harness wrapper prefix.
 *
 * ⚠ Returns null, NOT `''`. An absent title and a title of nothing are different
 * facts, and the projection stores only the former (absent stays absent).
 */
export function deriveSessionTitle(content: unknown): string | null {
  const singleLineText = collapseToSingleLine(extractMessageText(content));
  if (singleLineText.length === 0) {
    return null;
  }
  if (BARE_SLASH_COMMAND_PATTERN.test(singleLineText)) {
    return null;
  }
  for (const wrapperPrefix of HARNESS_WRAPPER_TITLE_PREFIXES) {
    if (singleLineText.startsWith(wrapperPrefix)) {
      return null;
    }
  }
  return singleLineText.slice(0, SESSION_TITLE_MAX_LENGTH);
}

// ── the fallback rung ────────────────────────────────────────────────────────

// How many leading characters of a session id make the short id. Long enough to
// be distinguishable at a glance in a uuid corpus, short enough to fit a phone
// row. Presentation only — it never keys anything.
export const SHORT_SESSION_ID_LENGTH = 8;

// The last-resort label when a session has no id at all (never seen live;
// handled rather than assumed away, and printable so a leaf can never render
// blank).
export const UNKNOWN_SESSION_LABEL = '<unknown-session>';

// Fixed month names, indexed by month number minus one. A TABLE, not
// `toLocaleString`: the grep gate bans nondeterminism in core, and a label whose
// text depends on the daemon's ambient locale is not a deterministic projection
// of the log (rule 0.3). Same posture as `formatTokenCount` / `formatUsd`.
const MONTH_ABBREVIATIONS: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// The leading `YYYY-MM-DDTHH:MM` of an ISO-8601 instant. Matched, never parsed:
// `new Date(iso)` followed by `getMonth()` would re-render the instant in the
// HOST's time zone, so the same log would label the same session differently on
// two machines. Slicing the string keeps the label a pure function of the bytes
// the log stored.
const ISO_TIMESTAMP_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

// The separator between the time and the short id. U+00B7 MIDDLE DOT — printable
// and visually quiet; never a control byte.
const FALLBACK_LABEL_SEPARATOR = ' · ';

/**
 * `Jul 19 23:25` from an ISO instant, or **null** when the string is not one.
 * Read as written — the corpus stores UTC (`…Z`), so this renders UTC, which is
 * the only reading that is the same on every machine.
 */
export function formatSessionTimestamp(isoTimestamp: string | null | undefined): string | null {
  if (typeof isoTimestamp !== 'string') {
    return null;
  }
  const matched = ISO_TIMESTAMP_PREFIX_PATTERN.exec(isoTimestamp);
  if (matched === null) {
    return null;
  }
  const monthIndex = Number(matched[2]) - 1;
  const monthAbbreviation = MONTH_ABBREVIATIONS[monthIndex];
  if (monthAbbreviation === undefined) {
    return null;
  }
  return `${monthAbbreviation} ${matched[3]} ${matched[4]}:${matched[5]}`;
}

/**
 * The bottom rung: **when this session was first seen, and which one it is.**
 *
 * ⚠ **NOT AN EDGE CASE — 6 of the 13 sessions in the live event log reach it**
 * (5 have no usable user message at all; 1 is `/compact` and four wrapper
 * blocks), and 63 of the 76 sessions in the live cost ledger are not known to
 * the projection at all. It is a first-class rung and it must DISTINGUISH.
 *
 * Both halves are load-bearing, measured on the live log:
 *   • the timestamp alone collides — `101609cc` and `6e8b0f55` were created
 *     **one millisecond apart** in the same directory;
 *   • the short id alone is unreadable — a wall of hex in a list is what the
 *     cwd-basename rung was invented to avoid in the first place.
 *
 * NEVER blank, so a session leaf can never render empty. A session id shorter
 * than the short-id length is used whole.
 */
export function formatSessionFallbackLabel(
  sessionId: string,
  earliestActivityAt: string | null | undefined,
): string {
  const shortSessionId =
    sessionId.trim().length > 0 ? sessionId.slice(0, SHORT_SESSION_ID_LENGTH) : UNKNOWN_SESSION_LABEL;
  const formattedTimestamp = formatSessionTimestamp(earliestActivityAt);
  if (formattedTimestamp === null) {
    return shortSessionId;
  }
  return `${formattedTimestamp}${FALLBACK_LABEL_SEPARATOR}${shortSessionId}`;
}

// ── the ladder ───────────────────────────────────────────────────────────────

export interface SessionLabelInputs {
  readonly sessionId: string;
  // The HUMAN-supplied name, or null. Never written by this codebase's
  // auto-titler — see the module header.
  readonly name?: string | null;
  // The SYSTEM-derived title (`deriveSessionTitle` of the first qualifying user
  // message), or null.
  readonly derivedTitle?: string | null;
  // The earliest instant this session was OBSERVED — its `createdAt` in the
  // session list, its earliest cost row's `timestamp` in the ledger. Feeds the
  // fallback only.
  readonly earliestActivityAt?: string | null;
}

/**
 * **THE** session identity ladder: `name` → `derivedTitle` → the distinguishing
 * fallback.
 *
 * ⚠ **THERE IS NO CWD-BASENAME RUNG, AND REINTRODUCING ONE IS THE DEFECT.**
 * D37 groups the cost ledger by DIRECTORY, so a session's cwd basename IS its
 * parent directory node's own label whenever the session sits directly in that
 * directory — the common case, 15 of 23 directory nodes in the live ledger. The
 * rung therefore carries **zero information**: `/content/death` rendered as a
 * `death` folder containing three more rows called `death`, and the operator
 * read it as "the same project listed several times within a single folder".
 * It is not demoted to a lower rung "just in case"; it is deleted, because a
 * label that restates its own parent is worse than no label at all.
 *
 * A blank/whitespace-only value at any rung falls through to the next — the
 * ladder must never render an empty leaf.
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
