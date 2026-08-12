import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  RETIRED_EVENT_KINDS,
  SteppingClock,
  readAllStreamsGrouped,
  replayFromEmpty,
  // S11·U1 (D72 Move 2): the fold is the INSTANCE store now; every task-shaped
  // read below goes through `legacyTasksViewOf`, which is where the shape these
  // assertions speak lives. S11·U2 flips the WRITE side to match — the returned
  // records and the outcomes are untouched, and that is what these otherwise
  // unchanged assertions prove.
  canonicalJson,
  instancesProjection,
  // S13-A2: the widened generic payload schema, and the frozen historical enum
  // the alien reason must NOT be a member of.
  instanceMoveRejectedPayloadSchema,
  transitionRejectionReasonSchema,
  // S12-A6: the LEGACY birth constructor, used to plant a recorded pre-Move-3
  // instance (its ref folds to `null` through the alias adapter).
  taskCreated,
  legacyTasksViewOf,
  type EventInput,
  type InstancesState,
  type ParsedWorkflow,
  type TaskRecord,
  type TasksState,
  type TransitionProposal,
} from '@vimes/core';
import {
  InstanceWriter,
  type ProposeMoveResult,
  type RevisePayloadResult,
} from './instanceWriter.js';
import { loadShippedWorkflow } from './shippedManifest.js';

// ─── S11·U2 — the SOLE instance writer (slice 6 step 4b, re-homed) ───────────
//
// ⚠ THE INSTRUMENT THAT MATTERS HERE IS THE EVENT LOG, NOT THE RETURN VALUE.
// I7 is "a proposal that violates the state machine is rejected AND THE REJECTION
// IS EVENTED". A writer that returned the right reason and wrote nothing would
// satisfy every return-value assertion in this file while violating the invariant
// outright — so every rejection case asserts the EMITTED RECORD first and the
// returned reason second, and additionally asserts that NO `instance_moved` rode
// along beside it.
//
// The harness folds the real `instancesProjection` over a real MemoryEventStore
// and narrows it back through `legacyTasksViewOf`, so
// `readTasks` is a genuine fold of what was actually written — not a hand-held
// state object the writer could agree with by construction.
//
// ⚠ WHAT CHANGED IN THE PORT, AND WHAT DELIBERATELY DID NOT. Every expectation on
// an EMITTED KIND or an EMITTED PAYLOAD moved to the generic spelling
// (`instance_created` / `instance_moved` / `instance_move_rejected` /
// `instance_payload_revised`, with `instanceId`/`project`/`node`/`payload`/
// `patch`) — that flip IS this unit. Every expectation on a RETURNED record, a
// returned outcome, the folded board or the id sequence is byte-identical to the
// one that shipped, because none of that was supposed to move.

const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';

// ── S12·U2 (D72 Move 3): the harness adjudicates against the REAL SHIPPED
// DECLARATION, not a hand-built one. Two reasons. First, it is what production
// reads — a writer test against a bespoke workflow would prove agreement with a
// fiction. Second, every assertion below about a rejection reason or an accepted
// edge is now, transitively, an assertion that the SHIPPED manifest still says
// what the compiled table said (S12-A1's promise, exercised through the writer).
const SHIPPED_WORKFLOW = loadShippedWorkflow();

interface WriterHarness {
  writer: InstanceWriter;
  // Every event the writer emitted, in order.
  emitted: EventInput[];
  // How many times the writer read the projection.
  readTasksCallCount: () => number;
  // The projection as folded from the store RIGHT NOW.
  currentTasks: () => TasksState;
  // S12·U2: append events the WRITER did not write — used only to plant a
  // RECORDED PRE-MOVE-3 birth (a legacy `task_created`, whose ref folds to
  // `null`), which is a history no current code path can produce.
  seedRecordedEvents: (events: EventInput[]) => void;
  // The INSTANCE fold (not the legacy narrowing) — the only view that carries the
  // `workflow` ref, which is the fact the S12-A6 block below is about.
  currentInstances: () => InstancesState;
}

// S13·U1: the workflow is INJECTABLE, defaulting to the shipped declaration.
// Every pre-existing caller passes nothing and adjudicates against the real
// manifest exactly as before; the S13-A2 block below passes a declaration
// carrying a forbidden reason NO enum has ever contained, which is the whole
// point of the assertion (a second tenant's vocabulary, simulated without
// shipping a second tenant).
function buildHarness(workflowUnderTest: ParsedWorkflow = SHIPPED_WORKFLOW.workflow): WriterHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-07-22T12:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  const emitted: EventInput[] = [];
  let readTasksCallCount = 0;

  const currentTasks = (): TasksState =>
    legacyTasksViewOf(replayFromEmpty(instancesProjection, readAllStreamsGrouped(store)));

  const writer = new InstanceWriter({
    emit: (events) => {
      emitted.push(...events);
      store.append(events);
    },
    readTasks: () => {
      readTasksCallCount += 1;
      return currentTasks();
    },
    // A COUNTING id source, injected (rule 0.3): instanceIds are byte-identical
    // run to run, so nothing in this file depends on randomUUID.
    ids: new CountingIdSource(),
    // The declaration the writer adjudicates against, and the ref it stamps —
    // both the SHIPPED ones (see SHIPPED_WORKFLOW above).
    workflow: workflowUnderTest,
    workflowRef: SHIPPED_WORKFLOW.ref,
  });

  return {
    writer,
    emitted,
    readTasksCallCount: () => readTasksCallCount,
    currentTasks,
    seedRecordedEvents: (events) => store.append(events),
    currentInstances: () => replayFromEmpty(instancesProjection, readAllStreamsGrouped(store)),
  };
}

function eventTypes(events: EventInput[]): string[] {
  return events.map((event) => event.type);
}

function proposal(overrides: Partial<TransitionProposal> = {}): TransitionProposal {
  return { toStage: 'planning', proposedBy: 'human', ...overrides };
}

// Walk a fresh instance to a named node through the writer, so the rejection cases
// below start from a REAL recorded history rather than a fabricated record. The
// returned harness has its `emitted` array cleared, so each test's assertions
// count only the events its own proposal produced.
function harnessWithTaskAt(
  stage: TaskRecord['stage'],
  workflowUnderTest: ParsedWorkflow = SHIPPED_WORKFLOW.workflow,
): {
  harness: WriterHarness;
  taskId: string;
} {
  const harness = buildHarness(workflowUnderTest);
  const created = harness.writer.createInstance({
    projectRoot: PROJECT_ROOT,
    createdBy: 'human',
    isolation: 'worktree',
    stage,
  });
  harness.emitted.length = 0;
  return { harness, taskId: created.taskId };
}

