import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../schemas.js';
import { TASK_STAGES } from './taskStateMachine.js';
import { resolveStageRunner, type StageRunnerPlan } from './stageRunner.js';

// ─── slice 6 step 7 — who runs the stage ─────────────────────────────────────
//
// ⚠ **THIS FILE WAS INVERTED BY D46 (S7·7b-core). The flipped assertions below are
// a RECORDED REVERSAL, not a regression.** Until 2026-07-25 this module resumed
// the hot author for a fix, and the first describe block asserted exactly that.
// D46 killed `mode:'resume'` for stage runs on two independent grounds — one
// transcript must never straddle two attempts (identity/replay/cost attribution),
// and an author resumed with its own review feedback is structurally invited to
// defend its original approach. The old cases are kept, in place, with their
// expectations flipped to `spawn`, so the reversal is legible in the diff rather
// than disappearing with a deleted describe.
//
// The whole file now defends ONE rule, and it is a correctness rule at both ends:
//
//   • **NO INPUT, AT ANY STAGE, EVER RESUMES.** A spot-check cannot hold that
//     line, so it is asserted by ENUMERATION over ref shapes × task shapes ×
//     STAGES (see the enumeration block below).
//   • the review branch keeps its own dedicated cases anyway: independence was a
//     correctness rule BEFORE D46 made freshness universal, and it must survive
//     any future revisit of D46's "revisit if fix-cycle cost proves material".

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

