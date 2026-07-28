import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../schemas.js';
import type { StageRunnerPlan } from './stageRunner.js';
import { composeStageInstruction, type StageInstructionContext } from './stageInstruction.js';

// ─── the dispatcher's instruction seam — the WORDS ────────────────────────────
//
// This is the ONLY unit that pins the actual prose Wes signed off (rule 0.2
// applied to words, not numbers). The tests assert the exact substrings a
// change to this file must preserve, plus totality (I8) and determinism
// (rule 0.3) — no clock, no randomness, so the same (task, plan) must produce
// a byte-identical string forever.

const TASK_ID = 'task-stage-instruction-0001';
const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    projectRoot: PROJECT_ROOT,
    title: 'Fix the widget',
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

const SPAWN: StageRunnerPlan = { mode: 'spawn' };
// ⚠ `const RESUME: StageRunnerPlan = { mode: 'resume', appSessionId: … }` stood
// here until S7·7b-daemon. D46 deleted the variant from the union and the branch
// from the composer, so it no longer type-checks — see the two describe blocks
// below that lost their resume halves, and stageRunner.ts for the reversal itself.

describe('composeStageInstruction — spawn wording', () => {
  it('contains the exact Task:/Stage:/Directory: lines with the task\'s values', () => {
    const task = taskRecord({
      title: 'Fix the widget',
      stage: 'implementing',
      projectRoot: PROJECT_ROOT,
    });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).toContain('  Task:      Fix the widget');
    expect(instruction).toContain('  Stage:     implementing');
    expect(instruction).toContain(`  Directory: ${PROJECT_ROOT} — work in this directory; do not guess or invent a`);
  });

  it('contains the mid-run steering / correction sentence', () => {
    const instruction = composeStageInstruction(taskRecord(), SPAWN);
    expect(instruction).toContain(
      "If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a correction to THIS task, not a new task.",
    );
  });

  it('contains the "You do not advance the task yourself" sentence', () => {
    const instruction = composeStageInstruction(taskRecord(), SPAWN);
    expect(instruction).toContain(
      'When you believe the stage is done, briefly summarize what you did and what (if anything) remains, then stop. You do not advance the task yourself — a human reviews and moves it forward on the board.',
    );
  });

  it('is byte-identical, in full, to the signed-off spawn wording', () => {
    const task = taskRecord({ title: 'Fix the widget', stage: 'implementing', projectRoot: '/home/foo' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to make progress on one task. This is real work.

  Task:      Fix the widget
  Stage:     implementing
  Directory: /home/foo — work in this directory; do not guess or invent a different path name.

Do the work this stage calls for, and stay within the task's scope.

If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if anything) remains, then stop. You do not advance the task yourself — a human reviews and moves it forward on the board.`,
    );
  });
});

describe('composeStageInstruction — untitled task', () => {
  it('falls back to "untitled (<taskId>)" when title is ABSENT', () => {
    const task = taskRecord({ title: undefined });
    delete (task as { title?: string }).title;
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).toContain(`  Task:      untitled (${TASK_ID})`);
  });

  it('does NOT fall back when title is the EMPTY STRING — a chosen title, used as-is', () => {
    const task = taskRecord({ title: '' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).toContain('  Task:      \n');
  });
});

// ⚠ **`describe('composeStageInstruction — resume wording')` WAS DELETED HERE BY
// S7·7b-daemon (D46) — A RECORDED REVERSAL, NOT A DROPPED TEST.** Its two cases
// pinned the resume briefing ("You are resuming your own earlier work on this
// task (…)"), including a full byte-identical golden. That text is gone with the
// branch that produced it: `resolveStageRunner` cannot return `mode:'resume'`, the
// dispatcher cannot route to one, and `StageRunnerPlan` no longer carries the
// variant, so there is nothing left to call the composer with.
//
// The coverage did not vanish — it MOVED. What a fix now receives is the
// implementing briefing plus the fix-seed, and that is pinned (golden and all) by
// the S7·7b fix-seed block near the end of this file.

describe('composeStageInstruction — determinism (rule 0.3)', () => {
  it('same (task, plan) in → byte-identical string out', () => {
    // The `spawn and resume` half of this case's old name went with D46: `spawn`
    // is the only mode there is.
    const task = taskRecord();
    expect(composeStageInstruction(task, SPAWN)).toBe(composeStageInstruction(task, SPAWN));
  });
});

describe('composeStageInstruction — totality (I8)', () => {
  it('never throws on an empty-string title (a chosen title, not the untitled fallback)', () => {
    expect(() => composeStageInstruction(taskRecord({ title: '' }), SPAWN)).not.toThrow();
  });

  it('never throws on an unusual projectRoot', () => {
    const weirdRoots = ['', '   ', 'not/a/real/path', '../../etc/passwd', 'C:\\weird\\windows\\path'];
    for (const projectRoot of weirdRoots) {
      expect(() => composeStageInstruction(taskRecord({ projectRoot }), SPAWN)).not.toThrow();
    }
  });

  it('never throws on an absent title', () => {
    const task = taskRecord();
    delete (task as { title?: string }).title;
    expect(() => composeStageInstruction(task, SPAWN)).not.toThrow();
    // (The `RESUME` half of this assertion went with D46 — see the note above.)
  });
});

// ─── S7·7a: the fresh-implementer handoff (D44) ───────────────────────────────
//
// A spawn into the `implementing` stage that carries work-order and/or plan
// content gets the richer briefing. The tests below pin the signed-off prose
// (rule 0.2 for words), prove every section is conditional (I8), prove the degrade
// path is byte-identical to today (0.4), and pin the stable framing as a common
// cache prefix (verify-by-breaking).

// The stable OPENING paragraph — mirrored here from stageInstruction.ts (a
// deliberate copy, not an import: this test is the pin, so it must fail loudly if
// the source constant drifts). It carries NO task-specific value and is therefore
// a common prefix across every implementing briefing.
const STABLE_OPENING =
  `You are a worker session that VIMES dispatched to implement one task. This is real work. The plan below has already been reviewed and approved — carry it out; do not re-plan it.`;

// A fully-populated implementing task — every work-order field present.
function populatedImplementingTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    title: 'Fix the widget',
    stage: 'implementing',
    projectRoot: '/home/foo',
    scope: 'Make the widget do the thing.',
    explicitlyOut: ['Do not touch the gadget.', 'Do not refactor unrelated code.'],
    acceptanceCriteria: [
      { id: 'ac-1', text: 'The widget works.' },
      { id: 'ac-2', text: 'Tests pass.' },
    ],
    killCriterion: 'the build cannot be made green without a schema change.',
    ...overrides,
  });
}

const PLAN_BLOB = 'Step 1. Do the thing.\nStep 2. Verify.';

describe('composeStageInstruction — implementing handoff (S7·7a)', () => {
  it('is byte-identical, in full, to the signed-off implementing briefing', () => {
    const instruction = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
    });
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to implement one task. This is real work. The plan below has already been reviewed and approved — carry it out; do not re-plan it.

  Task:      Fix the widget
  Stage:     implementing
  Directory: /home/foo — work in this directory; do not guess or invent a different path name.

Scope — what this task is:
Make the widget do the thing.

Explicitly out of scope — do not do these:
  - Do not touch the gadget.
  - Do not refactor unrelated code.

Done when ALL of these are true:
  - The widget works.
  - Tests pass.

Stop and report instead of pushing through if: the build cannot be made green without a schema change.

The approved plan:

Step 1. Do the thing.
Step 2. Verify.

Implement the plan, staying within scope. If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a correction to THIS task, not a new task.

When the work is done, report it using the report_completion tool — a worklog with decisionsMade (the calls you made and why) and pathsRejected (dead ends you tried or considered and abandoned; the next attempt must not re-explore them). That report is how you finish and is your ENTIRE deliverable: VIMES records it and moves the task to review. You do not advance the task yourself.`,
    );
  });

  it('keeps the mid-run steering paragraph verbatim from the generic spawn text', () => {
    // ⚠ S7·7b DELIBERATE GOLDEN CHURN. This test used to assert the OTHER half of
    // the closing too — "reuses the SAME closing two paragraphs as the generic
    // spawn text". D53 broke that shared contract on purpose: the implementer now
    // finishes by REPORTING (an outcome the work states for itself), while the
    // generic worker still finishes by stopping for a human. Only the steering
    // paragraph is still shared, and it is still shared verbatim.
    const implementing = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
    });
    expect(implementing).toContain(
      "If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a " +
        'correction to THIS task, not a new task.',
    );
    // And the superseded sentence is GONE from this briefing — the pin on the
    // reversal, not merely on the new text.
    expect(implementing).not.toContain('a human reviews and moves it forward on the board.');
  });

  it('names the report_completion tool and its two worklog fields (the exact names 7b-daemon registers)', () => {
    // Load-bearing prose, exactly like planning's ExitPlanMode line and review's
    // report_review line: this is HOW the run ends, and `decisionsMade` /
    // `pathsRejected` are the tool's own input keys
    // (`reportCompletionPayloadSchema.worklog`).
    const implementing = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
    });
    expect(implementing).toContain('report it using the report_completion tool');
    expect(implementing).toContain('decisionsMade');
    expect(implementing).toContain('pathsRejected');
  });

  it('leaves the GENERIC, planning and review closings untouched by the S7·7b change', () => {
    // Green-stays-green, stated as its own case: the report_completion contract is
    // the IMPLEMENTING briefing's alone. The generic spawn text still ends with the
    // summarize-and-stop wording, and neither of the other two stage briefings has
    // learned about report_completion.
    const genericTask = taskRecord({ title: 'Bare task', stage: 'implementing' });
    const generic = composeStageInstruction(genericTask, SPAWN);
    expect(generic).toContain(
      'When you believe the stage is done, briefly summarize what you did and what (if anything) remains, then stop. You do not advance the task yourself — a human reviews and moves it forward on the board.',
    );
    expect(generic).not.toContain('report_completion');
    expect(composeStageInstruction(populatedPlanningTask(), SPAWN)).not.toContain(
      'report_completion',
    );
    expect(composeStageInstruction(populatedReviewTask(), SPAWN)).not.toContain('report_completion');
  });
});