describe('InstanceWriter — createInstance', () => {
  it('emits exactly one instance_created and returns the record AS FOLDED, not an echo', () => {
    // Assertion 3. The returned record is compared field-by-field against the
    // projection's own fold of the log, so an implementation that hand-built the
    // return value would have to hand-build it identically to the projection —
    // and a projection/event disagreement shows up here immediately.
    const harness = buildHarness();
    const created = harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceCreated]);
    expect(harness.emitted[0]!.stream).toBe('tasks');
    // ⚠ THE PORTED EXPECTATION, RE-POINTED BY S12·U2 (S12-A6): the birth payload
    // is the GENERIC one — `instanceId`/`project`/`node`, the five authored fields
    // under `payload` (`{}` when nobody authored anything) — and `workflow` is now
    // the PINNED REF instead of `null`. That flip is the point of D72 Move 3: a
    // declaration governs adjudication as of this unit, so stamping its identity
    // is observed truth rather than the declared kind rule 0.7 forbade. The rev is
    // the shipped manifest's own semver `version`.
    expect(harness.emitted[0]!.payload).toEqual({
      instanceId: created.taskId,
      project: PROJECT_ROOT,
      node: 'backlog',
      createdBy: 'human',
      workflow: { extension: 'vimes-tasks', workflow: 'software', rev: '1.0.0' },
      isolation: 'worktree',
      payload: {},
    });

    // ⚠ AND THE RECORD IS UNCHANGED. The fold still produces today's task shape,
    // so this half of the assertion is byte-identical to the pre-S11 one.
    const foldedTask = harness.currentTasks().tasks[created.taskId];
    expect(created).toEqual(foldedTask);
    expect(created).toEqual({
      taskId: created.taskId,
      projectRoot: PROJECT_ROOT,
      stage: 'backlog',
      manualReviewRequired: false,
      isolation: 'worktree',
      gates: {},
      sessionRefs: [],
      createdBy: 'human',
      lastHeartbeatAt: null,
      staleRetries: 0,
    } satisfies TaskRecord);
  });

  it('mints the instanceId from the INJECTED id source', () => {
    // Rule 0.3: nothing here reaches for randomUUID. A CountingIdSource makes the
    // id deterministic, which is what lets the fixtures above compare bytes.
    const harness = buildHarness();
    const first = harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    const second = harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    expect(first.taskId).toBe('00000000-0000-4000-8000-000000000001');
    expect(second.taskId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('round-trips GATES through the log into the folded record', () => {
    // The step-4b widening, exercised through the writer rather than the fold: a
    // gated instance is only expressible in production because the birth record
    // now carries the field. `gates` stays TOP-LEVEL on the generic payload — it
    // is transitional CORE (slice-11.md's fence), not tenant payload, because the
    // engine still reads it to decide.
    const harness = buildHarness();
    const created = harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'orchestrator',
      isolation: 'shared-dir',
      stage: 'backlog',
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
    });

    expect(harness.emitted[0]!.payload).toMatchObject({
      gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
    });
    expect(created.gates).toEqual({ requireHeadroom: { meterId: 'window-5h', pct: 40 } });
    expect(created).toEqual(harness.currentTasks().tasks[created.taskId]);
  });

  it('omits `gates` from the birth record entirely when none were named', () => {
    // An ungated instance's birth record keeps the absent-vs-empty discipline the
    // fold's ONE defaulting rule (`gates ?? {}`) depends on — the widening is
    // optional-only, exactly as it was on `task_created`.
    const harness = buildHarness();
    harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    expect(Object.keys(harness.emitted[0]!.payload as object).sort()).toEqual(
      ['createdBy', 'instanceId', 'isolation', 'node', 'payload', 'project', 'workflow'],
    );
  });

  // ── S7·2a — the four AUTHORED work-order fields ─────────────────────────────

  it('MINTS one id per acceptance criterion from the injected source (deterministic)', () => {
    // THE PINNED DESIGN, exercised. The input criterion is `{ text }` only; the
    // writer mints the id server-side from the SAME CountingIdSource that mints
    // the instanceId, so under the counting source the ids are byte-deterministic.
    // The instanceId is minted FIRST (counter #1), then each criterion in order
    // (#2, #3), so the exact strings are pinnable — which is what proves nothing
    // re-mints and nothing reaches for randomUUID.
    const harness = buildHarness();
    const created = harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
      scope: 'carry the work order onto the born record',
      explicitlyOut: ['the amend path (S7·2b)'],
      acceptanceCriteria: [
        { text: 'first criterion' },
        { text: 'second criterion' },
      ],
      killCriterion: 'a criterion id cannot be made deterministic',
    });

    // instanceId is counter #1; criterion ids are #2 and #3, in order.
    expect(created.taskId).toBe('00000000-0000-4000-8000-000000000001');
    expect(created.acceptanceCriteria).toEqual([
      { id: '00000000-0000-4000-8000-000000000002', text: 'first criterion' },
      { id: '00000000-0000-4000-8000-000000000003', text: 'second criterion' },
    ]);

    // Exactly ONE event, and it is the birth record on the tasks stream (the
    // stream name is persisted state and does NOT move with the vocabulary —
    // slice-11.md).
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceCreated]);

    // The FULL {id,text} criteria (not the {text} input) are what got written into
    // the event, so replay reads the stored ids back — now under the OPAQUE
    // `payload` key (q13's record split), which is the whole ported expectation.
    expect(harness.emitted[0]!.payload).toMatchObject({
      payload: {
        scope: 'carry the work order onto the born record',
        explicitlyOut: ['the amend path (S7·2b)'],
        acceptanceCriteria: [
          { id: '00000000-0000-4000-8000-000000000002', text: 'first criterion' },
          { id: '00000000-0000-4000-8000-000000000003', text: 'second criterion' },
        ],
        killCriterion: 'a criterion id cannot be made deterministic',
      },
    });

    // I12: the returned record IS the projection's fold of the log, not an echo.
    expect(created).toEqual(harness.currentTasks().tasks[created.taskId]);
    expect(created.scope).toBe('carry the work order onto the born record');
    expect(created.explicitlyOut).toEqual(['the amend path (S7·2b)']);
    expect(created.killCriterion).toBe('a criterion id cannot be made deterministic');
  });

  it('omits ALL work-order fields from the birth record when none were named', () => {
    // Absent stays absent (I6) — and after the record split the absence lives
    // INSIDE `payload`: the key is always present (the schema requires it) and it
    // is EMPTY, which is exactly what the alias adapter produces for every
    // recorded unauthored `task_created`. A mixed-era stream therefore folds one
    // way (S11-A2).
    const harness = buildHarness();
    const created = harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    expect(Object.keys(harness.emitted[0]!.payload as object).sort()).toEqual(
      ['createdBy', 'instanceId', 'isolation', 'node', 'payload', 'project', 'workflow'],
    );
    expect((harness.emitted[0]!.payload as { payload: object }).payload).toEqual({});
    // And the folded record carries none of them either.
    expect('scope' in created).toBe(false);
    expect('explicitlyOut' in created).toBe(false);
    expect('acceptanceCriteria' in created).toBe(false);
    expect('killCriterion' in created).toBe(false);
  });
});

