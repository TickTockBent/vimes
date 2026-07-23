import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../schemas.js';
import { TASK_STAGES } from './taskStateMachine.js';
import { resolveStageRunner, type StageRunnerPlan } from './stageRunner.js';

// ─── slice 6 step 7 — who runs the stage ─────────────────────────────────────
//
// Two rules with opposite motives share this module, and the tests are shaped to
// match that asymmetry:
//
//   • the FIX LOOP resume is an OPTIMISATION — spot-checks are enough, because
//     the failure mode is "we paid for a cold agent", which costs money and not
//     correctness;
//   • the INDEPENDENCE RULE is a CORRECTNESS rule — a review that runs in the
//     authoring session cannot see the flaw it created, and the gate silently
//     degrades into self-approval. A spot-check cannot hold that line, so it is
//     asserted by ENUMERATION (see the `review` describe block).

const TASK_ID = 'task-stage-runner-0001';
const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';
const FIRST_IMPLEMENTING_SESSION = 'app-impl-0001';
const SECOND_IMPLEMENTING_SESSION = 'app-impl-0002';
const PLANNING_SESSION = 'app-plan-0001';
const REVIEW_SESSION = 'app-review-0001';

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    projectRoot: PROJECT_ROOT,
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

// Refs, written the way the projection writes them: oldest first, appended.
function ref(stage: string, appSessionId: string): TaskRecord['sessionRefs'][number] {
  return { stage, appSessionId };
}

describe('resolveStageRunner — the fix loop resumes the hot author', () => {
  it('implementing + a prior implementing ref resumes THAT session', () => {
    // Assertion 1. The task went implementing → review → implementing (the
    // `review → implementing` edge in taskStateMachine.ts), so the work already
    // has an author and the author is cache-warm.
    const plan = resolveStageRunner(
      taskRecord({
        stage: 'implementing',
        sessionRefs: [ref('implementing', FIRST_IMPLEMENTING_SESSION)],
      }),
    );
    expect(plan).toEqual<StageRunnerPlan>({
      mode: 'resume',
      appSessionId: FIRST_IMPLEMENTING_SESSION,
    });
  });

  it('with several implementing refs the MOST RECENT (last-appended) one wins', () => {
    // Assertion 1, second half. The projection APPENDS refs and never sorts them,
    // so the array reads oldest → newest and the newest is the author of the work
    // actually on disk. A second lap round the review/fix loop, or a re-run after
    // a quarantine, is what puts two implementing refs on one task — and resuming
    // the OLDEST would resume a dead session holding a stale view of the code.
    const plan = resolveStageRunner(
      taskRecord({
        stage: 'implementing',
        sessionRefs: [
          ref('implementing', FIRST_IMPLEMENTING_SESSION),
          ref('review', REVIEW_SESSION),
          ref('implementing', SECOND_IMPLEMENTING_SESSION),
        ],
      }),
    );
    expect(plan).toEqual<StageRunnerPlan>({
      mode: 'resume',
      appSessionId: SECOND_IMPLEMENTING_SESSION,
    });
  });

  it('a later ref for ANOTHER stage does not shadow the implementing author', () => {
    // The reviewer ran last, but the reviewer is not the author. Scanning back
    // from the end must skip non-implementing refs rather than stop at them.
    const plan = resolveStageRunner(
      taskRecord({
        stage: 'implementing',
        sessionRefs: [
          ref('planning', PLANNING_SESSION),
          ref('implementing', FIRST_IMPLEMENTING_SESSION),
          ref('review', REVIEW_SESSION),
        ],
      }),
    );
    expect(plan).toEqual<StageRunnerPlan>({
      mode: 'resume',
      appSessionId: FIRST_IMPLEMENTING_SESSION,
    });
  });
});

