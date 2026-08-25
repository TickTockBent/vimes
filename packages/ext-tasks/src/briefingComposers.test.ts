import { describe, expect, it } from 'vitest';
import type { StageRunnerPlan, TaskRecord } from '@vimes/ext-host';
import { composeStageInstruction, type StageInstructionContext } from './stageInstruction.js';
import {
  briefingComposers,
  type BriefingInputs,
  type ProjectedTaskRecord,
} from './briefingComposers.js';

// ─── S19·U1 (slice-19 §3.1) — the composer table ─────────────────────────────
//
// ONE claim, asserted per stage: **the wrapper's output is BYTE-IDENTICAL to
// calling the prose module directly with today's equivalent arguments.** The
// equivalence pairs below are built from `stageInstruction.test.ts`'s own
// fixtures (the same populated planning / implementing / review tasks and the
// same plan blob), so a drift in either half shows up as a byte difference
// rather than as two tests that quietly agree about nothing.
//
// The second, quieter claim rides along in every pair: the wrapper is handed
// the PROJECTED record (slice-19 §3.2) while the direct call is handed the FULL
// one, `planArtifactHash` / `lastReview` / `lastCompletion` included — so a
// byte-identical result is also the evidence that the projection costs the
// briefing nothing.

const SPAWN: StageRunnerPlan = { mode: 'spawn' };

const REVIEW_PAYLOAD: NonNullable<TaskRecord['lastReview']> = {
  taskId: 'task-briefing-composers-0001',
  stage: 'implementing',
  attempt: 2,
  workOrderRev: 1,
  criteria: [
    { criterionId: 'ac-1', verdict: 'fail', note: 'the widget still does not work' },
    { criterionId: 'ac-2', verdict: 'pass' },
  ],
};

const COMPLETION_PAYLOAD: NonNullable<TaskRecord['lastCompletion']> = {
  taskId: 'task-briefing-composers-0001',
  stage: 'implementing',
  attempt: 2,
  workOrderRev: 1,
  worklog: {
    decisionsMade: ['used the existing adapter'],
    pathsRejected: ['a second projection'],
  },
};

// The plan blob `stageInstruction.test.ts` uses, verbatim.
const PLAN_BLOB = 'Step 1. Do the thing.\nStep 2. Verify.';

/**
 * A fully-populated task, carrying ALL THREE excluded fields so the projection
 * below has something real to remove.
 */
function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-briefing-composers-0001',
    projectRoot: '/home/foo',
    title: 'Fix the widget',
    scope: 'Make the widget do the thing.',
    explicitlyOut: ['Do not touch the gadget.', 'Do not refactor unrelated code.'],
    acceptanceCriteria: [
      { id: 'ac-1', text: 'The widget works.' },
      { id: 'ac-2', text: 'Tests pass.' },
    ],
    killCriterion: 'the build cannot be made green without a schema change.',
    planArtifactHash: 'sha256:deadbeef',
    lastReview: REVIEW_PAYLOAD,
    lastCompletion: COMPLETION_PAYLOAD,
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

/**
 * The engine's projection, rebuilt HERE by hand rather than imported: the
 * boundary checker forbids this package from reaching into `@vimes/core`, and
 * the tenant type is a structural twin by design (slice-19 A7). Building it
 * from the excluded key list is also what makes the pair honest — the direct
 * call gets the full record, the wrapper gets this.
 */
function projected(task: TaskRecord): ProjectedTaskRecord {
  const { planArtifactHash, lastReview, lastCompletion, ...kept } = task;
  void planArtifactHash;
  void lastReview;
  void lastCompletion;
  return kept;
}

/** One equivalence pair: what the wrapper is handed, and today's direct call. */
interface EquivalencePair {
  readonly name: string;
  readonly entryPoint: string;
  readonly task: TaskRecord;
  readonly inputs: BriefingInputs;
  readonly context?: StageInstructionContext;
}

const PLANNING_TASK = taskRecord({ stage: 'planning' });
const IMPLEMENTING_TASK = taskRecord({ stage: 'implementing' });
const REVIEW_TASK = taskRecord({ stage: 'review' });
const BACKLOG_TASK = taskRecord({ stage: 'backlog' });