// ─── S7·2b — revisePayload (D43: revisioned, not mutated) ────────────────────
//
// Same instrument discipline as the rejection cases below: for every outcome that
// writes NOTHING, the assertion is on `harness.emitted` first and the returned
// outcome second. A writer that returned `unknown-criterion` while emitting a
// revision anyway would satisfy every return-value check in this describe while
// putting a revision in the log that nobody's request produced.

// An instance carrying a two-criterion work order — the record the revision cases
// patch, and the source of the criterion ids they are allowed to restate. Under
// the CountingIdSource the instanceId is #1 and the criteria are #2 and #3, so the
// ids below are byte-deterministic rather than looked up.
const FIRST_CRITERION_ID = '00000000-0000-4000-8000-000000000002';
const SECOND_CRITERION_ID = '00000000-0000-4000-8000-000000000003';

function harnessWithAuthoredTask(stage: TaskRecord['stage'] = 'backlog'): {
  harness: WriterHarness;
  taskId: string;
} {
  const harness = buildHarness();
  const created = harness.writer.createInstance({
    projectRoot: PROJECT_ROOT,
    createdBy: 'human',
    isolation: 'worktree',
    stage,
    scope: 'the scope as first authored',
    explicitlyOut: ['the two-door UI'],
    acceptanceCriteria: [{ text: 'the first criterion' }, { text: 'the second criterion' }],
    killCriterion: 'the kill criterion as first authored',
  });
  harness.emitted.length = 0;
  return { harness, taskId: created.taskId };
}