describe('resolveStageRunner — a first pass has no author to resume', () => {
  it('implementing with no refs at all spawns', () => {
    // Assertion 2.
    expect(resolveStageRunner(taskRecord({ stage: 'implementing', sessionRefs: [] }))).toEqual<
      StageRunnerPlan
    >({ mode: 'spawn' });
  });

  it('implementing whose ONLY refs are planning/review sessions spawns', () => {
    // Assertion 2, the load-bearing half: a planning session is NOT the author.
    // It produced a plan, not the work under fix; resuming it would hand the fix
    // to a session whose context is the wrong artifact. Same for a review session
    // — reusing the critic as the implementer is the independence rule inverted.
    const plan = resolveStageRunner(
      taskRecord({
        stage: 'implementing',
        sessionRefs: [ref('planning', PLANNING_SESSION), ref('review', REVIEW_SESSION)],
      }),
    );
    expect(plan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });
});

// ─── THE INDEPENDENCE RULE, BY ENUMERATION ───────────────────────────────────
//
// Assertion 3, and the reason this file is longer than the module it tests.
//
// A spot-check ("a review with an implementing ref spawns") passes for an
// implementation that resumes on some OTHER ref shape — three refs instead of
// one, a duplicate id, an unknown stage, a re-run after quarantine. The rule
// being defended is not "this input spawns"; it is **NO input resumes**, so the
// test enumerates the input space instead of sampling it.
//
// The construction: every ordered sequence of up to `MAX_REFS_PER_SHAPE` refs
// drawn from a stage alphabet that covers every real `TaskStage` plus the shapes
// a schema of `z.string()` genuinely permits (empty string, wrong case, an
// unknown stage), crossed with the task-level fields that could plausibly be
// consulted by a future "optimisation" (isolation, gates, manualReviewRequired,
// createdBy). Every generated task is asserted to plan `spawn`.
//
// ⚠ The enumeration is also proved NON-VACUOUS: the identical shapes are replayed
// with `stage: 'implementing'`, where a large, asserted number of them DO resume.
// Without that check an enumeration that silently produced zero usable inputs, or
// a generator that lost its ref arrays, would "pass" while testing nothing.

const REF_STAGE_ALPHABET: readonly string[] = [
  ...TASK_STAGES,
  // A ref's stage is `z.string()` in the schema, not the stage enum, so these are
  // reachable inputs rather than paranoia — and 'IMPLEMENTING' is exactly the
  // value a case-insensitive match would wrongly treat as the author.
  'IMPLEMENTING',
  'implementing ',
  'unknown-stage',
  '',
];
const MAX_REFS_PER_SHAPE = 3;

// Ids are drawn from a two-entry pool ON PURPOSE: with three refs per shape the
// pool wraps, so the enumeration contains the duplicate/overlapping-id cases (one
// session id appearing under two different stages) that a resume rule could trip
// over — a review ref and an implementing ref naming the SAME session, for one.
const SESSION_ID_POOL: readonly string[] = [FIRST_IMPLEMENTING_SESSION, SECOND_IMPLEMENTING_SESSION];

function allSessionRefShapes(): Array<TaskRecord['sessionRefs']> {
  const shapes: Array<TaskRecord['sessionRefs']> = [[]];
  let previousLengthShapes: Array<TaskRecord['sessionRefs']> = [[]];
  for (let refCount = 1; refCount <= MAX_REFS_PER_SHAPE; refCount += 1) {
    const currentLengthShapes: Array<TaskRecord['sessionRefs']> = [];
    for (const shorterShape of previousLengthShapes) {
      for (const stage of REF_STAGE_ALPHABET) {
        // The id rotates with the ref's position so that a shape's refs are not
        // all the same session, while staying deterministic.
        const appSessionId = SESSION_ID_POOL[shorterShape.length % SESSION_ID_POOL.length]!;
        currentLengthShapes.push([...shorterShape, ref(stage, appSessionId)]);
      }
    }
    shapes.push(...currentLengthShapes);
    previousLengthShapes = currentLengthShapes;
  }
  return shapes;
}

// The task-level variations crossed with every ref shape. None of these SHOULD
// matter to the runner — which is the point of varying them.
const TASK_FIELD_VARIANTS: ReadonlyArray<Partial<TaskRecord>> = [
  {},
  { isolation: 'shared-dir', createdBy: 'orchestrator' },
  { manualReviewRequired: true, gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } } },
  { gates: { deferUntilReset: 'window-5h' }, projectRoot: '/some/other/root' },
];

