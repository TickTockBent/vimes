// ─── slice 6 step 7 — WHO RUNS THE STAGE (PURE, packages/core) ───────────────
//
// `decideDispatch` (step 3) answers **whether** a stage run happens. This module
// answers the next question and only that one: **which session runs it.**
//
// TWO QUESTIONS, TWO FUNCTIONS, ON PURPOSE. Folding "who runs it" into
// `decideDispatch` would put that judgement inside the function that carries I10,
// and I10 would stop being assertable on its own. Nothing in this file may ever
// decide whether to dispatch, and nothing in `dispatchDecision.ts` may ever decide
// who runs it.
//
// ── D46 (2026-07-25) — THE ANSWER IS NOW ALWAYS "A FRESH ONE" ────────────────
//
// **This module used to have two rules and now has one.** Until D46 it read the
// task's `sessionRefs` and, for an `implementing` stage that already had an
// author, returned `{ mode: 'resume', appSessionId }` — the fix loop went back to
// the hot, cache-warm session that wrote the work. That was a deliberate design
// (docs/design-directions.md, "The dispatcher's review/fix loop + cache
// economics", Wes 2026-07-20: *"Fixes of orchestrator-found flaws go to the
// original hot-cache worker (cheap + context-rich)"*), and **D46 reversed it.**
//
// The two independent arguments, recorded here because this is the file where
// somebody will one day try to put the optimisation back:
//
//   1. **Identity.** A resumed author makes ONE TRANSCRIPT STRADDLE TWO ATTEMPTS,
//      which muddies per-attempt usage attribution, replay (I6), and the "are
//      attempts improving?" comparison, all at once. The
//      `(taskId, stage, attempt, workOrderRev)` key stays honest only if a session
//      never spans attempts.
//   2. **Anchoring** (survives even if you reject #1). An author resumed with its
//      own review feedback is STRUCTURALLY INVITED TO DEFEND ITS ORIGINAL
//      APPROACH — it is marinating in its own rationale. A fresh implementer
//      reading work-order + diff + feedback COLD judges the fix against the
//      contract. Review-stage independence and fix-stage freshness are the same
//      principle; the old rule 1 (review always spawns) was always half of this
//      rule, and D46 simply made it whole.
//
// ⚠ **THE COST IS REAL AND WAS ACCEPTED, NOT OVERLOOKED.** A warm resumed author
// re-reads its context at cache-read rates inside the 1h TTL; a fresh implementer
// pays cold prefix + re-reads, so a fix cycle is genuinely MORE EXPENSIVE now.
// D46's standing call is *"revisit if fix-cycle cost proves material"* — and clean
// attempt identity is exactly what makes that a queryable number. If you are here
// to reinstate the resume, that revisit is a DECISION RECORD, not an edit.
//
// ⚠ **SCOPE.** D46 rider 2: this governs STAGE RUNS ONLY. Interactive free
// sessions keep `resume` untouched — `SessionHost.resumeSession` is alive and is
// the human's own door. What died is the DISPATCHER's use of it.
//
// What replaced the resume is not nothing: the context a fix used to inherit by
// being the same session is now handed to the fresh session explicitly — the prior
// attempt's diff is read off disk (D53's rider), and the review feedback + the
// prior attempt's worklog ride in the briefing as the FIX-SEED (see
// `stageInstruction.ts`). That seed is the resume's replacement, and it is why
// removing the resume did not lose the fixer's context.
//
// Rule 0.3: PURE and TOTAL. No clock, no I/O, no randomness, no mutation of the
// input, no throw.

import type { TaskRecord } from '../schemas.js';

// The stage whose session is never reused. Kept as a named constant even though
// the function is now constant, because the `review` branch below is still checked
// explicitly and the name is what says WHY.
const INDEPENDENT_REVIEW_STAGE = 'review';

export type StageRunnerPlan =
  // A fresh session. Since D46 this is the ONLY variant — the union is kept as a
  // one-armed union rather than collapsed to a bare object type so that a future
  // second mode (D46's own "revisit if fix-cycle cost proves material", or an
  // as-yet-unimagined third door) is an ADDITIVE change to this type and to every
  // `plan.mode === ...` check downstream, exactly as `resume` once was.
  { readonly mode: 'spawn' };

/**
 * Decide who runs this task's current stage. **Since D46 the answer is always a
 * fresh session** — see the file header for the reversal and its two arguments.
 *
 * The function is therefore CONSTANT in its input, and this is stated plainly
 * rather than hidden behind branches: the `review` check below returns the same
 * value as the fall-through, and it is kept ONLY because it is a load-bearing
 * correctness rule in its own right.
 *
 *   1. **`review` → ALWAYS `spawn`.** THE INDEPENDENCE RULE, and it PREDATES D46.
 *      An agent reviewing its own work shares its own misunderstanding, so a
 *      review run in the authoring session cannot see the flaw it created and the
 *      gate silently degrades into self-approval. Checked FIRST and returned
 *      unconditionally, so that no future rule added below it can route a review
 *      into anything else — the branch is structurally unreachable-from-elsewhere
 *      rather than merely unreached.
 *
 *      ⚠ Do NOT delete this branch as "redundant now". It is redundant only for as
 *      long as the fall-through also spawns; the whole point of writing it out is
 *      that the day somebody adds a second mode for `implementing`, review is
 *      already fenced off from it. `stageRunner.test.ts` asserts the review cases
 *      separately from the general ones for the same reason.
 *
 *   2. **EVERY OTHER STAGE → `spawn`.** `implementing` (first pass AND fix — D46
 *      made them indistinguishable to this function), `planning`, and anything
 *      else including a stage outside the enum. The task's `sessionRefs` are NOT
 *      CONSULTED AT ALL any more; the count of prior attempts is the dispatcher's
 *      business (`attempt++`), not this function's.
 */
export function resolveStageRunner(task: TaskRecord): StageRunnerPlan {
  const stage = task?.stage as string | undefined;

  // 1. THE INDEPENDENCE RULE. Unconditional, and first. See the note above on why
  // this stays even though the fall-through is identical.
  if (stage === INDEPENDENT_REVIEW_STAGE) {
    return { mode: 'spawn' };
  }

  // 2. Everything else, including the fix loop (D46).
  return { mode: 'spawn' };
}