describe('composeStageInstruction — implementing conditional sections (I8)', () => {
  it('renders ONLY the plan section when the plan is the only content present', () => {
    const task = taskRecord({ title: 'Just a plan', stage: 'implementing', projectRoot: '/p' });
    const instruction = composeStageInstruction(task, SPAWN, { plan: PLAN_BLOB });
    expect(instruction).toContain('The approved plan:\n\nStep 1. Do the thing.');
    expect(instruction).not.toContain('Scope — what this task is:');
    expect(instruction).not.toContain('Explicitly out of scope');
    expect(instruction).not.toContain('Done when ALL of these are true:');
    expect(instruction).not.toContain('Stop and report instead of pushing through if:');
    // Still the rich framing, not the generic text.
    expect(instruction.startsWith(STABLE_OPENING)).toBe(true);
  });

  it('renders ONLY the scope section when scope is the only content present', () => {
    const task = taskRecord({ scope: 'Only scope here.', stage: 'implementing' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).toContain('Scope — what this task is:\nOnly scope here.');
    expect(instruction).not.toContain('The approved plan:');
    expect(instruction).not.toContain('Explicitly out of scope');
  });

  it('omits explicitlyOut when the array is EMPTY (never an empty bulleted section)', () => {
    const task = taskRecord({ scope: 'S', explicitlyOut: [], stage: 'implementing' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Explicitly out of scope');
  });

  it('omits acceptanceCriteria when the array is EMPTY', () => {
    const task = taskRecord({ scope: 'S', acceptanceCriteria: [], stage: 'implementing' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Done when ALL of these are true:');
  });

  it('omits scope / killCriterion when they are the EMPTY STRING (carry no content)', () => {
    const task = taskRecord({
      scope: '',
      killCriterion: '',
      explicitlyOut: ['keep me'],
      stage: 'implementing',
    });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Scope — what this task is:');
    expect(instruction).not.toContain('Stop and report instead of pushing through if:');
    expect(instruction).toContain('Explicitly out of scope — do not do these:\n  - keep me');
  });

  it('omits the plan section for an empty / whitespace-carrying absent plan', () => {
    const task = populatedImplementingTask();
    expect(composeStageInstruction(task, SPAWN, { plan: '' })).not.toContain('The approved plan:');
    expect(composeStageInstruction(task, SPAWN, {})).not.toContain('The approved plan:');
    expect(composeStageInstruction(task, SPAWN)).not.toContain('The approved plan:');
  });

  it('never throws on empty arrays, empty strings, absent fields, or a huge plan blob', () => {
    const hugePlan = 'x'.repeat(200_000);
    expect(() =>
      composeStageInstruction(populatedImplementingTask(), SPAWN, { plan: hugePlan }),
    ).not.toThrow();
    expect(() =>
      composeStageInstruction(
        taskRecord({ scope: '', explicitlyOut: [], acceptanceCriteria: [], killCriterion: '' }),
        SPAWN,
      ),
    ).not.toThrow();
    // The huge blob really is carried, not truncated.
    const withHuge = composeStageInstruction(populatedImplementingTask(), SPAWN, { plan: hugePlan });
    expect(withHuge).toContain(hugePlan);
  });
});

describe('composeStageInstruction — implementing degrade (0.4)', () => {
  it('falls through to the GENERIC spawn text when NONE of the five is present', () => {
    // A bare implementing task with no work-order fields and no plan context.
    const bare = taskRecord({ title: 'Bare task', stage: 'implementing', projectRoot: '/home/foo' });
    const generic = `You are a worker session that VIMES dispatched to make progress on one task. This is real work.

  Task:      Bare task
  Stage:     implementing
  Directory: /home/foo — work in this directory; do not guess or invent a different path name.

Do the work this stage calls for, and stay within the task's scope.

If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if anything) remains, then stop. You do not advance the task yourself — a human reviews and moves it forward on the board.`;
    expect(composeStageInstruction(bare, SPAWN)).toBe(generic);
    // Absent-stays-absent: an empty context, or an empty plan, is the same as none.
    expect(composeStageInstruction(bare, SPAWN, {})).toBe(generic);
    expect(composeStageInstruction(bare, SPAWN, { plan: '' })).toBe(generic);
  });

  it('does NOT take the IMPLEMENTING rich branch for a planning stage even with a plan', () => {
    // S7·5c (D50): a planning-stage spawn now takes its OWN briefing branch, so it
    // must NOT be the implementing opening AND must NOT carry an approved-plan blob
    // (planning PRODUCES the plan — it never receives one).
    const planningTask = populatedImplementingTask({ stage: 'planning' });
    const instruction = composeStageInstruction(planningTask, SPAWN, { plan: PLAN_BLOB });
    // Not the implementer opening — it took the planning branch instead.
    expect(instruction.startsWith(STABLE_OPENING)).toBe(false);
    expect(instruction).toContain('to PLAN one task');
    expect(instruction).not.toContain('The approved plan:');
  });
});

describe('composeStageInstruction — implementing cache prefix (verify-by-breaking)', () => {
  it('the stable opening is a common PREFIX across two DIFFERENT populated tasks', () => {
    const first = composeStageInstruction(
      populatedImplementingTask({ title: 'Task A', scope: 'scope A' }),
      SPAWN,
      { plan: 'plan A' },
    );
    const second = composeStageInstruction(
      populatedImplementingTask({ title: 'Task B', scope: 'a completely different scope' }),
      SPAWN,
      { plan: 'plan B, unrelated' },
    );
    // Both begin with the byte-stable framing. If a variable line were moved into
    // the prefix (e.g. scope rendered before the opening), this reddens.
    expect(first.startsWith(STABLE_OPENING)).toBe(true);
    expect(second.startsWith(STABLE_OPENING)).toBe(true);
  });

  it('perturbing a work-order field leaves the framing prefix byte-unchanged', () => {
    // Two tasks identical in title/projectRoot, differing only in scope: their
    // common prefix must still cover the whole opening + Task/Stage/Directory block.
    const base = populatedImplementingTask({ scope: 'the original scope' });
    const perturbed = populatedImplementingTask({ scope: 'a perturbed scope, longer than before' });
    const baseInstruction = composeStageInstruction(base, SPAWN, { plan: PLAN_BLOB });
    const perturbedInstruction = composeStageInstruction(perturbed, SPAWN, { plan: PLAN_BLOB });
    const commonPrefix = longestCommonPrefix(baseInstruction, perturbedInstruction);
    // The shared prefix reaches through the Directory block (up to the Scope label).
    expect(commonPrefix.startsWith(STABLE_OPENING)).toBe(true);
    expect(commonPrefix).toContain('Directory: /home/foo — work in this directory');
  });
});

describe('composeStageInstruction — implementing determinism (rule 0.3)', () => {
  it('same (task, plan, context) in → byte-identical string out, twice', () => {
    const task = populatedImplementingTask();
    const first = composeStageInstruction(task, SPAWN, { plan: PLAN_BLOB });
    const second = composeStageInstruction(task, SPAWN, { plan: PLAN_BLOB });
    expect(first).toBe(second);
  });
});

// ─── S7·5c: the planning briefing (D50) ───────────────────────────────────────
//
// A spawn into the `planning` stage gets the plan-directed briefing. Unlike the
// implementing branch there is NO degrade-to-generic — even a bare planning task
// returns this briefing, because the plan-directed + no-sub-agent framing is
// always load-bearing for planning (the tools-restriction choke is the primary
// block; this prose is the belt). The tests pin the signed-off prose (rule 0.2),
// prove every section is conditional (I8), pin the stable framing as a cache
// prefix, and prove NO degrade.

// The stable OPENING paragraph — mirrored here from stageInstruction.ts (a
// deliberate copy, not an import: this test is the pin, so it must fail loudly if
// the source constant drifts).
const STABLE_PLANNING_OPENING =
  `You are a worker session that VIMES dispatched to PLAN one task. You are in plan mode: investigate directly and produce a plan — do not implement anything yet.`;

// A fully-populated planning task — every work-order field present. There is no
// plan blob for planning (planning PRODUCES the plan).
function populatedPlanningTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    title: 'Fix the widget',
    stage: 'planning',
    projectRoot: '/home/foo',
    scope: 'Make the widget do the thing.',
    explicitlyOut: ['Do not touch the gadget.', 'Do not refactor unrelated code.'],
    acceptanceCriteria: [
      { id: 'ac-1', text: 'The widget works.' },
      { id: 'ac-2', text: 'Tests pass.' },
    ],
    killCriterion: 'the build cannot be made green without a schema change.',
    ...overrides,
  });
}

describe('composeStageInstruction — planning briefing (S7·5c)', () => {
  it('is byte-identical, in full, to the signed-off planning briefing (all four fields)', () => {
    const instruction = composeStageInstruction(populatedPlanningTask(), SPAWN);
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to PLAN one task. You are in plan mode: investigate directly and produce a plan — do not implement anything yet.

  Task:      Fix the widget
  Stage:     planning
  Directory: /home/foo — work in this directory; do not guess or invent a different path name.

Scope — what this task is:
Make the widget do the thing.

Explicitly out of scope — do not plan for these:
  - Do not touch the gadget.
  - Do not refactor unrelated code.

Acceptance criteria — your plan must make ALL of these achievable:
  - The widget works.
  - Tests pass.

Stop and report instead of planning if: the build cannot be made green without a schema change.

Investigate the codebase directly with your own tools — read files, search, run read-only commands. Sub-agents are NOT authorized for this task; do the exploration yourself. Do not wait for anything or anyone.

When you have a plan, present it by exiting plan mode — that is how you finish. The plan is your ENTIRE deliverable: VIMES captures it and hands it to a fresh session that will implement it without your context, so make it complete and self-contained enough for a stranger to execute.`,
    );
  });

  it('NO degrade-to-generic: a bare planning task (none of the four fields) still returns THIS briefing', () => {
    const bare = taskRecord({ title: 'Bare plan task', stage: 'planning', projectRoot: '/home/foo' });
    const instruction = composeStageInstruction(bare, SPAWN);
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to PLAN one task. You are in plan mode: investigate directly and produce a plan — do not implement anything yet.

  Task:      Bare plan task
  Stage:     planning
  Directory: /home/foo — work in this directory; do not guess or invent a different path name.

Investigate the codebase directly with your own tools — read files, search, run read-only commands. Sub-agents are NOT authorized for this task; do the exploration yourself. Do not wait for anything or anyone.

When you have a plan, present it by exiting plan mode — that is how you finish. The plan is your ENTIRE deliverable: VIMES captures it and hands it to a fresh session that will implement it without your context, so make it complete and self-contained enough for a stranger to execute.`,
    );
    // It must NOT be the generic spawn text (that is the whole point of no-degrade).
    expect(instruction).not.toContain(
      'You are a worker session that VIMES dispatched to make progress on one task.',
    );
  });

  it('sanity: carries the load-bearing lines and the planning stage header', () => {
    const instruction = composeStageInstruction(populatedPlanningTask(), SPAWN);
    expect(instruction).toContain('exiting plan mode');
    expect(instruction).toContain('Sub-agents are NOT authorized');
    expect(instruction).toContain('  Stage:     planning');
  });
});

describe('composeStageInstruction — planning conditional sections (I8)', () => {
  it('renders ONLY the opening/Task block + closing when no work-order fields are present', () => {
    const bare = taskRecord({ title: 'Bare', stage: 'planning', projectRoot: '/p' });
    const instruction = composeStageInstruction(bare, SPAWN);
    expect(instruction).not.toContain('Scope — what this task is:');
    expect(instruction).not.toContain('Explicitly out of scope');
    expect(instruction).not.toContain('Acceptance criteria — your plan');
    expect(instruction).not.toContain('Stop and report instead of planning if:');
    expect(instruction.startsWith(STABLE_PLANNING_OPENING)).toBe(true);
  });

  it('omits scope when it is the EMPTY STRING; other sections still render', () => {
    const task = populatedPlanningTask({ scope: '' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Scope — what this task is:');
    expect(instruction).toContain('Explicitly out of scope — do not plan for these:');
  });

  it('omits explicitlyOut when the array is EMPTY', () => {
    const task = populatedPlanningTask({ explicitlyOut: [] });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Explicitly out of scope');
    expect(instruction).toContain('Scope — what this task is:');
  });

  it('omits acceptanceCriteria when the array is EMPTY', () => {
    const task = populatedPlanningTask({ acceptanceCriteria: [] });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Acceptance criteria — your plan');
  });

  it('omits killCriterion when it is the EMPTY STRING', () => {
    const task = populatedPlanningTask({ killCriterion: '' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Stop and report instead of planning if:');
  });

  it('never carries an approved-plan section (planning produces the plan, never receives one)', () => {
    // Even if a caller mistakenly passes a plan blob, the planning branch ignores it.
    const instruction = composeStageInstruction(populatedPlanningTask(), SPAWN, { plan: PLAN_BLOB });
    expect(instruction).not.toContain('The approved plan:');
  });
});

describe('composeStageInstruction — planning cache prefix + determinism', () => {
  it('the stable opening is a common PREFIX across two DIFFERENT planning tasks', () => {
    const first = composeStageInstruction(
      populatedPlanningTask({ title: 'Task A', scope: 'scope A' }),
      SPAWN,
    );
    const second = composeStageInstruction(
      populatedPlanningTask({ title: 'Task B', scope: 'a completely different scope' }),
      SPAWN,
    );
    expect(first.startsWith(STABLE_PLANNING_OPENING)).toBe(true);
    expect(second.startsWith(STABLE_PLANNING_OPENING)).toBe(true);
  });

  it('perturbing a work-order field leaves the framing prefix byte-unchanged', () => {
    const base = populatedPlanningTask({ scope: 'the original scope' });
    const perturbed = populatedPlanningTask({ scope: 'a perturbed scope, longer than before' });
    const commonPrefix = longestCommonPrefix(
      composeStageInstruction(base, SPAWN),
      composeStageInstruction(perturbed, SPAWN),
    );
    expect(commonPrefix.startsWith(STABLE_PLANNING_OPENING)).toBe(true);
    expect(commonPrefix).toContain('Directory: /home/foo — work in this directory');
  });

  it('same (task, plan) in → byte-identical string out, twice', () => {
    const task = populatedPlanningTask();
    expect(composeStageInstruction(task, SPAWN)).toBe(composeStageInstruction(task, SPAWN));
  });
});

// ─── S7·6a: the review briefing (D43/D46) ─────────────────────────────────────
//
// A spawn into the `review` stage gets the review-directed briefing. Like planning
// there is NO degrade-to-generic — even a bare review task returns this briefing,
// because the review framing + the report_review contract are always load-bearing.
// The KEY difference from S7·5c/S7·7a: acceptance criteria are rendered WITH their
// `[id]`, because the reviewer must report per-criterion BY id. The tests pin the
// signed-off prose (rule 0.2), prove every section is conditional (I8), pin the
// stable framing as a cache prefix, and prove NO degrade.

// The stable OPENING paragraph — mirrored here from stageInstruction.ts (a
// deliberate copy, not an import: this test is the pin, so it must fail loudly if
// the source constant drifts).
const STABLE_REVIEW_OPENING =
  `You are a worker session that VIMES dispatched to REVIEW one task's implementation independently. You did not write this code — judge it fresh against the acceptance criteria below.`;

// A fully-populated review task — every rendered work-order field present.
function populatedReviewTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    title: 'Fix the widget',
    stage: 'review',
    projectRoot: '/home/foo',
    scope: 'Make the widget do the thing.',
    explicitlyOut: ['Do not touch the gadget.', 'Do not refactor unrelated code.'],
    acceptanceCriteria: [
      { id: 'ac-1', text: 'The widget works.' },
      { id: 'ac-2', text: 'Tests pass.' },
    ],
    killCriterion: 'the build cannot be made green without a schema change.',
    ...overrides,
  });
}

describe('composeStageInstruction — review briefing (S7·6a)', () => {
  it('is byte-identical, in full, to the signed-off review briefing (criteria rendered WITH ids)', () => {
    const instruction = composeStageInstruction(populatedReviewTask(), SPAWN);
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to REVIEW one task's implementation independently. You did not write this code — judge it fresh against the acceptance criteria below.

  Task:      Fix the widget
  Stage:     review
  Directory: /home/foo — the implementation is here; review it in place.

Scope — what this task was meant to do:
Make the widget do the thing.

Acceptance criteria — judge EACH as pass or fail:
  - [ac-1] The widget works.
  - [ac-2] Tests pass.

Explicitly out of scope — do not hold these against it:
  - Do not touch the gadget.
  - Do not refactor unrelated code.

Inspect the implementation directly with your own tools — read the changed files, run git diff and the tests, search as needed. Sub-agents are NOT authorized for this task; do the review yourself.

When you have judged every criterion, report your verdict using the report_review tool — one entry per criterion (its id, pass or fail, a short note). That report is how you finish and is your ENTIRE deliverable: VIMES reads it to decide whether the task is done or goes back for fixes. You do not advance the task yourself.`,
    );
  });

  it('renders acceptance criteria WITH their [id] — the difference from planning/implementing', () => {
    const instruction = composeStageInstruction(populatedReviewTask(), SPAWN);
    expect(instruction).toContain('  - [ac-1] The widget works.');
    expect(instruction).toContain('  - [ac-2] Tests pass.');
  });

  it('names the report_review tool (the exact name S7·6b registers)', () => {
    const instruction = composeStageInstruction(populatedReviewTask(), SPAWN);
    expect(instruction).toContain('report your verdict using the report_review');
    expect(instruction).toContain('Sub-agents are NOT authorized');
  });

  it('DEGENERATE: a review task with NO acceptance criteria still returns the review briefing, criteria section omitted, no-criteria clause rendered instead', () => {
    const bare = taskRecord({ title: 'Bare review task', stage: 'review', projectRoot: '/home/foo' });
    const instruction = composeStageInstruction(bare, SPAWN);
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to REVIEW one task's implementation independently. You did not write this code — judge it fresh against the acceptance criteria below.

  Task:      Bare review task
  Stage:     review
  Directory: /home/foo — the implementation is here; review it in place.

This task enumerates no acceptance criteria. Derive sensible criteria yourself from the scope and the implementation, and report each one through report_review — mint a short id per criterion so each verdict is keyed.

Inspect the implementation directly with your own tools — read the changed files, run git diff and the tests, search as needed. Sub-agents are NOT authorized for this task; do the review yourself.

When you have judged every criterion, report your verdict using the report_review tool — one entry per criterion (its id, pass or fail, a short note). That report is how you finish and is your ENTIRE deliverable: VIMES reads it to decide whether the task is done or goes back for fixes. You do not advance the task yourself.`,
    );
    // NO degrade-to-generic (the whole point).
    expect(instruction).not.toContain(
      'You are a worker session that VIMES dispatched to make progress on one task.',
    );
    expect(instruction).not.toContain('Acceptance criteria — judge EACH');
  });

  // ─── S7·7f: the no-criteria review clause ─────────────────────────────────────
  it('renders the no-criteria clause when acceptanceCriteria is ABSENT, and NOT when present', () => {
    const withoutCriteria = composeStageInstruction(
      taskRecord({ title: 'Bare review task', stage: 'review', projectRoot: '/home/foo' }),
      SPAWN,
    );
    expect(withoutCriteria).toContain(
      'This task enumerates no acceptance criteria. Derive sensible criteria yourself from the scope and the implementation, and report each one through report_review — mint a short id per criterion so each verdict is keyed.',
    );

    const withCriteria = composeStageInstruction(populatedReviewTask(), SPAWN);
    expect(withCriteria).not.toContain('This task enumerates no acceptance criteria.');
  });

  it('renders the no-criteria clause when acceptanceCriteria is an EMPTY array too', () => {
    const instruction = composeStageInstruction(populatedReviewTask({ acceptanceCriteria: [] }), SPAWN);
    expect(instruction).toContain('This task enumerates no acceptance criteria.');
  });
});

describe('composeStageInstruction — review conditional sections (I8)', () => {
  it('omits scope when it is the EMPTY STRING; other sections still render', () => {
    const task = populatedReviewTask({ scope: '' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Scope — what this task was meant to do:');
    expect(instruction).toContain('Acceptance criteria — judge EACH as pass or fail:');
  });

  it('omits acceptanceCriteria when the array is EMPTY', () => {
    const task = populatedReviewTask({ acceptanceCriteria: [] });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Acceptance criteria — judge EACH');
    expect(instruction).toContain('Scope — what this task was meant to do:');
  });

  it('omits explicitlyOut when the array is EMPTY', () => {
    const task = populatedReviewTask({ explicitlyOut: [] });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).not.toContain('Explicitly out of scope — do not hold these against it:');
    expect(instruction).toContain('Acceptance criteria — judge EACH as pass or fail:');
  });

  it('does NOT render a killCriterion section (review omits it)', () => {
    const instruction = composeStageInstruction(populatedReviewTask(), SPAWN);
    expect(instruction).not.toContain('Stop and report');
  });

  it('renders ONLY the opening/Task block + closing when no work-order fields are present', () => {
    const bare = taskRecord({ title: 'Bare', stage: 'review', projectRoot: '/p' });
    const instruction = composeStageInstruction(bare, SPAWN);
    expect(instruction).not.toContain('Scope — what this task was meant to do:');
    expect(instruction).not.toContain('Acceptance criteria — judge EACH');
    expect(instruction).not.toContain('Explicitly out of scope');
    expect(instruction.startsWith(STABLE_REVIEW_OPENING)).toBe(true);
  });
});

describe('composeStageInstruction — review cache prefix + determinism', () => {
  it('the stable opening is a common PREFIX across two DIFFERENT review tasks', () => {
    const first = composeStageInstruction(
      populatedReviewTask({ title: 'Task A', scope: 'scope A' }),
      SPAWN,
    );
    const second = composeStageInstruction(
      populatedReviewTask({ title: 'Task B', scope: 'a completely different scope' }),
      SPAWN,
    );
    expect(first.startsWith(STABLE_REVIEW_OPENING)).toBe(true);
    expect(second.startsWith(STABLE_REVIEW_OPENING)).toBe(true);
  });

  it('perturbing a work-order field leaves the framing prefix byte-unchanged', () => {
    const base = populatedReviewTask({ scope: 'the original scope' });
    const perturbed = populatedReviewTask({ scope: 'a perturbed scope, longer than before' });
    const commonPrefix = longestCommonPrefix(
      composeStageInstruction(base, SPAWN),
      composeStageInstruction(perturbed, SPAWN),
    );
    expect(commonPrefix.startsWith(STABLE_REVIEW_OPENING)).toBe(true);
    expect(commonPrefix).toContain('Directory: /home/foo — the implementation is here');
  });

  it('never carries an approved-plan section (review judges the code, it does not receive a plan)', () => {
    const instruction = composeStageInstruction(populatedReviewTask(), SPAWN, { plan: PLAN_BLOB });
    expect(instruction).not.toContain('The approved plan:');
  });

  it('same (task, plan) in → byte-identical string out, twice', () => {
    const task = populatedReviewTask();
    expect(composeStageInstruction(task, SPAWN)).toBe(composeStageInstruction(task, SPAWN));
  });
});

// ─── S7·7b: the FIX-SEED (D46 + D53's on-disk-diff rider) ─────────────────────
//
// D46 killed the resume, so a fix after a failed review arrives at the SAME
// implementing-spawn branch a first pass does. The only difference is the context:
// review feedback + the prior attempt's worklog. The tests below pin the prose,
// prove the seed is strictly additive (absent → byte-identical to S7·7a), prove
// feedback-without-worklog composes cleanly (the real case: a bounce before any
// completion was reported), and pin the framing prefix as still stable.

const FIX_FEEDBACK: NonNullable<StageInstructionContext['reviewFeedback']> = [
  { criterionId: 'ac-1', verdict: 'pass', note: 'the widget works now' },
  { criterionId: 'ac-2', verdict: 'fail', note: 'two tests still red' },
  { criterionId: 'ac-3', verdict: 'fail' },
];

const FIX_WORKLOG: NonNullable<StageInstructionContext['worklog']> = {
  decisionsMade: ['reused the existing helper rather than a new one'],
  pathsRejected: ['a bespoke parser — too slow', 'patching the caller — wrong layer'],
};

describe('composeStageInstruction — fix-seed (S7·7b)', () => {
  it('is byte-identical, in full, to the signed-off FIX briefing (feedback + worklog)', () => {
    const instruction = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
      reviewFeedback: FIX_FEEDBACK,
      worklog: FIX_WORKLOG,
    });
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to implement one task. This is real work. The plan below has already been reviewed and approved — carry it out; do not re-plan it.

  Task:      Fix the widget
  Stage:     implementing
  Directory: /home/foo — work in this directory; do not guess or invent a different path name.

Scope — what this task is:
Make the widget do the thing.

Explicitly out of scope — do not do these:
  - Do not touch the gadget.
  - Do not refactor unrelated code.

Done when ALL of these are true:
  - The widget works.
  - Tests pass.

Stop and report instead of pushing through if: the build cannot be made green without a schema change.

The approved plan:

Step 1. Do the thing.
Step 2. Verify.

This is a FIX. A previous attempt at this task was implemented and then FAILED an independent review. You did not write that attempt — but its changes are ALREADY ON DISK in the directory above. Read them first (\`git diff\`, and \`git status\` for new files) so you are correcting existing work rather than starting over on top of it.

The review's verdict on that attempt — every FAIL is your job:
  - [ac-2] FAIL — two tests still red
  - [ac-3] FAIL
  - [ac-1] PASS — the widget works now

The previous attempt's own worklog — do NOT re-explore what it already rejected. If you think a rejected path is right after all, say so in your report rather than quietly retrying it.

Decisions made:
  - reused the existing helper rather than a new one

Paths rejected:
  - a bespoke parser — too slow
  - patching the caller — wrong layer

Implement the plan, staying within scope. If a message arrives while you're working, it's a human steering you mid-run — read it and adjust. It's a correction to THIS task, not a new task.

When the work is done, report it using the report_completion tool — a worklog with decisionsMade (the calls you made and why) and pathsRejected (dead ends you tried or considered and abandoned; the next attempt must not re-explore them). That report is how you finish and is your ENTIRE deliverable: VIMES records it and moves the task to review. You do not advance the task yourself.`,
    );
  });

  it('points at the diff ON DISK and never inlines one (D53 rider)', () => {
    const instruction = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
      reviewFeedback: FIX_FEEDBACK,
    });
    expect(instruction).toContain('its changes are ALREADY ON DISK in the directory above');
    expect(instruction).toContain('`git diff`');
    // The refinement, stated negatively: no diff SECTION exists to inline into.
    expect(instruction).not.toContain('The previous diff:');
    expect(instruction).not.toContain('diff --git');
  });

  it('renders FAILS FIRST, then passes, both with their [id]', () => {
    // Fails first because they are the work; passes rendered at all because a fixer
    // needs to know what NOT to break reaching for a failure.
    const instruction = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      reviewFeedback: FIX_FEEDBACK,
    });
    const firstFail = instruction.indexOf('  - [ac-2] FAIL');
    const secondFail = instruction.indexOf('  - [ac-3] FAIL');
    const onlyPass = instruction.indexOf('  - [ac-1] PASS');
    expect(firstFail).toBeGreaterThan(-1);
    expect(secondFail).toBeGreaterThan(firstFail);
    expect(onlyPass).toBeGreaterThan(secondFail);
  });

  it('omits the "— note" tail for a criterion with no note (never a dangling dash)', () => {
    const instruction = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      reviewFeedback: [{ criterionId: 'ac-3', verdict: 'fail' }],
    });
    expect(instruction).toContain('  - [ac-3] FAIL\n');
    expect(instruction).not.toContain('[ac-3] FAIL —');
  });

  it('FEEDBACK WITHOUT WORKLOG composes cleanly — the real pre-first-report case', () => {
    // A fix can be dispatched before any `report_completion` exists (a bounce the
    // orchestrator made by hand, or an attempt whose author never reported). The
    // preamble and the verdict render; the worklog heading must NOT appear at all.
    const instruction = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
      reviewFeedback: FIX_FEEDBACK,
    });
    expect(instruction).toContain('This is a FIX.');
    expect(instruction).toContain("The review's verdict on that attempt");
    expect(instruction).not.toContain("The previous attempt's own worklog");
    expect(instruction).not.toContain('Decisions made:');
    expect(instruction).not.toContain('Paths rejected:');
  });

  it('WORKLOG WITHOUT FEEDBACK still earns the preamble, and omits the verdict block', () => {
    const instruction = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      worklog: FIX_WORKLOG,
    });
    expect(instruction).toContain('This is a FIX.');
    expect(instruction).not.toContain("The review's verdict on that attempt");
    expect(instruction).toContain('Decisions made:');
  });

  it('renders each worklog sub-list independently (one present, one empty)', () => {
    const decisionsOnly = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      worklog: { decisionsMade: ['kept the helper'], pathsRejected: [] },
    });
    expect(decisionsOnly).toContain('Decisions made:\n  - kept the helper');
    expect(decisionsOnly).not.toContain('Paths rejected:');

    const rejectedOnly = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      worklog: { decisionsMade: [], pathsRejected: ['the bespoke parser'] },
    });
    expect(rejectedOnly).toContain('Paths rejected:\n  - the bespoke parser');
    expect(rejectedOnly).not.toContain('Decisions made:');
  });

  it('a fix-seed-ONLY task does not degrade to the generic text (the seed would be lost)', () => {
    // Reachable: a hand-created task with no work-order fields and no plan, bounced
    // out of review. Degrading here would silently drop the one thing the fix loop
    // cannot afford to lose.
    const bare = taskRecord({ title: 'Bare task', stage: 'implementing', projectRoot: '/home/foo' });
    const instruction = composeStageInstruction(bare, SPAWN, { reviewFeedback: FIX_FEEDBACK });
    expect(instruction.startsWith(STABLE_OPENING)).toBe(true);
    expect(instruction).toContain('  - [ac-2] FAIL — two tests still red');
    expect(instruction).not.toContain(
      'You are a worker session that VIMES dispatched to make progress on one task.',
    );
  });
});

