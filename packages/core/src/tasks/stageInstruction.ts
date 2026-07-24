import type { TaskRecord } from '../schemas.js';
import type { StageRunnerPlan } from './stageRunner.js';

// ─── the dispatcher's instruction seam — the WORDS (pure, packages/core) ──────
//
// Pure, deterministic, no clock/IO (rule 0.3). The minimal stage-instruction
// seam-fill Wes signed off 2026-07-24 — see docs/open-questions.md D43/D44 for the
// richer per-stage/spec version deliberately deferred to slice 7. This says only
// what a worker needs to start ONE piece of real work and be steerable mid-run;
// it is intentionally stage-GENERIC (does not specialise planning vs implementing
// vs review — that specialisation is D43/D44).
export function composeStageInstruction(task: TaskRecord, plan: StageRunnerPlan): string {
  // ⚠ ABSENT vs EMPTY (the `title?` distinction the schema comment draws): a
  // title of `''` is a title someone chose and is used as-is; only an ABSENT
  // title (never created with one) falls back to the untitled label.
  const label = task.title ?? `untitled (${task.taskId})`;

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
