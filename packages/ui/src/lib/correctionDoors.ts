// S7·8 — the two correction doors' pure core (D46/D53).
//
// D46 gave the board exactly two legitimate ways to correct dispatched work,
// and D46's own closing line is why this file exists at all: "the failure in
// T7 was never a missing door — it was that the doors weren't labeled."
//   • STEER — `review → implementing`, same `payloadRev`, a fresh attempt
//     seeded with the prior diff + review feedback + worklog. This is just the
//     board's existing dispatch, relabeled with its meaning: it rides the
//     UNCHANGED dispatch handler in TaskBoardView.vue.
//   • AMEND — a new `payloadRev` via
//     `POST /api/instances/:instanceId/payload-revisions` (S7·2b, landed
//     daemon-side — see that route's own header in
//     packages/daemon/src/instanceApi.ts). D53 is explicit that amending NEVER
//     dispatches: it changes what the work order SAYS, and whether to re-run
//     against the new revision is a separate, later act.
//
// This module owns the two things that must NOT live in the .vue (house
// rule): the amend form's pure body-diff builder (the sibling of
// workOrderForm.ts's `buildWorkOrderBody`, but a DIFFER rather than a
// from-scratch builder — an amendment only ever says what CHANGED), and the
// door descriptors themselves. The .vue renders both; it decides nothing.
//
// @vimes/core is deliberately NOT a dependency of this package (lib/types.ts's
// header) — the wire shapes below mirror
// packages/core/src/projections/instances.ts and
// packages/daemon/src/instanceApi.ts's `amendWorkOrderBodySchema` narrowly.

// One row of the amend form's criteria editor. `id === null` marks a NEW row
// (the server mints its id); a non-null id is an EXISTING criterion being kept
// (possibly reworded — rewording keeps the id, that is the design: per-criterion
// review keying survives a rewording, and the rev bump is what records that the
// text moved).
export interface AmendCriterionRow {
  id: string | null;
  text: string;
}

// The amend form's raw model — the sibling of workOrderForm.ts's
// `WorkOrderFormModel`, seeded from the record rather than started blank.
export interface AmendFormModel {
  scope: string;
  explicitlyOut: string[];
  acceptanceCriteria: AmendCriterionRow[];
  killCriterion: string;
}

// The payload-revisions route's body (S7·2b): every field OPTIONAL — ABSENT MEANS
// UNTOUCHED, which is a different fact from "cleared". `amendedBy` is fixed:
// the UI is always a human at the keyboard, never the dispatcher (that door
// belongs to `report_review`'s verdict path, a different writer entirely).
export interface AmendmentBody {
  amendedBy: 'human';
  scope?: string;
  explicitlyOut?: string[];
  acceptanceCriteria?: ({ id: string; text: string } | { text: string })[];
  killCriterion?: string;
}

