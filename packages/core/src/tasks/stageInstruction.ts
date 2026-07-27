import type { TaskRecord } from '../schemas.js';
import type { StageRunnerPlan } from './stageRunner.js';

// ─── the dispatcher's instruction seam — the WORDS (pure, packages/core) ──────
//
// Pure, deterministic, no clock/IO (rule 0.3). The minimal stage-instruction
// seam-fill Wes signed off 2026-07-24 — see docs/open-questions.md D43/D44 for the
// richer per-stage/spec version deliberately deferred to slice 7. This says only
// what a worker needs to start ONE piece of real work and be steerable mid-run;
// it is intentionally stage-GENERIC (does not specialise planning vs implementing
// vs review — that specialisation is D43/D44) EXCEPT for the one specialisation
// S7·7a adds below: the fresh-implementer handoff.

// ── S7·7a: the OPTIONAL out-of-band context the composer needs but cannot read ─
//
// The composer stays PURE (rule 0.3): it never touches the artifact store, the
// clock, or the disk. But the fresh-implementer briefing must carry the APPROVED
// PLAN, and the plan BLOB is content-addressed IO that lives daemon-side
// (`task.planArtifactHash` → blob in the SQLite artifact store). Approach (a),
// signed off in the WO: the daemon fetches the blob and passes it IN here, so the
// only IO stays at the daemon boundary and this function remains golden-string
// testable.
//
// ⚠ RESERVED TO GROW. S7·7b's fix-seed (D46: prior diff / review feedback /
// worklog for a resume-after-review) lands here as further optional fields. For
// S7·7a it carries exactly one — the resolved plan text — and every field is
// optional so an ABSENT context is byte-identical to no context at all.
export interface StageInstructionContext {
  // The plan text the daemon already fetched by hash. Absent when the task has no
  // `planArtifactHash`, or when the store returned null for one (a degrade, not an
  // error — see the dispatcher). Absent (or empty) → the plan section is omitted.
  readonly plan?: string;
}

// The stable OPENING paragraph of the implementing briefing — a byte-stable
// constant with no task-specific values, so it is a common PREFIX across every
// implementing handoff (the cache-read discipline from the slice-7
// "composeStageInstruction" doc: a fixed prefix lets the model's prompt cache hit
// across dispatches). Perturbing a work-order field must never disturb it; the
// cache-prefix test verifies exactly that.
const IMPLEMENTING_BRIEFING_OPENING =
  `You are a worker session that VIMES dispatched to implement one task. This is
real work. The plan below has already been reviewed and approved — carry it out;
do not re-plan it.`;

// The stable CLOSING two paragraphs — the mid-run-steering + don't-advance
// contract, lifted VERBATIM from the generic spawn text below (only the leading
// "Implement the plan, staying within scope. " differs, and it re-wraps the first
// paragraph). Every worker, generic or implementing, gets the identical contract,
// and this is the byte-stable SUFFIX of the briefing.
const IMPLEMENTING_BRIEFING_CLOSING =
  `Implement the plan, staying within scope. If a message arrives while you're
working, it's a human steering you mid-run — read it and adjust. It's a
correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if
anything) remains, then stop. You do not advance the task yourself — a human
reviews and moves it forward on the board.`;

// The stable OPENING paragraph of the PLANNING briefing — byte-stable prefix
// (cache discipline, same rationale as IMPLEMENTING_BRIEFING_OPENING). Plan-
// directed: it tells the worker it is in plan mode and must produce a plan.
const PLANNING_BRIEFING_OPENING =
  `You are a worker session that VIMES dispatched to PLAN one task. You are in plan
mode: investigate directly and produce a plan — do not implement anything yet.`;

// The stable CLOSING two paragraphs — the investigate-directly + no-sub-agents
// contract, and the present-via-exit-plan-mode contract. Byte-stable SUFFIX.
// Load-bearing (spike-proven): the "sub-agents NOT authorized" line is belt to
// the tools-restriction choke, and "present it by exiting plan mode" is what
// makes the planner call ExitPlanMode instead of writing a plan file and stopping.
const PLANNING_BRIEFING_CLOSING =
  `Investigate the codebase directly with your own tools — read files, search, run
read-only commands. Sub-agents are NOT authorized for this task; do the
exploration yourself. Do not wait for anything or anyone.

When you have a plan, present it by exiting plan mode — that is how you finish.
The plan is your ENTIRE deliverable: VIMES captures it and hands it to a fresh
session that will implement it without your context, so make it complete and
self-contained enough for a stranger to execute.`;