describe('InstanceWriter — revisePayload', () => {
  it('emits exactly ONE instance_payload_revised carrying only the named fields, and returns the FOLD', () => {
    const { harness, taskId } = harnessWithAuthoredTask();
    const result = harness.writer.revisePayload(taskId, {
      amendedBy: 'human',
      scope: 'the narrowed scope',
    });

    // One event, on the tasks stream, carrying the envelope + ONLY the field the
    // reviser named. The key-set assertion is the byte discipline: an
    // `undefined`-valued `killCriterion` in `patch` would tell the fold to clear a
    // field nobody touched.
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instancePayloadRevised]);
    expect(harness.emitted[0]!.stream).toBe('tasks');
    expect(harness.emitted[0]!.payload).toEqual({
      instanceId: taskId,
      payloadRev: 1,
      revisedBy: 'human',
      patch: { scope: 'the narrowed scope' },
    });

    // I12: the returned record IS the projection's fold of the log, not an echo.
    const foldedTask = harness.currentTasks().tasks[taskId]!;
    expect(result).toEqual({ outcome: 'amended', task: foldedTask });
    expect(foldedTask.scope).toBe('the narrowed scope');
    expect(foldedTask.workOrderRev).toBe(1);
    // Untouched fields survived the patch.
    expect(foldedTask.killCriterion).toBe('the kill criterion as first authored');
  });

  it('bumps the rev 1 → 2 → 3 across successive revisions, starting from ABSENT', () => {
    // The rev is computed HERE and nowhere else, off `(task.workOrderRev ?? 0) + 1`
    // read FRESH each call — so the third revision can only say 3 if the second
    // one's event was really folded back onto the record in between.
    const { harness, taskId } = harnessWithAuthoredTask();
    expect('workOrderRev' in harness.currentTasks().tasks[taskId]!).toBe(false);

    for (const expectedRev of [1, 2, 3]) {
      const result = harness.writer.revisePayload(taskId, {
        amendedBy: 'orchestrator',
        scope: `scope at rev ${expectedRev}`,
      });
      expect(result).toMatchObject({ outcome: 'amended' });
      expect(harness.currentTasks().tasks[taskId]!.workOrderRev).toBe(expectedRev);
    }

    expect(eventTypes(harness.emitted)).toEqual([
      EVENT_TYPES.instancePayloadRevised,
      EVENT_TYPES.instancePayloadRevised,
      EVENT_TYPES.instancePayloadRevised,
    ]);
    expect(harness.emitted.map((event) => (event.payload as { payloadRev: number }).payloadRev)).toEqual([
      1, 2, 3,
    ]);
  });

  it('KEEPS a supplied criterion id verbatim and MINTS one for an id-less entry', () => {
    // The identity rule, exercised: a restated criterion keeps the id
    // `report_review` keys its verdicts to, even when its TEXT changes, while a new
    // criterion gets its id from the INJECTED source (rule 0.3 — nothing here
    // reaches for randomUUID, so the minted id is byte-deterministic). The instance
    // burned counters #1–#3 at creation, so the next mint is #4.
    const { harness, taskId } = harnessWithAuthoredTask();
    const result = harness.writer.revisePayload(taskId, {
      amendedBy: 'human',
      acceptanceCriteria: [
        { id: FIRST_CRITERION_ID, text: 'the first criterion, reworded' },
        { text: 'a criterion the amendment introduces' },
      ],
    });

    const mintedCriteria = [
      { id: FIRST_CRITERION_ID, text: 'the first criterion, reworded' },
      { id: '00000000-0000-4000-8000-000000000004', text: 'a criterion the amendment introduces' },
    ];
    // The FULL {id,text} replacement list is what got written into the event, so
    // replay reads the stored ids back and never re-mints.
    expect(harness.emitted[0]!.payload).toEqual({
      instanceId: taskId,
      payloadRev: 1,
      revisedBy: 'human',
      patch: { acceptanceCriteria: mintedCriteria },
    });
    expect(result).toMatchObject({ outcome: 'amended' });
    // The list is a REPLACEMENT: the second criterion, left out of the revision,
    // is gone from the record.
    expect(harness.currentTasks().tasks[taskId]!.acceptanceCriteria).toEqual(mintedCriteria);
  });

  it('an UNKNOWN criterion id → unknown-criterion, and NOTHING is emitted', () => {
    // The invariant is the empty log, not the returned outcome. Refusing WHOLE is
    // also what keeps a half-applied criteria list unreachable: the good entry
    // beside the bad one is not written either.
    const { harness, taskId } = harnessWithAuthoredTask();
    const result = harness.writer.revisePayload(taskId, {
      amendedBy: 'human',
      scope: 'a scope that must not land',
      acceptanceCriteria: [
        { id: FIRST_CRITERION_ID, text: 'a legitimate restatement' },
        { id: 'crit-id-that-was-never-minted', text: 'keyed to nothing' },
      ],
    });

    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'unknown-criterion',
      criterionId: 'crit-id-that-was-never-minted',
    });
    // The record is untouched — no rev, no new scope.
    const untouchedTask = harness.currentTasks().tasks[taskId]!;
    expect('workOrderRev' in untouchedTask).toBe(false);
    expect(untouchedTask.scope).toBe('the scope as first authored');
  });

  it('an instance with NO criteria has no valid ids — any supplied id is unknown', () => {
    // The edge the `?? []` covers: an unauthored instance cannot have a criterion
    // restated against it, because there is nothing to restate.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    const result = harness.writer.revisePayload(taskId, {
      amendedBy: 'orchestrator',
      acceptanceCriteria: [{ id: FIRST_CRITERION_ID, text: 'keyed to a list that does not exist' }],
    });

    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({ outcome: 'unknown-criterion', criterionId: FIRST_CRITERION_ID });
  });

  it('a refused revision MINTS NOTHING — the id source is untouched', () => {
    // Validate-then-mint, asserted rather than only documented. The refusal below
    // carries an id-less entry that WOULD have minted #4; because validation runs
    // first, the revision that follows still gets #4 and the id sequence is exactly
    // what it would have been had the bad request never arrived.
    const { harness, taskId } = harnessWithAuthoredTask();
    harness.writer.revisePayload(taskId, {
      amendedBy: 'human',
      acceptanceCriteria: [
        { text: 'an entry that would mint' },
        { id: 'crit-id-that-was-never-minted', text: 'the entry that refuses' },
      ],
    });
    expect(harness.emitted).toEqual([]);

    harness.writer.revisePayload(taskId, {
      amendedBy: 'human',
      acceptanceCriteria: [{ text: 'the first id actually minted' }],
    });
    expect(harness.emitted[0]!.payload).toMatchObject({
      patch: {
        acceptanceCriteria: [
          { id: '00000000-0000-4000-8000-000000000004', text: 'the first id actually minted' },
        ],
      },
    });
  });

  it('a revision that names NO work-order field → empty-amendment, nothing emitted', () => {
    // A rev bump that changes nothing is log noise, and it would invalidate every
    // in-flight node run's `payloadRev` for no recorded reason.
    const { harness, taskId } = harnessWithAuthoredTask();
    const result = harness.writer.revisePayload(taskId, { amendedBy: 'human' });

    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({ outcome: 'empty-amendment' });
    expect('workOrderRev' in harness.currentTasks().tasks[taskId]!).toBe(false);
  });

  it('an EXPLICIT empty acceptanceCriteria is a revision, NOT an empty one', () => {
    // The pair the empty check must not conflate: clearing the criteria list is a
    // real, recorded revision; naming nothing at all is not. The explicit `[]`
    // RIDES THROUGH into `patch` — the same thing the alias adapter is careful to
    // preserve in the other direction.
    const { harness, taskId } = harnessWithAuthoredTask();
    const result = harness.writer.revisePayload(taskId, {
      amendedBy: 'human',
      acceptanceCriteria: [],
    });

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instancePayloadRevised]);
    expect(harness.emitted[0]!.payload).toEqual({
      instanceId: taskId,
      payloadRev: 1,
      revisedBy: 'human',
      patch: { acceptanceCriteria: [] },
    });
    expect(result).toMatchObject({ outcome: 'amended' });
    expect(harness.currentTasks().tasks[taskId]!.acceptanceCriteria).toEqual([]);
  });

  it('an unknown taskId emits NOTHING and never throws', () => {
    // Same posture as `proposeMove`'s unknown instance: writing a revision
    // for an id no birth record introduced would put a phantom in the log.
    const harness = buildHarness();
    let result: RevisePayloadResult | undefined;
    expect(() => {
      result = harness.writer.revisePayload('task-that-never-existed', {
        amendedBy: 'human',
        scope: 'an amendment to nothing',
      });
    }).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({ outcome: 'unknown-task', taskId: 'task-that-never-existed' });
    expect(Object.keys(harness.currentTasks().tasks)).toEqual([]);
  });

  it('an instance on a TERMINAL node revises successfully — the missing guard is deliberate', () => {
    // ⚠ PINNED ON PURPOSE. A revision is a RECORD FACT, not a move: the
    // state machine is never consulted, so `done` (and `cancelled`, and
    // `quarantined`) are revisable, unlike the `terminal-stage` REJECTION the
    // move cases below assert. Correcting the written scope of finished work
    // is legitimate, and nothing dangerous follows — dispatch is a separate decision
    // and `decideDispatch` already refuses a task whose stage runs no worker. If a
    // future edit adds a node check here, this test reddens and the reader is sent
    // to `revisePayload`'s note rather than to a silent behaviour change.
    for (const terminalStage of ['done', 'cancelled'] as const) {
      const { harness, taskId } = harnessWithAuthoredTask(terminalStage);
      const result = harness.writer.revisePayload(taskId, {
        amendedBy: 'orchestrator',
        scope: `amended while ${terminalStage}`,
      });

      expect(result, terminalStage).toMatchObject({ outcome: 'amended' });
      expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instancePayloadRevised]);
      const amendedTask = harness.currentTasks().tasks[taskId]!;
      expect(amendedTask.stage).toBe(terminalStage);
      expect(amendedTask.workOrderRev).toBe(1);
    }
  });

  it('proposes NO move and never emits anything but the revision (D53)', () => {
    // No dispatch coupling, no node movement: a revision changes what the work
    // order SAYS and nothing else. An `instance_moved` appearing here would mean
    // the revise door had quietly grown a second consequence.
    const { harness, taskId } = harnessWithAuthoredTask('implementing');
    harness.writer.revisePayload(taskId, { amendedBy: 'human', scope: 'a fresh scope' });

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instancePayloadRevised]);
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('implementing');
  });

  it('reads the projection FRESH and never mutates the state it was handed', () => {
    const { harness, taskId } = harnessWithAuthoredTask();
    const handedOutState = harness.currentTasks();
    const serializedBefore = canonicalJson(handedOutState);
    const readsBefore = harness.readTasksCallCount();

    harness.writer.revisePayload(taskId, { amendedBy: 'human', scope: 'a fresh scope' });

    expect(harness.readTasksCallCount()).toBeGreaterThan(readsBefore);
    expect(canonicalJson(handedOutState)).toBe(serializedBefore);
    expect(canonicalJson(harness.currentTasks())).not.toBe(serializedBefore);
  });
});

