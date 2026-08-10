// ─── THE TRANSITIONAL VOCABULARY MODULE (PURE, packages/core) ────────────────
//
// What lives here is the TASK TENANT'S OWN WORDS and nothing else: its stages,
// the classes of thing that may propose a move, the enumerated refusal reasons
// its rejection event carries, and the one rule that says what an accepted move
// RECORDS (the node write plus the convergence flag).
//
// ⚠ **THE LEGALITY TABLE IS NO LONGER HERE.** D72 Move 3 (S12, 2026-08-10)
// moved it OUT of compiled engine data and INTO the `vimes-tasks` extension's
// declaration, where it is TOML a reviewer reads. Authority now runs:
//
//   the declaration (`extensions/vimes-tasks/vimes-extension.toml`)
//     → parsed by `extensions/manifest.ts` into a `ParsedWorkflow`
//     → adjudicated by `extensions/proposeMove.ts` (tenant-blind, decision-only)
//     → written by the daemon's instance writer, which resolves the workflow
//       once at boot and serves it to the UI over `GET /api/tasks/stage-edges`.
//
// Nothing in this file decides legality any more, and nothing may re-acquire
// that job: a second table would be a second authority, which is the exact
// drift D72 exists to end.
//
// ⚠ **THIS MODULE IS TRANSITIONAL, AND ITS TWO RETIREMENTS ARE ALREADY NAMED.**
//
//   • The convergence-flag rule (`nextTaskForAcceptedTransition` and its
//     private helper) retires with the **BOUNDED-LOOP ACTIVATION** move, when
//     declared `max_traversals`/`on_exhausted` routing to the `manual-review`
//     node replaces the flag. That is behaviour-shaping and earns its own
//     D-record (slice-12 F1); it did NOT retire with Move 3.
//   • The module's re-home — these tenant words out of `packages/core` entirely
//     — rides the **DE-TENANTING** move (slice-12 F5).
//
// Rule 0.3: pure. No clock, no randomness, no I/O. This module does not
// dispatch, spawn, project or persist, and it never emits an event.

import { z } from 'zod';
import { taskStageSchema, type TaskRecord, type TaskStage } from '../schemas.js';

// ── the stage vocabulary ─────────────────────────────────────────────────────
// ONE SOURCE OF RECORD, still — but it now lives in `schemas.ts` and is consumed
// BY `taskRecordSchema` rather than derived FROM it. S7·7b flipped that direction
// (D52 finding 1): the record gained `lastReview`/`lastCompletion`, whose types
// are the report payloads, which are themselves keyed by stage — so deriving the
// stage back out of the record closed a cycle. The full reasoning lives beside
// the declaration in `schemas.ts`.
//
// ⚠ RE-EXPORTED FROM HERE ON PURPOSE. Every pre-S7·7b consumer imports
// `taskStageSchema`/`TaskStage` from this module (events.ts, tasks/workOrder.ts,
// the package index, the tests), and the hoist is deliberately invisible to them.
export { taskStageSchema };
export type { TaskStage };

// Every stage, in the schema's own order.
//
// ⚠ THE ORDER IS WIRE-LOAD-BEARING. S12·U2 derives the `stage-edges` route's
// key order from this vocabulary, and that response is a contract the deployed
// UI parses. Re-ordering the enum in `schemas.ts` is a wire change, not a
// cosmetic one.
export const TASK_STAGES: readonly TaskStage[] = taskStageSchema.options;

// ── the proposal, the refusals ───────────────────────────────────────────────

// Who is proposing. `dispatcher` is the deterministic mover; `orchestrator` is
// the agent-facing surface slice 7 exposes; `human` is Wes at the board. All
// three PROPOSE — none of them transitions anything itself (principle 10).
// Deliberately WIDER than `taskRecordSchema.createdBy` ('human' | 'orchestrator'):
// a task is never *created* by the dispatcher, but it is very often *moved* by it.
export const transitionProposedBySchema = z.enum(['human', 'orchestrator', 'dispatcher']);
export type TransitionProposedBy = z.infer<typeof transitionProposedBySchema>;

// The enumerated refusals. Defined as a zod enum so the `task_transition_rejected`
// event payload validates against the SAME vocabulary the adjudicator returns —
// one source of record per fact (principle 9). The adjudicator lives in
// `extensions/proposeMove.ts` and returns these same strings; the
// `quarantined-cannot-complete` one now arrives as DECLARED DATA off the
// workflow's `forbidden` row rather than out of an engine branch.
export const transitionRejectionReasonSchema = z.enum([
  // The proposed edge is simply not declared.
  'illegal-edge',
  // Proposing OUT of a terminal node. Reopening mints a new task instead.
  'terminal-stage',
  // A no-op: the task is already in the proposed stage.
  'same-stage',
  // The named refusal: a quarantined run may not complete.
  'quarantined-cannot-complete',
  // Defensive: a stage value outside the declared vocabulary reached us (a
  // malformed proposal, or a task record from somewhere it should not have come
  // from). Slice 7 hardens I7 against hostile input; this reason is the landing pad.
  'unknown-stage',
]);
export type TransitionRejectionReason = z.infer<typeof transitionRejectionReasonSchema>;

export interface TransitionProposal {
  readonly toStage: TaskStage;
  // THE CONVERGENCE EXIT. `manualReviewRequired` is a FLAG carried on the
  // transition INTO `done`, not a separate stage: when auto-review rework stops
  // converging, the task completes as `done` + `manualReviewRequired: true` —
  // handed off explicitly rather than silently passed. It is MEANINGLESS on any
  // other target and is ignored there (see `nextManualReviewRequired`).
  readonly manualReviewRequired?: boolean;
  readonly proposedBy: TransitionProposedBy;
  readonly note?: string;
}

// The flag rule, in ONE place so the recorded move and its event payload agree:
// only an accepted transition INTO `done` may set it. Everywhere else the
// proposal's flag is IGNORED and the task's existing value rides through
// unchanged — nothing ever *sets* the flag off the completion edge.
function nextManualReviewRequired(task: TaskRecord, proposal: TransitionProposal): boolean {
  if (proposal.toStage !== 'done') {
    return task.manualReviewRequired;
  }
  return proposal.manualReviewRequired === true;
}

/**
 * The RECORD an accepted move produces: the new node written, and the
 * convergence flag decided by the rule above. ONE source states it — the daemon
 * writer calls this, because the declaration-reading adjudicator returns a
 * DECISION ONLY (slice-12 F5). Two places computing a next record would be two
 * authorities over what an accepted move means.
 *
 * ⚠ **F5/F1 FENCE — THIS BELONGS BESIDE THE TENANT VOCABULARY, NOT IN THE
 * ADJUDICATOR.** `nextManualReviewRequired` hardcodes `done`, a tenant's word
 * the declaration-reading adjudicator must not contain (principle #16, and the
 * grep that asserts it). So the node write and the convergence-flag rule stay
 * HERE until the BOUNDED-LOOP ACTIVATION move retires the flag into declared
 * `max_traversals`/`on_exhausted` routing (slice-12 F1; the S11 fence entry
 * that pointed the flag at Move 3 is amended, not silently edited).
 *
 * PURE: a NEW object, the input never mutated.
 */
export function nextTaskForAcceptedTransition(
  task: TaskRecord,
  proposal: TransitionProposal,
): TaskRecord {
  return {
    ...task,
    stage: proposal.toStage,
    manualReviewRequired: nextManualReviewRequired(task, proposal),
  };
}
