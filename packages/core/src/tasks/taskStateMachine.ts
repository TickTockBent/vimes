// ─── slice 6 step 1 — the task state machine (PURE, packages/core) ───────────
//
// The deterministic heart of the dispatcher: given a task and a PROPOSED
// transition, decide ACCEPT or REJECT. Agents propose; this decides. That
// separation is what makes **I7** assertable headlessly (no Claude, no network,
// no clock) and what stops slice 7's orchestrator layer from becoming a second
// writer to task state (principle 10).
//
// Rule 0.3: pure. No clock, no randomness, no I/O — the caller supplies
// everything and receives a decision. This module does NOT dispatch, spawn,
// project or persist; it never emits an event either. Its callers do, and a
// rejection MUST be evented (`task_transition_rejected`) — an unrecorded
// rejection is, as far as I7 is concerned, a rejection that never happened.
//
// Rule: **NEVER THROW on a bad proposal.** Rejection is a normal, evented
// outcome, not an exception. `proposeTransition` is TOTAL — every (task,
// proposal) pair, including stages outside the enum, maps to an outcome.

import { z } from 'zod';
import { taskRecordSchema, type TaskRecord } from '../schemas.js';

// ── the stage vocabulary ─────────────────────────────────────────────────────
// DERIVED from `taskRecordSchema` rather than re-typed, so the machine and the
// record can never drift apart. The schema is slice-0 reserved and is NOT
// reshaped here.
export const taskStageSchema = taskRecordSchema.shape.stage;
export type TaskStage = z.infer<typeof taskStageSchema>;

// Every stage, in the schema's own order. Tests enumerate THIS (× itself) to
// build the full cross product, so an added stage automatically enters the
// coverage rather than silently escaping it.
export const TASK_STAGES: readonly TaskStage[] = taskStageSchema.options;

// Where a task starts life. Named here so the projection (step 2) and the
// dispatcher (step 3) agree without re-deciding it.
export const INITIAL_TASK_STAGE: TaskStage = 'backlog';

// ── the transition table — THE DESIGN, encoded as DATA ───────────────────────
// A map from stage → the stages a proposal may move it to. Anything not listed
// is an illegal edge. Deliberately a table and not nested `if`s: it is the
// artifact a reviewer reads and the artifact the tests enumerate, so the rule
// and its coverage cannot drift apart.
//
// Each of these edges encodes a decision:
//
//   • `review → implementing` is THE REVIEW/FIX LOOP (design-directions
//     2026-07-20). A rejected review sends the work BACK to implementing; it
//     does not fail the task. This is why `review` is not a dead end.
//
//   • `done` is TERMINAL — its allowed set is empty, and that is intentional.
//     Reopening finished work MINTS A NEW TASK rather than resurrecting a
//     completed one, so the audit trail stays honest (the same spirit as
//     append-only corrections). A proposal out of `done` rejects `terminal-stage`.
//
//   • `quarantined → done` is DELIBERATELY ABSENT. A run the watchdog
//     quarantined must never silently pass; it goes back through work
//     (`planning` / `implementing`), back to the `backlog`, or is explicitly
//     parked (`blocked-external`). That edge gets its OWN refusal reason
//     (`quarantined-cannot-complete`) rather than a generic one — see the
//     precedence note on `proposeTransition`.
//
//   • `blocked-external` is a PARK, and unblocking names the stage to resume
//     into. It is permissive by design because the blocking cause lives outside
//     our model, so we cannot know which stage the task should re-enter. It does
//     NOT reach `done`: leaving a park still goes through the work stages.
export const TASK_STAGE_EDGES: ReadonlyMap<TaskStage, ReadonlySet<TaskStage>> = new Map<
  TaskStage,
  ReadonlySet<TaskStage>
>([
  ['backlog', new Set<TaskStage>(['planning', 'blocked-external'])],
  ['planning', new Set<TaskStage>(['plan-ready', 'blocked-external', 'quarantined', 'backlog'])],
  ['plan-ready', new Set<TaskStage>(['implementing', 'planning', 'blocked-external', 'backlog'])],
  ['implementing', new Set<TaskStage>(['review', 'blocked-external', 'quarantined'])],
  ['review', new Set<TaskStage>(['done', 'implementing', 'blocked-external', 'quarantined'])],
  [
    'blocked-external',
    new Set<TaskStage>(['backlog', 'planning', 'plan-ready', 'implementing', 'review']),
  ],
  ['quarantined', new Set<TaskStage>(['backlog', 'planning', 'implementing', 'blocked-external'])],
  ['done', new Set<TaskStage>()],
]);

// Is `toStage` a listed edge out of `fromStage`? Pure table lookup — this is the
// GENERIC check, and the named refusals deliberately run BEFORE it.
export function isLegalTaskEdge(fromStage: TaskStage, toStage: TaskStage): boolean {
  return TASK_STAGE_EDGES.get(fromStage)?.has(toStage) ?? false;
}

