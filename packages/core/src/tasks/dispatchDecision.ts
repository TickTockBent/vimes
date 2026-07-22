// ─── slice 6 step 3 — the dispatcher DECISION function (PURE, packages/core) ──
//
// Given a task, the meters as currently projected, an injected clock and the
// caller's liveness knowledge, decide whether to **spawn** a stage run, **defer**
// it, or **refuse** it. Nothing here spawns, events, or touches I/O: the daemon
// (step 4) executes the returned decision and writes the `dispatch_refused`
// record. That separation is what makes **I10** assertable headlessly — no
// Claude, no network, no clock.
//
// **I10 lands here.** Slice 5 deliberately shipped only the readable half: the
// meters read model and the pure `evaluateHeadroomGate`. This module is the half
// that can REFUSE — "the dispatcher never spawns when a task's `requireHeadroom`
// gate fails against current meters."
//
// Rule 0.3: pure. `nowIso` and `staleAfterMs` are PARAMETERS — this module never
// reads a clock, never randomizes, and never mutates its input. Same inputs,
// same decision, forever.
//
// Rule: **NEVER THROW.** Like `proposeTransition` (step 1), `decideDispatch` is
// TOTAL — every input, including a stage outside the schema enum, maps to a
// decision. A dispatcher that throws is a dispatcher that has silently stopped.
//
// SCOPE NOTE — quarantine is NOT here. It is the watchdog's outcome, driven by
// heartbeat staleness (step 5, after the ⟨tune⟩s are signed off). This function
// decides `spawn | defer | refuse` only.

import { z } from 'zod';
import { evaluateHeadroomGate, type HeadroomGateResult } from '../meterDerivations.js';
import type { MetersState } from '../projections/meters.js';
import type { TaskRecord } from '../schemas.js';
import { TASK_STAGES, type TaskStage } from './taskStateMachine.js';

// ── which stages actually run a worker ───────────────────────────────────────
// Exported as DATA (the same discipline as `TASK_STAGE_EDGES`): it is the
// artifact a reviewer reads and the artifact the tests enumerate, and its
// COMPLEMENT against `TASK_STAGES` is derived rather than transcribed, so the
// partition cannot drift when a stage is added.
//
// Each membership is a decision:
//   • `planning`, `implementing`, `review` run a worker — these dispatch.
//   • `backlog` is a QUEUE; entering work is a transition (step 1), not a spawn.
//   • `plan-ready` awaits a PROMOTION DECISION — a human or the orchestrator
//     moves it on; the dispatcher must not front-run that.
//   • `done` is terminal, `blocked-external` is a park, and `quarantined` is the
//     watchdog's verdict. Spawning into any of the three would resurrect work
//     that something deliberately stopped.
export const DISPATCHABLE_TASK_STAGES: ReadonlySet<TaskStage> = new Set<TaskStage>([
  'planning',
  'implementing',
  'review',
]);

// The complement, derived — never hand-listed. Exported so callers and tests
// share one partition rather than two that can disagree (principle 9).
export const NON_DISPATCHABLE_TASK_STAGES: readonly TaskStage[] = TASK_STAGES.filter(
  (stage) => !DISPATCHABLE_TASK_STAGES.has(stage),
);

// Widened to `string` deliberately: the check is only meaningful if a value
// outside the enum can physically reach it (callers cross an API boundary;
// TypeScript's guarantee stops there). An unknown stage is NOT dispatchable —
// the fail-closed direction, and it needs no reason of its own because
// "we do not run workers for stages we do not recognize" is the same fact.
export function isDispatchableStage(candidateStage: string): boolean {
  return DISPATCHABLE_TASK_STAGES.has(candidateStage as TaskStage);
}

// ── the decision vocabulary ──────────────────────────────────────────────────
// Zod enums rather than bare unions, mirroring `transitionRejectionReasonSchema`
// (step 1): the reason a refusal carries is the same vocabulary the
// `dispatch_refused` payload records, so one source of record per fact
// (principle 9) — and tests can ENUMERATE the reasons instead of sampling them.