describe('InstanceWriter — an ACCEPTED move', () => {
  it('emits exactly one instance_moved and returns the record read back', () => {
    // Assertion 4.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    const result = harness.writer.proposeMove(
      taskId,
      proposal({ toStage: 'planning', proposedBy: 'dispatcher', note: 'kickoff' }),
    );

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceMoved]);
    expect(harness.emitted[0]!.payload).toEqual({
      instanceId: taskId,
      fromNode: 'backlog',
      toNode: 'planning',
      manualReviewRequired: false,
      proposedBy: 'dispatcher',
      note: 'kickoff',
    });
    expect(result).toEqual({
      outcome: 'accepted',
      task: harness.currentTasks().tasks[taskId]!,
    } satisfies ProposeMoveResult);
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('planning');
  });

  it('records the MACHINE\'S RESULTING manualReviewRequired on the → done edge', () => {
    // Assertion 4, the load-bearing half. The convergence exit is the ONE edge
    // where the machine honours the proposal's flag.
    const { harness, taskId } = harnessWithTaskAt('review');
    const result = harness.writer.proposeMove(
      taskId,
      proposal({ toStage: 'done', manualReviewRequired: true, proposedBy: 'dispatcher' }),
    );

    expect(harness.emitted[0]!.payload).toMatchObject({
      toNode: 'done',
      manualReviewRequired: true,
    });
    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(harness.currentTasks().tasks[taskId]!.manualReviewRequired).toBe(true);
  });

  it('records the MACHINE\'S flag, NOT the proposal\'s, on every other edge', () => {
    // The half that proves the writer is recording a RESULT rather than echoing a
    // REQUEST. The machine ignores `manualReviewRequired` off the `→ done` edge
    // and carries the instance's existing value through; a writer that copied the
    // proposal would write `true` here, the projection would fold `true`, and the
    // board would claim a manual review nobody decided on.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    harness.writer.proposeMove(
      taskId,
      proposal({ toStage: 'planning', manualReviewRequired: true, proposedBy: 'human' }),
    );

    expect(harness.emitted[0]!.payload).toMatchObject({ manualReviewRequired: false });
    expect(harness.currentTasks().tasks[taskId]!.manualReviewRequired).toBe(false);
  });

  it('omits `note` from the record when the proposal carried none', () => {
    const { harness, taskId } = harnessWithTaskAt('backlog');
    harness.writer.proposeMove(taskId, proposal({ toStage: 'planning' }));
    expect(Object.keys(harness.emitted[0]!.payload as object)).not.toContain('note');
  });
});

