import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../schemas.js';
import type { StageRunnerPlan } from './stageRunner.js';
import { composeStageInstruction } from './stageInstruction.js';

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
const RESUME: StageRunnerPlan = { mode: 'resume', appSessionId: 'app-resume-0001' };

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
      "If a message arrives while you're working, it's a human steering you mid-run —\nread it and adjust. It's a correction to THIS task, not a new task.",
    );
  });

  it('contains the "You do not advance the task yourself" sentence', () => {
    const instruction = composeStageInstruction(taskRecord(), SPAWN);
    expect(instruction).toContain(
      'When you believe the stage is done, briefly summarize what you did and what (if\n' +
        'anything) remains, then stop. You do not advance the task yourself — a human\n' +
        'reviews and moves it forward on the board.',
    );
  });

  it('is byte-identical, in full, to the signed-off spawn wording', () => {
    const task = taskRecord({ title: 'Fix the widget', stage: 'implementing', projectRoot: '/home/foo' });
    const instruction = composeStageInstruction(task, SPAWN);
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to make progress on one task.
This is real work.

  Task:      Fix the widget
  Stage:     implementing
  Directory: /home/foo — work in this directory; do not guess or invent a
             different path name.

Do the work this stage calls for, and stay within the task's scope.

If a message arrives while you're working, it's a human steering you mid-run —
read it and adjust. It's a correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if
anything) remains, then stop. You do not advance the task yourself — a human
reviews and moves it forward on the board.`,
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

describe('composeStageInstruction — resume wording', () => {
  it('is the shorter resume text, containing "{label} · {stage}" and "resuming your own earlier work"', () => {
    const task = taskRecord({ title: 'Fix the widget', stage: 'implementing' });
    const instruction = composeStageInstruction(task, RESUME);
    expect(instruction).toContain('resuming your own earlier work');
    expect(instruction).toContain('(Fix the widget · implementing)');
  });

  it('is byte-identical, in full, to the signed-off resume wording', () => {
    const task = taskRecord({ title: 'Fix the widget', stage: 'implementing' });
    const instruction = composeStageInstruction(task, RESUME);
    expect(instruction).toBe(
      `You are resuming your own earlier work on this task (Fix the widget · implementing). New
guidance has arrived — a human correction, or feedback from an independent
review. Read the latest messages, address them, and continue in the same
directory and scope. When done, summarize and stop; a human advances it.`,
    );
  });
});

describe('composeStageInstruction — determinism (rule 0.3)', () => {
  it('same (task, plan) in → byte-identical string out, spawn and resume', () => {
    const task = taskRecord();
    expect(composeStageInstruction(task, SPAWN)).toBe(composeStageInstruction(task, SPAWN));
    expect(composeStageInstruction(task, RESUME)).toBe(composeStageInstruction(task, RESUME));
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
    expect(() => composeStageInstruction(task, RESUME)).not.toThrow();
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
  `You are a worker session that VIMES dispatched to implement one task. This is
real work. The plan below has already been reviewed and approved — carry it out;
do not re-plan it.`;

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
      `You are a worker session that VIMES dispatched to implement one task. This is
real work. The plan below has already been reviewed and approved — carry it out;
do not re-plan it.

  Task:      Fix the widget
  Stage:     implementing
  Directory: /home/foo — work in this directory; do not guess or invent a
             different path name.

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

Implement the plan, staying within scope. If a message arrives while you're
working, it's a human steering you mid-run — read it and adjust. It's a
correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if
anything) remains, then stop. You do not advance the task yourself — a human
reviews and moves it forward on the board.`,
    );
  });

  it('reuses the SAME closing two paragraphs as the generic spawn text (verbatim contract)', () => {
    const implementing = composeStageInstruction(populatedImplementingTask(), SPAWN, {
      plan: PLAN_BLOB,
    });
    // The don't-advance sentence is byte-identical across both briefings.
    expect(implementing).toContain(
      'When you believe the stage is done, briefly summarize what you did and what (if\n' +
        'anything) remains, then stop. You do not advance the task yourself — a human\n' +
        'reviews and moves it forward on the board.',
    );
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
    const generic = `You are a worker session that VIMES dispatched to make progress on one task.
This is real work.

  Task:      Bare task
  Stage:     implementing
  Directory: /home/foo — work in this directory; do not guess or invent a
             different path name.

Do the work this stage calls for, and stay within the task's scope.

If a message arrives while you're working, it's a human steering you mid-run —
read it and adjust. It's a correction to THIS task, not a new task.

When you believe the stage is done, briefly summarize what you did and what (if
anything) remains, then stop. You do not advance the task yourself — a human
reviews and moves it forward on the board.`;
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
  `You are a worker session that VIMES dispatched to PLAN one task. You are in plan
mode: investigate directly and produce a plan — do not implement anything yet.`;

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
      `You are a worker session that VIMES dispatched to PLAN one task. You are in plan
mode: investigate directly and produce a plan — do not implement anything yet.

  Task:      Fix the widget
  Stage:     planning
  Directory: /home/foo — work in this directory; do not guess or invent a
             different path name.

Scope — what this task is:
Make the widget do the thing.

Explicitly out of scope — do not plan for these:
  - Do not touch the gadget.
  - Do not refactor unrelated code.

Acceptance criteria — your plan must make ALL of these achievable:
  - The widget works.
  - Tests pass.

Stop and report instead of planning if: the build cannot be made green without a schema change.

Investigate the codebase directly with your own tools — read files, search, run
read-only commands. Sub-agents are NOT authorized for this task; do the
exploration yourself. Do not wait for anything or anyone.

When you have a plan, present it by exiting plan mode — that is how you finish.
The plan is your ENTIRE deliverable: VIMES captures it and hands it to a fresh
session that will implement it without your context, so make it complete and
self-contained enough for a stranger to execute.`,
    );
  });

  it('NO degrade-to-generic: a bare planning task (none of the four fields) still returns THIS briefing', () => {
    const bare = taskRecord({ title: 'Bare plan task', stage: 'planning', projectRoot: '/home/foo' });
    const instruction = composeStageInstruction(bare, SPAWN);
    expect(instruction).toBe(
      `You are a worker session that VIMES dispatched to PLAN one task. You are in plan
mode: investigate directly and produce a plan — do not implement anything yet.

  Task:      Bare plan task
  Stage:     planning
  Directory: /home/foo — work in this directory; do not guess or invent a
             different path name.

Investigate the codebase directly with your own tools — read files, search, run
read-only commands. Sub-agents are NOT authorized for this task; do the
exploration yourself. Do not wait for anything or anyone.

When you have a plan, present it by exiting plan mode — that is how you finish.
The plan is your ENTIRE deliverable: VIMES captures it and hands it to a fresh
session that will implement it without your context, so make it complete and
self-contained enough for a stranger to execute.`,
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

// The longest common prefix of two strings — a test helper, not production code.
function longestCommonPrefix(first: string, second: string): string {
  let index = 0;
  const limit = Math.min(first.length, second.length);
  while (index < limit && first[index] === second[index]) {
    index += 1;
  }
  return first.slice(0, index);
}
