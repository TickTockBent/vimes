import type {
  ReportCompletionPayload,
  ReportReviewPayload,
  StageRunnerPlan,
  TaskRecord,
} from '@vimes/ext-host';

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
// S7·7b GREW IT, exactly as reserved: the fix-seed (D46) lands here as two further
// optional fields. Every field is optional so an ABSENT context is byte-identical
// to no context at all — the S7·7a discipline, now carrying three things.
export interface StageInstructionContext {
  // The plan text the daemon already fetched by hash. Absent when the task has no
  // `planArtifactHash`, or when the store returned null for one (a degrade, not an
  // error — see the dispatcher). Absent (or empty) → the plan section is omitted.
  readonly plan?: string;
  // ── S7·7b: THE FIX-SEED (D46) ──────────────────────────────────────────────
  //
  // D46 killed the resume: a fix is a FRESH implementer, never the hot author (see
  // stageRunner.ts for the two arguments). What a fresh fixer loses is not the
  // code — the prior attempt's changes are ON DISK and D53's rider has the fixer
  // read them with `git diff` rather than the dispatcher inlining a diff into the
  // prompt (zero prompt bytes, never truncated, never stale). What it loses is the
  // FEEDBACK and the DEAD ENDS, neither of which has an on-disk home. So exactly
  // those two ride in here, as small structured data.
  //
  // Sourced by the daemon from `TaskRecord.lastReview` / `.lastCompletion` (the
  // S7·7b projection folds). Threaded in rather than read here for the same reason
  // `plan` is: rule 0.3 keeps this function pure and golden-string testable.

  // The per-criterion verdicts of the review that FAILED this attempt. Absent (or
  // empty) → the whole feedback block is omitted.
  readonly reviewFeedback?: ReportReviewPayload['criteria'];
  // The PRIOR attempt's worklog — its own account of what it decided and what it
  // tried and abandoned. Absent (or carrying two empty lists) → the whole worklog
  // block is omitted.
  //
  // ⚠ ABSENT IS A REAL, EXPECTED STATE, not an error: a fix can be dispatched
  // before any `report_completion` exists for the task (a review that ran against
  // work whose author never reported, or a bounce the orchestrator made by hand).
  // Feedback-without-worklog must compose cleanly — there is a test for it.
  readonly worklog?: ReportCompletionPayload['worklog'];
}

// ⚠ S7·7f: the PROSE constants below are UNWRAPPED on purpose — each paragraph is
// one long source line (no mid-sentence `\n`) because template literals preserve
// hard-wraps verbatim into the dispatched prompt; do not re-wrap them for tidiness.

// The stable OPENING paragraph of the implementing briefing — a byte-stable
// constant with no task-specific values, so it is a common PREFIX across every
// implementing handoff (the cache-read discipline from the slice-7
// "composeStageInstruction" doc: a fixed prefix lets the model's prompt cache hit
// across dispatches). Perturbing a work-order field must never disturb it; the
// cache-prefix test verifies exactly that.
const IMPLEMENTING_BRIEFING_OPENING =
  `You are a worker session that VIMES dispatched to implement one task. This is real work. The plan below has already been reviewed and approved — carry it out; do not re-plan it.`;

// The stable CLOSING two paragraphs — the mid-run-steering contract, then the
// FINISH contract. Byte-stable SUFFIX of the implementing briefing.
//
// ⚠ **THE SECOND PARAGRAPH WAS REPLACED IN S7·7b (D53, D46) — DELIBERATE GOLDEN
// CHURN.** It used to be lifted verbatim from the generic spawn text below
// ("briefly summarize what you did … a human reviews and moves it forward on the
// board"), i.e. the implementer finished by STOPPING and a human moved the card.
// D53 makes `implementing → review` an OUTCOME the work reports for itself, and
// D46 makes the worklog the fix-seed a fresh fixer needs, so the implementer now
// finishes by CALLING A TOOL and the report is the deliverable. The first
// paragraph (mid-run steering) is untouched; the generic, planning and review
// briefings are untouched.
//
// ⚠ The tool name `report_completion` here MUST match the tool 7b-daemon registers
// (SDK MCP server `vimes_report`, alongside `report_review`; model-facing name
// `mcp__vimes_report__report_completion`, which the model resolves from this plain
// name). Load-bearing prose, exactly like planning's ExitPlanMode line and
// review's `report_review` line — it is HOW the run ends. The field names
// `decisionsMade`/`pathsRejected` are stated verbatim because they are the tool's
// own input keys (`reportCompletionPayloadSchema.worklog`).
//
// ⚠ NOTE THE ORDER OF UNITS. As of S7·7b-core the tool does not exist yet; the
// emitter is 7b-daemon. This prose ships in the same commit-lineage but the
// briefing is only true once that unit lands — which is why the two are sequenced
// back to back and not separated by a deploy.
const IMPLEMENTING_BRIEFING_CLOSING =
  `Implement the plan, staying within scope. If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a correction to THIS task, not a new task.

When the work is done, report it using the report_completion tool — a worklog with decisionsMade (the calls you made and why) and pathsRejected (dead ends you tried or considered and abandoned; the next attempt must not re-explore them). That report is how you finish and is your ENTIRE deliverable: VIMES records it and moves the task to review. You do not advance the task yourself.`;