describe('composeStageInstruction — fix-seed absent-stays-absent (S7·7a discipline)', () => {
  it('an absent seed is byte-identical to the S7·7a output', () => {
    const task = populatedImplementingTask();
    const noSeed = composeStageInstruction(task, SPAWN, { plan: PLAN_BLOB });
    // Every shape of "nothing to say" must produce the same bytes: no fields at
    // all, explicitly-undefined fields, and empty collections.
    expect(
      composeStageInstruction(task, SPAWN, {
        plan: PLAN_BLOB,
        reviewFeedback: [],
        worklog: { decisionsMade: [], pathsRejected: [] },
      }),
    ).toBe(noSeed);
    expect(
      composeStageInstruction(task, SPAWN, {
        plan: PLAN_BLOB,
        reviewFeedback: undefined,
        worklog: undefined,
      }),
    ).toBe(noSeed);
    // And the no-seed output really carries none of the fix prose.
    expect(noSeed).not.toContain('This is a FIX.');
    expect(noSeed).not.toContain("The review's verdict");
    expect(noSeed).not.toContain("The previous attempt's own worklog");
  });

  it('a bare task with an EMPTY seed still degrades to the generic spawn text', () => {
    // The degrade rule survives the widening: an empty seed carries no content, so
    // it must not be what tips a bare task into the rich briefing.
    const bare = taskRecord({ title: 'Bare task', stage: 'implementing', projectRoot: '/home/foo' });
    const generic = composeStageInstruction(bare, SPAWN);
    expect(
      composeStageInstruction(bare, SPAWN, {
        reviewFeedback: [],
        worklog: { decisionsMade: [], pathsRejected: [] },
      }),
    ).toBe(generic);
  });
});

