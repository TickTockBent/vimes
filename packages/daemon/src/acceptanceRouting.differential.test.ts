import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MemoryArtifactStore,
  parseExtensionManifest,
  type EventInput,
  type MetersState,
  type ParsedWorkflow,
  type ReportCompletionPayload,
  type ReportReviewPayload,
  type TaskRecord,
  type TasksState,
} from '@vimes/core';
import type { SendResult, SpawnResult } from './sessionHost.js';
import type { ProposeMoveResult } from './instanceWriter.js';
import { TaskDispatcher, type TaskDispatcherDeps } from './taskDispatcher.js';
import { SHIPPED_MANIFEST_PATH, SHIPPED_WORKFLOW_ID, loadShippedWorkflow } from './shippedManifest.js';
import { declaredCompletionRouting, declaredPlanRouting, declaredReviewRouting } from './acceptanceRouting.js';

// ─── S20·U3 — THE DIFFERENTIAL, FROZEN AND FLIPPED (slice-20 §3.7, A2–A5) ────
//
// ⚠ **WHAT THIS FILE WAS, AND WHAT IT IS NOW.** Through U2, every `describe`
// below drove TWO paths over the same snapshot — a REAL `TaskDispatcher`
// (compiled: three hard-coded routings) and `declared*Routing` (U2's module,
// built beside it but wired to nothing) — and asserted they agreed cell for
// cell. U3 is the flip: the dispatcher's `record*` methods now call
// `declared*Routing` THEMSELVES (`taskDispatcher.ts`), so "compiled vs
// declared" no longer names two things — it collapsed the moment the compiled
// half was deleted. Comparing a dispatcher against itself would prove nothing.
//
// Move-3's precedent (S19·U3, `briefingPreflight.test.ts`'s FROZEN IMAGES) is
// the idiom this file follows: capture the compiled side's answer ONE LAST
// TIME, freeze it as a literal with its provenance stated, and let the guard
// survive its reference's death. Every frozen literal below (`frozenReview-
// Filed`, `frozenCompletionFiled`, the plan envelope/capture shapes, the A3/A4
// expected outcomes) is exactly what U2's differential observed the COMPILED
// half produce, transcribed rather than re-derived — a red against one of them
// is a finding about the DECLARED path (now the only path), never license to
// "update the freeze to match".
//
// Two sections stay GENUINELY comparative, not frozen, because they never
// compared against the compiled dispatcher in the first place:
//
//   • PART D (A3) is now GOVERNANCE, not divergence: a perturbed declaration,
//     driven through the REAL (now declaration-governed) dispatcher, must
//     route per the perturbation. This is the STRONGEST assertion this file
//     makes post-flip — proof that the declaration is what decides, not an
//     agreement between two things that both hard-code the same answer.
//   • PART F (A5) calls `declared*Routing` directly, unmediated by the
//     dispatcher — it was never part of the compiled/declared comparison, and
//     stays exactly as it was: a white-box check that the binding guard
//     resolves (or refuses to resolve) the way §3.3 requires.

const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';
const TASK_ID = 'task-acceptance-0001';
const FIXED_NOW = '2026-08-26T12:00:00.000Z';
const STALE_AFTER_MS = 90_000;

const PLANNER_SESSION_ID = 'cccccccc-0000-4000-8000-0000000000a1';
const REVIEWER_SESSION_ID = 'cccccccc-0000-4000-8000-0000000000a2';
const IMPLEMENTER_SESSION_ID = 'cccccccc-0000-4000-8000-0000000000a3';
/** A session id no task carries a ref for — the no-op cells' input. */
const UNKNOWN_SESSION_ID = 'cccccccc-0000-4000-8000-00000000dead';

const PLAN_TEXT = 'Step 1: build the declared path.\nStep 2: prove it equals the compiled one.\n';
const WORKLOG: ReportCompletionPayload['worklog'] = {
  decisionsMade: ['built the declared routing beside the compiled one'],
  pathsRejected: ['flipping the dispatcher in U2'],
};

// The verb ids the SDK adapter observes and hands to the seam. Spelled as
// LITERALS on purpose, the same as `taskDispatcher.ts`'s own module constants —
// this file asserts the SHIPPED BINDING, not a derivation of it.
const REVIEW_VERB = 'vimes_report.report_review';
const COMPLETION_VERB = 'vimes_report.report_completion';
/** §1.8.3's capture catalogue, v1: exactly one entry. */
const PLAN_CAPTURE = 'plan';