// ── S7·7b: the FIX-SEED preamble (D46 + D53's on-disk-diff rider) ─────────────
//
// A byte-stable constant with no task-specific values, rendered only when the
// briefing carries a fix-seed. Two things it must say and one it must NOT:
//   • this is a FIX of a prior attempt that failed review — so the fixer knows the
//     work-order is not virgin ground and the failures below are the job;
//   • the prior attempt's changes are ALREADY ON DISK — read them with `git diff`.
//     D53's rider: the dispatcher does NOT inline diff text (zero prompt bytes,
//     never truncated, never stale), so the briefing must point at the diff or the
//     fixer will start from scratch on top of half-finished work;
//   • it must NOT say "you wrote this" — the fixer is a stranger to the code, and
//     D46's anchoring argument is the whole reason it is a stranger.
const FIX_ATTEMPT_PREAMBLE =
  `This is a FIX. A previous attempt at this task was implemented and then FAILED an independent review. You did not write that attempt — but its changes are ALREADY ON DISK in the directory above. Read them first (\`git diff\`, and \`git status\` for new files) so you are correcting existing work rather than starting over on top of it.`;

// The stable OPENING paragraph of the PLANNING briefing — byte-stable prefix
// (cache discipline, same rationale as IMPLEMENTING_BRIEFING_OPENING). Plan-
// directed: it tells the worker it is in plan mode and must produce a plan.
const PLANNING_BRIEFING_OPENING =
  `You are a worker session that VIMES dispatched to PLAN one task. You are in plan mode: investigate directly and produce a plan — do not implement anything yet.`;

// The stable CLOSING two paragraphs — the investigate-directly + no-sub-agents
// contract, and the present-via-exit-plan-mode contract. Byte-stable SUFFIX.
// Load-bearing (spike-proven): the "sub-agents NOT authorized" line is belt to
// the tools-restriction choke, and "present it by exiting plan mode" is what
// makes the planner call ExitPlanMode instead of writing a plan file and stopping.
const PLANNING_BRIEFING_CLOSING =
  `Investigate the codebase directly with your own tools — read files, search, run read-only commands. Sub-agents are NOT authorized for this task; do the exploration yourself. Do not wait for anything or anyone.

When you have a plan, present it by exiting plan mode — that is how you finish. The plan is your ENTIRE deliverable: VIMES captures it and hands it to a fresh session that will implement it without your context, so make it complete and self-contained enough for a stranger to execute.`;