describe('resolveStageRunner — D46 INVERSION: the fix loop spawns FRESH (was: resumes the hot author)', () => {
  // ⚠ Every expectation in this describe was `mode: 'resume'` before D46. Each
  // case is kept with its original setup, and only the expectation flipped, so
  // that the reversal reads as a reversal. See the file header for D46's two
  // arguments; the short version is that the hot author is exactly the session
  // that must NOT do the fix.

  it('implementing + a prior implementing ref SPAWNS — it does not resume that session', () => {
    // Assertion 1, inverted (D46). The task went implementing → review →
    // implementing (the `review → implementing` edge in taskStateMachine.ts), so
    // the work already has an author and the author is cache-warm. That author is
    // NOT reused: it is marinating in its own rationale, and its transcript would
    // straddle two attempts. The fix-seed (review feedback + worklog + the diff on
    // disk) is what carries the context forward instead.
    const plan = resolveStageRunner(
      taskRecord({
        stage: 'implementing',
        sessionRefs: [ref('implementing', FIRST_IMPLEMENTING_SESSION)],
      }),
    );
    expect(plan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });

  it('several implementing refs (several laps round the loop) still SPAWN', () => {
    // Assertion 1's second half, inverted. The MOST RECENT author used to win
    // here; now no author wins, and the count of prior attempts is irrelevant to
    // this function — `attempt++` is the dispatcher's business, not the runner's.
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
    expect(plan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });

  it('a mixed ref trail (planning + implementing + review) spawns', () => {
    // Was: "a later ref for ANOTHER stage does not shadow the implementing
    // author". There is no author to shadow any more — the ref trail is now
    // history the runner does not consult at all.
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
    expect(plan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });

  it('the FIRST PASS and the FIX are now indistinguishable to this function', () => {
    // The sharpest statement of D46 available here: the two inputs that used to
    // produce DIFFERENT plans now produce the same one, byte for byte. That is the
    // reversal, not merely "both happen to spawn".
    const firstPass = resolveStageRunner(taskRecord({ stage: 'implementing', sessionRefs: [] }));
    const fixAfterReview = resolveStageRunner(
      taskRecord({
        stage: 'implementing',
        sessionRefs: [
          ref('implementing', FIRST_IMPLEMENTING_SESSION),
          ref('review', REVIEW_SESSION),
        ],
      }),
    );
    expect(fixAfterReview).toEqual(firstPass);
    expect(fixAfterReview).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });
});

describe('resolveStageRunner — a first pass has no author to resume', () => {
  it('implementing with no refs at all spawns', () => {
    // Assertion 2. Unchanged by D46 — this case always spawned; it is now the
    // ONLY behaviour rather than one branch of two.
    expect(resolveStageRunner(taskRecord({ stage: 'implementing', sessionRefs: [] }))).toEqual<
      StageRunnerPlan
    >({ mode: 'spawn' });
  });

  it('implementing whose ONLY refs are planning/review sessions spawns', () => {
    // Assertion 2, also unchanged by D46, and kept because it still names two
    // wrong answers a future change could reach for: a planning session produced a
    // plan, not the work under fix, and reusing the critic as the implementer is
    // the independence rule inverted.
    const plan = resolveStageRunner(
      taskRecord({
        stage: 'implementing',
        sessionRefs: [ref('planning', PLANNING_SESSION), ref('review', REVIEW_SESSION)],
      }),
    );
    expect(plan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
  });
});

// ─── NEVER-RESUME, BY ENUMERATION ────────────────────────────────────────────
//
// Assertion 3, and the reason this file is longer than the module it tests.
//
// ⚠ **D46 WIDENED THIS BLOCK.** It used to enumerate the INDEPENDENCE RULE only —
// "no review resumes" — with `implementing` serving as the control arm that DID
// resume. D46 promoted the claim to the whole function: **NO input, at ANY stage,
// ever resumes.** The review-only claim is now a corollary and is still asserted
// separately below, because it must outlive any future revisit of D46's
// "revisit if fix-cycle cost proves material" call.
//
// A spot-check ("a fix with one implementing ref spawns") passes for an
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
// createdBy), crossed with every task STAGE. Every generated task must plan `spawn`.
//
// ⚠ NON-VACUITY, post-D46. The old control arm (replay the same shapes under
// `implementing` and assert that many RESUME) is gone with the behaviour it
// measured — there is nothing left that resumes, so the enumeration cannot be
// validated by finding a resume any more. Two checks replace it: the generator's
// size is asserted exactly (a shrunken or empty generator reddens), and the
// enumeration is asserted to actually CONTAIN the tempting inputs — the shapes
// with a prior implementing ref, under `stage: 'implementing'`, which are exactly
// the inputs that used to resume.

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

describe('resolveStageRunner — NEVER RESUMES (enumerated, not spot-checked) — D46', () => {
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

  it('the enumeration CONTAINS the tempting inputs — the shapes that used to resume', () => {
    // Non-vacuity, post-D46 (see the block comment above). The old control arm
    // proved the generator worked by finding resumes in it; nothing resumes now,
    // so instead we assert the inputs a resume WOULD have fired on are genuinely
    // present and numerous. 421 of the 1885 shapes carry an 'implementing' ref
    // (1 + 23 + 397 across lengths 1–3 over a 12-value alphabet); the floor is
    // deliberately below that and far above zero.
    const shapesWithPriorAuthor = refShapes.filter((sessionRefs) =>
      sessionRefs.some((each) => each.stage === 'implementing'),
    );
    expect(shapesWithPriorAuthor.length).toBeGreaterThan(400);
  });

  it('NO input resumes — every ref shape × every task shape × EVERY STAGE spawns', () => {
    // ⚠ THE D46 ASSERTION. Not "no review resumes" (that was the pre-D46 claim,
    // kept as a corollary below) but "no task, in any stage, with any ref trail,
    // ever gets a resume". `resolveStageRunner` is now constant in everything but
    // the seam it preserves.
    let inputsChecked = 0;
    const resumingInputs: Array<{
      stage: string;
      refs: TaskRecord['sessionRefs'];
      plan: StageRunnerPlan;
    }> = [];
    // Every real stage, plus a value outside the enum — reachable across an API
    // boundary, where TypeScript's guarantee has stopped.
    const stagesUnderTest: readonly string[] = [...TASK_STAGES, 'not-a-stage'];
    for (const sessionRefs of refShapes) {
      for (const fieldVariant of TASK_FIELD_VARIANTS) {
        for (const stage of stagesUnderTest) {
          const task = {
            ...taskRecord({ ...fieldVariant, sessionRefs }),
            stage,
          } as unknown as TaskRecord;
          const plan = resolveStageRunner(task);
          inputsChecked += 1;
          if (plan.mode !== 'spawn') {
            resumingInputs.push({ stage, refs: sessionRefs, plan });
          }
        }
      }
    }
    // Reported as the offending inputs rather than a bare count, so a regression
    // says WHICH shape broke the rule instead of only that one did.
    expect(resumingInputs).toEqual([]);
    expect(inputsChecked).toBe(
      refShapes.length * TASK_FIELD_VARIANTS.length * stagesUnderTest.length,
    );
    expect(inputsChecked).toBeGreaterThan(40_000);
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
    // `implementing` and `review` are skipped only because they have dedicated
    // describes of their own above; the enumeration covers all three anyway.
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
    // `sessionRefs` (the plausible way a re-introduced "most recent author" lookup
    // would find its target) throws instead of passing quietly. Kept after D46
    // precisely because the runner no longer READS `sessionRefs` at all: this is
    // the test that would catch it starting to again.
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
    // Flipped by D46 (was `resume` on SECOND_IMPLEMENTING_SESSION).
    expect(firstPlan).toEqual<StageRunnerPlan>({ mode: 'spawn' });
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

  it('a partially corrupt ref trail is simply not consulted (D46 inversion)', () => {
    // Was: "skips a corrupt ref rather than letting it hide an intact older
    // author" — the pre-D46 runner scanned backwards and this case proved one bad
    // record could not blind it to a resumable one behind it. There is no scan any
    // more, so the case is kept for its INPUT (a genuinely malformed trail with an
    // otherwise-usable author in it) and its expectation flipped: no ref shape,
    // intact or corrupt, produces anything but a fresh spawn.
    const partiallyCorruptTask = {
      ...taskRecord({ stage: 'implementing' }),
      sessionRefs: [
        { stage: 'implementing', appSessionId: FIRST_IMPLEMENTING_SESSION },
        { stage: 'implementing', appSessionId: '' },
        null,
      ],
    } as unknown as TaskRecord;
    expect(resolveStageRunner(partiallyCorruptTask)).toEqual<StageRunnerPlan>({ mode: 'spawn' });
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