const SHIPPED_WORKFLOW: ParsedWorkflow = loadShippedWorkflow().workflow;

/** A session host that must never be reached — see the harness note. */
const UNREACHABLE_SESSION_HOST: TaskDispatcherDeps['sessionHost'] = {
  spawnSession: (): SpawnResult => {
    throw new Error('the differential must never spawn — a record* path reached the session host');
  },
  isLive: (): boolean => {
    throw new Error('the differential must never ask for liveness');
  },
  sendMessage: (): SendResult => {
    throw new Error('the differential must never send');
  },
};

interface Harness {
  readonly dispatcher: TaskDispatcher;
  readonly emitted: EventInput[];
  readonly proposeMoveCalls: Array<{
    taskId: string;
    toStage: string;
    proposedBy: string;
  }>;
  readonly artifactStore: MemoryArtifactStore;
  /** The EXACT snapshot the dispatcher reads. */
  readonly tasks: TasksState;
  /** Every message `applyOutcome`'s warn seam received, in call order. */
  readonly warnCalls: string[];
}

function buildHarness(
  tasks: readonly TaskRecord[],
  options: { declaredWorkflow?: ParsedWorkflow } = {},
): Harness {
  const emitted: EventInput[] = [];
  const proposeMoveCalls: Harness['proposeMoveCalls'] = [];
  const warnCalls: string[] = [];
  const artifactStore = new MemoryArtifactStore();
  const tasksById: Record<string, TaskRecord> = {};
  for (const task of tasks) {
    tasksById[task.taskId] = task;
  }
  const tasksState: TasksState = { tasks: tasksById };
  const meters: MetersState = { meters: {}, history: {} };

  const deps: TaskDispatcherDeps = {
    sessionHost: UNREACHABLE_SESSION_HOST,
    emit: (events) => {
      emitted.push(...events);
    },
    readTasks: () => tasksState,
    readMeters: () => meters,
    nowIso: () => FIXED_NOW,
    staleAfterMs: STALE_AFTER_MS,
    artifactStore,
    instanceWriter: {
      proposeMove: (taskId, proposal): ProposeMoveResult => {
        proposeMoveCalls.push({
          taskId,
          toStage: proposal.toStage,
          proposedBy: proposal.proposedBy,
        });
        // Narrowed to the two fields this file compares — `TransitionProposal`
        // also carries `manualReviewRequired`/`note`, which no `record*` path
        // sets and which slice 20 does not touch.
        expect(proposal.manualReviewRequired).toBeUndefined();
        expect(proposal.note).toBeUndefined();
        return { outcome: 'unknown-task', taskId };
      },
    },
    // S20·U3 (the flip): `record*` reads THIS to decide everything — defaults
    // to the shipped declaration; a governance cell (Part D) overrides it with
    // a perturbed copy.
    declaredWorkflow: options.declaredWorkflow ?? SHIPPED_WORKFLOW,
    warn: (message) => {
      warnCalls.push(message);
    },
  };

  return {
    dispatcher: new TaskDispatcher(deps),
    emitted,
    proposeMoveCalls,
    artifactStore,
    tasks: tasksState,
    warnCalls,
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    projectRoot: PROJECT_ROOT,
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'shared-dir',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

function planningTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    stage: 'planning',
    sessionRefs: [{ stage: 'planning', appSessionId: PLANNER_SESSION_ID }],
    ...overrides,
  });
}

function reviewTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    stage: 'review',
    sessionRefs: [{ stage: 'review', appSessionId: REVIEWER_SESSION_ID }],
    acceptanceCriteria: [
      { id: 'c1', text: 'first criterion' },
      { id: 'c2', text: 'second criterion' },
    ],
    ...overrides,
  });
}

function implementingTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecord({
    stage: 'implementing',
    sessionRefs: [{ stage: 'implementing', appSessionId: IMPLEMENTER_SESSION_ID }],
    ...overrides,
  });
}

// ── the shared observations, named once ─────────────────────────────────────

/** The dispatcher's ONE proposal, with the "exactly one" claim asserted. */
function soleProposal(harness: Harness): { taskId: string; toStage: string; proposedBy: string } {
  expect(harness.proposeMoveCalls).toHaveLength(1);
  return harness.proposeMoveCalls[0]!;
}

