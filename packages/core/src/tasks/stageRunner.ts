// ─── slice 6 step 7 — WHO RUNS THE STAGE (PURE, packages/core) ───────────────
//
// `decideDispatch` (step 3) answers **whether** a stage run happens. This module
// answers the next question and only that one: **which session runs it** — a
// brand-new one, or the session that already did the work.
//
// TWO QUESTIONS, TWO FUNCTIONS, ON PURPOSE. Folding "who runs it" into
// `decideDispatch` would put a cache-economics judgement inside the function that
// carries I10, and I10 would stop being assertable on its own. Nothing in this
// file may ever decide whether to dispatch, and nothing in `dispatchDecision.ts`
// may ever decide who runs it.
//
// ── the design (docs/design-directions.md, "The dispatcher's review/fix loop +
//    cache economics", Wes 2026-07-20) ────────────────────────────────────────
//
//   "**Review wants independence; fixes want the hot author.** An agent reviewing
//    its own work shares its own misunderstanding — a real blindspot. So the GATE
//    review is the orchestrator or a fresh reviewer; self-review is a cheap first
//    pass, never the gate. Fixes of orchestrator-found flaws go to the original
//    hot-cache worker (cheap + context-rich)."
//
//   "**Cache economics:** resuming the hot worker for fixes avoids the big
//    cache-miss of a new agent. Prompt cache is scoped to machine+directory (D6):
//    a worktree worker is cold *relative to shared-dir workers* but hot *within
//    its own worktree* on resume — so the loop is internally consistent; the miss
//    avoided is the new-agent spin-up, at the cost of no cross-agent cache sharing
//    in worktree mode."
//
// The asymmetry is the whole module: **resume is an OPTIMISATION and review is a
// CORRECTNESS RULE.** They point in opposite directions, and the correctness rule
// wins wherever they meet.
//
// Rule 0.3: PURE and TOTAL. No clock, no I/O, no randomness, no mutation of the
// input, no throw — derived from `task.sessionRefs` and `task.stage` alone. Same
// task in, same plan out, forever.

import type { TaskRecord } from '../schemas.js';

// The stage whose session is never reused, and the stage that reuses one. Named
// constants rather than inline string literals because both names appear in a
// load-bearing comparison below, and a typo in either one degrades silently into
// "always spawn" — which is safe for `review` and WRONG-but-quiet for the fix loop.
const INDEPENDENT_REVIEW_STAGE = 'review';
const AUTHORING_STAGE = 'implementing';

export type StageRunnerPlan =
  // A fresh session. The default, and the only plan `review` can ever get.
  | { readonly mode: 'spawn' }
  // Resume THIS existing app session — the hot author of the work under fix.
  | { readonly mode: 'resume'; readonly appSessionId: string };

/**
 * Decide who runs this task's current stage.
 *
 * THE RULES, in the order they are checked (the order is load-bearing — see the
 * note on rule 1):
 *
 *   1. **`review` → ALWAYS `spawn`.** THE INDEPENDENCE RULE. Never resume, and
 *      never reuse an implementing session, whatever the task's refs look like.
 *      Checked FIRST and returned unconditionally so that no ref shape, and no
 *      future rule added below it, can route a review into a resume: the branch
 *      is structurally unreachable-from-elsewhere rather than merely unreached.
 *
 *      ⚠ **THIS IS THE BRANCH A FUTURE OPTIMISATION WILL COME FOR.** It looks
 *      exactly like a missed cache win — the reviewer starts cold, every time, and
 *      a resumed implementer would be free. It is not a missed win; it is the
 *      point. An agent reviewing its own work shares its own misunderstanding, so
 *      a review run in the authoring session cannot see the flaw it created and
 *      the gate silently degrades into self-approval. If you are here to make
 *      review cheaper, make the reviewer's SPAWN cheaper — do not reuse the
 *      author's session. `stageRunner.test.ts` enumerates ref shapes precisely so
 *      this cannot be relaxed by accident.
 *
 *   2. **`implementing` WITH a prior `implementing` ref → `resume` it.** THE FIX
 *      LOOP: the task has been through `review` and come back down the
 *      `review → implementing` edge, so the work already has an author, and that
 *      author is context-rich and cache-warm. Independence was already secured —
 *      by the reviewer that found the flaw — so nothing is lost by going back to
 *      the person who wrote it.
 *
 *   3. **`implementing` with NO prior implementing ref → `spawn`.** First pass;
 *      there is no author yet. A `planning` session is NOT the author: it produced
 *      a plan, not the work under fix, and treating it as one would resume a
 *      session whose context is the wrong artifact.
 *
 *   4. **Any other stage → `spawn`.** `planning` is the live case (the only other
 *      dispatchable stage); everything else — including a stage outside the enum —
 *      lands here too. Fail-safe direction: a fresh session is always correct, and
 *      the resume is only ever an optimisation.
 */
