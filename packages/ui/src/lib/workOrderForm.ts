// S7·3 — the work-order authoring form's pure core.
//
// The board's create sheet lets a human author the four work-order fields
// (scope, explicitlyOut, acceptanceCriteria, killCriterion). The FIELD LIST is
// not hard-coded here: it is served by the daemon as a descriptor
// (`GET /api/workflows/:e/:w/:r/payload-schema`, S13·U2's q25 introspection)
// and rendered from `store.workOrderSchema`,
// because `@vimes/core` — where the zod that defines the shape lives — is a
// deliberate non-dependency of this package (see lib/types.ts). This file owns
// only the two things that must NOT live in the .vue: the descriptor's narrow
// wire type, and the pure body builder that enforces absent-stays-absent. The
// builder is unit-tested; the .vue that drives it is manual (house rule).

// The served descriptor's shape, mirrored narrowly (the daemon is the source —
// see WorkOrderFieldDescriptor in packages/daemon/src/instanceApi.ts). `kind` drives
// how the sheet renders each field:
//   • longtext      → a <textarea>.
//   • list          → repeatable plain-string rows.
//   • criteria-list → repeatable rows, each ONE criterion's text (the id is
//     minted server-side; the form sends `{ text }` only).
export interface WorkOrderFieldDescriptor {
  key: 'scope' | 'explicitlyOut' | 'acceptanceCriteria' | 'killCriterion';
  kind: 'longtext' | 'list' | 'criteria-list';
  label: string;
  help: string;
  maxLength?: number;
  maxItems?: number;
  itemMaxLength?: number;
}

// The raw form model the sheet binds to — one field per authored work-order
// field. Lists are one string PER ROW (a criterion row is just its text); the
// builder maps a criterion row to the `{ text }` input shape the route expects.
export interface WorkOrderFormModel {
  scope: string;
  explicitlyOut: string[];
  acceptanceCriteria: string[];
  killCriterion: string;
}

// The create-body work-order fragment: every field OPTIONAL, empties OMITTED.
export interface WorkOrderBody {
  scope?: string;
  explicitlyOut?: string[];
  acceptanceCriteria?: { text: string }[];
  killCriterion?: string;
}

// Trim each row, drop the blank ones, and return the survivors (or null when
// none survive) — the shared list-cleaning step for both list kinds.
function nonBlankRows(rows: readonly string[]): string[] | null {
  const trimmed = rows.map((row) => row.trim()).filter((row) => row !== '');
  return trimmed.length === 0 ? null : trimmed;
}

// Build the create-body work-order fragment from the raw form model, with
// ABSENT-STAYS-ABSENT enforced here and nowhere else:
//   • a prose field is trimmed; an empty/whitespace-only value is OMITTED (never
//     sent as `''` — a blank box must not become a task with an empty scope).
//   • a list is trimmed row-by-row; blank rows are dropped; an all-blank (or
//     empty) list is OMITTED rather than sent as `[]`.
//   • criteria rows become `{ text }` — no id, which the writer mints server-side.
// An all-empty form yields `{}`: an unauthored create, byte-identical to today's
// title-only POST.
export function buildWorkOrderBody(formModel: WorkOrderFormModel): WorkOrderBody {
  const body: WorkOrderBody = {};

  const trimmedScope = formModel.scope.trim();
  if (trimmedScope !== '') {
    body.scope = trimmedScope;
  }

  const trimmedKillCriterion = formModel.killCriterion.trim();
  if (trimmedKillCriterion !== '') {
    body.killCriterion = trimmedKillCriterion;
  }

  const explicitlyOutRows = nonBlankRows(formModel.explicitlyOut);
  if (explicitlyOutRows !== null) {
    body.explicitlyOut = explicitlyOutRows;
  }

  const acceptanceCriteriaRows = nonBlankRows(formModel.acceptanceCriteria);
  if (acceptanceCriteriaRows !== null) {
    body.acceptanceCriteria = acceptanceCriteriaRows.map((text) => ({ text }));
  }

  return body;
}
