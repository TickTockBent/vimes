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
  type TransitionProposal,
} from '@vimes/core';
import type { SendResult, SpawnResult } from './sessionHost.js';
import type { ProposeMoveResult } from './instanceWriter.js';
import { TaskDispatcher, type TaskDispatcherDeps } from './taskDispatcher.js';
import { SHIPPED_MANIFEST_PATH, SHIPPED_WORKFLOW_ID, loadShippedWorkflow } from './shippedManifest.js';
import {
  declaredCompletionRouting,
  declaredPlanRouting,
  declaredReviewRouting,
  type DeclaredCaptureRouting,
  type DeclaredOutcome,
  type DeclaredReportRouting,
} from './acceptanceRouting.js';

// ─── S20·U2 — THE A2 DIFFERENTIAL: declared ≡ compiled, cell for cell ─────────
//
// **The slice's central instrument** (slice-20 §3.7, A2), and Move-3's middle
// beat: the declared routing path is built BESIDE the compiled one, and this file
// drives BOTH over the SAME inputs and asserts they agree — the proposal, the
// full emitted payload, and (plan only) the artifact envelope's identity.
//
// ⚠ **BOTH PATHS RUN FROM ONE CASE DEFINITION.** Every cell below builds one
// harness, calls the REAL `TaskDispatcher.record*` (the compiled half, still
// governing production), calls the D1 function over the same task snapshot, and
// compares. That structure is what makes the U3 freeze a small edit: when the
// compiled half is deleted, its side of each comparison becomes a LITERAL and the
// declared side keeps running — the same shape S19's differential froze into.
//
// ⚠ **NOTHING IN THIS FILE FLIPS ANYTHING.** `taskDispatcher.ts` is byte-untouched
// this unit (D4); the declared path has no production caller yet. What is being
// proved is that it is SAFE to give it one.
//
// ── what "declared ≡ compiled" means precisely, and where it deliberately stops ─
//
//   • the PROPOSAL  — the target the declaration names must equal the target the
//     compiled literal / `deriveReviewOutcome` produced. `proposedBy` is NOT a
//     declaration fact: it is I7's constant, supplied by the caller at the choke
//     point and untouched by this slice (§0.3), so it is pinned as a literal on
//     the compiled side rather than expected off the declared one.
//   • the EVENT     — the whole `report_filed` `EventInput`, stream and type
//     included. The factories stamp nothing (events.ts), so this is an exact
//     comparison, not a field-by-field approximation.
//   • the ENVELOPE  — plan only. §0.5(d)'s fourth literal class, and Sol round-2's
//     point: an identity that derives three of its four occurrences and hard-codes
//     the fourth is internally inconsistent under perturbation.
//   • the HASH and `createdAt` — NOT compared as declared facts, because they are
//     not declared facts. One is the store's (content-addressed, produced by the
//     `put` the caller runs) and one is the injected clock's. The differential
//     asserts the declared payload equals the emitted one MINUS the hash, and
//     separately that the hash names stored content — which is the compiled half's
//     own store→emit contract, not a routing claim.

// ── PART A — the harness: `record*`-only, and nothing else ──────────────────
//
// A deliberately smaller harness than `taskDispatcher.test.ts`'s. The three
// methods under test never spawn, never resolve a working directory, never
// consult the checkout coordinator and never read the meters — so the fakes for
// all of that are inert, and the session-host stub THROWS rather than recording:
// a differential cell that reached the host would be exercising something other
// than the routing, and should fail loudly rather than pass quietly.

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
// LITERALS on purpose: they are the differential's INPUT, not something derived
// from the declaration under test — deriving them from the same workflow the
// declared path resolves against would make the binding assert itself. A5's
// positive control below is what ties these two strings to the two nodes.
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
    proposal: TransitionProposal;
    emittedCountBefore: number;
  }>;
  readonly artifactStore: MemoryArtifactStore;
  /** The EXACT snapshot the dispatcher read — handed to the declared path too. */
  readonly tasks: TasksState;
}