export function resolveStageRunner(task: TaskRecord): StageRunnerPlan {
  const stage = task?.stage as string | undefined;

  // 1. THE INDEPENDENCE RULE. Unconditional, and first.
  if (stage === INDEPENDENT_REVIEW_STAGE) {
    return { mode: 'spawn' };
  }

  // 2/3. The fix loop, or the first pass.
  if (stage === AUTHORING_STAGE) {
    const hotAuthorSessionId = mostRecentSessionIdForStage(task, AUTHORING_STAGE);
    if (hotAuthorSessionId !== null) {
      return { mode: 'resume', appSessionId: hotAuthorSessionId };
    }
    return { mode: 'spawn' };
  }

  // 4. Everything else.
  return { mode: 'spawn' };
}

/**
 * The `appSessionId` of the MOST RECENT ref for `stage`, or null when there is
 * none.
 *
 * ⚠ WHICH END IS "MOST RECENT": **the LAST element of the array.** The tasks
 * projection folds `task_session_attached` by APPENDING, never sorting
 * (`projections/tasks.ts` — "APPEND, never sort: the refs are a chronological
 * trail of which sessions ran this task, and the log order is the only order that
 * means anything"). So the array reads oldest → newest and `.at(-1)` of the
 * matches is the newest. Scanning backwards from the end and returning the first
 * hit is that same fact, written so it short-circuits.
 *
 * WHY the most recent and not the first: a task can go round the review/fix loop
 * more than once, and after a quarantine a re-run is a NEW session that the
 * projection deliberately keeps alongside the old one. The oldest implementing ref
 * may therefore be a dead session with stale context; the newest is the author of
 * the work that is actually on disk.
 *
 * TOTAL BY CONSTRUCTION (I8): `sessionRefs` is validated as an array of
 * `{stage, appSessionId}` by the schema, but this function is reachable from an
 * API boundary and from replayed records, so every assumption is re-checked here
 * rather than trusted. A malformed ref is SKIPPED, never thrown on — and a task
 * whose refs are entirely malformed simply has no author, which resolves to
 * `spawn`, the safe direction.
 */
function mostRecentSessionIdForStage(task: TaskRecord, stage: string): string | null {
  const sessionRefs: unknown = task?.sessionRefs;
  if (!Array.isArray(sessionRefs)) {
    return null;
  }
  for (let refIndex = sessionRefs.length - 1; refIndex >= 0; refIndex -= 1) {
    const sessionRef: unknown = sessionRefs[refIndex];
    if (sessionRef === null || typeof sessionRef !== 'object') {
      continue;
    }
    const candidate = sessionRef as { stage?: unknown; appSessionId?: unknown };
    // Exact string match, never a case-insensitive or prefix one: 'implementing'
    // is an enum value, not a label, and a fuzzy match here would let some future
    // 'implementing-review' stage silently inherit the author.
    if (candidate.stage !== stage) {
      continue;
    }
    if (typeof candidate.appSessionId !== 'string' || candidate.appSessionId.length === 0) {
      // A ref with no usable session id cannot be resumed. Skipping (rather than
      // returning null) keeps looking further back — one corrupt ref must not
      // hide an intact older author.
      continue;
    }
    return candidate.appSessionId;
  }
  return null;
}