describe('composeStageInstruction — fix-seed prefix stability + determinism (rule 0.3)', () => {
  it('the stable opening is still a common PREFIX with and without a fix-seed', () => {
    const withoutSeed = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
    });
    const withSeed = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
      reviewFeedback: FIX_FEEDBACK,
      worklog: FIX_WORKLOG,
    });
    expect(withSeed.startsWith(STABLE_OPENING)).toBe(true);
    const commonPrefix = longestCommonPrefix(withoutSeed, withSeed);
    expect(commonPrefix.startsWith(STABLE_OPENING)).toBe(true);
    // The seed is appended AFTER the plan, so the shared prefix reaches all the way
    // through the plan block — a fix dispatch re-reads the first pass's whole
    // briefing at cache-read rates.
    expect(commonPrefix).toContain('The approved plan:');
    expect(commonPrefix).toContain('Step 2. Verify.');
  });

  it('same (task, plan, fix-seed) in → byte-identical string out, twice', () => {
    const task = populatedImplementingTask();
    const context = { plan: PLAN_BLOB, reviewFeedback: FIX_FEEDBACK, worklog: FIX_WORKLOG };
    expect(composeStageInstruction(task, SPAWN, context)).toBe(
      composeStageInstruction(task, SPAWN, context),
    );
  });

  it('never throws on a malformed seed (I8 — the context crosses a replay boundary)', () => {
    // `lastReview`/`lastCompletion` come off a REPLAYED record, so a partially
    // written or hand-edited one must degrade to "section omitted", never throw.
    const malformedContexts: unknown[] = [
      { reviewFeedback: null },
      { reviewFeedback: 'not-an-array' },
      { reviewFeedback: [{}] },
      { worklog: null },
      { worklog: {} },
      { worklog: { decisionsMade: 'nope', pathsRejected: 7 } },
      { worklog: { decisionsMade: null, pathsRejected: null } },
    ];
    for (const malformedContext of malformedContexts) {
      expect(
        () =>
          composeStageInstruction(
            populatedImplementingTask(),
            SPAWN,
            malformedContext as StageInstructionContext,
          ),
        JSON.stringify(malformedContext),
      ).not.toThrow();
    }
  });
});

// The longest common prefix of two strings — a test helper, not production code.
function longestCommonPrefix(first: string, second: string): string {
  let index = 0;
  const limit = Math.min(first.length, second.length);
  while (index < limit && first[index] === second[index]) {
    index += 1;
  }
  return first.slice(0, index);
}