describe('InstanceWriter — I7: a REJECTED proposal is EVENTED, never merely returned', () => {
  // Assertion 5, the load-bearing one. Each row is a DISTINCT refusal reason, so
  // the invariant is established across the machine's whole vocabulary rather than
  // on one convenient branch.
  //
  // Every case asserts three things, and the FIRST is the invariant:
  //   1. exactly one `instance_move_rejected` is in the log, carrying the
  //      attempted edge and the exact reason;
  //   2. NO `instance_moved` rode along beside it — a writer that emitted both
  //      would move the board while claiming it refused;
  //   3. the returned reason matches, and the instance DID NOT MOVE.
  //
  // ⚠ S13·U1 RE-SPELLED THREE OF THESE FIVE, and the split is visible in the
  // table: `expectedReason` is a `string` now because the rows below are drawn
  // from BOTH channels (slice-13 F1). Four are ENGINE reasons, respelled
  // node-generic; `quarantined-cannot-complete` is DECLARED content off the
  // shipped manifest's forbidden row and is UNCHANGED (F2) — which is precisely
  // the classification this table now demonstrates. These are NEW adjudications
  // through the live writer, not historical payloads, so respelling them is the
  // deliberate spec change and not a rewritten record.
  const rejectionCases: Array<{
    caseName: string;
    startingStage: TaskRecord['stage'];
    attemptedToStage: string;
    expectedReason: string;
  }> = [
    {
      caseName: 'illegal-edge (backlog → review is not in the table)',
      startingStage: 'backlog',
      attemptedToStage: 'review',
      expectedReason: 'illegal-edge',
    },
    {
      caseName: 'terminal-node (nothing leaves done — reopening mints a new instance)',
      startingStage: 'done',
      attemptedToStage: 'implementing',
      expectedReason: 'terminal-node',
    },
    {
      caseName: 'same-node (a no-op proposal is still recorded as refused)',
      startingStage: 'planning',
      attemptedToStage: 'planning',
      expectedReason: 'same-node',
    },
    {
      caseName: 'quarantined-cannot-complete (the DECLARED safety refusal, spelling unchanged)',
      startingStage: 'quarantined',
      attemptedToStage: 'done',
      expectedReason: 'quarantined-cannot-complete',
    },
    {
      caseName: 'unknown-node (a node outside the declaration — slice 7 hostile input)',
      startingStage: 'backlog',
      attemptedToStage: 'shipped-it-lol',
      expectedReason: 'unknown-node',
    },
  ];

  for (const rejectionCase of rejectionCases) {
    it(`${rejectionCase.caseName} → one instance_move_rejected, no move`, () => {
      const { harness, taskId } = harnessWithTaskAt(rejectionCase.startingStage);
      const result = harness.writer.proposeMove(taskId, {
        // ⚠ CAST ON PURPOSE. `TransitionProposal.toStage` is typed to the enum,
        // but the whole point of `unknown-stage` is that a value outside it
        // physically reaches the machine across an API boundary (step 1 says so in
        // as many words). TypeScript's guarantee stops at that boundary; the test
        // has to cross it to exercise the branch.
        toStage: rejectionCase.attemptedToStage as TransitionProposal['toStage'],
        proposedBy: 'orchestrator',
      });

      // 1. THE INVARIANT: the rejection is in the log.
      expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceMoveRejected]);
      expect(harness.emitted[0]!.stream).toBe('tasks');
      expect(harness.emitted[0]!.payload).toEqual({
        instanceId: taskId,
        fromNode: rejectionCase.startingStage,
        attemptedToNode: rejectionCase.attemptedToStage,
        reason: rejectionCase.expectedReason,
        proposedBy: 'orchestrator',
      });

      // 2. Nothing moved the board alongside it.
      expect(eventTypes(harness.emitted)).not.toContain(EVENT_TYPES.instanceMoved);

      // 3. The reason came back, and the instance is still where it was.
      expect(result).toEqual({
        outcome: 'rejected',
        reason: rejectionCase.expectedReason,
      } satisfies ProposeMoveResult);
      expect(harness.currentTasks().tasks[taskId]!.stage).toBe(rejectionCase.startingStage);
    });
  }

  it('records EVERY rejection in a run of them — none is dropped after the first', () => {
    // A rejection that stops being recorded once an instance has been refused
    // before is still an unrecorded rejection. Five proposals, five records, still
    // `backlog`.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        harness.writer.proposeMove(taskId, proposal({ toStage: 'done' })).outcome,
      ).toBe('rejected');
    }
    expect(harness.emitted).toHaveLength(5);
    expect(new Set(eventTypes(harness.emitted))).toEqual(
      new Set([EVENT_TYPES.instanceMoveRejected]),
    );
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('backlog');
  });

  it('never throws on any of the rejection shapes (I8)', () => {
    const { harness, taskId } = harnessWithTaskAt('backlog');
    // Cast through `unknown` for the same reason the table above casts: these
    // nodes are OUTSIDE the enum on purpose, which is exactly what a hostile
    // caller across the HTTP boundary can send.
    const hostileProposals = [
      { toStage: '', proposedBy: 'human' },
      { toStage: '../../etc/passwd', proposedBy: 'orchestrator' },
      { toStage: '__proto__', proposedBy: 'dispatcher' },
      { toStage: 'DONE', proposedBy: 'human' },
      { toStage: 'done ', proposedBy: 'human' },
    ] as unknown as TransitionProposal[];

    for (const hostileProposal of hostileProposals) {
      expect(() => harness.writer.proposeMove(taskId, hostileProposal)).not.toThrow();
    }
    // All five were REFUSED and all five were RECORDED — none silently accepted.
    expect(harness.emitted).toHaveLength(hostileProposals.length);
    expect(new Set(eventTypes(harness.emitted))).toEqual(
      new Set([EVENT_TYPES.instanceMoveRejected]),
    );
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('backlog');
  });
});

// ── S13-A2 — the DECLARED channel: a novel forbidden reason is RECORDED ──────
//
// slice-13 §4 S13-A2: "a novel declared forbidden reason (one not in any enum)
// is recorded without throwing. This is the assertion that would have failed
// before this slice."
//
// The reason string is deliberately ALIEN — `sealed-by-the-archivist` is not
// task-flavoured, appears nowhere in engine source, and could not plausibly be
// mistaken for a vocabulary anyone forgot to add. That is F2's classification
// test made concrete: it is a string only a TENANT would write, so the engine
// must carry it without knowing it.
//
// Before S13·U1 this reddened at `instanceWriter.ts`'s
// `transitionRejectionReasonSchema.parse(decision.reason)` — the guard whose own
// comment scheduled its retirement for this slice.
const ARCHIVIST_REASON = 'sealed-by-the-archivist';

// The shipped declaration, plus ONE forbidden row on an edge the shipped table
// declares as LEGAL (`backlog → planning`, manifest line 215). Forbidding a legal
// edge is what makes the assertion load-bearing: without the row the move is
// accepted, so a refusal carrying this reason can only have come from the row.
// The manifest asset itself is UNTOUCHED (F2: no fixture, no manifest, no
// tripwire) — this declaration exists only in this test's memory.
function workflowWithArchivistSeal(): ParsedWorkflow {
  return {
    ...SHIPPED_WORKFLOW.workflow,
    forbidden: [
      ...SHIPPED_WORKFLOW.workflow.forbidden,
      { from: 'backlog', to: 'planning', reason: ARCHIVIST_REASON },
    ],
  };
}

