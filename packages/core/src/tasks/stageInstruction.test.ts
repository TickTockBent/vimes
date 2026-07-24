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