describe('resolveStageRunner — THE INDEPENDENCE RULE (enumerated, not spot-checked)', () => {
  const refShapes = allSessionRefShapes();

  it('the enumeration itself has the size it claims — a shrunken generator cannot pass silently', () => {
    // 1 + n + n² + n³ over the stage alphabet. Asserted because every claim below
    // is "no input resumes", and an empty input set satisfies that vacuously.
    const alphabetSize = REF_STAGE_ALPHABET.length;
    const expectedShapeCount =
      1 + alphabetSize + alphabetSize * alphabetSize + alphabetSize * alphabetSize * alphabetSize;
    expect(refShapes).toHaveLength(expectedShapeCount);
    expect(refShapes.length).toBeGreaterThan(1000);
    // And the alphabet really does cover the whole stage enum, so no stage can be
    // added to the machine without also entering this enumeration.
    for (const stage of TASK_STAGES) {
      expect(REF_STAGE_ALPHABET).toContain(stage);
    }
  });

  it('NO input makes a review resume — every ref shape × every task shape spawns', () => {
    let inputsChecked = 0;
    const resumingInputs: Array<{ refs: TaskRecord['sessionRefs']; plan: StageRunnerPlan }> = [];
    for (const sessionRefs of refShapes) {
      for (const fieldVariant of TASK_FIELD_VARIANTS) {
        const reviewTask = taskRecord({ ...fieldVariant, stage: 'review', sessionRefs });
        const plan = resolveStageRunner(reviewTask);
        inputsChecked += 1;
        if (plan.mode !== 'spawn') {
          resumingInputs.push({ refs: sessionRefs, plan });
        }
      }
    }
    // Reported as the offending inputs rather than a bare count, so a regression
    // says WHICH shape broke the rule instead of only that one did.
    expect(resumingInputs).toEqual([]);
    expect(inputsChecked).toBe(refShapes.length * TASK_FIELD_VARIANTS.length);
    expect(inputsChecked).toBeGreaterThan(4000);
  });

  it('the SAME enumeration resumes freely under `implementing` — so it is not vacuous', () => {
    // The control arm. If the generator produced degenerate inputs, or the runner
    // had been reduced to `() => ({ mode: 'spawn' })`, the assertion above would
    // still pass; this one would not. Every shape containing at least one
    // 'implementing' ref must resume, and the count must be large.
    let resumedCount = 0;
    for (const sessionRefs of refShapes) {
      const containsImplementingRef = sessionRefs.some((each) => each.stage === 'implementing');
      const plan = resolveStageRunner(taskRecord({ stage: 'implementing', sessionRefs }));
      expect(plan.mode).toBe(containsImplementingRef ? 'resume' : 'spawn');
      if (plan.mode === 'resume') {
        resumedCount += 1;
      }
    }
    // 421 of the 1885 shapes contain an 'implementing' ref (1 + 23 + 397 across
    // lengths 1–3 over a 12-value alphabet). The floor is deliberately below that
    // and far above zero: the claim is "this arm really does resume, a lot".
    expect(resumedCount).toBeGreaterThan(400);
  });

  it('a review whose refs are ALL implementing sessions still spawns — stated on its own', () => {
    // The single case the enumeration already covers, written out anyway because
    // it is the one a reader will look for: the maximally tempting cache win.
    const plan = resolveStageRunner(
      taskRecord({
        stage: 'review',
        sessionRefs: [
          ref('implementing', FIRST_IMPLEMENTING_SESSION),
          ref('implementing', SECOND_IMPLEMENTING_SESSION),
        ],
      }),
    );
    expect(plan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });

  it('a review does not even reuse a previous REVIEW session', () => {
    // Independence is per-run, not per-role: the second review of the same task
    // must not inherit the first reviewer's conclusions.
    const plan = resolveStageRunner(
      taskRecord({ stage: 'review', sessionRefs: [ref('review', REVIEW_SESSION)] }),
    );
    expect(plan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });
});

describe('resolveStageRunner — every other stage spawns', () => {
  it('planning spawns, with or without refs', () => {
    // Assertion 4. `planning` is the third dispatchable stage; it has no fix loop.
    expect(resolveStageRunner(taskRecord({ stage: 'planning', sessionRefs: [] }))).toEqual({
      mode: 'spawn',
    });
    expect(
      resolveStageRunner(
        taskRecord({
          stage: 'planning',
          sessionRefs: [
            ref('planning', PLANNING_SESSION),
            ref('implementing', FIRST_IMPLEMENTING_SESSION),
          ],
        }),
      ),
    ).toEqual({ mode: 'spawn' });
  });

  it('every non-dispatchable stage spawns too — the runner never refuses', () => {
    // The runner answers WHO, never WHETHER: `decideDispatch` has already refused
    // these stages before this function is consulted, and answering 'spawn' here
    // is not a second opinion about dispatching — it is the absence of one.
    for (const stage of TASK_STAGES) {
      if (stage === 'implementing' || stage === 'review') {
        continue;
      }
      const plan = resolveStageRunner(
        taskRecord({ stage, sessionRefs: [ref('implementing', FIRST_IMPLEMENTING_SESSION)] }),
      );
      expect(plan, `stage ${stage}`).toEqual<StageRunnerPlan>({ mode: 'spawn' });
    }
  });

  it('a stage outside the enum spawns rather than throwing', () => {
    // Reachable across an API boundary, where TypeScript's guarantee has stopped.
    const offEnumTask = { ...taskRecord(), stage: 'not-a-stage' } as unknown as TaskRecord;
    expect(() => resolveStageRunner(offEnumTask)).not.toThrow();
    expect(resolveStageRunner(offEnumTask)).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });
});

describe('resolveStageRunner — purity and totality', () => {
  it('does not mutate a DEEP-FROZEN task, and repeats itself exactly', () => {
    // Assertion 5. Frozen rather than merely compared, so an in-place sort of
    // `sessionRefs` (the plausible way to find "the most recent") throws instead
    // of passing quietly.
    const frozenTask = taskRecord({
      stage: 'implementing',
      sessionRefs: [
        ref('implementing', FIRST_IMPLEMENTING_SESSION),
        ref('implementing', SECOND_IMPLEMENTING_SESSION),
      ],
    });
    for (const sessionRef of frozenTask.sessionRefs) {
      Object.freeze(sessionRef);
    }
    Object.freeze(frozenTask.sessionRefs);
    Object.freeze(frozenTask.gates);
    Object.freeze(frozenTask);
    const beforeJson = JSON.stringify(frozenTask);

    const firstPlan = resolveStageRunner(frozenTask);
    const secondPlan = resolveStageRunner(frozenTask);

    expect(JSON.stringify(frozenTask)).toBe(beforeJson);
    expect(firstPlan).toEqual(secondPlan);
    expect(JSON.stringify(secondPlan)).toBe(JSON.stringify(firstPlan));
    expect(firstPlan).toEqual<StageRunnerPlan>({
      mode: 'resume',
      appSessionId: SECOND_IMPLEMENTING_SESSION,
    });
  });

  it('returns a fresh plan object per call, never one shared across dispatches', () => {
    // Two calls must not hand back the same object identity: a caller that (say)
    // annotated the plan would otherwise corrupt every subsequent dispatch.
    const task = taskRecord({ stage: 'planning' });
    expect(resolveStageRunner(task)).not.toBe(resolveStageRunner(task));
  });

  it('malformed sessionRefs resolve to spawn and NEVER throw (I8)', () => {
    // Assertion 6. Each of these is a shape the type system forbids and a real
    // boundary (an HTTP body, a hand-edited record, a partially-written replay)
    // can still produce. Not one of them may take the dispatcher down.
    const malformedRefValues: unknown[] = [
      undefined,
      null,
      'implementing',
      42,
      {},
      [null],
      [42, 'nope'],
      [{}],
      [{ stage: 'implementing' }],
      [{ stage: 'implementing', appSessionId: '' }],
      [{ stage: 'implementing', appSessionId: 7 }],
      [{ appSessionId: FIRST_IMPLEMENTING_SESSION }],
      [{ stage: null, appSessionId: null }],
    ];
    for (const malformedRefs of malformedRefValues) {
      const brokenTask = {
        ...taskRecord({ stage: 'implementing' }),
        sessionRefs: malformedRefs,
      } as unknown as TaskRecord;
      expect(() => resolveStageRunner(brokenTask), JSON.stringify(malformedRefs ?? null)).not.toThrow();
      expect(resolveStageRunner(brokenTask), JSON.stringify(malformedRefs ?? null)).toEqual<
        StageRunnerPlan
      >({ mode: 'spawn' });
    }
  });

  it('skips a corrupt ref rather than letting it hide an intact older author', () => {
    // One unusable ref must not blind the runner to a resumable one behind it —
    // the difference between "one bad record cost us a cache hit" and "one bad
    // record made every subsequent fix spawn a stranger".
    const partiallyCorruptTask = {
      ...taskRecord({ stage: 'implementing' }),
      sessionRefs: [
        { stage: 'implementing', appSessionId: FIRST_IMPLEMENTING_SESSION },
        { stage: 'implementing', appSessionId: '' },
        null,
      ],
    } as unknown as TaskRecord;
    expect(resolveStageRunner(partiallyCorruptTask)).toEqual<StageRunnerPlan>({
      mode: 'resume',
      appSessionId: FIRST_IMPLEMENTING_SESSION,
    });
  });

  it('an entirely absent task field does not throw', () => {
    // Belt and braces on totality: the function is called from a daemon that must
    // not stop, so even a garbage record maps to a decision.
    expect(() => resolveStageRunner(undefined as unknown as TaskRecord)).not.toThrow();
    expect(resolveStageRunner({} as unknown as TaskRecord)).toEqual<StageRunnerPlan>({
      mode: 'spawn',
    });
  });
});