const PAIRS: readonly EquivalencePair[] = [
  {
    // The shipped planning node declares `instance.record` and nothing else.
    name: 'planning — the record alone (the shipped declaration)',
    entryPoint: 'briefings/planning',
    task: PLANNING_TASK,
    inputs: { record: projected(PLANNING_TASK) },
  },
  {
    // The shipped implementing node declares the record, the plan artifact and
    // both report kinds. FIRST PASS: the plan is there, the fix-seed is not.
    name: 'implementing — first pass (record + plan, no fix-seed)',
    entryPoint: 'briefings/implementing',
    task: IMPLEMENTING_TASK,
    inputs: { record: projected(IMPLEMENTING_TASK), planText: PLAN_BLOB },
    context: { plan: PLAN_BLOB },
  },
  {
    // THE FIX PASS: plan plus both halves of the fix-seed (D46).
    name: 'implementing — fix pass (record + plan + both fix-seed halves)',
    entryPoint: 'briefings/implementing',
    task: IMPLEMENTING_TASK,
    inputs: {
      record: projected(IMPLEMENTING_TASK),
      planText: PLAN_BLOB,
      lastReview: REVIEW_PAYLOAD,
      lastCompletion: COMPLETION_PAYLOAD,
    },
    context: {
      plan: PLAN_BLOB,
      reviewFeedback: REVIEW_PAYLOAD.criteria,
      worklog: COMPLETION_PAYLOAD.worklog,
    },
  },
  {
    // Feedback WITHOUT a worklog — the asymmetric case the prose module
    // documents (a bounce before any completion report existed).
    name: 'implementing — feedback without a worklog',
    entryPoint: 'briefings/implementing',
    task: IMPLEMENTING_TASK,
    inputs: { record: projected(IMPLEMENTING_TASK), lastReview: REVIEW_PAYLOAD },
    context: { reviewFeedback: REVIEW_PAYLOAD.criteria },
  },
  {
    // A declared plan row whose artifact is ABSENT degrades to the no-plan
    // briefing — the input set simply carries no `planText` key.
    name: 'implementing — declared plan, absent artifact (absent-stays-absent)',
    entryPoint: 'briefings/implementing',
    task: IMPLEMENTING_TASK,
    inputs: { record: projected(IMPLEMENTING_TASK) },
  },
  {
    name: 'review — the record alone (the shipped declaration)',
    entryPoint: 'briefings/review',
    task: REVIEW_TASK,
    inputs: { record: projected(REVIEW_TASK) },
  },
  {
    name: 'generic — a stage with no specialisation',
    entryPoint: 'briefings/generic',
    task: BACKLOG_TASK,
    inputs: { record: projected(BACKLOG_TASK) },
  },
];

describe('briefingComposers — the table (slice-19 §3.1)', () => {
  it('carries EXACTLY the four declared entry points', () => {
    expect(Object.keys(briefingComposers).sort()).toEqual([
      'briefings/generic',
      'briefings/implementing',
      'briefings/planning',
      'briefings/review',
    ]);
  });

  it('every entry resolves to a callable composer', () => {
    for (const entryPoint of Object.keys(briefingComposers)) {
      expect(typeof briefingComposers[entryPoint]).toBe('function');
    }
  });

  it('has NO fallback row — a string outside the four is absent, not defaulted', () => {
    // §3.1: "Unresolvable entry-point → preflight refusal, never a generic
    // fallback." The table's job is to be MISSING the key, so the caller can
    // refuse; a fallback here would make that refusal unreachable.
    for (const stranger of [
      'briefings/audit',
      'briefings',
      'briefings/',
      'planning',
      'briefings/Planning',
      '',
      '__proto__ted',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(briefingComposers, stranger)).toBe(false);
    }
  });
});

describe('briefingComposers — byte-identity with today’s direct call', () => {
  for (const pair of PAIRS) {
    it(`${pair.name} → byte-identical`, () => {
      const composer = briefingComposers[pair.entryPoint];
      expect(composer).toBeDefined();
      const throughTheTable = (composer as (inputs: BriefingInputs) => string)(pair.inputs);
      const directly = composeStageInstruction(pair.task, SPAWN, pair.context);
      expect(throughTheTable).toBe(directly);
      // Not vacuous: both halves produced real prose.
      expect(throughTheTable.length).toBeGreaterThan(0);
    });
  }

  it('the pair set covers all four entry points', () => {
    expect(new Set(PAIRS.map((pair) => pair.entryPoint))).toEqual(
      new Set(Object.keys(briefingComposers)),
    );
  });

  it('an EMPTY input set beyond the record composes as NO context at all', () => {
    // The byte-load-bearing half of the reconstruction: `{}` and `undefined`
    // must be the same call. Asserted directly rather than only through a pair.
    const composer = briefingComposers['briefings/implementing'];
    expect(composer).toBeDefined();
    const task = taskRecord({ stage: 'implementing' });
    expect((composer as (inputs: BriefingInputs) => string)({ record: projected(task) })).toBe(
      composeStageInstruction(task, SPAWN, undefined),
    );
  });

  it('is DETERMINISTIC: the same input set twice → the same bytes', () => {
    for (const pair of PAIRS) {
      const composer = briefingComposers[pair.entryPoint] as (inputs: BriefingInputs) => string;
      expect(composer(pair.inputs)).toBe(composer(pair.inputs));
    }
  });
});

describe('briefingComposers — the undeclared record refuses, fail-closed', () => {
  it('throws when `instance.record` was not declared (slice-19 §3.5 compose-threw)', () => {
    for (const entryPoint of Object.keys(briefingComposers)) {
      const composer = briefingComposers[entryPoint] as (inputs: BriefingInputs) => string;
      expect(() => composer({})).toThrow('instance.record');
      // The message names the entry point, so the refusal says WHICH node.
      expect(() => composer({})).toThrow(entryPoint);
    }
  });
});
