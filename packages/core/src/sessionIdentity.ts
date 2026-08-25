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

// ── the dispatch-briefing skip (S16-F1, ruled ⟨Wes⟩ 2026-08-17) ──────────────
//
// ⚠ **A SECOND FRAGILE-ADAPTER BOUNDARY (rule 0.6) — but this one is OURS, and
// that is why it is machine-checked rather than merely commented.** Every
// briefing VIMES dispatches is composed by `packages/ext-tasks/src/stageInstruction.ts`
// — tenant code across the package boundary since S18, which is exactly why
// this coupling is machine-checked as recorded bytes rather than trusted by
// proximity — whose four variants (implementing-rich, PLAN, REVIEW, generic make-progress) all
// open with this exact sentence stem before diverging, then all emit a line
// shaped `  Task:      ${label}`. The stem is RESTATED here rather than
// imported so this module stays a leaf (nothing in the identity ladder should
// depend on the task subsystem). The coupling is held by a machine check in
// `packages/daemon/src/dispatchBriefingStem.test.ts` — the daemon is the one
// package that legally imports BOTH sides since S18, so it can compose REAL
// briefings through the real `composeStageInstruction` and assert that every
// variant still derives its task label through this branch. If the composer's
// opening sentence ever changes, THAT file reddens; it cannot go quietly inert.
//
// ⚠ It used to live next door. S18·U2's signed fixture swap froze those
// briefings into `sessionIdentity.test.ts` as recorded constants (core may not
// import a tenant), which SEVERED the live coupling — caught by the post-close
// cold review and re-homed to the daemon (docs/slice-18.md §6c, S18-F4).
//
// ⚠ **WHY THIS BRANCH RUNS BEFORE THE CAP, NOT AFTER (the whole of S16-F1).**
// D91's first attempt stripped this boilerplate DOWNSTREAM, off the finished
// `derivedTitle` — and it was a structural no-op for three of the four
// variants, because `Task:` sits at collapsed offset 178 (implementing), 182
// (review) and 160 (planning) while `SESSION_TITLE_MAX_LENGTH` is 120. The
// marker was truncated away before any stripper could see it, so those sessions
// fell to the timestamp rung. (The generic variant's marker lands at 96 — inside
// the cap — so it degraded differently: the marker survived and the LABEL was
// truncated to whatever fitted in the ~24 characters left.) The fix is one of
// position: recognize the shape on the RAW text, where the marker is still
// present AND the line structure still exists, and feed only the recovered
// label through the ordinary pipeline.
export const DISPATCH_BRIEFING_STEM = 'You are a worker session that VIMES dispatched';

// The marker that opens the briefing's task line. Matched at its FIRST
// occurrence: a task legitimately titled `Task: surf the wave` composes a line
// reading `  Task:      Task: surf the wave`, and taking the LAST occurrence
// would eat the real title's own prefix rather than the briefing's.
const DISPATCH_TASK_MARKER = 'Task:';

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
 *   • a known harness wrapper prefix;
 *   • a VIMES dispatch briefing that carries no `Task:` marker (S16-F1).
 *
 * A dispatch briefing that DOES carry one is titled by its task label rather
 * than by its opening sentence — see `DISPATCH_BRIEFING_STEM` above for why the
 * recognition happens on the raw text and before the cap.
 *
 * ⚠ Returns null, NOT `''`. An absent title and a title of nothing are different
 * facts, and the projection stores only the former (absent stays absent).
 */
export function deriveSessionTitle(content: unknown): string | null {
  const rawText = extractMessageText(content);

  // ── the dispatch-briefing branch (S16-F1) ──────────────────────────────────
  //
  // Tested on the RAW text, before any collapse: the line structure IS the
  // information this branch needs, and the collapse destroys it. Deliberately
  // NOT `trimStart().startsWith(...)` — the composer emits the stem at byte 0
  // of every variant, so a leading-whitespace tolerance would only widen the
  // shape this recognizes beyond anything observed (rule 0.7).
  if (rawText.startsWith(DISPATCH_BRIEFING_STEM)) {
    const markerIndex = rawText.indexOf(DISPATCH_TASK_MARKER);
    // Boilerplate with nothing usable in it is a WRAPPER, not a title — the
    // same treatment `HARNESS_WRAPPER_TITLE_PREFIXES` gets. The ladder falls to
    // the distinguishing timestamp rung, which is strictly better than titling
    // every dispatched session with the same opening sentence.
    if (markerIndex === -1) {
      return null;
    }
    const afterMarker = rawText.slice(markerIndex + DISPATCH_TASK_MARKER.length);
    // ⚠ **THAT LINE ONLY.** The label ends at the newline; the very next lines
    // are `  Stage:` and `  Directory:`, and an everything-after-the-marker
    // slice would drag both into the title. A marker on the last line (no
    // trailing newline) takes the remainder — `indexOf` returning -1 is that
    // case, not an error.
    const lineEndIndex = afterMarker.indexOf('\n');
    const taskLineRemainder = lineEndIndex === -1 ? afterMarker : afterMarker.slice(0, lineEndIndex);
    // Through the SAME pipeline as any other title: control-stripped,
    // collapsed, capped at the display bound. A label longer than the bound
    // truncates exactly as a human's prompt would.
    return titleFromRawText(taskLineRemainder);
  }

  return titleFromRawText(rawText);
}

// The ordinary pipeline, extracted verbatim so both callers above share ONE
// spelling of "what makes a title". Byte-identical to the pre-S16·U6 body of
// `deriveSessionTitle` — the non-stem path is unchanged, and passthrough tests
// pin that.
function titleFromRawText(rawText: string): string | null {
  const singleLineText = collapseToSingleLine(rawText);
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

// ⚠ **THIS SLICE IS A DISPLAY DISTINGUISHER, NOT A D79 HANDLE (S14-F1, signed
// 2026-08-12; slice-14.md §3c, third exemption).** D79 consolidated "shorten a
// session id" into `sessionShortIds.ts` — one derivation, one base width,
// collisions extended git-style — and S14·U2 initially migrated this rung onto
// that width too. That was an ERROR OF THE SAME CLASS §3c already caught for
// `founding.ts`'s task ids, and it broke the rung's only job: at the D79 base
// width of 4, with no collision context to extend against, `sess-unnamed` and
// `sess-blank` both render `sess` and the fallback stops distinguishing.
//
// The distinction that settles it is CONTEXT, not width. `shortSessionIds`
// needs the whole estate's ids to know whether a prefix collides; this function
// is handed ONE session and no scope at all, so it can never collision-extend —
// which is precisely why it is NOT an addressable handle. It renders a label a
// human reads next to a timestamp; D79's handle is the wire's collision-extended
// `shortId` (`sessionShortIds.ts`), and nothing else is one.
//
// So the width is declared HERE, under this module's own name, at 8 — the width
// the live corpus was measured against. It is deliberately independent of
// `SHORT_SESSION_ID_BASE_LENGTH`: the two answer different questions and moving
// one must not move the other. (The old spelling `SHORT_SESSION_ID_LENGTH` stays
// dead — five scattered spellings is the history D79 ended, and resurrecting the
// name would re-open it.)
export const FALLBACK_LABEL_ID_LENGTH = 8;

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
    sessionId.trim().length > 0
      ? sessionId.slice(0, FALLBACK_LABEL_ID_LENGTH)
      : UNKNOWN_SESSION_LABEL;
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