// The instance-record fields this file reads, mirrored narrowly and loosely
// (the same posture as taskBoard.ts's `TaskBoardRecord` — every field but
// `instanceId` is `unknown` on purpose, so a hostile or degenerate record never
// throws here; see that interface's own note on why I8 forbids a stricter
// type). This is a SEPARATE mirror from `TaskBoardRecord`, not a widening of
// it: that interface is the CARD's inputs, this one is the AMEND FORM's, and
// they read different slices of the same wire record.
//
// ⚠ S13·U3: THE FOUR AUTHORED FIELDS MOVED UNDER `payload` (q13's split) and
// the rev is spelled `payloadRev`. The engine never reads inside `payload` to
// decide anything; this form reads it because a work order IS tenant content.
export interface AmendableTaskRecord {
  readonly instanceId: string;
  readonly payloadRev?: unknown;
  readonly attachedSessions?: unknown;
  readonly payload?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// The instance's opaque payload as a plain bag, or an empty one when the record
// carries none / carries a non-object. TOTAL (I8): the four reads below are all
// guarded, so an empty bag is indistinguishable from an unauthored work order,
// which is exactly right.
function payloadOf(task: AmendableTaskRecord): Record<string, unknown> {
  const payload = task.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

// A record's own list field, filtered to the strings it actually carries — a
// non-array or a mixed-type array degrades to whatever usable strings it holds
// rather than throwing (I8), mirroring `readTaskCards`'s tolerance elsewhere.
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

// A record's `acceptanceCriteria` (`{ id, text }[]`), read into rows. A
// malformed entry — missing `id` or `text`, or not an object at all — is
// SKIPPED rather than guessed at: a row with an invented id would let the
// amend form silently rewrite a criterion the record never actually carried.
function asCriterionRows(value: unknown): AmendCriterionRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: AmendCriterionRow[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const candidate = raw as { id?: unknown; text?: unknown };
    const id = asString(candidate.id);
    const text = asString(candidate.text);
    if (id === null || text === null) {
      continue;
    }
    rows.push({ id, text });
  }
  return rows;
}

// Prefill the amend form from the record. Absent scope/killCriterion → `''`
// (an untouched prose field renders as an empty box, not as the word
// "undefined"); absent lists → `[]`; criteria carry their REAL ids, which is
// what lets a submitted reword still key back to the record's own criterion.
export function seedAmendFormModel(task: AmendableTaskRecord): AmendFormModel {
  const payload = payloadOf(task);
  return {
    scope: asString(payload.scope) ?? '',
    explicitlyOut: asStringArray(payload.explicitlyOut),
    acceptanceCriteria: asCriterionRows(payload.acceptanceCriteria),
    killCriterion: asString(payload.killCriterion) ?? '',
  };
}

// Trim every row and drop the blanks — the shared list-cleaning step, same
// idiom as workOrderForm.ts's `nonBlankRows`, but returning `[]` rather than
// `null` on an all-blank input: a list field's CLEANED-EMPTY state is a real
// value here (it is what makes a clear-vs-unchanged decision possible below),
// not something to omit before comparison the way the create form omits it.
function cleanedRows(rows: readonly string[]): string[] {
  return rows.map((row) => row.trim()).filter((row) => row !== '');
}

// The criteria-row sibling of `cleanedRows`: trim each row's TEXT and drop the
// ones left blank — a blank row is dropped whether it is a brand-new row
// (`id === null`) or an existing criterion emptied out by an edit, because
// neither can be sent (the wire shape requires non-empty `text`).
function cleanedCriteriaRows(rows: readonly AmendCriterionRow[]): AmendCriterionRow[] {
  return rows
    .map((row) => ({ id: row.id, text: row.text.trim() }))
    .filter((row) => row.text !== '');
}

function stringArraysEqual(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function criteriaRowsEqual(
  first: readonly AmendCriterionRow[],
  second: readonly AmendCriterionRow[],
): boolean {
  return (
    first.length === second.length &&
    first.every((row, index) => row.id === second[index]!.id && row.text === second[index]!.text)
  );
}

// Build the amendment body from what CHANGED between `seed` (the form as it
// was prefilled from the record) and `edited` (the form as the operator left
// it) — the diff builder, the heart of this unit.
//
// Returns `null` when nothing survives the diff: the client-side mirror of the
// payload-revisions route's own `empty-amendment` refusal, so a no-op submit
// never reaches the network at all.
//
// ⚠ PROSE VS LIST, TWO DIFFERENT NOTIONS OF "CLEARED" (the wire's own limit,
// not a choice made here). The event this route writes CANNOT express "clear
// this prose field" — there is no way to distinguish "leave scope alone" from
// "set scope to empty" once both are the same absent key — so a cleaned-empty
// prose field is always read as UNCHANGED and omitted, never sent as `''`. A
// LIST field has no such ambiguity: `[]` on the wire unambiguously means
// "empty this list", so a cleaned-empty list that used to hold something is a
// real, sendable clear.
export function buildAmendmentBody(seed: AmendFormModel, edited: AmendFormModel): AmendmentBody | null {
  const changes: Partial<Omit<AmendmentBody, 'amendedBy'>> = {};

  // ── Prose fields: cleaned-empty is UNCHANGED, never a clear ──────────────
  const cleanedEditedScope = edited.scope.trim();
  if (cleanedEditedScope !== '' && cleanedEditedScope !== seed.scope.trim()) {
    changes.scope = cleanedEditedScope;
  }

  const cleanedEditedKillCriterion = edited.killCriterion.trim();
  if (cleanedEditedKillCriterion !== '' && cleanedEditedKillCriterion !== seed.killCriterion.trim()) {
    changes.killCriterion = cleanedEditedKillCriterion;
  }

  // ── explicitlyOut: cleaned-empty CAN be a real clear ──────────────────────
  const cleanedEditedExplicitlyOut = cleanedRows(edited.explicitlyOut);
  const cleanedSeedExplicitlyOut = cleanedRows(seed.explicitlyOut);
  if (!stringArraysEqual(cleanedEditedExplicitlyOut, cleanedSeedExplicitlyOut)) {
    changes.explicitlyOut = cleanedEditedExplicitlyOut;
  }

  // ── acceptanceCriteria: same clear-vs-unchanged shape as explicitlyOut,
  // plus the id-keying rule — a reworded row keeps its id (same identity, new
  // text), a brand-new row carries none (the writer mints one).
  const cleanedEditedCriteria = cleanedCriteriaRows(edited.acceptanceCriteria);
  const cleanedSeedCriteria = cleanedCriteriaRows(seed.acceptanceCriteria);
  if (!criteriaRowsEqual(cleanedEditedCriteria, cleanedSeedCriteria)) {
    changes.acceptanceCriteria = cleanedEditedCriteria.map((row) =>
      row.id === null ? { text: row.text } : { id: row.id, text: row.text },
    );
  }

  if (Object.keys(changes).length === 0) {
    return null;
  }
  return { amendedBy: 'human', ...changes };
}

// ── The doors themselves ────────────────────────────────────────────────────

export interface CorrectionDoor {
  readonly kind: 'steer' | 'amend';
  readonly title: string;
  readonly detail: string;
}

// The two doors, ALWAYS returned in this order (steer first — it is the
// cheaper, more common correction: same contract, try again). `N` is the
// instance's current `payloadRev`, defaulting to 0 for a record that has never
// been revised (the field is ABSENT until the first revision — the reader
// spells the default, the record does not) or carries a malformed one — the
// same "never throw, never guess a non-zero number" posture as the rest of
// this file.
export function correctionDoors(task: AmendableTaskRecord): readonly CorrectionDoor[] {
  const rev = asNumber(task.payloadRev) ?? 0;
  return [
    {
      kind: 'steer',
      title: 'Steer — same work-order',
      detail: `rev ${rev}, fresh attempt — dispatches now`,
    },
    {
      kind: 'amend',
      title: 'Amend — revise the work-order',
      detail: `writes rev ${rev + 1} — dispatch is a separate step`,
    },
  ];
}

// The doors render only once the task has run at least once — a never-
// dispatched task has nothing to steer or amend against yet, and keeps
// today's plain Dispatch button. `attachedSessions` is the same append-only
// trail `taskBoard.ts`'s `sessionTrailOf` reads; a non-array (never dispatched,
// or a malformed record) reads as "not available" rather than throwing.
export function correctionDoorsAvailable(task: AmendableTaskRecord): boolean {
  return Array.isArray(task.attachedSessions) && task.attachedSessions.length > 0;
}
