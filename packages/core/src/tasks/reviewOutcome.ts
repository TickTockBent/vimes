import type { ReportReviewPayload } from './workOrder.js';

// ─── S7·6a — the review verdict → proposed stage function (PURE, packages/core) ─
//
// Pure, deterministic and TOTAL (rule 0.3): no clock, no IO, never throws on any
// input. It decides WHERE a reported review sends the task; it does NOT event the
// transition itself — the dispatcher (S7·6b) reads this result and proposes the
// move through the state machine (I7), so this stays a headless decision that the
// harness and the dispatcher share.
//
// The rules, in order:
//   • any reported 'fail'                    -> 'implementing'  (the fix loop)
//   • a task criterion NOT covered by a pass -> 'implementing'  (incomplete review)
//   • all task criteria covered and passed   -> 'done'
//   • empty task criteria (a bare task)      -> 'done'          (vacuously covered)
//
// `taskCriterionIds` is the coverage BAR: the ids on the task's own acceptance
// list. A review is only complete when every one of them has a reported pass — a
// reviewer cannot finish a task by reporting a pass on some OTHER criterion, and
// (the converse) an EXTRA reported id that is not on the task is ignored for
// coverage, so it neither blocks nor forces `done`.
export function deriveReviewOutcome(
  reportedCriteria: ReportReviewPayload['criteria'],
  taskCriterionIds: readonly string[],
): 'done' | 'implementing' {
  // Any explicit fail sends it straight back to the fix loop, regardless of what
  // else was (or was not) reported.
  if (reportedCriteria.some((criterion) => criterion.verdict === 'fail')) {
    return 'implementing';
  }
  // The set of task-criterion ids the reviewer explicitly PASSED. Only 'pass'
  // verdicts count toward coverage; a criterion the reviewer never mentioned is
  // uncovered by definition.
  const passedCriterionIds = new Set(
    reportedCriteria
      .filter((criterion) => criterion.verdict === 'pass')
      .map((criterion) => criterion.criterionId),
  );
  // `every` over an empty list is vacuously true → a bare task (no criteria) is
  // covered and goes to 'done'.
  const allTaskCriteriaCovered = taskCriterionIds.every((criterionId) =>
    passedCriterionIds.has(criterionId),
  );
  return allTaskCriteriaCovered ? 'done' : 'implementing';
}