/** The dispatcher's ONE emitted event, with the "exactly one" claim asserted. */
function soleEvent(harness: Harness): EventInput {
  expect(harness.emitted).toHaveLength(1);
  return harness.emitted[0]!;
}

// ── FROZEN IMAGES — the review/completion report_filed shape ────────────────
//
// ⚠ **THIS IS WHAT THE COMPILED `recordReview`/`recordCompletion` PRODUCED,**
// captured by U2's differential before U3 deleted the compiled half: the exact
// `report_filed` envelope (stream, type, and every payload field), for the
// exact shipped node ids. A red here is a finding about the emitted event, not
// license to "update the freeze".
function frozenReviewFiled(params: {
  criteria: ReportReviewPayload['criteria'];
  attempt?: number;
  payloadRev?: number;
}): EventInput {
  return {
    stream: 'tasks',
    type: 'report_filed',
    payload: {
      instanceId: TASK_ID,
      node: 'review',
      attempt: params.attempt ?? 1,
      payloadRev: params.payloadRev ?? 0,
      reportKind: 'review',
      body: { criteria: params.criteria },
    },
  };
}

function frozenCompletionFiled(params: {
  worklog: ReportCompletionPayload['worklog'];
  attempt?: number;
  payloadRev?: number;
}): EventInput {
  return {
    stream: 'tasks',
    type: 'report_filed',
    payload: {
      instanceId: TASK_ID,
      node: 'implementing',
      attempt: params.attempt ?? 1,
      payloadRev: params.payloadRev ?? 0,
      reportKind: 'completion',
      body: { worklog: params.worklog },
    },
  };
}

// ── PART B — A2: the outcome matrix, FROZEN (slice-20 §3.7) ─────────────────

const pass = (criterionId: string): ReportReviewPayload['criteria'][number] => ({
  criterionId,
  verdict: 'pass',
});
const fail = (criterionId: string): ReportReviewPayload['criteria'][number] => ({
  criterionId,
  verdict: 'fail',
});

/**
 * The five REVIEW cells, in §3.7's order — the same case table
 * `core/src/extensions/acceptance.test.ts`'s equivalence suite uses, driven
 * here through the whole dispatcher rather than the pure arm.
 *
 * `expectedStage` is the FROZEN answer — `deriveReviewOutcome`'s image, the
 * same literal `acceptance.test.ts` now checks the evaluator against — so a
 * cell that "agreed" because both regressed the same way still fails.
 */
const REVIEW_CELLS: readonly {
  readonly name: string;
  readonly criteria: ReportReviewPayload['criteria'];
  readonly instanceCriteria: readonly { id: string; text: string }[];
  readonly expectedStage: string;
}[] = [
  {
    name: 'any-fail — one explicit fail sends it back regardless of the passes beside it',
    criteria: [pass('c1'), fail('c2')],
    instanceCriteria: [
      { id: 'c1', text: 'first criterion' },
      { id: 'c2', text: 'second criterion' },
    ],
    expectedStage: 'implementing',
  },
  {
    name: 'coverage-miss — every reported verdict passes, but a criterion went unmentioned',
    criteria: [pass('c1')],
    instanceCriteria: [
      { id: 'c1', text: 'first criterion' },
      { id: 'c2', text: 'second criterion' },
    ],
    expectedStage: 'implementing',
  },
  {
    name: 'all-pass — every instance criterion covered by a pass',
    criteria: [pass('c1'), pass('c2')],
    instanceCriteria: [
      { id: 'c1', text: 'first criterion' },
      { id: 'c2', text: 'second criterion' },
    ],
    expectedStage: 'done',
  },
  {
    name: 'extra-id-ignored — an id off the list neither blocks nor forces the pass (A-17)',
    criteria: [pass('c1'), pass('c2'), pass('not-on-the-list')],
    instanceCriteria: [
      { id: 'c1', text: 'first criterion' },
      { id: 'c2', text: 'second criterion' },
    ],
    expectedStage: 'done',
  },
  {
    name: 'bare-task — an empty criterion list is vacuously covered',
    criteria: [],
    instanceCriteria: [],
    expectedStage: 'done',
  },
];