describe('InstanceWriter — S13-A2: a NOVEL declared refusal reason is recorded verbatim', () => {
  it('does not throw, and writes the declaration’s own string into the log', () => {
    const { harness, taskId } = harnessWithTaskAt('backlog', workflowWithArchivistSeal());

    let result: ProposeMoveResult | undefined;
    expect(() => {
      result = harness.writer.proposeMove(taskId, proposal({ toStage: 'planning' }));
    }).not.toThrow();

    // 1. THE INVARIANT (I7, unchanged by the vocabulary split): the refusal is in
    //    the log, and the reason is the DECLARATION's string, byte for byte.
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.instanceMoveRejected]);
    expect(harness.emitted[0]!.stream).toBe('tasks');
    expect(harness.emitted[0]!.payload).toEqual({
      instanceId: taskId,
      fromNode: 'backlog',
      attemptedToNode: 'planning',
      reason: ARCHIVIST_REASON,
      proposedBy: 'human',
    });

    // 2. The returned outcome carries the same string — this is what the 409 body
    //    passes through.
    expect(result).toEqual({
      outcome: 'rejected',
      reason: ARCHIVIST_REASON,
    } satisfies ProposeMoveResult);

    // 3. Nothing moved.
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('backlog');
  });

  it('round-trips verbatim through a real fold of what was actually written', () => {
    // The strongest read surface that exposes a refusal reason is the LOG itself:
    // `packages/core/src/projections/instances.ts` documents `instance_move_rejected`
    // as deliberately NOT folded (a rejection changed no state, so folding it
    // would invent a change). So the round trip asserted here is
    // append -> re-read -> schema-validated payload, which is the whole path a
    // reader has. If a projection ever folds reason content, this is the test to
    // extend.
    const { harness, taskId } = harnessWithTaskAt('backlog', workflowWithArchivistSeal());
    harness.writer.proposeMove(taskId, proposal({ toStage: 'planning' }));

    // The generic event schema must ACCEPT the alien string. This is the widened
    // `instanceMoveRejectedPayloadSchema.reason` (`z.string().min(1)`) under test,
    // aimed at the exact payload the writer wrote.
    const recordedPayload = instanceMoveRejectedPayloadSchema.parse(harness.emitted[0]!.payload);
    expect(recordedPayload.reason).toBe(ARCHIVIST_REASON);

    // And the same string appears NOWHERE in the frozen historical enum — that is
    // what makes it novel rather than a vocabulary entry someone forgot. (The
    // ENGINE enum's exact membership is S13-A1's job, asserted beside its author
    // in `packages/core/src/extensions/proposeMove.test.ts`.)
    expect(transitionRejectionReasonSchema.options).not.toContain(ARCHIVIST_REASON);
  });

  it('carries a reason no engine enum contains, for a SECOND novel string too', () => {
    // One alien string could be a coincidence of schema laxity. A second, shaped
    // differently, shows the channel is open rather than accidentally permissive
    // of one value.
    const secondAlienReason = 'the tide is out';
    const workflow: ParsedWorkflow = {
      ...SHIPPED_WORKFLOW.workflow,
      forbidden: [
        ...SHIPPED_WORKFLOW.workflow.forbidden,
        { from: 'planning', to: 'plan-ready', reason: secondAlienReason },
      ],
    };
    const { harness, taskId } = harnessWithTaskAt('planning', workflow);

    expect(() => {
      harness.writer.proposeMove(taskId, proposal({ toStage: 'plan-ready' }));
    }).not.toThrow();
    expect(harness.emitted[0]!.payload).toMatchObject({ reason: secondAlienReason });
  });
});

describe('InstanceWriter — an unknown taskId', () => {
  it('emits NOTHING and never throws', () => {
    // Assertion 6. Deliberately not even a rejection: fabricating one would put an
    // instanceId in the tasks stream that no birth record ever introduced, and the
    // board would grow a phantom.
    const harness = buildHarness();
    let result: ProposeMoveResult | undefined;
    expect(() => {
      result = harness.writer.proposeMove('task-that-never-existed', proposal());
    }).not.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(result).toEqual({
      outcome: 'unknown-task',
      taskId: 'task-that-never-existed',
    } satisfies ProposeMoveResult);
    expect(Object.keys(harness.currentTasks().tasks)).toEqual([]);
  });
});

describe('InstanceWriter — it reads the projection FRESH and never mutates it', () => {
  it('reads tasks on every call rather than caching a state object', () => {
    // Assertion 7, first half. A writer holding a cached board adjudicates edges
    // out of a node the instance has already left.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    const readsAfterCreate = harness.readTasksCallCount();

    harness.writer.proposeMove(taskId, proposal({ toStage: 'planning' }));
    expect(harness.readTasksCallCount()).toBeGreaterThan(readsAfterCreate);

    // And the SECOND proposal sees the node the FIRST one wrote — which is only
    // possible if the board was re-read.
    const secondResult = harness.writer.proposeMove(
      taskId,
      proposal({ toStage: 'plan-ready' }),
    );
    expect(secondResult).toMatchObject({ outcome: 'accepted' });
    expect(harness.currentTasks().tasks[taskId]!.stage).toBe('plan-ready');
  });

  it('never mutates the state object the projection handed it', () => {
    // Assertion 7, second half. The writer receives a real projection state;
    // snapshots share references with live state, so a writer that mutated one
    // would corrupt a snapshot. Serialized before and after, byte-compared.
    const { harness, taskId } = harnessWithTaskAt('backlog');
    const handedOutState = harness.currentTasks();
    const serializedBefore = canonicalJson(handedOutState);

    harness.writer.proposeMove(taskId, proposal({ toStage: 'planning' }));
    harness.writer.proposeMove(taskId, proposal({ toStage: 'nonsense' as TransitionProposal['toStage'] }));

    expect(canonicalJson(handedOutState)).toBe(serializedBefore);
    // ...while the store genuinely moved on, so the comparison above is not
    // vacuously true against a board that never changed.
    expect(canonicalJson(harness.currentTasks())).not.toBe(serializedBefore);
  });
});

// ─── S11-A6 — SINGLE SPELLING ON THE WRITE PATH ──────────────────────────────
//
// The slice's grep assertion, made a TEST so it survives a refactor that a grep
// over one commit's diff would miss. The claim is narrow and total: **no event
// this writer emits carries a retired kind.** The oracle is `RETIRED_EVENT_KINDS`
// itself rather than a hand-written list of forbidden strings — a kind retired in
// a later wave joins the table and this test starts guarding it for free.
//
// (The dispatcher's four emissions are asserted the same way, over the same
// table, in taskDispatcher.test.ts's own S11-A6 block. Between them every
// production emitter of this vocabulary is covered.)
describe('InstanceWriter — S11-A6: every emitted kind is the GENERIC one', () => {
  it('a full create → move → refused move → revise flow emits NO retired kind', () => {
    const { harness, taskId } = harnessWithAuthoredTask('backlog');
    // Re-run creation into the same harness so the birth record is in `emitted`
    // too (harnessWithAuthoredTask clears it for the other describes' benefit).
    harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });
    harness.writer.proposeMove(taskId, proposal({ toStage: 'planning' }));
    // A REFUSAL, deliberately in the flow: the rejection record is the one an
    // implementation is most likely to leave on the old spelling, because nothing
    // folds it.
    harness.writer.proposeMove(taskId, proposal({ toStage: 'done' }));
    harness.writer.revisePayload(taskId, { amendedBy: 'human', scope: 'revised' });

    // The flow really did produce all four kinds — otherwise the assertion below
    // would pass vacuously over a shorter log than it claims to cover.
    expect(new Set(eventTypes(harness.emitted))).toEqual(
      new Set([
        EVENT_TYPES.instanceCreated,
        EVENT_TYPES.instanceMoved,
        EVENT_TYPES.instanceMoveRejected,
        EVENT_TYPES.instancePayloadRevised,
      ]),
    );

    const retiredKinds = Object.keys(RETIRED_EVENT_KINDS);
    // Non-empty, so the containment check below cannot pass by having nothing to
    // check against.
    expect(retiredKinds.length).toBeGreaterThan(0);
    for (const event of harness.emitted) {
      expect(retiredKinds, `${event.type} is a RETIRED kind`).not.toContain(event.type);
    }
  });
});