// The stable OPENING paragraph of the REVIEW briefing — byte-stable prefix
// (cache discipline, same rationale as the openings above). Review-directed: it
// tells the worker it is judging code it did NOT write, fresh, against the criteria.
const REVIEW_BRIEFING_OPENING =
  `You are a worker session that VIMES dispatched to REVIEW one task's implementation
independently. You did not write this code — judge it fresh against the acceptance
criteria below.`;

// The stable CLOSING two paragraphs — the inspect-directly + no-sub-agents contract,
// and the report-via-report_review contract. Byte-stable SUFFIX.
//
// ⚠ The tool name `report_review` here MUST match the tool S7·6b registers (SDK MCP
// server `vimes_report`, tool `report_review`; model-facing name
// `mcp__vimes_report__report_review`, which the model resolves from this plain name).
// It is load-bearing prose (spike-proven, mirroring planning's ExitPlanMode line):
// the report tool call is how the reviewer finishes, and deriveReviewOutcome reads
// the per-criterion verdicts it produces.
const REVIEW_BRIEFING_CLOSING =
  `Inspect the implementation directly with your own tools — read the changed files, run
git diff and the tests, search as needed. Sub-agents are NOT authorized for this
task; do the review yourself.

When you have judged every criterion, report your verdict using the report_review
tool — one entry per criterion (its id, pass or fail, a short note). That report is
how you finish and is your ENTIRE deliverable: VIMES reads it to decide whether the
task is done or goes back for fixes. You do not advance the task yourself.`;