describe('S20-A2 frozen — REVIEW: the declared path reproduces the deleted compiled routing', () => {
  it.each(REVIEW_CELLS)('$name', (cell) => {
    const task = reviewTask({ acceptanceCriteria: [...cell.instanceCriteria] });
    const harness = buildHarness([task]);

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, cell.criteria);

    expect(soleEvent(harness)).toEqual(frozenReviewFiled({ criteria: cell.criteria }));
    expect(soleProposal(harness)).toEqual({
      taskId: TASK_ID,
      toStage: cell.expectedStage,
      proposedBy: 'dispatcher',
    });
  });

  it('the matrix really does exercise BOTH outcomes', () => {
    // Five identical comparisons would pass while proving nothing about the rule.
    expect([...new Set(REVIEW_CELLS.map((cell) => cell.expectedStage))].sort()).toEqual([
      'done',
      'implementing',
    ]);
  });
});

describe('S20-A2 frozen — COMPLETION: the declared path reproduces the deleted compiled routing', () => {
  it('a valid worklog files the report and routes to the frozen target', () => {
    const harness = buildHarness([implementingTask()]);

    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, WORKLOG);

    expect(soleEvent(harness)).toEqual(frozenCompletionFiled({ worklog: WORKLOG }));
    expect(soleProposal(harness)).toEqual({
      taskId: TASK_ID,
      toStage: 'review',
      proposedBy: 'dispatcher',
    });
  });
});

describe('S20-A2 frozen — PLAN: the declared path reproduces the deleted compiled routing, ENVELOPE INCLUDED', () => {
  it('a captured plan records the same fact, the same envelope identity, and the same move', () => {
    const harness = buildHarness([planningTask()]);

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    // 1. the MOVE
    expect(soleProposal(harness)).toEqual({
      taskId: TASK_ID,
      toStage: 'plan-ready',
      proposedBy: 'dispatcher',
    });

    // 2. the FACT — everything but the hash, which is the store's (see the header).
    const event = soleEvent(harness);
    const payload = event.payload as Record<string, unknown> & { artifactHash: string };
    const { artifactHash, ...payloadWithoutHash } = payload;
    expect(event.stream).toBe('tasks');
    expect(event.type).toBe('capture_recorded');
    expect(payloadWithoutHash).toEqual({
      instanceId: TASK_ID,
      captureKind: 'plan',
      node: 'planning',
      attempt: 1,
      payloadRev: 0,
      capturedFrom: { appSessionId: PLANNER_SESSION_ID },
    });
    // …and the hash really does name stored content (the store's own
    // ordering contract, not a routing claim).
    expect(harness.artifactStore.getBlob(artifactHash)).toBe(PLAN_TEXT);

    // 3. the ENVELOPE (§0.5(d)) — kind, taskId, taskRef.stage and rev.
    // `createdAt` and `hash` are the clock's and the store's, so they are
    // stripped rather than declared.
    const envelopes = harness.artifactStore.listByTask(TASK_ID);
    expect(envelopes).toHaveLength(1);
    const { hash, createdAt, ...envelopeIdentity } = envelopes[0]!;
    expect(envelopeIdentity).toEqual({
      kind: 'plan',
      taskRef: { taskId: TASK_ID, stage: 'planning' },
      rev: 0,
      createdBy: { appSessionId: PLANNER_SESSION_ID },
    });
    expect(hash).toBe(artifactHash);
    expect(createdAt).toBe(FIXED_NOW);
  });
});

// ── PART B′ — the identity tuple under a SECOND attempt ─────────────────────
//
// The matrix above runs every cell at attempt 1, where a `0` and a `1` are the
// only two values in play and an attempt filter keyed on the WRONG node still
// looks nearly right. This cell makes `attempt` carry information: three refs at
// the node, and a `workOrderRev` that is not the default. §0.5(b)'s uncounted
// twin is exactly what it pins.