// ─── S12-A6 (D72 Move 3) — the pinned ref, and the instances born before it ───
//
// Two facts, one block:
//
//   • a NEW instance's birth record carries the boot-resolved ref (pinned in the
//     createInstance block above, and through the HTTP door in
//     instanceApi.test.ts);
//   • an instance born BEFORE Move 3 — whose recorded `workflow` is `null`,
//     because that is what the writer wrote then and what the `task_created`
//     alias adapter still writes for a recorded legacy birth — adjudicates
//     against the SAME boot declaration and moves IDENTICALLY (F2: one boot
//     declaration governs; the pinned ref is recorded truth for replay, not a
//     per-move lookup).
//
// The legacy birth is planted with a REAL recorded `task_created`, appended
// straight to the store rather than through the writer, because no current code
// path can produce one — which is exactly the history this assertion is about.
describe('InstanceWriter — S12-A6: the pinned ref, and pre-Move-3 (null-workflow) instances', () => {
  const LEGACY_INSTANCE_ID = 'legacy-instance-1';

  function harnessWithLegacyBirthAt(stage: TaskRecord['stage']): WriterHarness {
    const harness = buildHarness();
    harness.seedRecordedEvents([
      taskCreated({
        taskId: LEGACY_INSTANCE_ID,
        projectRoot: PROJECT_ROOT,
        createdBy: 'human',
        isolation: 'worktree',
        stage,
      }),
    ]);
    harness.emitted.length = 0;
    return harness;
  }

  it('folds a recorded legacy birth to `workflow: null`, and a new one to the pinned ref', () => {
    // The premise, asserted rather than assumed: the two eras really do differ in
    // the recorded field, so the agreement below is a fact about adjudication and
    // not about two identical records.
    const harness = harnessWithLegacyBirthAt('backlog');
    const fresh = harness.writer.createInstance({
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    });

    const instances = harness.currentInstances().instances;
    expect(instances[LEGACY_INSTANCE_ID]!.workflow).toBeNull();
    expect(instances[fresh.taskId]!.workflow).toEqual(SHIPPED_WORKFLOW.ref);
  });

  it('ACCEPTS a legal move off a null-workflow instance, byte-for-byte as it does a stamped one', () => {
    const legacyHarness = harnessWithLegacyBirthAt('backlog');
    const legacyResult = legacyHarness.writer.proposeMove(
      LEGACY_INSTANCE_ID,
      proposal({ toStage: 'planning', proposedBy: 'human', note: 'same edge' }),
    );

    const { harness: stampedHarness, taskId: stampedId } = harnessWithTaskAt('backlog');
    const stampedResult = stampedHarness.writer.proposeMove(
      stampedId,
      proposal({ toStage: 'planning', proposedBy: 'human', note: 'same edge' }),
    );

    expect(eventTypes(legacyHarness.emitted)).toEqual([EVENT_TYPES.instanceMoved]);
    expect(eventTypes(stampedHarness.emitted)).toEqual([EVENT_TYPES.instanceMoved]);
    // Identical but for the id — same edge, same flag, same proposer, same note.
    expect({
      ...(legacyHarness.emitted[0]!.payload as Record<string, unknown>),
      instanceId: 'ID',
    }).toEqual({ ...(stampedHarness.emitted[0]!.payload as Record<string, unknown>), instanceId: 'ID' });
    expect(legacyResult.outcome).toBe('accepted');
    expect(stampedResult.outcome).toBe('accepted');
  });

  it('REJECTS an illegal move off a null-workflow instance with the same reason and record', () => {
    const legacyHarness = harnessWithLegacyBirthAt('backlog');
    const legacyResult = legacyHarness.writer.proposeMove(
      LEGACY_INSTANCE_ID,
      proposal({ toStage: 'done', proposedBy: 'human' }),
    );

    const { harness: stampedHarness, taskId: stampedId } = harnessWithTaskAt('backlog');
    const stampedResult = stampedHarness.writer.proposeMove(
      stampedId,
      proposal({ toStage: 'done', proposedBy: 'human' }),
    );

    expect(eventTypes(legacyHarness.emitted)).toEqual([EVENT_TYPES.instanceMoveRejected]);
    expect({
      ...(legacyHarness.emitted[0]!.payload as Record<string, unknown>),
      instanceId: 'ID',
    }).toEqual({ ...(stampedHarness.emitted[0]!.payload as Record<string, unknown>), instanceId: 'ID' });
    expect(legacyResult).toEqual(stampedResult);
    // The instance did not move on either side.
    expect(legacyHarness.currentTasks().tasks[LEGACY_INSTANCE_ID]!.stage).toBe('backlog');
    expect(stampedHarness.currentTasks().tasks[stampedId]!.stage).toBe('backlog');
  });

  it('refuses the DECLARED forbidden row identically on both eras (quarantined → done)', () => {
    // The one refusal that arrives as DECLARED DATA rather than engine code — the
    // forbidden row's own `reason`, echoed verbatim by the adjudicator and then
    // parsed into the (still closed) recorded enum.
    const legacyHarness = harnessWithLegacyBirthAt('quarantined');
    const legacyResult = legacyHarness.writer.proposeMove(
      LEGACY_INSTANCE_ID,
      proposal({ toStage: 'done', proposedBy: 'human' }),
    );
    const { harness: stampedHarness, taskId: stampedId } = harnessWithTaskAt('quarantined');
    const stampedResult = stampedHarness.writer.proposeMove(
      stampedId,
      proposal({ toStage: 'done', proposedBy: 'human' }),
    );

    expect(legacyResult).toEqual({
      outcome: 'rejected',
      reason: 'quarantined-cannot-complete',
    } satisfies ProposeMoveResult);
    expect(stampedResult).toEqual(legacyResult);
    expect(legacyHarness.emitted[0]!.payload).toMatchObject({
      reason: 'quarantined-cannot-complete',
    });
  });
});
