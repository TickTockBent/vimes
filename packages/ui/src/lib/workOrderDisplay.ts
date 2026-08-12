// S8·6b — the work-order INSPECTION surface's pure core.
//
// The gap this closes (observed live 2026-08-04, mid-Gate-2-trial): clicking a
// task on the board showed title + id + stage only. The work order — scope,
// explicitly-out, acceptance criteria, kill criterion — was invisible
// read-only. The ONLY surface that rendered those fields was the amend door
// (TaskBoardView.vue's `correctionTaskRecord` / `seedAmendFormModel`), and an
// inspection surface that is secretly an edit form is not one — the Gate-2
// trial requires Wes to GRADE authored work orders from the board.
//
// This module owns the read-only derivation ONLY (house rule: logic lives in
// lib/*.ts with tests, the .vue that renders it is manual). It reads the SAME
// wire fields `correctionDoors.ts`'s `AmendableTaskRecord` / `seedAmendFormModel`
// read — a second narrow VIEW of the identical wire object, not a second
// authority — but seeds nothing and edits nothing: this is display, not a form.
//
// @vimes/core is deliberately NOT a dependency of this package (lib/types.ts's
// header) — the wire shapes below mirror
// packages/core/src/projections/instances.ts narrowly.

// One acceptance-criterion row as rendered: text AND id. The id is the stable
// identity verdicts key against, and it renders small/dim rather than hidden —
// seeing it matters when reading a review later (per-criterion verdict display
// is later work, but the id it will key against is legible from day one).
export interface WorkOrderDisplayCriterion {
  readonly id: string;
  readonly text: string;
}

// The display model. Every field is independently absent-able — a record can
// carry a scope but no criteria, criteria but no kill criterion, and so on —
// which is why this is four independent optionals rather than one
// all-or-nothing shape.
export interface WorkOrderDisplay {
  // null → the view renders an em-dash line, never a fabricated empty string.
  readonly scope: string | null;
  // null → the view OMITS the "Explicitly out" section entirely (never an
  // empty list with nothing under its heading — that would be a fabricated
  // empty, the exact thing this derivation exists to avoid).
  readonly explicitlyOut: readonly string[] | null;
  // null → the view omits "Acceptance criteria" entirely, same posture as
  // `explicitlyOut`.
  readonly acceptanceCriteria: readonly WorkOrderDisplayCriterion[] | null;
  // null → the view renders an em-dash line, same posture as `scope`.
  readonly killCriterion: string | null;
  // null → the instance has never been revised (the field is ABSENT until the
  // first revision) or carries a malformed one. The view defaults this to 0 for
  // display (matching `correctionDoors.ts`'s `correctionDoors` rev default),
  // which is why this stays `null` here rather than pre-defaulting: the view's
  // default is a PRESENTATION choice, not a fact this derivation should bake in.
  readonly payloadRev: number | null;
}

// The wire record's fields this module reads, mirrored narrowly and loosely —
// every field is `unknown` on purpose (I8: a hostile or degenerate record must
// never throw here). Deliberately does NOT carry `createdBy`: the provenance
// half of the footer this unit renders REUSES `taskBoard.ts`'s
// `authoredByOrchestrator` (already derived, already tested there) rather than
// re-deriving it a third time — see TaskBoardView.vue's `workOrderDisplay`
// computed for where the two facts (this model's `payloadRev` + the card's
// `authoredByOrchestrator`) are combined into the one footer line.
//
// ⚠ S13·U3: the four authored fields live under `payload` (q13's split) and the
// rev is spelled `payloadRev` — the same move `correctionDoors.ts` made, on the
// same wire object.
export interface WorkOrderDisplayRecord {
  readonly payload?: unknown;
  readonly payloadRev?: unknown;
}

// A string field that is present AND has real content once whitespace is
// stripped. Returns the ORIGINAL (untrimmed) value — the view renders these
// `whitespace-pre-wrap`, so the authored formatting (line breaks, indentation)
// is exactly what should reach the screen, not a trimmed copy of it.
function asAuthoredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

// The instance's opaque payload as a plain bag, or an empty one when the record
// carries none / carries a non-object. TOTAL (I8) — every read off it below is
// guarded, so an empty bag reads exactly like an unauthored work order.
function payloadOf(record: WorkOrderDisplayRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

// A record's list field, filtered to the strings it actually carries — a
// non-array or a mixed-type array degrades to whatever usable strings it holds
// rather than throwing (I8, same tolerance as `correctionDoors.ts`'s
// `asStringArray`). An empty result (absent key, non-array, or an array that
// survives filtering down to nothing) is `null` — "absent list as omitted",
// never a fabricated empty section.
function asDisplayStringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length === 0 ? null : strings;
}

// A record's `acceptanceCriteria` (`{ id, text }[]`), read into display rows.
// A malformed entry — missing `id` or `text`, wrong type, or not an object at
// all — is SKIPPED rather than guessed at (mirrors `correctionDoors.ts`'s
// `asCriterionRows`: a row with an invented id would misrepresent what the
// record actually carries). An empty result is `null`, same "omitted, not
// fabricated" posture as `asDisplayStringList`.
function asDisplayCriterionList(value: unknown): readonly WorkOrderDisplayCriterion[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: WorkOrderDisplayCriterion[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const candidate = raw as { id?: unknown; text?: unknown };
    const id = typeof candidate.id === 'string' ? candidate.id : null;
    const text = typeof candidate.text === 'string' ? candidate.text : null;
    if (id === null || text === null) {
      continue;
    }
    rows.push({ id, text });
  }
  return rows.length === 0 ? null : rows;
}

/**
 * The work-order display model for one task record, or `null` when the task
 * has no authored work order at all.
 *
 * ⚠ `null` MEANS "an unauthored task" — the card then shows one honest line
 * ("No work-order authored.") rather than an empty section skeleton. The
 * check is over the four CONTENT fields only (`payload.scope`,
 * `payload.explicitlyOut`, `payload.acceptanceCriteria`,
 * `payload.killCriterion`); `payloadRev` deliberately does NOT participate.
 * `payloadRev` is metadata about a work order, not a work order in itself — a
 * record predating slice 7 carries neither; a record with a rev but genuinely
 * no content is not a shape the writers produce (a rev only bumps alongside a
 * real content change, see `instanceWriter.ts`) — and treating a bare rev as
 * "authored" would be a guess this module exists not to make.
 *
 * TOTAL over its input: no shape of `record` throws.
 */
export function deriveWorkOrderDisplay(record: WorkOrderDisplayRecord): WorkOrderDisplay | null {
  const payload = payloadOf(record);
  const scope = asAuthoredString(payload.scope);
  const killCriterion = asAuthoredString(payload.killCriterion);
  const explicitlyOut = asDisplayStringList(payload.explicitlyOut);
  const acceptanceCriteria = asDisplayCriterionList(payload.acceptanceCriteria);

  if (scope === null && killCriterion === null && explicitlyOut === null && acceptanceCriteria === null) {
    return null;
  }

  return {
    scope,
    explicitlyOut,
    acceptanceCriteria,
    killCriterion,
    payloadRev: asNumber(record.payloadRev),
  };
}