describe('S20-A2 frozen — the D46 identity tuple, where it actually counts', () => {
  it('attempt counts the refs AT THE RESOLVED NODE and payloadRev is the record’s', () => {
    const task = reviewTask({
      workOrderRev: 3,
      sessionRefs: [
        { stage: 'implementing', appSessionId: IMPLEMENTER_SESSION_ID },
        { stage: 'review', appSessionId: 'cccccccc-0000-4000-8000-0000000000b1' },
        { stage: 'review', appSessionId: REVIEWER_SESSION_ID },
      ],
    });
    const harness = buildHarness([task]);
    const criteria = [pass('c1'), pass('c2')];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    // The independent expectation: two review refs, rev 3 — NOT 1 and NOT 0.
    expect(soleEvent(harness)).toEqual(
      frozenReviewFiled({ criteria, attempt: 2, payloadRev: 3 }),
    );
  });

  it('the plan path counts the same way, and the envelope carries the same rev', () => {
    const task = planningTask({
      workOrderRev: 2,
      sessionRefs: [
        { stage: 'planning', appSessionId: 'cccccccc-0000-4000-8000-0000000000b2' },
        { stage: 'review', appSessionId: REVIEWER_SESSION_ID },
        { stage: 'planning', appSessionId: PLANNER_SESSION_ID },
      ],
    });
    const harness = buildHarness([task]);

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    const event = soleEvent(harness);
    const payload = event.payload as Record<string, unknown> & { artifactHash: string };
    expect(payload).toMatchObject({ attempt: 2, payloadRev: 2 });
    const { artifactHash: _hash, ...payloadWithoutHash } = payload;
    expect(payloadWithoutHash).toEqual({
      instanceId: TASK_ID,
      captureKind: 'plan',
      node: 'planning',
      attempt: 2,
      payloadRev: 2,
      capturedFrom: { appSessionId: PLANNER_SESSION_ID },
    });
    const envelopes = harness.artifactStore.listByTask(TASK_ID);
    expect(envelopes[0]!.rev).toBe(2);
  });
});

// ── PART C — the NO-OP cells: nothing recorded, nothing proposed ────────────

describe('S20-A2 frozen — the NO-OP cells: an unknown session records nothing', () => {
  it('review: an unclaimed reviewer session emits and proposes nothing', () => {
    const harness = buildHarness([reviewTask()]);

    expect(() => harness.dispatcher.recordReview(UNKNOWN_SESSION_ID, [pass('c1')])).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(harness.proposeMoveCalls).toEqual([]);
  });

  it('completion: same', () => {
    const harness = buildHarness([implementingTask()]);

    expect(() => harness.dispatcher.recordCompletion(UNKNOWN_SESSION_ID, WORKLOG)).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(harness.proposeMoveCalls).toEqual([]);
  });

  it('plan: an unclaimed planner session emits and proposes nothing — and the EMPTY capture is the compiled guard, preserved', () => {
    const harness = buildHarness([planningTask()]);

    expect(() => harness.dispatcher.recordPlan(UNKNOWN_SESSION_ID, PLAN_TEXT)).not.toThrow();
    expect(harness.emitted).toEqual([]);
    expect(harness.proposeMoveCalls).toEqual([]);
    expect(harness.artifactStore.listByTask(TASK_ID)).toEqual([]);

    // …and the whitespace-only plan, which the (former) compiled half refused
    // BEFORE the lookup — so the declared path must too, or a claimed session
    // with an empty plan silently stores an empty-hash artifact.
    const claimedHarness = buildHarness([planningTask()]);
    claimedHarness.dispatcher.recordPlan(PLANNER_SESSION_ID, '   \n\t  ');
    expect(claimedHarness.emitted).toEqual([]);
    expect(claimedHarness.proposeMoveCalls).toEqual([]);
    expect(claimedHarness.artifactStore.listByTask(TASK_ID)).toEqual([]);
  });
});

// ── PART D — A3: THE DECLARATION GOVERNS (now GOVERNANCE, not divergence) ───
//
// Pre-flip, this section drove the SAME perturbed workflow through
// `declaredReviewRouting` alone while the compiled dispatcher — which could not
// read a manifest — kept emitting its literals, and the DIFFERENCE was the
// evidence that the declaration decided anything at all. Post-flip there is no
// second implementation left to contrast with: the dispatcher itself is
// declaration-governed now, so the strongest available proof is that swapping
// its `declaredWorkflow` dependency swaps its behaviour — a manifest edit
// changing a REAL dispatcher's real output, with nothing else touched.

/**
 * Parse a PERTURBED copy of the shipped manifest.
 *
 * ⚠ Each edit must match EXACTLY ONCE. A perturbation that silently matched
 * nothing would leave the "perturbed" workflow identical to the shipped one, and
 * every assertion below would then pass by agreeing with the thing it is supposed
 * to contradict — the quietest possible way for this instrument to become
 * decorative.
 */