// ── the proposal, the refusals, the outcome ──────────────────────────────────

// Who is proposing. `dispatcher` is the deterministic mover; `orchestrator` is
// the agent-facing surface slice 7 exposes; `human` is Wes at the board. All
// three PROPOSE — none of them transitions anything itself (principle 10).
// Deliberately WIDER than `taskRecordSchema.createdBy` ('human' | 'orchestrator'):
// a task is never *created* by the dispatcher, but it is very often *moved* by it.
export const transitionProposedBySchema = z.enum(['human', 'orchestrator', 'dispatcher']);
export type TransitionProposedBy = z.infer<typeof transitionProposedBySchema>;

// The enumerated refusals. Defined as a zod enum so the `task_transition_rejected`
// event payload validates against the SAME vocabulary the machine returns — one
// source of record per fact (principle 9).
export const transitionRejectionReasonSchema = z.enum([
  // The proposed edge is simply not in the table.
  'illegal-edge',
  // Proposing OUT of `done`. Reopening mints a new task instead.
  'terminal-stage',
  // A no-op: the task is already in the proposed stage.
  'same-stage',
  // The named refusal: a quarantined run may not complete.
  'quarantined-cannot-complete',
  // Defensive: a stage value outside the schema enum reached us (a malformed
  // proposal, or a task record from somewhere it should not have come from).
  // Slice 7 hardens I7 against hostile input; this reason is the landing pad.
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

export type TransitionOutcome =
  | { readonly accepted: true; readonly nextTask: TaskRecord }
  | { readonly accepted: false; readonly reason: TransitionRejectionReason };

// The flag rule, in ONE place so the machine and its event payload agree: only
// an accepted transition INTO `done` may set it. Everywhere else the proposal's
// flag is IGNORED and the task's existing value rides through unchanged — the
// machine never *sets* the flag off the completion edge.
function nextManualReviewRequired(task: TaskRecord, proposal: TransitionProposal): boolean {
  if (proposal.toStage !== 'done') {
    return task.manualReviewRequired;
  }
  return proposal.manualReviewRequired === true;
}

function isKnownStage(candidateStage: string): candidateStage is TaskStage {
  return TASK_STAGE_EDGES.has(candidateStage as TaskStage);
}

/**
 * Decide a single proposed task transition. TOTAL and PURE: every input maps to
 * an outcome, nothing throws, nothing is mutated, and the same inputs always
 * produce the same output.
 *
 * REFUSAL PRECEDENCE (the order matters, and each step is load-bearing):
 *
 *   1. `unknown-stage` — a stage outside the schema enum, on either end. Checked
 *      first because every rule below assumes a known vocabulary.
 *   2. `same-stage` — a no-op proposal; nothing is being asked for.
 *      TIE-BREAK: `done → done` is BOTH a no-op and a proposal touching a
 *      terminal stage. It resolves as `same-stage`, because nothing was proposed
 *      to *leave* `done`. `done → any OTHER stage` is `terminal-stage`.
 *   3. `terminal-stage` — proposing out of `done`.
 *   4. `quarantined-cannot-complete` — the named refusal for `quarantined → done`.
 *      MUST run BEFORE the generic table lookup: otherwise the safety rule that
 *      keeps a quarantined run from silently passing would report as a bland
 *      `illegal-edge`, indistinguishable from a typo.
 *   5. `illegal-edge` — the generic table lookup.
 *
 * On ACCEPT the returned `nextTask` is a NEW object; the input is never mutated.
 */
export function proposeTransition(
  task: TaskRecord,
  proposal: TransitionProposal,
): TransitionOutcome {
  // Widened to `string` on purpose: the defensive check below is only meaningful
  // if a value outside the enum can physically reach it (callers cross an API
  // boundary; TypeScript's guarantee stops there).
  const fromStage: string = task.stage;
  const toStage: string = proposal.toStage;

  // 1. defensive — a stage outside the enum on either end.
  if (!isKnownStage(fromStage) || !isKnownStage(toStage)) {
    return { accepted: false, reason: 'unknown-stage' };
  }

  // 2. no-op (and the documented `done → done` tie-break).
  if (fromStage === toStage) {
    return { accepted: false, reason: 'same-stage' };
  }

  // 3. `done` is terminal — reopening mints a new task.
  if (fromStage === 'done') {
    return { accepted: false, reason: 'terminal-stage' };
  }

  // 4. the named safety refusal, BEFORE the generic edge check.
  if (fromStage === 'quarantined' && toStage === 'done') {
    return { accepted: false, reason: 'quarantined-cannot-complete' };
  }

  // 5. the table.
  if (!isLegalTaskEdge(fromStage, toStage)) {
    return { accepted: false, reason: 'illegal-edge' };
  }

  const nextTask: TaskRecord = {
    ...task,
    stage: toStage,
    manualReviewRequired: nextManualReviewRequired(task, proposal),
  };
  return { accepted: true, nextTask };
}