export const dispatchRefuseReasonSchema = z.enum([
  // The task is not in a stage that runs a worker (see the partition above).
  'stage-not-dispatchable',
  // A run is already live for this task. Mirrors I11's spirit — a resume against
  // a live run is refused BEFORE any process spawns; we never double-spawn.
  'already-running',
  // `requireHeadroom` was evaluated and the meter says there is not enough room.
  'headroom-insufficient',
  // `requireHeadroom` could not be evaluated: the meter was never observed, its
  // observation has gone stale, or it carries no percentage. See the pillar-4
  // note on `decideDispatch` — this is NOT a synonym for 'headroom-insufficient'.
  'headroom-unknown',
]);
export type DispatchRefuseReason = z.infer<typeof dispatchRefuseReasonSchema>;

export const dispatchDeferReasonSchema = z.enum([
  // The gated meter's window has not rolled over yet; `resetsAt` is still ahead.
  'awaiting-meter-reset',
  // We cannot see WHEN it rolls over (meter never observed, or no `resetsAt`).
  // A schedule question, not an unmet requirement — see the contrast below.
  'reset-time-unknown',
]);
export type DispatchDeferReason = z.infer<typeof dispatchDeferReasonSchema>;

export interface DispatchInput {
  readonly task: TaskRecord;
  // The meters read model (slice 5 step 1) as currently projected.
  readonly meters: MetersState;
  // INJECTED clock (rule 0.3). This module never reads one.
  readonly nowIso: string;
  // REQUIRED, no default. The staleness window is a ⟨tune⟩ band and rule 0.2
  // forbids pinning one here as a silent default — the caller names it.
  readonly staleAfterMs: number;
  // Caller-supplied liveness knowledge: is a stage run already live for this
  // task? The dispatcher does not go looking — liveness is the daemon's fact
  // (and the UI reads the SAME one; there is no second definition of "alive").
  readonly hasLiveRun: boolean;
}

export type DispatchDecision =
  | {
      readonly action: 'spawn';
      readonly stage: TaskStage;
      // Carried THROUGH from the record, never re-defaulted here. D32 pinned
      // `worktree` as the default, but defaulting is the task-creation step's
      // job; a second defaulter is a second writer of the same fact.
      readonly isolation: TaskRecord['isolation'];
    }
  | {
      readonly action: 'defer';
      readonly reason: DispatchDeferReason;
      // Which meter we are waiting on — so a deferral can explain itself.
      readonly meterId: string;
    }
  | {
      readonly action: 'refuse';
      readonly reason: DispatchRefuseReason;
      // The evaluator's full result, present exactly on the headroom refusals,
      // so the refusal can say WHAT it saw (verdict, reason, headroom, freshness)
      // rather than only that it said no.
      readonly gate?: HeadroomGateResult;
    };

// Parse an ISO timestamp to epoch milliseconds, or null when it is absent or
// unparseable. `Date.parse` is a pure string→number function (no clock read), so
// it is permitted under rule 0.3.
//
// A private copy of `meterDerivations.ts`'s helper of the same shape: that module
// keeps its own private (slice-5 frozen surface, not re-exported), and this step
// is explicitly forbidden from reshaping it. Both are three lines of the same
// total function over the same input domain, so there is no behavior to diverge —
// if a third copy ever wants to exist, promote it instead of adding one.
function parseIsoToEpochMs(isoTimestamp: string | null | undefined): number | null {
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return null;
  }
  const epochMilliseconds = Date.parse(isoTimestamp);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : null;
}