function perturbedWorkflow(edits: readonly (readonly [string, string])[]): ParsedWorkflow {
  let manifestText = readFileSync(SHIPPED_MANIFEST_PATH, 'utf8');
  for (const [from, to] of edits) {
    const occurrences = manifestText.split(from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `perturbation ${JSON.stringify(from)} matched ${occurrences} times in the shipped manifest; exactly 1 is required`,
      );
    }
    manifestText = manifestText.replace(from, to);
  }
  const parsed = parseExtensionManifest(manifestText);
  if (!parsed.ok) {
    throw new Error(
      `the perturbed manifest did not parse: ${parsed.errors
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const workflow = parsed.manifest.workflows.find(
    (candidate) => candidate.id === SHIPPED_WORKFLOW_ID,
  );
  if (workflow === undefined) {
    throw new Error(`the perturbed manifest declares no "${SHIPPED_WORKFLOW_ID}" workflow`);
  }
  return workflow;
}

/**
 * Review's two targets, pointed at DIFFERENT declared nodes. Both are real nodes
 * of the shipped workflow, so the parser's `unknown-node-reference` rule is
 * satisfied — the perturbation moves the routing, it does not corrupt the graph.
 *
 * ⚠ Whether the WRITER would accept the resulting proposal is a different
 * question and deliberately not this file's: legality, `max_traversals` and
 * evented rejection are the writer's and are untouched by slice 20 (§2). What is
 * asserted here is which target the DECLARATION-GOVERNED DISPATCHER produced.
 */
const PERTURBED_REVIEW_TARGETS = perturbedWorkflow([
  ['on_pass       = "done"', 'on_pass       = "manual-review"'],
  ['on_fail       = "implementing"', 'on_fail       = "backlog"'],
]);

describe('S20-A3 — a PERTURBED declaration governs a REAL dispatcher’s real output', () => {
  it('a passing review routes to the PERTURBED on_pass', () => {
    const harness = buildHarness([reviewTask()], { declaredWorkflow: PERTURBED_REVIEW_TARGETS });
    const criteria = [pass('c1'), pass('c2')];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    expect(soleProposal(harness)).toEqual({
      taskId: TASK_ID,
      toStage: 'manual-review',
      proposedBy: 'dispatcher',
    });
    // …and the FACT is unchanged by the perturbation: only the routing moved.
    expect(soleEvent(harness)).toEqual(frozenReviewFiled({ criteria }));
  });

  it('a failing review routes to the PERTURBED on_fail', () => {
    const harness = buildHarness([reviewTask()], { declaredWorkflow: PERTURBED_REVIEW_TARGETS });
    const criteria = [pass('c1'), fail('c2')];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    expect(soleProposal(harness)).toEqual({
      taskId: TASK_ID,
      toStage: 'backlog',
      proposedBy: 'dispatcher',
    });
    expect(soleEvent(harness)).toEqual(frozenReviewFiled({ criteria }));
  });

  it('the perturbation is REAL — the shipped workflow still declares the original targets', () => {
    // The negative control for the control: if `perturbedWorkflow` had returned
    // the shipped object, the two cases above would be asserting `done === done`.
    const shippedReview = SHIPPED_WORKFLOW.nodes.find((node) => node.id === 'review');
    const perturbedReview = PERTURBED_REVIEW_TARGETS.nodes.find((node) => node.id === 'review');
    expect(shippedReview?.acceptance).toMatchObject({ onPass: 'done', onFail: 'implementing' });
    expect(perturbedReview?.acceptance).toMatchObject({
      onPass: 'manual-review',
      onFail: 'backlog',
    });
  });

  it('the SAME dispatcher, unperturbed, still produces the shipped targets — the perturbation moved ONE thing', () => {
    const harness = buildHarness([reviewTask()]);
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, [pass('c1'), pass('c2')]);
    expect(soleProposal(harness).toStage).toBe('done');
  });
});

// ── PART E — A4: UNSET MEANS REST (§3.4), and the reachable UNEVALUABLE ─────
//
// Three perturbations. The first two REMOVE a target rather than move one, and
// both assert the same two things in this order, because the order is the
// contract: the report is still FILED (fact before consequence), and NOTHING is
// proposed. The third removes an ENTIRE acceptance table from a node that still
// arms a capture — the reachable `unevaluable` this file could not exercise
// before the warn seam existed (U3's own addition).

/** implementing's `on_pass` removed — the `report` kind with nowhere to go. */
const NO_ON_PASS = perturbedWorkflow([['\n  on_pass = "review"', '']]);
/** review's `on_fail` removed — a FAILING rubric with nowhere to go. */
const NO_ON_FAIL = perturbedWorkflow([['\n  on_fail       = "implementing"', '']]);
/**
 * planning's ENTIRE `[workflows.nodes.acceptance]` table removed — the node
 * still arms `briefing.capture = ["plan"]` (the reverse-lookup still resolves
 * it), but `acceptanceFor` now answers `node-declares-no-acceptance`
 * (node-kit §1.8.4 (f) NONE is the ORDINARY case for most nodes; here it is
 * forced onto a node that captures something, which is what makes the
 * resulting `unevaluable` REACHABLE through a real report/capture path rather
 * than merely constructible).
 */
const NO_ACCEPTANCE_ON_PLANNING = perturbedWorkflow([
  [
    '  [workflows.nodes.acceptance]\n' +
      '  kind     = "artifact"                     # the captured plan IS the deliverable\n' +
      '  requires = ["capture:plan"]               # satisfied by §1.8.3\'s interception\n' +
      '  on_pass  = "plan-ready"\n',
    '',
  ],
]);

describe('S20-A4 — an UNSET target files the fact and proposes nothing', () => {
  it('unset `on_pass` on a completion → the report still files, the node RESTS', () => {
    const harness = buildHarness([implementingTask()], { declaredWorkflow: NO_ON_PASS });

    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, WORKLOG);

    // FACT BEFORE CONSEQUENCE: the event is unchanged by the perturbation…
    expect(soleEvent(harness)).toEqual(frozenCompletionFiled({ worklog: WORKLOG }));
    // …and nothing routes.
    expect(harness.proposeMoveCalls).toEqual([]);
  });

  it('unset `on_fail` on a FAILING rubric → the report still files, the node RESTS', () => {
    const harness = buildHarness([reviewTask()], { declaredWorkflow: NO_ON_FAIL });
    const criteria = [pass('c1'), fail('c2')];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    expect(soleEvent(harness)).toEqual(frozenReviewFiled({ criteria }));
    expect(harness.proposeMoveCalls).toEqual([]);
  });

  it('…and the same rubric PASSING still routes — rest is the unset arm, not the whole table', () => {
    // Without this control, an implementation that rested on EVERYTHING would
    // pass both cases above.
    const harness = buildHarness([reviewTask()], { declaredWorkflow: NO_ON_FAIL });
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, [pass('c1'), pass('c2')]);
    expect(soleProposal(harness)).toEqual({
      taskId: TASK_ID,
      toStage: 'done',
      proposedBy: 'dispatcher',
    });
  });

  it('a capture arming node with NO acceptance table → the capture still records, UNEVALUABLE, warned EXACTLY ONCE, no proposal', () => {
    const harness = buildHarness([planningTask()], { declaredWorkflow: NO_ACCEPTANCE_ON_PLANNING });

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    // FACT BEFORE CONSEQUENCE: the capture is recorded exactly as it would be
    // on the shipped declaration — the missing acceptance table only affects
    // ROUTING, never whether the fact gets written.
    const event = soleEvent(harness);
    const payload = event.payload as Record<string, unknown> & { artifactHash: string };
    const { artifactHash, ...payloadWithoutHash } = payload;
    expect(event.type).toBe('capture_recorded');
    expect(payloadWithoutHash).toEqual({
      instanceId: TASK_ID,
      captureKind: 'plan',
      node: 'planning',
      attempt: 1,
      payloadRev: 0,
      capturedFrom: { appSessionId: PLANNER_SESSION_ID },
    });
    expect(harness.artifactStore.getBlob(artifactHash)).toBe(PLAN_TEXT);

    // NO PROPOSAL — the table could not be judged, so nothing routes.
    expect(harness.proposeMoveCalls).toEqual([]);

    // EXACTLY ONE WARNING, naming the task, the node, and the typed reason —
    // S19-F1's lesson (assert the count is exactly 1, not just ≥1).
    expect(harness.warnCalls).toHaveLength(1);
    expect(harness.warnCalls[0]).toContain(TASK_ID);
    expect(harness.warnCalls[0]).toContain('planning');
    expect(harness.warnCalls[0]).toContain('node-declares-no-acceptance');
  });

  it('the missing-acceptance perturbation is REAL — the shipped planning node declares one', () => {
    const shippedPlanning = SHIPPED_WORKFLOW.nodes.find((node) => node.id === 'planning');
    const perturbedPlanning = NO_ACCEPTANCE_ON_PLANNING.nodes.find((node) => node.id === 'planning');
    expect(shippedPlanning?.acceptance).toBeDefined();
    expect(perturbedPlanning?.acceptance).toBeUndefined();
    // …and the capture arming survived the edit — this is the whole point of
    // the perturbation: a node that still captures but no longer accepts.
    expect(perturbedPlanning?.briefing?.capture).toEqual(['plan']);
  });
});

// ── PART F — A5: the runtime binding guard, preserved (unmediated by the dispatcher) ─
//
// These cells call `declared*Routing` directly — they were never part of the
// compiled/declared comparison (there was never a compiled equivalent of
// "resolve a spurious verb"), so the flip does not change their shape. They
// stay a white-box check on `acceptanceDeclarations.ts`'s binding guard.

describe('S20-A5 — a verb no node declares is a total runtime NO-OP', () => {
  it('an undeclared verb resolves nothing — no fact, no route', () => {
    const harness = buildHarness([reviewTask()]);

    expect(
      declaredReviewRouting({
        workflow: SHIPPED_WORKFLOW,
        tasks: harness.tasks,
        // A verb the shipped workflow binds to no node's acceptance.
        appSessionId: REVIEWER_SESSION_ID,
        verbId: 'vimes_report.report_nothing',
        criteria: [pass('c1')],
      }),
    ).toEqual({ kind: 'no-op', reason: 'verb-not-declared' });
  });

  it('POSITIVE CONTROL: the two shipped verbs each resolve to their own node', () => {
    // Without this the case above would pass for an implementation that resolved
    // NOTHING — the guard would look preserved while the binding was broken.
    const reviewHarness = buildHarness([reviewTask()]);
    const reviewRouting = declaredReviewRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: reviewHarness.tasks,
      appSessionId: REVIEWER_SESSION_ID,
      verbId: REVIEW_VERB,
      criteria: [pass('c1'), pass('c2')],
    });
    expect(reviewRouting.kind === 'record' && reviewRouting.identity.node).toBe('review');

    const completionHarness = buildHarness([implementingTask()]);
    const completionRouting = declaredCompletionRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: completionHarness.tasks,
      appSessionId: IMPLEMENTER_SESSION_ID,
      verbId: COMPLETION_VERB,
      worklog: WORKLOG,
    });
    expect(completionRouting.kind === 'record' && completionRouting.identity.node).toBe(
      'implementing',
    );
  });

  it('a capture no node arms is the same total no-op — the capture twin of the guard', () => {
    const harness = buildHarness([planningTask()]);
    expect(
      declaredPlanRouting({
        workflow: SHIPPED_WORKFLOW,
        tasks: harness.tasks,
        appSessionId: PLANNER_SESSION_ID,
        // Not `'plan'`: a name no node's `briefing.capture` declares. Cast because
        // the input type is the event's CLOSED catalogue — the point of the cell is
        // that even a name the type system would not admit is answered, not thrown.
        captureName: 'diff' as unknown as 'plan',
        captureText: PLAN_TEXT,
      }),
    ).toEqual({ kind: 'no-op', reason: 'capture-not-declared' });
  });

  it('POSITIVE CONTROL: `plan` resolves to the node that ARMS it, read off the briefing', () => {
    const harness = buildHarness([planningTask()]);
    const routing = declaredPlanRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: harness.tasks,
      appSessionId: PLANNER_SESSION_ID,
      captureName: PLAN_CAPTURE,
      captureText: PLAN_TEXT,
    });
    expect(routing.kind === 'record' && routing.identity.node).toBe('planning');
    // …and the resolution really did come from the DECLARATION: the only node
    // whose briefing arms `plan` is the one it resolved to.
    expect(
      SHIPPED_WORKFLOW.nodes
        .filter((node) => node.briefing?.capture.includes(PLAN_CAPTURE) === true)
        .map((node) => node.id),
    ).toEqual(['planning']);
  });
});