// The stable OPENING paragraph of the REVIEW briefing — byte-stable prefix
// (cache discipline, same rationale as the openings above). Review-directed: it
// tells the worker it is judging code it did NOT write, fresh, against the criteria.
const REVIEW_BRIEFING_OPENING =
  `You are a worker session that VIMES dispatched to REVIEW one task's implementation independently. You did not write this code — judge it fresh against the acceptance criteria below.`;

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
  `Inspect the implementation directly with your own tools — read the changed files, run git diff and the tests, search as needed. Sub-agents are NOT authorized for this task; do the review yourself.

When you have judged every criterion, report your verdict using the report_review tool — one entry per criterion (its id, pass or fail, a short note). That report is how you finish and is your ENTIRE deliverable: VIMES reads it to decide whether the task is done or goes back for fixes. You do not advance the task yourself.`;

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
  // richer briefing below rather than the stage-generic text.
  //
  // ⚠ S7·7b: **THIS IS ALSO THE FIX BRANCH NOW.** D46 killed the resume, so a fix
  // after a failed review arrives here too — same stage, same spawn, a stranger
  // again. The difference is entirely in what the context carries: a fix-seed
  // (review feedback + the prior attempt's worklog) that a first pass does not
  // have. There is deliberately no separate "fix" branch and no `isFix` flag; the
  // presence of the seed IS the distinction, which keeps the first-pass output
  // byte-identical when it is absent.
  //
  // Every work-order section is CONDITIONAL on presence (I8 totality): an ABSENT
  // field — or an empty string / empty array, which carries no content — omits its
  // whole section rather than rendering an empty one. The plan comes from
  // `context.plan` (the blob the daemon fetched), not from the task, and so does
  // the fix-seed.
  if (plan.mode === 'spawn' && task.stage === 'implementing') {
    const hasScope = typeof task.scope === 'string' && task.scope.length > 0;
    const hasExplicitlyOut = Array.isArray(task.explicitlyOut) && task.explicitlyOut.length > 0;
    const hasAcceptanceCriteria =
      Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0;
    const hasKillCriterion =
      typeof task.killCriterion === 'string' && task.killCriterion.length > 0;
    const hasPlan = typeof context?.plan === 'string' && context.plan.length > 0;

    // ── the fix-seed's presence tests (S7·7b) ───────────────────────────────
    //
    // `Array.isArray` / per-field re-checks rather than trusting the types: this
    // context crosses the daemon boundary from a REPLAYED record (`lastReview` /
    // `lastCompletion` off the projection), and a partially-written or
    // hand-edited record must degrade to "section omitted", never throw (I8).
    const reviewFeedback = context?.reviewFeedback;
    const hasReviewFeedback = Array.isArray(reviewFeedback) && reviewFeedback.length > 0;
    const decisionsMade = context?.worklog?.decisionsMade;
    const pathsRejected = context?.worklog?.pathsRejected;
    const hasDecisionsMade = Array.isArray(decisionsMade) && decisionsMade.length > 0;
    const hasPathsRejected = Array.isArray(pathsRejected) && pathsRejected.length > 0;
    // A worklog of two empty lists carries no content — same rule as an empty
    // `explicitlyOut` array. ASYMMETRIC WITH `hasReviewFeedback` ON PURPOSE: a fix
    // dispatched before any completion report exists has feedback and NO worklog,
    // and that must compose cleanly rather than render an empty heading.
    const hasWorklog = hasDecisionsMade || hasPathsRejected;
    // The fix preamble is earned by EITHER half of the seed: feedback alone still
    // means a prior attempt is on disk, which is the thing the preamble exists to
    // say (D53's rider).
    const hasFixSeed = hasReviewFeedback || hasWorklog;

    // DEGRADE RULE: a bare implementing task dispatched with none of the five (nor
    // a fix-seed) carries nothing the generic text does not already say, so it
    // falls THROUGH to the generic spawn wording below — byte-identical to today.
    // The rich briefing only earns its extra prose when it has content to add.
    //
    // ⚠ S7·7b added `hasFixSeed` to this test. Without it, a task carrying ONLY a
    // fix-seed (no scope, no plan — reachable: a hand-created task bounced out of
    // review) would degrade to the generic text and SILENTLY DROP the feedback and
    // the worklog, which is the one thing the fix loop cannot afford to lose.
    if (
      hasScope ||
      hasExplicitlyOut ||
      hasAcceptanceCriteria ||
      hasKillCriterion ||
      hasPlan ||
      hasFixSeed
    ) {
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
  Directory: ${task.projectRoot} — work in this directory; do not guess or invent a different path name.`,
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

      // ── S7·7b: the FIX-SEED blocks (D46) ───────────────────────────────────
      //
      // Placed AFTER the plan and BEFORE the closing, in a fixed order — preamble,
      // then feedback, then worklog — so the briefing reads as "here is the task,
      // here is the plan, here is what went wrong last time, here is what the last
      // attempt already ruled out, now go". The order is stable regardless of which
      // blocks are present, which is what keeps two fix dispatches of the same task
      // comparable and the framing prefix/suffix intact (cache discipline).
      if (hasFixSeed) {
        briefingBlocks.push(FIX_ATTEMPT_PREAMBLE);
      }
      if (hasReviewFeedback) {
        // FAILS FIRST, then passes. Both are rendered: the failures are the work,
        // and the passes are context a fixer needs in order NOT to break them
        // reaching for a failure. `filter` is order-preserving, so the reviewer's
        // own ordering survives inside each group and the output is deterministic.
        const failedCriteria = reviewFeedback!.filter((criterion) => criterion.verdict === 'fail');
        const passedCriteria = reviewFeedback!.filter((criterion) => criterion.verdict !== 'fail');
        const verdictBullets = [...failedCriteria, ...passedCriteria]
          .map((criterion) => {
            // Uppercased so the verdict is scannable at a glance in a wall of
            // prose; the `[id]` is rendered for the same reason the REVIEW briefing
            // renders it — it is the key the next `report_review` will judge again.
            const verdictLabel = criterion.verdict === 'fail' ? 'FAIL' : 'PASS';
            const note =
              typeof criterion.note === 'string' && criterion.note.length > 0
                ? ` — ${criterion.note}`
                : '';
            return `  - [${criterion.criterionId}] ${verdictLabel}${note}`;
          })
          .join('\n');
        briefingBlocks.push(
          `The review's verdict on that attempt — every FAIL is your job:\n${verdictBullets}`,
        );
      }
      if (hasWorklog) {
        // Two sub-lists, each conditional, under one lead-in. Joined internally by
        // the same blank line the outer join uses, so the spacing is uniform
        // whether one sub-list is present or both.
        const worklogParts: string[] = [
          `The previous attempt's own worklog — do NOT re-explore what it already rejected. If you think a rejected path is right after all, say so in your report rather than quietly retrying it.`,
        ];
        if (hasDecisionsMade) {
          worklogParts.push(
            `Decisions made:\n${decisionsMade!.map((entry) => `  - ${entry}`).join('\n')}`,
          );
        }
        if (hasPathsRejected) {
          worklogParts.push(
            `Paths rejected:\n${pathsRejected!.map((entry) => `  - ${entry}`).join('\n')}`,
          );
        }
        briefingBlocks.push(worklogParts.join('\n\n'));
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
  Directory: ${task.projectRoot} — work in this directory; do not guess or invent a different path name.`,
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
    } else {
      // ── S7·7f: the NO-CRITERIA review clause ─────────────────────────────────
      //
      // A SEPARATE conditional block, not folded into REVIEW_BRIEFING_CLOSING: the
      // closing must stay a byte-stable SUFFIX (cache-prefix discipline — it is
      // shared across every review dispatch), and a conditional clause inside it
      // would fork that suffix. Observed 2026-07-27 (the johnny run): a reviewer
      // dispatched against a bare task with no acceptance criteria improvised 9
      // sensible criteria of its own and reported each one through report_review —
      // this blesses that OBSERVED-GOOD behaviour explicitly rather than changing
      // the mechanism. `deriveReviewOutcome` is UNTOUCHED: an empty-task-criteria
      // review still resolves the same way regardless of this prose.
      briefingBlocks.push(
        'This task enumerates no acceptance criteria. Derive sensible criteria yourself from the scope and the implementation, and report each one through report_review — mint a short id per criterion so each verdict is keyed.',
      );
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

  // ⚠ **THE `resume` BRANCH WAS DELETED HERE BY S7·7b-daemon (D46) — A RECORDED
  // REVERSAL, NOT A TIDY-UP.** It used to sit at exactly this point and returned a
  // short "You are resuming your own earlier work on this task (…). New guidance
  // has arrived …" text for the fix loop. `resolveStageRunner` stopped producing
  // `mode:'resume'` (see stageRunner.ts for D46's two arguments), the daemon's
  // `resumeStageRun` went with it, and the `StageRunnerPlan` union lost the variant
  // — so this branch became unreachable AND untypeable in the same step, which is
  // why the removal happened as one unit rather than three.
  //
  // What a fix gets INSTEAD is the implementing branch ABOVE, carrying the fix-seed
  // (`reviewFeedback` + `worklog` in the context). If you are looking for "where
  // does the fixer get told what went wrong", it is there, not here.
  //
  // Interactive/human resume is untouched (D46 rider 2) — but it never composed a
  // stage instruction, so it never reached this function.

  // plan.mode === 'spawn' — the ONLY mode since D46.
  //
  // ⚠ The `Directory:` line states `task.projectRoot`. This is correct under the
  // CURRENT default `VIMES_WORKTREE_ISOLATION=off` (worker cwd == projectRoot).
  // TODO(worktree-isolation): when that flag flips, the worker's cwd is the
  // *worktree* path, not projectRoot, so the composer will need the resolved
  // cwd passed in — a follow-up tied to the isolation flip (not solved here).
  return `You are a worker session that VIMES dispatched to make progress on one task. This is real work.

  Task:      ${label}
  Stage:     ${task.stage}
  Directory: ${task.projectRoot} — work in this directory; do not guess or invent a different path name.

Do the work this stage calls for, and stay within the task's scope.

If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if anything) remains, then stop. You do not advance the task yourself — a human reviews and moves it forward on the board.`;
}