// The third param is OPTIONAL → ABSENT-STAYS-ABSENT: called with no context (the
// default composer wiring, and every pre-S7·7a caller), the output is
// byte-identical to what this function produced before S7·7a. Only a `spawn` into
// the `implementing` stage that ALSO has work-order/plan content to carry takes
// the new branch; everything else falls through to the unchanged text.
export function composeStageInstruction(
  task: TaskRecord,
  plan: StageRunnerPlan,
  context?: StageInstructionContext,
): string {
  // ⚠ ABSENT vs EMPTY (the `title?` distinction the schema comment draws): a
  // title of `''` is a title someone chose and is used as-is; only an ABSENT
  // title (never created with one) falls back to the untitled label.
  const label = task.title ?? `untitled (${task.taskId})`;

  // ── S7·7a: the FRESH-IMPLEMENTER handoff (D44) ─────────────────────────────
  //
  // A fresh session spawned into the `implementing` stage is a stranger to the
  // work: it did not write the plan and has none of the reviewer's context. So
  // when there is a work-order and/or an approved plan to hand it, we compose the
  // richer briefing below rather than the stage-generic text. A RESUMED author
  // (the fix loop) already has all of this in its own history and takes the resume
  // branch above/below instead — this specialisation is spawn-only.
  //
  // Every work-order section is CONDITIONAL on presence (I8 totality): an ABSENT
  // field — or an empty string / empty array, which carries no content — omits its
  // whole section rather than rendering an empty one. The plan comes from
  // `context.plan` (the blob the daemon fetched), not from the task.
  if (plan.mode === 'spawn' && task.stage === 'implementing') {
    const hasScope = typeof task.scope === 'string' && task.scope.length > 0;
    const hasExplicitlyOut = Array.isArray(task.explicitlyOut) && task.explicitlyOut.length > 0;
    const hasAcceptanceCriteria =
      Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0;
    const hasKillCriterion =
      typeof task.killCriterion === 'string' && task.killCriterion.length > 0;
    const hasPlan = typeof context?.plan === 'string' && context.plan.length > 0;

    // DEGRADE RULE: a bare implementing task dispatched with none of the five
    // carries nothing the generic text does not already say, so it falls THROUGH
    // to the generic spawn wording below — byte-identical to today. The rich
    // briefing only earns its extra prose when it has content to add.
    if (hasScope || hasExplicitlyOut || hasAcceptanceCriteria || hasKillCriterion || hasPlan) {
      // Compose as an ordered list of BLOCKS joined by a single blank line. This
      // keeps the spacing deterministic and clean no matter which conditional
      // sections are present: no block carries a leading/trailing blank line, and
      // the join owns every gap between them. The stable opening + Task/Stage/
      // Directory block leads; the stable closing trails; the variable work-order
      // and plan blocks sit between, so the fixed framing stays a common prefix
      // and suffix across tasks (cache discipline).
      const briefingBlocks: string[] = [];

      // ⚠ The `Directory:` line states `task.projectRoot`, correct under the
      // current default `VIMES_WORKTREE_ISOLATION=off` (worker cwd == projectRoot)
      // — the same caveat the generic spawn text carries below. Under isolation the
      // resolved worktree cwd would need threading in, a follow-up tied to that flip.
      briefingBlocks.push(
        `${IMPLEMENTING_BRIEFING_OPENING}

  Task:      ${label}
  Stage:     implementing
  Directory: ${task.projectRoot} — work in this directory; do not guess or invent a
             different path name.`,
      );

      if (hasScope) {
        briefingBlocks.push(`Scope — what this task is:\n${task.scope}`);
      }
      if (hasExplicitlyOut) {
        const explicitlyOutBullets = task.explicitlyOut!.map((item) => `  - ${item}`).join('\n');
        briefingBlocks.push(`Explicitly out of scope — do not do these:\n${explicitlyOutBullets}`);
      }
      if (hasAcceptanceCriteria) {
        // One bullet per criterion's `text`; the stable `id` is for report_review
        // (S7·6) to key against, not for the worker to read, so it is not shown.
        const criterionBullets = task.acceptanceCriteria!
          .map((criterion) => `  - ${criterion.text}`)
          .join('\n');
        briefingBlocks.push(`Done when ALL of these are true:\n${criterionBullets}`);
      }
      if (hasKillCriterion) {
        briefingBlocks.push(
          `Stop and report instead of pushing through if: ${task.killCriterion}`,
        );
      }
      if (hasPlan) {
        briefingBlocks.push(`The approved plan:\n\n${context!.plan}`);
      }

      briefingBlocks.push(IMPLEMENTING_BRIEFING_CLOSING);

      return briefingBlocks.join('\n\n');
    }
  }

  // ── S7·5c: the PLANNING briefing (D50) ─────────────────────────────────────
  //
  // A dispatched planning session must produce an approvable plan via ExitPlanMode
  // and must NOT fan out sub-agents (the tools-restriction choke enforces the
  // latter; this prose is the belt + the plan-directed instruction the choke does
  // not provide). Work-order sections are conditional on presence (I8 totality),
  // exactly like the implementing branch.
  //
  // ⚠ DIFFERS FROM IMPLEMENTING ON PURPOSE — NO DEGRADE-TO-GENERIC. Even a bare
  // planning task (none of the four work-order fields) returns THIS briefing, not
  // the generic spawn text: the plan-directed + no-sub-agent framing is ALWAYS
  // load-bearing for planning. So this branch always returns.
  if (plan.mode === 'spawn' && task.stage === 'planning') {
    const hasScope = typeof task.scope === 'string' && task.scope.length > 0;
    const hasExplicitlyOut = Array.isArray(task.explicitlyOut) && task.explicitlyOut.length > 0;
    const hasAcceptanceCriteria =
      Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0;
    const hasKillCriterion =
      typeof task.killCriterion === 'string' && task.killCriterion.length > 0;

    const briefingBlocks: string[] = [];

    briefingBlocks.push(
      `${PLANNING_BRIEFING_OPENING}

  Task:      ${label}
  Stage:     planning
  Directory: ${task.projectRoot} — work in this directory; do not guess or invent a
             different path name.`,
    );

    if (hasScope) {
      briefingBlocks.push(`Scope — what this task is:\n${task.scope}`);
    }
    if (hasExplicitlyOut) {
      const explicitlyOutBullets = task.explicitlyOut!.map((item) => `  - ${item}`).join('\n');
      briefingBlocks.push(`Explicitly out of scope — do not plan for these:\n${explicitlyOutBullets}`);
    }
    if (hasAcceptanceCriteria) {
      const criterionBullets = task.acceptanceCriteria!
        .map((criterion) => `  - ${criterion.text}`)
        .join('\n');
      briefingBlocks.push(`Acceptance criteria — your plan must make ALL of these achievable:\n${criterionBullets}`);
    }
    if (hasKillCriterion) {
      briefingBlocks.push(`Stop and report instead of planning if: ${task.killCriterion}`);
    }

    briefingBlocks.push(PLANNING_BRIEFING_CLOSING);

    return briefingBlocks.join('\n\n');
  }

  // ── S7·6a: the REVIEW briefing (D43/D46) ───────────────────────────────────
  //
  // A dispatched review session judges an implementation it did NOT write, fresh,
  // against the acceptance criteria, and reports per-criterion pass/fail via the
  // `report_review` tool (S7·6b registers it; deriveReviewOutcome reads the verdicts).
  // Work-order sections are conditional on presence (I8 totality), like the branches
  // above.
  //
  // ⚠ TWO DIFFERENCES from the implementing / planning branches:
  //   1. Like planning, NO degrade-to-generic — even a bare review task (no criteria)
  //      returns THIS briefing: the review framing + the report_review contract are
  //      ALWAYS load-bearing. So this branch always returns.
  //   2. Acceptance criteria are rendered WITH their `[id]`, because the reviewer must
  //      report per-criterion BY id (planning/implementing deliberately HID the ids —
  //      the worker there has no per-id obligation; the reviewer does).
  if (plan.mode === 'spawn' && task.stage === 'review') {
    const hasScope = typeof task.scope === 'string' && task.scope.length > 0;
    const hasAcceptanceCriteria =
      Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0;
    const hasExplicitlyOut = Array.isArray(task.explicitlyOut) && task.explicitlyOut.length > 0;

    const briefingBlocks: string[] = [];

    briefingBlocks.push(
      `${REVIEW_BRIEFING_OPENING}

  Task:      ${label}
  Stage:     review
  Directory: ${task.projectRoot} — the implementation is here; review it in place.`,
    );

    if (hasScope) {
      briefingBlocks.push(`Scope — what this task was meant to do:\n${task.scope}`);
    }
    if (hasAcceptanceCriteria) {
      // ⚠ Rendered WITH `[id]` — the reviewer reports per-criterion BY id via
      // report_review. This is the deliberate DIFFERENCE from S7·5c/S7·7a, which
      // hide the id. DEGENERATE case: a task with NO acceptance criteria omits this
      // whole section (never an empty bulleted list) but STILL returns the review
      // briefing — deriveReviewOutcome sends an empty-criteria task to `done`.
      const criterionBullets = task.acceptanceCriteria!
        .map((criterion) => `  - [${criterion.id}] ${criterion.text}`)
        .join('\n');
      briefingBlocks.push(`Acceptance criteria — judge EACH as pass or fail:\n${criterionBullets}`);
    }
    if (hasExplicitlyOut) {
      const explicitlyOutBullets = task.explicitlyOut!.map((item) => `  - ${item}`).join('\n');
      briefingBlocks.push(
        `Explicitly out of scope — do not hold these against it:\n${explicitlyOutBullets}`,
      );
    }

    briefingBlocks.push(REVIEW_BRIEFING_CLOSING);

    return briefingBlocks.join('\n\n');
  }

  if (plan.mode === 'resume') {
    return `You are resuming your own earlier work on this task (${label} · ${task.stage}). New
guidance has arrived — a human correction, or feedback from an independent
review. Read the latest messages, address them, and continue in the same
directory and scope. When done, summarize and stop; a human advances it.`;
  }

  // plan.mode === 'spawn'
  //
  // ⚠ The `Directory:` line states `task.projectRoot`. This is correct under the
  // CURRENT default `VIMES_WORKTREE_ISOLATION=off` (worker cwd == projectRoot).
  // TODO(worktree-isolation): when that flag flips, the worker's cwd is the
  // *worktree* path, not projectRoot, so the composer will need the resolved
  // cwd passed in — a follow-up tied to the isolation flip (not solved here).
  return `You are a worker session that VIMES dispatched to make progress on one task.
This is real work.

  Task:      ${label}
  Stage:     ${task.stage}
  Directory: ${task.projectRoot} — work in this directory; do not guess or invent a
             different path name.

Do the work this stage calls for, and stay within the task's scope.

If a message arrives while you're working, it's a human steering you mid-run —
read it and adjust. It's a correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if
anything) remains, then stop. You do not advance the task yourself — a human
reviews and moves it forward on the board.`;
}