/**
 * Decide a single task's dispatch. TOTAL and PURE: every input maps to a
 * decision, nothing throws, nothing is mutated, and the same inputs always
 * produce the same decision.
 *
 * CHECK ORDER (load-bearing — the FIRST matching check wins, exactly as step 1's
 * refusal precedence works). Each step answers a question the ones below it
 * assume has already been answered:
 *
 *   1. `stage-not-dispatchable` — is this even a stage that runs a worker?
 *      Checked first because every check below is about WHETHER TO RUN A WORKER
 *      NOW, which is a question that only exists once the stage could run one.
 *      A `done` task with a failing meter gate is not "out of headroom"; it is
 *      finished, and reporting the meter would be a lie about why nothing ran.
 *   2. `already-running` — a run is live. Beats the gates because gate checks
 *      are about admitting NEW work; a live run is already admitted, and
 *      double-spawning it is a correctness failure no meter reading changes.
 *   3. `deferUntilReset` — DEFER while the named meter's window has not rolled.
 *   4. `requireHeadroom` — the I10 gate. Runs LAST of the checks so that a
 *      refusal naming headroom means headroom really was the binding reason.
 *   5. otherwise → `spawn`.
 *
 * ⚠ THE PILLAR-4 JUDGEMENT, stated where it is implemented: an **`unknown`**
 * headroom verdict **REFUSES**. It does not pass, and it does not share a reason
 * with `fail`. A task carrying `requireHeadroom` has explicitly said "only run
 * when there is headroom"; if the meter was never observed, has gone stale, or
 * reports no percent, we CANNOT CONFIRM the requirement is met, and spawning
 * anyway would be acting on a number we do not have — the lying-meter failure
 * pillar 4 forbids. The blast radius is opt-in: a task with no `requireHeadroom`
 * gate is unaffected, so a dead usage endpoint cannot halt ungated work. And it
 * gets its OWN reason (`headroom-unknown`) so a refusal never misreports "you are
 * out of headroom" when the truth is "we cannot see headroom."
 *
 * CONTRAST WITH DEFER (deliberate): an unknown RESET TIME **defers** rather than
 * refusing. "When does this window roll over?" is a SCHEDULE question that
 * resolves by itself the moment the meter is next observed — nothing about the
 * task has failed, so the work is postponed, not turned away. An unknown
 * HEADROOM is an unmet REQUIREMENT: the task named a condition, and we cannot
 * establish it. Postponement and refusal are different facts about different
 * questions, and collapsing them would either hide a stalled requirement behind
 * a retry loop or turn a five-minute wait into a refusal a human must clear.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  const { task, meters, nowIso, staleAfterMs, hasLiveRun } = input;

  // 1. Is this a stage that runs a worker? Fail-closed: anything not in the
  //    exported dispatchable set — including a stage outside the schema enum —
  //    refuses here.
  if (!isDispatchableStage(task.stage)) {
    return { action: 'refuse', reason: 'stage-not-dispatchable' };
  }

  // 2. Never double-spawn a stage.
  if (hasLiveRun) {
    return { action: 'refuse', reason: 'already-running' };
  }

  // 3. `deferUntilReset` names a METER whose window we are waiting on.
  const deferUntilResetMeterId = task.gates.deferUntilReset;
  if (deferUntilResetMeterId !== undefined) {
    const gatedMeter = meters.meters[deferUntilResetMeterId];
    const resetsAtMs = parseIsoToEpochMs(gatedMeter?.resetsAt);
    const nowMs = parseIsoToEpochMs(nowIso);
    if (resetsAtMs === null || nowMs === null) {
      // The meter was never observed, carries no `resetsAt`, or the timestamps
      // are unreadable: we do not know when the window rolls. UNKNOWN never
      // collapses into "it already reset" — that would spawn on a schedule we
      // cannot see. It defers instead (see the contrast above).
      return {
        action: 'defer',
        reason: 'reset-time-unknown',
        meterId: deferUntilResetMeterId,
      };
    }
    if (resetsAtMs > nowMs) {
      return {
        action: 'defer',
        reason: 'awaiting-meter-reset',
        meterId: deferUntilResetMeterId,
      };
    }
    // The window has rolled (`resetsAt` at or before now): this gate is
    // SATISFIED and the decision falls through to the checks below. A satisfied
    // defer gate is not an approval — the headroom gate still gets its say.
  }

  // 4. `requireHeadroom` — I10. This is the ONLY branch that can hold back a
  //    spawn on a meter reading, and it hands `evaluateHeadroomGate` (slice 5)
  //    the verdict; nothing here re-derives headroom or freshness.
  const requireHeadroomGate = task.gates.requireHeadroom;
  if (requireHeadroomGate !== undefined) {
    const gateResult = evaluateHeadroomGate(requireHeadroomGate, meters, nowIso, staleAfterMs);
    if (gateResult.verdict === 'fail') {
      return { action: 'refuse', reason: 'headroom-insufficient', gate: gateResult };
    }
    if (gateResult.verdict !== 'pass') {
      // 'unknown' — and any future verdict that is not an explicit pass. Written
      // as "not pass" rather than "=== 'unknown'" ON PURPOSE: the fail-closed
      // direction must be the DEFAULT, so a verdict added later cannot fall
      // through into a spawn by being unhandled.
      return { action: 'refuse', reason: 'headroom-unknown', gate: gateResult };
    }
  }

  // 5. Every gate cleared. This is the ONE `spawn` return in the module, and it
  //    is reachable only past an explicit `verdict === 'pass'` (or no headroom
  //    gate at all) — the structural half of I10.
  return { action: 'spawn', stage: task.stage, isolation: task.isolation };
}