function buildHarness(tasks: readonly TaskRecord[]): Harness {
  const emitted: EventInput[] = [];
  const proposeMoveCalls: Harness['proposeMoveCalls'] = [];
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
        proposeMoveCalls.push({ taskId, proposal, emittedCountBefore: emitted.length });
        return { outcome: 'unknown-task', taskId };
      },
    },
  };

  return {
    dispatcher: new TaskDispatcher(deps),
    emitted,
    proposeMoveCalls,
    artifactStore,
    tasks: tasksState,
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

// ── the two sides of every comparison, named once ───────────────────────────

/**
 * The declared path's proposal, in the shape the CALLER will hand
 * `instanceWriter.proposeMove`. `proposedBy` is I7's constant — see the header —
 * so it is added here rather than expected off the declaration.
 */
interface ProposalShape {
  readonly toStage: string;
  readonly proposedBy: string;
}

function declaredProposal(routing: DeclaredReportRouting | DeclaredCaptureRouting): ProposalShape {
  const outcome = declaredOutcome(routing);
  expect(outcome.kind).toBe('propose');
  if (outcome.kind !== 'propose') throw new Error('unreachable');
  return { toStage: outcome.toStage, proposedBy: 'dispatcher' };
}

/**
 * The compiled path's ONE proposal, with the "exactly one" claim asserted.
 *
 * Narrowed to the two fields under comparison — `TransitionProposal` also carries
 * `manualReviewRequired` and `note`, neither of which any `record*` path sets and
 * neither of which slice 20 touches; comparing the whole object would silently
 * make this differential a guard on fields it has nothing to say about.
 */
function compiledProposal(harness: Harness): ProposalShape {
  expect(harness.proposeMoveCalls).toHaveLength(1);
  const call = harness.proposeMoveCalls[0]!;
  expect(call.taskId).toBe(TASK_ID);
  const proposal: TransitionProposal = call.proposal;
  expect(proposal.manualReviewRequired).toBeUndefined();
  expect(proposal.note).toBeUndefined();
  return { toStage: proposal.toStage, proposedBy: proposal.proposedBy };
}

/** The declared path's routing decision, with the "it recorded at all" claim asserted. */
function declaredOutcome(routing: DeclaredReportRouting | DeclaredCaptureRouting): DeclaredOutcome {
  expect(routing.kind).toBe('record');
  if (routing.kind !== 'record') throw new Error('unreachable');
  return routing.outcome;
}

/** The compiled path's ONE event, with the "exactly one" claim asserted. */
function compiledEvent(harness: Harness): EventInput {
  expect(harness.emitted).toHaveLength(1);
  return harness.emitted[0]!;
}

function recordedEvent(routing: DeclaredReportRouting): EventInput {
  expect(routing.kind).toBe('record');
  if (routing.kind !== 'record') throw new Error('unreachable');
  return routing.event;
}

// ── PART B — A2: the outcome matrix (slice-20 §3.7) ─────────────────────────

const pass = (criterionId: string): ReportReviewPayload['criteria'][number] => ({
  criterionId,
  verdict: 'pass',
});
const fail = (criterionId: string): ReportReviewPayload['criteria'][number] => ({
  criterionId,
  verdict: 'fail',
});

/**
 * The five REVIEW cells, in §3.7's order. The shape is U1's equivalence table
 * (`core/src/extensions/acceptance.test.ts`) deliberately reused: the same five
 * rows, driven here through the whole dispatcher rather than the pure arm.
 *
 * `expectedStage` is the COMPILED answer, restated as a literal — so a cell that
 * agreed with the compiled path because BOTH regressed the same way still fails.
 * That is the reason a differential with no independent expectation is weaker
 * than it looks.
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

describe('S20-A2 differential — REVIEW: declared ≡ compiled over the outcome matrix', () => {
  it.each(REVIEW_CELLS)('$name', (cell) => {
    const task = reviewTask({ acceptanceCriteria: [...cell.instanceCriteria] });
    const harness = buildHarness([task]);

    // ── the COMPILED path: the real dispatcher, unchanged this unit ──────────
    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, cell.criteria);

    // ── the DECLARED path, over the SAME snapshot ────────────────────────────
    const declared = declaredReviewRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: harness.tasks,
      appSessionId: REVIEWER_SESSION_ID,
      verbId: REVIEW_VERB,
      criteria: cell.criteria,
    });

    // the independent expectation (see the table's note)
    expect(compiledProposal(harness).toStage).toBe(cell.expectedStage);
    // the differential proper
    expect(declaredProposal(declared)).toEqual(compiledProposal(harness));
    expect(recordedEvent(declared)).toEqual(compiledEvent(harness));
  });

  it('the matrix really does exercise BOTH outcomes', () => {
    // Five identical comparisons would pass while proving nothing about the rule.
    expect([...new Set(REVIEW_CELLS.map((cell) => cell.expectedStage))].sort()).toEqual([
      'done',
      'implementing',
    ]);
  });
});

describe('S20-A2 differential — COMPLETION: declared ≡ compiled', () => {
  it('a valid worklog files the report and routes to the declared target', () => {
    const harness = buildHarness([implementingTask()]);

    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, WORKLOG);

    const declared = declaredCompletionRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: harness.tasks,
      appSessionId: IMPLEMENTER_SESSION_ID,
      verbId: COMPLETION_VERB,
      worklog: WORKLOG,
    });

    expect(compiledProposal(harness).toStage).toBe('review');
    expect(declaredProposal(declared)).toEqual(compiledProposal(harness));
    expect(recordedEvent(declared)).toEqual(compiledEvent(harness));
  });
});

describe('S20-A2 differential — PLAN: declared ≡ compiled, ENVELOPE INCLUDED', () => {
  it('a captured plan records the same fact, the same envelope identity, and the same move', () => {
    const harness = buildHarness([planningTask()]);

    harness.dispatcher.recordPlan(PLANNER_SESSION_ID, PLAN_TEXT);

    const declared = declaredPlanRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: harness.tasks,
      appSessionId: PLANNER_SESSION_ID,
      captureName: PLAN_CAPTURE,
      captureText: PLAN_TEXT,
    });
    expect(declared.kind).toBe('record');
    if (declared.kind !== 'record') throw new Error('unreachable');

    // 1. the MOVE
    expect(compiledProposal(harness).toStage).toBe('plan-ready');
    expect(declaredProposal(declared)).toEqual(compiledProposal(harness));

    // 2. the FACT — everything but the hash, which is the store's (see the header).
    const emitted = compiledEvent(harness);
    const emittedPayload = emitted.payload as Record<string, unknown> & { artifactHash: string };
    const { artifactHash, ...emittedWithoutHash } = emittedPayload;
    expect(declared.capture).toEqual(emittedWithoutHash);
    // …and the hash the compiled half emitted really does name stored content,
    // which is its own store→emit ordering contract rather than a routing claim.
    expect(harness.artifactStore.getBlob(artifactHash)).toBe(PLAN_TEXT);

    // 3. the ENVELOPE (§0.5(d), A2's Sol round-2 addition) — kind, taskId,
    // taskRef.stage and rev. `createdAt` and `hash` are the clock's and the
    // store's, so they are stripped rather than declared.
    const envelopes = harness.artifactStore.listByTask(TASK_ID);
    expect(envelopes).toHaveLength(1);
    const { hash, createdAt, ...envelopeIdentity } = envelopes[0]!;
    expect(declared.envelope).toEqual(envelopeIdentity);
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

describe('S20-A2 differential — the D46 identity tuple, where it actually counts', () => {
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

    const declared = declaredReviewRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: harness.tasks,
      appSessionId: REVIEWER_SESSION_ID,
      verbId: REVIEW_VERB,
      criteria,
    });

    // The independent expectation: two review refs, rev 3 — NOT 1 and NOT 0.
    expect(compiledEvent(harness).payload).toMatchObject({ attempt: 2, payloadRev: 3 });
    expect(recordedEvent(declared)).toEqual(compiledEvent(harness));
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

    const declared = declaredPlanRouting({
      workflow: SHIPPED_WORKFLOW,
      tasks: harness.tasks,
      appSessionId: PLANNER_SESSION_ID,
      captureName: PLAN_CAPTURE,
      captureText: PLAN_TEXT,
    });
    expect(declared.kind).toBe('record');
    if (declared.kind !== 'record') throw new Error('unreachable');

    const emittedPayload = compiledEvent(harness).payload as Record<string, unknown> & {
      artifactHash: string;
    };
    expect(emittedPayload).toMatchObject({ attempt: 2, payloadRev: 2 });
    const { artifactHash: _hash, ...emittedWithoutHash } = emittedPayload;
    expect(declared.capture).toEqual(emittedWithoutHash);
    expect(declared.envelope.rev).toBe(2);
    const { hash: _envHash, createdAt: _createdAt, ...envelopeIdentity } =
      harness.artifactStore.listByTask(TASK_ID)[0]!;
    expect(declared.envelope).toEqual(envelopeIdentity);
  });
});

// ── PART C — the NO-OP cells: both paths do nothing, for the same reason ────

describe('S20-A2 differential — the NO-OP cells: an unknown session records nothing', () => {
  it('review: compiled emits and proposes nothing; declared says `no-owning-task`', () => {
    const harness = buildHarness([reviewTask()]);

    expect(() => harness.dispatcher.recordReview(UNKNOWN_SESSION_ID, [pass('c1')])).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(harness.proposeMoveCalls).toEqual([]);
    expect(
      declaredReviewRouting({
        workflow: SHIPPED_WORKFLOW,
        tasks: harness.tasks,
        appSessionId: UNKNOWN_SESSION_ID,
        verbId: REVIEW_VERB,
        criteria: [pass('c1')],
      }),
    ).toEqual({ kind: 'no-op', reason: 'no-owning-task' });
  });

  it('completion: same, both sides', () => {
    const harness = buildHarness([implementingTask()]);

    expect(() => harness.dispatcher.recordCompletion(UNKNOWN_SESSION_ID, WORKLOG)).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(harness.proposeMoveCalls).toEqual([]);
    expect(
      declaredCompletionRouting({
        workflow: SHIPPED_WORKFLOW,
        tasks: harness.tasks,
        appSessionId: UNKNOWN_SESSION_ID,
        verbId: COMPLETION_VERB,
        worklog: WORKLOG,
      }),
    ).toEqual({ kind: 'no-op', reason: 'no-owning-task' });
  });

  it('plan: same, both sides — and the EMPTY capture is the compiled guard, preserved', () => {
    const harness = buildHarness([planningTask()]);

    expect(() => harness.dispatcher.recordPlan(UNKNOWN_SESSION_ID, PLAN_TEXT)).not.toThrow();
    expect(harness.emitted).toEqual([]);
    expect(harness.proposeMoveCalls).toEqual([]);
    expect(harness.artifactStore.listByTask(TASK_ID)).toEqual([]);
    expect(
      declaredPlanRouting({
        workflow: SHIPPED_WORKFLOW,
        tasks: harness.tasks,
        appSessionId: UNKNOWN_SESSION_ID,
        captureName: PLAN_CAPTURE,
        captureText: PLAN_TEXT,
      }),
    ).toEqual({ kind: 'no-op', reason: 'no-owning-task' });

    // …and the whitespace-only plan, which the compiled half refuses BEFORE the
    // lookup — so the declared half must too, or the two disagree about whether
    // an unknown session with an empty plan is one no-op or two.
    const emptyHarness = buildHarness([planningTask()]);
    emptyHarness.dispatcher.recordPlan(PLANNER_SESSION_ID, '   \n\t  ');
    expect(emptyHarness.emitted).toEqual([]);
    expect(emptyHarness.proposeMoveCalls).toEqual([]);
    expect(
      declaredPlanRouting({
        workflow: SHIPPED_WORKFLOW,
        tasks: emptyHarness.tasks,
        appSessionId: PLANNER_SESSION_ID,
        captureName: PLAN_CAPTURE,
        captureText: '   \n\t  ',
      }),
    ).toEqual({ kind: 'no-op', reason: 'empty-capture' });
  });
});

// ── PART D — A3: THE DECLARATION GOVERNS (perturbation) ─────────────────────
//
// S19's lesson, restated: a differential run against a manifest that AGREES with
// the compiled literals proves only that two paths agree, never that the
// declaration is what decided. The perturbation is the evidence. A copy of the
// shipped manifest is edited IN MEMORY (the shipped file is never touched — it is
// the 37-golden reference and §2-out), re-parsed through the real parser, and the
// declared path is driven against it while the compiled path — which cannot read
// a manifest at all — keeps emitting its literals. **THE DIFFERENCE IS THE POINT.**

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
 * asserted here is which target the DECLARATION produced.
 */
const PERTURBED_REVIEW_TARGETS = perturbedWorkflow([
  ['on_pass       = "done"', 'on_pass       = "manual-review"'],
  ['on_fail       = "implementing"', 'on_fail       = "backlog"'],
]);

describe('S20-A3 — the DECLARATION governs the targets, not the deleted literals', () => {
  it('a passing review routes to the PERTURBED on_pass while the compiled half still says `done`', () => {
    const harness = buildHarness([reviewTask()]);
    const criteria = [pass('c1'), pass('c2')];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    const declared = declaredReviewRouting({
      workflow: PERTURBED_REVIEW_TARGETS,
      tasks: harness.tasks,
      appSessionId: REVIEWER_SESSION_ID,
      verbId: REVIEW_VERB,
      criteria,
    });

    // The compiled half cannot read a manifest: it still proposes its literal.
    expect(compiledProposal(harness).toStage).toBe('done');
    // The declared half followed the declaration. THE DIFFERENCE IS THE EVIDENCE.
    expect(declaredProposal(declared)).toEqual({
      toStage: 'manual-review',
      proposedBy: 'dispatcher',
    });
    // …and the FACT is unchanged by the perturbation: only the routing moved.
    expect(recordedEvent(declared)).toEqual(compiledEvent(harness));
  });

  it('a failing review routes to the PERTURBED on_fail while the compiled half still says `implementing`', () => {
    const harness = buildHarness([reviewTask()]);
    const criteria = [pass('c1'), fail('c2')];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    const declared = declaredReviewRouting({
      workflow: PERTURBED_REVIEW_TARGETS,
      tasks: harness.tasks,
      appSessionId: REVIEWER_SESSION_ID,
      verbId: REVIEW_VERB,
      criteria,
    });

    expect(compiledProposal(harness).toStage).toBe('implementing');
    expect(declaredProposal(declared)).toEqual({ toStage: 'backlog', proposedBy: 'dispatcher' });
    expect(recordedEvent(declared)).toEqual(compiledEvent(harness));
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
});

// ── PART E — A4: UNSET MEANS REST (§3.4) ────────────────────────────────────
//
// Two perturbations that REMOVE a target rather than move one. Both assert the
// same two things, in this order, because the order is the contract: the report
// is still FILED (fact before consequence), and NOTHING is proposed.

/** implementing's `on_pass` removed — the `report` kind with nowhere to go. */
const NO_ON_PASS = perturbedWorkflow([['\n  on_pass = "review"', '']]);
/** review's `on_fail` removed — a FAILING rubric with nowhere to go. */
const NO_ON_FAIL = perturbedWorkflow([['\n  on_fail       = "implementing"', '']]);

describe('S20-A4 — an UNSET target files the fact and proposes nothing', () => {
  it('unset `on_pass` on a completion → the report still files, the node RESTS', () => {
    const harness = buildHarness([implementingTask()]);

    harness.dispatcher.recordCompletion(IMPLEMENTER_SESSION_ID, WORKLOG);

    const declared = declaredCompletionRouting({
      workflow: NO_ON_PASS,
      tasks: harness.tasks,
      appSessionId: IMPLEMENTER_SESSION_ID,
      verbId: COMPLETION_VERB,
      worklog: WORKLOG,
    });

    // FACT BEFORE CONSEQUENCE: the event is identical to the compiled one…
    expect(recordedEvent(declared)).toEqual(compiledEvent(harness));
    // …and the declaration named no target, so nothing routes.
    expect(declaredOutcome(declared)).toEqual({ kind: 'rest' });
    // The compiled half, which still has its literal, is the contrast.
    expect(compiledProposal(harness).toStage).toBe('review');
  });

  it('unset `on_fail` on a FAILING rubric → the report still files, the node RESTS', () => {
    const harness = buildHarness([reviewTask()]);
    const criteria = [pass('c1'), fail('c2')];

    harness.dispatcher.recordReview(REVIEWER_SESSION_ID, criteria);

    const declared = declaredReviewRouting({
      workflow: NO_ON_FAIL,
      tasks: harness.tasks,
      appSessionId: REVIEWER_SESSION_ID,
      verbId: REVIEW_VERB,
      criteria,
    });

    expect(recordedEvent(declared)).toEqual(compiledEvent(harness));
    expect(declaredOutcome(declared)).toEqual({ kind: 'rest' });
    expect(compiledProposal(harness).toStage).toBe('implementing');
  });

  it('…and the same rubric PASSING still routes — rest is the unset arm, not the whole table', () => {
    // Without this control, an implementation that rested on EVERYTHING would
    // pass both cases above.
    const harness = buildHarness([reviewTask()]);
    const criteria = [pass('c1'), pass('c2')];
    const declared = declaredReviewRouting({
      workflow: NO_ON_FAIL,
      tasks: harness.tasks,
      appSessionId: REVIEWER_SESSION_ID,
      verbId: REVIEW_VERB,
      criteria,
    });
    expect(declaredProposal(declared)).toEqual({ toStage: 'done', proposedBy: 'dispatcher' });
  });
});

// ── PART F — A5: the runtime binding guard, preserved ───────────────────────

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
