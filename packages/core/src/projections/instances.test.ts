import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonicalJson.js';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput, EventRecord } from '../schemas.js';
import { taskRecordSchema } from '../schemas.js';
import {
  EVENT_TYPES,
  RETIRED_EVENT_KINDS,
  captureKindSchema,
  captureRecorded,
  completionReported,
  dispatchRefused,
  instanceCreated,
  instanceMoveRejected,
  instanceMoved,
  instancePayloadRevised,
  instanceRunAttached,
  planSubmitted,
  reportFiled,
  reviewReported,
  taskCreated,
  taskQuarantined,
  taskSessionAttached,
  taskTransitionRejected,
  taskTransitioned,
  workOrderAmended,
} from '../events.js';
import { CAPTURE_CATALOGUE } from '../extensions/manifest.js';
import {
  MemorySnapshotStore,
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
} from './projection.js';
import { instancesProjection, type InstanceRecord, type InstancesState } from './instances.js';
import { legacyTasksViewOf, type TasksState } from './legacyTasksView.js';

// ─── S11·U1 (D72 Move 2) — the instances reducer's assertions ────────────────
//
// This file REPLACES the old task-projection test file, which died with the
// projection it tested. Every behaviour assertion that file made is here,
// re-expressed in the generic vocabulary; nothing was dropped. Three things
// changed and only three:
//
//   1. the vocabulary (taskId -> instanceId, stage -> node, and so on),
//   2. the cases that pinned the LEGACY RECORD SHAPE now read through
//      `legacyTasksViewOf`, which is where that shape lives now, and
//   3. new cases were ADDED for the alias table (S11-A2/A3), the new
//      fold-derived fields, and snapshot-cut replay over generic kinds (S11-A5).
//
// ⚠ The legacy CONSTRUCTORS are used deliberately in several cases below, not
// out of inertia: until U2 lands `instanceWriter.ts`, every event on the real
// 'tasks' stream is a retired kind, so a test that only ever fed generic events
// would be testing a fold path production does not use yet.

const INSTANCE_A = 'task-aaaa-0001';
const INSTANCE_B = 'task-bbbb-0002';
const RUN_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUN_SESSION_B_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const PROJECT_ROOT = '/home/user/projects/vimes';

function makeStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

// Fold a list of event batches through the projection exactly as boot would.
function stateFromLog(batches: EventInput[][]): InstancesState {
  const store = makeStore();
  for (const batch of batches) {
    store.append(batch);
  }
  return replayFromEmpty(instancesProjection, readAllStreamsGrouped(store));
}

// The legacy shape, derived — the only place these tests are allowed to speak
// task vocabulary, and the exact derivation `app.ts`'s `readTasksAsLegacyView`
// still runs for the writer/dispatcher/orchestrator/watchdog `readTasks`
// callbacks (the legacy tasks-projection alias route this once ALSO served,
// through S13·U3, was deleted S13·U4 — see legacyTasksView.ts's header).
function legacyFromLog(batches: EventInput[][]): TasksState {
  return legacyTasksViewOf(stateFromLog(batches));
}

function serializeLegacy(state: InstancesState): string {
  return canonicalJson(legacyTasksViewOf(state));
}

// A single recorded event, for the cases that need to apply one event to a
// hand-built state (purity, malformed payloads, unknown types).
function recordOf(input: EventInput): EventRecord {
  const store = makeStore();
  store.append([input]);
  return store.read(input.stream, 1)[0]!;
}

function createInstanceA(): EventInput {
  return instanceCreated({
    instanceId: INSTANCE_A,
    project: PROJECT_ROOT,
    node: 'backlog',
    createdBy: 'human',
    workflow: null,
    isolation: 'worktree',
    payload: {},
  });
}

// The same birth fact in the RETIRED spelling — used by the alias-equivalence
// cases and by every case that has to prove production's current writer still
// folds correctly.
function createTaskALegacy(): EventInput {
  return taskCreated({
    taskId: INSTANCE_A,
    projectRoot: PROJECT_ROOT,
    createdBy: 'human',
    isolation: 'worktree',
    stage: 'backlog',
  });
}

describe('instances projection — instance_created', () => {
  it('inserts a well-formed InstanceRecord, and its legacy view satisfies the task schema', () => {
    const state = stateFromLog([[createInstanceA()]]);
    const bornInstance = state.instances[INSTANCE_A];
    expect(bornInstance).toBeDefined();

    expect(bornInstance).toEqual({
      instanceId: INSTANCE_A,
      project: PROJECT_ROOT,
      workflow: null,
      currentNode: 'backlog',
      // Creation seeds NO history entry — being created is not a move.
      nodeHistory: [],
      edgeTraversalCounts: {},
      // ...but being placed on the birth node IS an entry into it.
      attemptsPerNode: { backlog: 1 },
      attachedSessions: [],
      createdBy: 'human',
      payload: {},
      isolation: 'worktree',
      gates: {},
      manualReviewRequired: false,
      lastHeartbeatAt: null,
      staleRetries: 0,
    } satisfies InstanceRecord);

    // The projection can never produce a record the LEGACY schema rejects —
    // the same assertion the old test made, now made where that shape lives.
    const validated = taskRecordSchema.safeParse(legacyTasksViewOf(state).tasks[INSTANCE_A]);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
  });

  it('honours the node the birth record STATES rather than assuming backlog', () => {
    const view = legacyFromLog([
      [
        instanceCreated({
          instanceId: INSTANCE_B,
          project: PROJECT_ROOT,
          node: 'planning',
          createdBy: 'orchestrator',
          workflow: null,
          isolation: 'shared-dir',
          payload: {},
        }),
      ],
    ]);
    expect(view.tasks[INSTANCE_B]!.stage).toBe('planning');
    expect(view.tasks[INSTANCE_B]!.isolation).toBe('shared-dir');
    expect(view.tasks[INSTANCE_B]!.createdBy).toBe('orchestrator');
  });

  it('folds the GATES the birth record carries (step 4b widening, carried through the rename)', () => {
    // Until step 4b widened the birth event, no event could set `gates` at all —
    // the field existed on the record, defaulted to `{}`, and was unreachable,
    // which made I10's whole refusal path test-only. This is the fold that makes
    // a gated instance expressible in the log.
    const state = stateFromLog([
      [
        instanceCreated({
          instanceId: INSTANCE_B,
          project: PROJECT_ROOT,
          node: 'backlog',
          createdBy: 'orchestrator',
          workflow: null,
          isolation: 'worktree',
          gates: {
            requireHeadroom: { meterId: 'window-5h', pct: 40 },
            deferUntilReset: 'weekly-cap',
          },
          payload: {},
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_B]!.gates).toEqual({
      requireHeadroom: { meterId: 'window-5h', pct: 40 },
      deferUntilReset: 'weekly-cap',
    });
    const validated = taskRecordSchema.safeParse(legacyTasksViewOf(state).tasks[INSTANCE_B]);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
  });

  it('a birth record with NO gates still folds {} — old events are unchanged', () => {
    // The reason the widening is OPTIONAL-only: a birth record written before
    // the field existed must fold to exactly what it folded to then, or I6
    // breaks over every log already on disk.
    const withoutGates = stateFromLog([[createInstanceA()]]);
    expect(withoutGates.instances[INSTANCE_A]!.gates).toEqual({});

    // Stated as a BYTE comparison as well, because "equals {}" would also pass
    // for a record that grew an extra key alongside it.
    const explicitlyEmpty = stateFromLog([
      [
        instanceCreated({
          instanceId: INSTANCE_A,
          project: PROJECT_ROOT,
          node: 'backlog',
          createdBy: 'human',
          workflow: null,
          isolation: 'worktree',
          gates: {},
          payload: {},
        }),
      ],
    ]);
    expect(instancesProjection.serialize(withoutGates)).toBe(
      instancesProjection.serialize(explicitlyEmpty),
    );
  });

  it('folds the TITLE the birth record carries (step 9 widening), into the opaque payload', () => {
    const state = stateFromLog([
      [
        instanceCreated({
          instanceId: INSTANCE_B,
          project: PROJECT_ROOT,
          node: 'backlog',
          createdBy: 'human',
          workflow: null,
          isolation: 'worktree',
          payload: { title: 'wire the kanban board to the tasks projection' },
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_B]!.payload.title).toBe(
      'wire the kanban board to the tasks projection',
    );
    // ...and the legacy view hoists it back to the top level, where the schema
    // and the deployed UI still expect it.
    const legacyRecord = legacyTasksViewOf(state).tasks[INSTANCE_B]!;
    expect(legacyRecord.title).toBe('wire the kanban board to the tasks projection');
    const validated = taskRecordSchema.safeParse(legacyRecord);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
  });

  it('a birth record with NO title folds to a record with NO title key — never ""', () => {
    // ⚠ Stated as a BYTE comparison and not merely `toBeUndefined()`, because
    // `title: undefined` written as a KEY would also satisfy `toBeUndefined()`
    // while changing what `Object.keys`-based tooling sees — and `''` would
    // satisfy neither but is the tempting default. Absent stays absent, in the
    // payload AND in the view derived from it.
    const untitled = stateFromLog([[createInstanceA()]]);
    expect('title' in untitled.instances[INSTANCE_A]!.payload).toBe(false);
    const legacyRecord = legacyTasksViewOf(untitled).tasks[INSTANCE_A]!;
    expect('title' in legacyRecord).toBe(false);
    expect(taskRecordSchema.safeParse(legacyRecord).success).toBe(true);

    const explicitlyUntitled = stateFromLog([
      [
        instanceCreated({
          instanceId: INSTANCE_A,
          project: PROJECT_ROOT,
          node: 'backlog',
          createdBy: 'human',
          workflow: null,
          isolation: 'worktree',
          payload: {},
        }),
      ],
    ]);
    expect(instancesProjection.serialize(untitled)).toBe(
      instancesProjection.serialize(explicitlyUntitled),
    );
  });

  it('an EMPTY-STRING title is folded verbatim — it is a title someone chose', () => {
    // The converse of the rule above, and the reason the fold spreads rather
    // than coalescing: `''` is not "no title". The projection does not decide
    // which titles are worth keeping; the board decides what to RENDER.
    const state = stateFromLog([
      [
        instanceCreated({
          instanceId: INSTANCE_A,
          project: PROJECT_ROOT,
          node: 'backlog',
          createdBy: 'human',
          workflow: null,
          isolation: 'worktree',
          payload: { title: '' },
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_A]!.payload.title).toBe('');
    expect('title' in state.instances[INSTANCE_A]!.payload).toBe(true);
    expect(legacyTasksViewOf(state).tasks[INSTANCE_A]!.title).toBe('');
  });

  it('a PARTIAL gates object folds exactly what was named, inventing nothing', () => {
    // Both gate fields are independently optional. An instance that names only
    // `requireHeadroom` must not acquire a `deferUntilReset` it never asked for —
    // a fabricated gate would refuse work nobody gated.
    const state = stateFromLog([
      [
        instanceCreated({
          instanceId: INSTANCE_A,
          project: PROJECT_ROOT,
          node: 'backlog',
          createdBy: 'human',
          workflow: null,
          isolation: 'worktree',
          gates: { requireHeadroom: { meterId: 'window-5h', pct: 75 } },
          payload: {},
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_A]!.gates).toEqual({
      requireHeadroom: { meterId: 'window-5h', pct: 75 },
    });
    expect(state.instances[INSTANCE_A]!.gates.deferUntilReset).toBeUndefined();
  });

  it('a duplicate instance_created never clobbers the existing record (replay safety)', () => {
    // The instance has MOVED since it was born; re-delivering the birth record
    // must not reset it to `backlog`.
    const state = stateFromLog([
      [createInstanceA()],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'backlog',
          toNode: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [createInstanceA()],
    ]);
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('planning');
    expect(Object.keys(state.instances)).toEqual([INSTANCE_A]);
    // ...and the duplicate did not re-seed the derived counters either.
    expect(state.instances[INSTANCE_A]!.attemptsPerNode).toEqual({ backlog: 1, planning: 1 });
  });

  it('a duplicate arriving in the RETIRED spelling is the same no-op', () => {
    // The alias table resolves before the duplicate check, so a legacy re-append
    // over a generic birth record is caught by the same guard — the case that
    // exists in production for exactly as long as the migration window does.
    const state = stateFromLog([[createInstanceA()], [createTaskALegacy()]]);
    expect(Object.keys(state.instances)).toEqual([INSTANCE_A]);
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('backlog');
  });
});

// ── I6 — absent stays absent over the S7·1 work-order widening ───────────────
//
// The load-bearing legacy-shape test. A birth record that omits all five
// optional work-order fields must fold to a legacy view with NONE of the new
// keys present, byte-identical to what the pre-S7·1 projection produced.
describe('instances projection — I6, the S7·1 work-order widening is invisible when unused', () => {
  it('a birth record omitting all work-order fields views with NONE of the new keys present', () => {
    const legacyRecord = legacyFromLog([[createInstanceA()]]).tasks[INSTANCE_A]!;
    expect('scope' in legacyRecord).toBe(false);
    expect('explicitlyOut' in legacyRecord).toBe(false);
    expect('acceptanceCriteria' in legacyRecord).toBe(false);
    expect('killCriterion' in legacyRecord).toBe(false);
    expect('workOrderRev' in legacyRecord).toBe(false);
    expect(taskRecordSchema.safeParse(legacyRecord).success).toBe(true);
  });

  it('views byte-identically to the pre-S7·1 record shape (exactly the pre-existing keys)', () => {
    const legacyRecord = legacyFromLog([[createInstanceA()]]).tasks[INSTANCE_A]!;
    // The full pre-S7·1 key set, hand-enumerated so a silent extra key (a
    // default sneaking in, or a NEW S11 field leaking through the view) fails
    // this comparison even if every individual `in` check above were somehow
    // satisfied. This is also the assertion that pins the view as a NARROWING.
    expect(Object.keys(legacyRecord).sort()).toEqual(
      [
        'taskId',
        'projectRoot',
        'stage',
        'manualReviewRequired',
        'isolation',
        'gates',
        'sessionRefs',
        'createdBy',
        'lastHeartbeatAt',
        'staleRetries',
      ].sort(),
    );
  });
});

// ── S7·2a — the work-order fields fold onto the birth record ─────────────────
describe('instances projection — a carrying birth record folds the payload fields', () => {
  // `acceptanceCriteria` uses the FULL `{id,text}` shape because the writer mints
  // the ids and writes them INTO the event — the fold reads them back, it never
  // mints.
  const AUTHORED_PAYLOAD = {
    scope: 'carry the four authored work-order fields onto the born record',
    explicitlyOut: ['workOrderRev (S7·2b)', 'the two-door UI (S7·8)'],
    acceptanceCriteria: [
      { id: 'crit-id-alpha', text: 'the fold preserves criterion ids' },
      { id: 'crit-id-beta', text: 'absent stays absent' },
    ],
    killCriterion: 'a field cannot fold without a projection default',
  };

  function createInstanceWithPayload(): EventInput {
    return instanceCreated({
      instanceId: INSTANCE_A,
      project: PROJECT_ROOT,
      node: 'backlog',
      createdBy: 'human',
      workflow: null,
      isolation: 'worktree',
      payload: AUTHORED_PAYLOAD,
    });
  }

  it('folds all four VERBATIM, ids preserved, and the legacy view still satisfies the schema', () => {
    const state = stateFromLog([[createInstanceWithPayload()]]);
    const instancePayload = state.instances[INSTANCE_A]!.payload;

    expect(instancePayload.scope).toBe(AUTHORED_PAYLOAD.scope);
    expect(instancePayload.explicitlyOut).toEqual(AUTHORED_PAYLOAD.explicitlyOut);
    // The criterion ids are preserved exactly — nothing re-mints on fold.
    expect(instancePayload.acceptanceCriteria).toEqual(AUTHORED_PAYLOAD.acceptanceCriteria);
    expect(instancePayload.killCriterion).toBe(AUTHORED_PAYLOAD.killCriterion);

    const validated = taskRecordSchema.safeParse(legacyTasksViewOf(state).tasks[INSTANCE_A]);
    expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
  });

  it('replay-equivalence (I6): folding the same carrying-log twice is byte-identical', () => {
    // The whole reason the ids are written INTO the event rather than re-minted
    // on fold. If any part of the fold re-derived a criterion id (or defaulted a
    // field), a second fold of the SAME log would produce different bytes.
    const firstFold = stateFromLog([[createInstanceWithPayload()]]);
    const secondFold = stateFromLog([[createInstanceWithPayload()]]);
    expect(instancesProjection.serialize(secondFold)).toBe(
      instancesProjection.serialize(firstFold),
    );
  });
});

// ── instance_payload_revised — the PATCH fold (D43: revisioned, not mutated) ──
//
// The fold's job here is narrow and easy to get subtly wrong: a present field
// REPLACES, an absent field is LEFT ALONE, and the rev is RECORDED rather than
// counted. Every case below separates those three, because an implementation
// that spread the whole patch (turning omitted fields into `undefined` keys) or
// that incremented a rev of its own would still look right on the happy path.
describe('instances projection — instance_payload_revised patches the payload', () => {
  const AUTHORED_PAYLOAD = {
    scope: 'the scope as first authored',
    explicitlyOut: ['the amend path', 'the two-door UI'],
    acceptanceCriteria: [
      { id: 'crit-id-alpha', text: 'the first criterion' },
      { id: 'crit-id-beta', text: 'the second criterion' },
    ],
    killCriterion: 'the kill criterion as first authored',
  };

  function createAuthoredInstanceA(): EventInput {
    return instanceCreated({
      instanceId: INSTANCE_A,
      project: PROJECT_ROOT,
      node: 'backlog',
      createdBy: 'human',
      workflow: null,
      isolation: 'worktree',
      payload: AUTHORED_PAYLOAD,
    });
  }

  it('a scope-only revision replaces scope, sets the rev, and touches NOTHING else', () => {
    const state = stateFromLog([
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'human',
          patch: { scope: 'the narrowed scope' },
        }),
      ],
    ]);
    const revised = state.instances[INSTANCE_A]!;

    expect(revised.payload.scope).toBe('the narrowed scope');
    expect(revised.payloadRev).toBe(1);
    // The three fields the revision never mentioned are exactly as the birth
    // record left them — not cleared, and not present-but-`undefined`.
    expect(revised.payload.explicitlyOut).toEqual(AUTHORED_PAYLOAD.explicitlyOut);
    expect(revised.payload.acceptanceCriteria).toEqual(AUTHORED_PAYLOAD.acceptanceCriteria);
    expect(revised.payload.killCriterion).toBe(AUTHORED_PAYLOAD.killCriterion);
    expect(taskRecordSchema.safeParse(legacyTasksViewOf(state).tasks[INSTANCE_A]).success).toBe(
      true,
    );
  });

  it('`revisedBy` stays on the EVENT — the record grows no such key', () => {
    // The record is current state; who authored a revision is audit, and it
    // lives in the log exactly as a move's `proposedBy` does.
    const state = stateFromLog([
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'orchestrator',
          patch: { scope: 'revised by the orchestrator' },
        }),
      ],
    ]);
    expect('revisedBy' in state.instances[INSTANCE_A]!).toBe(false);
    expect('amendedBy' in legacyTasksViewOf(state).tasks[INSTANCE_A]!).toBe(false);
  });

  it('two revisions: the LATEST rev and the LATEST value of each field win', () => {
    const state = stateFromLog([
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'human',
          patch: {
            scope: 'scope after the first revision',
            killCriterion: 'kill criterion after the first revision',
          },
        }),
      ],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 2,
          revisedBy: 'orchestrator',
          patch: { scope: 'scope after the second revision' },
        }),
      ],
    ]);
    const revised = state.instances[INSTANCE_A]!;

    expect(revised.payloadRev).toBe(2);
    expect(revised.payload.scope).toBe('scope after the second revision');
    // ⚠ THE CASE THAT SEPARATES "PATCH" FROM "REPLACE THE WHOLE PAYLOAD": the
    // second revision omitted `killCriterion`, so the FIRST revision's value
    // survives. A fold that rebuilt the payload from each event would have
    // dropped it back to the birth record's value (or to nothing).
    expect(revised.payload.killCriterion).toBe('kill criterion after the first revision');
    expect(revised.payload.explicitlyOut).toEqual(AUTHORED_PAYLOAD.explicitlyOut);
  });

  it('an EXPLICIT empty acceptanceCriteria CLEARS the list — distinct from omitting it', () => {
    // Clearing the criteria is a legal revision (a payload that stops claiming
    // checkable outcomes). The two cases are asserted side by side, because they
    // are the pair a fold keyed on truthiness rather than presence would
    // conflate.
    const cleared = stateFromLog([
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'human',
          patch: { acceptanceCriteria: [] },
        }),
      ],
    ]);
    expect(cleared.instances[INSTANCE_A]!.payload.acceptanceCriteria).toEqual([]);

    const untouched = stateFromLog([
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'human',
          patch: { scope: 'elsewhere' },
        }),
      ],
    ]);
    expect(untouched.instances[INSTANCE_A]!.payload.acceptanceCriteria).toEqual(
      AUTHORED_PAYLOAD.acceptanceCriteria,
    );
  });

  it('revises an instance that was created with an EMPTY payload', () => {
    // The absent-stays-absent birth record is where a revision most plausibly
    // trips: there is nothing to patch over, so the revised fields appear for the
    // first time and the untouched ones must STILL be absent afterwards.
    const state = stateFromLog([
      [createInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'human',
          patch: { scope: 'a scope the birth record never had' },
        }),
      ],
    ]);
    const revised = state.instances[INSTANCE_A]!;

    expect(revised.payload.scope).toBe('a scope the birth record never had');
    expect(revised.payloadRev).toBe(1);
    expect('explicitlyOut' in revised.payload).toBe(false);
    expect('acceptanceCriteria' in revised.payload).toBe(false);
    expect('killCriterion' in revised.payload).toBe(false);
  });

  it('RECORDS the rev the payload states — it never counts revision events', () => {
    // A log whose revs are not 1,2,3… (a snapshot boot that starts mid-history
    // is the real-world shape). The fold must land on 7 because the event says
    // 7; a fold that counted revisions would say 1.
    const state = stateFromLog([
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 7,
          revisedBy: 'human',
          patch: { scope: 'rev seven' },
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_A]!.payloadRev).toBe(7);
    expect(legacyTasksViewOf(state).tasks[INSTANCE_A]!.workOrderRev).toBe(7);
  });

  it('ignores a revision for an unknown instance — it never fabricates a record', () => {
    const state = stateFromLog([
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_B,
          payloadRev: 1,
          revisedBy: 'human',
          patch: { scope: 'a revision for an instance nobody created' },
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_B]).toBeUndefined();
    expect(Object.keys(state.instances)).toEqual([INSTANCE_A]);
    // ...and the instance that DOES exist was not touched by it either.
    expect(state.instances[INSTANCE_A]!.payload.scope).toBe(AUTHORED_PAYLOAD.scope);
    expect('payloadRev' in state.instances[INSTANCE_A]!).toBe(false);
    expect('workOrderRev' in legacyTasksViewOf(state).tasks[INSTANCE_A]!).toBe(false);
  });

  it('a malformed revision payload is a no-op and never throws', () => {
    // I8's spirit: a hostile or truncated payload must not crash a fold. A
    // negative rev fails `nonnegative()`, so the whole event is skipped and the
    // record keeps whatever it had.
    const priorState = stateFromLog([[createAuthoredInstanceA()]]);
    const malformedRecord = recordOf({
      stream: 'tasks',
      type: EVENT_TYPES.instancePayloadRevised,
      payload: { instanceId: INSTANCE_A, payloadRev: -1, revisedBy: 'human', patch: {} },
    });
    let nextState: InstancesState | undefined;
    expect(() => {
      nextState = instancesProjection.apply(priorState, malformedRecord);
    }).not.toThrow();
    expect(nextState).toBe(priorState);
  });

  it('a malformed RETIRED-spelling amendment is a no-op and never throws', () => {
    // The same case one layer earlier: the alias adapter refuses the payload and
    // returns null, and the fold turns that into the SAME state object.
    const priorState = stateFromLog([[createAuthoredInstanceA()]]);
    const malformedRecord = recordOf({
      stream: 'tasks',
      type: 'work_order_amended',
      payload: { taskId: INSTANCE_A, workOrderRev: -1, amendedBy: 'human', scope: 'nope' },
    });
    let nextState: InstancesState | undefined;
    expect(() => {
      nextState = instancesProjection.apply(priorState, malformedRecord);
    }).not.toThrow();
    expect(nextState).toBe(priorState);
  });

  it('I6 replay-equivalence: creation + two revisions folds byte-identically twice', () => {
    // The determinism the whole design rests on: the rev and the criterion ids
    // are both STORED, never derived, so a second fold of the same log produces
    // the same bytes. If either were computed during the fold, this would drift.
    const revisionLog: EventInput[][] = [
      [createAuthoredInstanceA()],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'human',
          patch: {
            scope: 'scope after the first revision',
            acceptanceCriteria: [
              { id: 'crit-id-alpha', text: 'the first criterion, reworded' },
              { id: 'crit-id-gamma', text: 'a criterion minted by the revision' },
            ],
          },
        }),
      ],
      [
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 2,
          revisedBy: 'orchestrator',
          patch: { explicitlyOut: [] },
        }),
      ],
    ];
    const firstFold = stateFromLog(revisionLog);
    const secondFold = stateFromLog(revisionLog);
    expect(instancesProjection.serialize(secondFold)).toBe(
      instancesProjection.serialize(firstFold),
    );
    // Not vacuous: the twice-folded record really carries the revised shape.
    expect(firstFold.instances[INSTANCE_A]!.payloadRev).toBe(2);
    expect(firstFold.instances[INSTANCE_A]!.payload.explicitlyOut).toEqual([]);
    expect(firstFold.instances[INSTANCE_A]!.payload.acceptanceCriteria).toEqual([
      { id: 'crit-id-alpha', text: 'the first criterion, reworded' },
      { id: 'crit-id-gamma', text: 'a criterion minted by the revision' },
    ]);
  });

  it('does not mutate the state it was handed (I12)', () => {
    const priorState = stateFromLog([[createAuthoredInstanceA()]]);
    const serializedBefore = instancesProjection.serialize(priorState);

    const nextState = instancesProjection.apply(
      priorState,
      recordOf(
        instancePayloadRevised({
          instanceId: INSTANCE_A,
          payloadRev: 1,
          revisedBy: 'human',
          patch: { scope: 'a scope the prior state must never learn about' },
        }),
      ),
    );

    expect(instancesProjection.serialize(priorState)).toBe(serializedBefore);
    expect(nextState).not.toBe(priorState);
    expect(nextState.instances[INSTANCE_A]).not.toBe(priorState.instances[INSTANCE_A]);
  });
});

describe('instances projection — instance_moved', () => {
  it('updates the current node of the named instance', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'backlog',
          toNode: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'planning',
          toNode: 'plan-ready',
          manualReviewRequired: false,
          proposedBy: 'orchestrator',
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('plan-ready');
    expect(state.instances[INSTANCE_A]!.manualReviewRequired).toBe(false);
    expect(legacyTasksViewOf(state).tasks[INSTANCE_A]!.stage).toBe('plan-ready');
  });

  it('carries the convergence flag on the → done edge', () => {
    // `done` + manualReviewRequired: the explicit hand-off. Only that edge can
    // turn the flag on; the fold records the RESULT the machine decided.
    const state = stateFromLog([
      [createInstanceA()],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'review',
          toNode: 'done',
          manualReviewRequired: true,
          proposedBy: 'dispatcher',
          note: 'auto-review stopped converging',
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('done');
    expect(state.instances[INSTANCE_A]!.manualReviewRequired).toBe(true);
  });

  it('ignores a move for an unknown instanceId — no instance is fabricated', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [
        instanceMoved({
          instanceId: 'task-never-created',
          fromNode: 'backlog',
          toNode: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ]);
    expect(Object.keys(state.instances)).toEqual([INSTANCE_A]);
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('backlog');
  });
});

describe('instances projection — the deliberately NON-folded events', () => {
  // Each of these is recorded in the log for a documented reason and must leave
  // instance state BYTE-IDENTICAL:
  //   • instance_move_rejected / task_transition_rejected — I7's evidence;
  //     nothing about the instance changed. ⚠ BOTH SPELLINGS are asserted,
  //     because the retired one HAS an alias row and therefore takes the adapt
  //     path before reaching the fold's `default` — the one place a rebuilt-but-
  //     equal state object would slip through byte comparison and be caught only
  //     by the identity assertion below.
  //   • dispatch_refused — I10's refusal; the instance stayed put. Deliberately
  //     absent from the alias table too.
  //   • task_quarantined — a SESSION-stream fact; principle 9 keeps the node
  //     sourced only from `instance_moved`.
  const nonFoldedEvents: ReadonlyArray<readonly [string, EventInput]> = [
    [
      'instance_move_rejected',
      instanceMoveRejected({
        instanceId: INSTANCE_A,
        fromNode: 'planning',
        attemptedToNode: 'done',
        reason: 'illegal-edge',
        proposedBy: 'orchestrator',
      }),
    ],
    [
      'task_transition_rejected (the retired spelling, WITH an alias row)',
      taskTransitionRejected({
        taskId: INSTANCE_A,
        fromStage: 'planning',
        attemptedToStage: 'done',
        reason: 'illegal-edge',
        proposedBy: 'orchestrator',
      }),
    ],
    ['dispatch_refused', dispatchRefused({ taskId: INSTANCE_A, reason: 'requireHeadroom gate failed' })],
    ['task_quarantined', taskQuarantined({ appSessionId: RUN_SESSION_ID, taskId: INSTANCE_A })],
  ];

  for (const [eventName, nonFoldedEvent] of nonFoldedEvents) {
    it(`${eventName} leaves the instance board byte-identical`, () => {
      const before = stateFromLog([
        [createInstanceA()],
        [
          instanceMoved({
            instanceId: INSTANCE_A,
            fromNode: 'backlog',
            toNode: 'planning',
            manualReviewRequired: false,
            proposedBy: 'dispatcher',
          }),
        ],
      ]);
      const serializedBefore = instancesProjection.serialize(before);

      const after = instancesProjection.apply(before, recordOf(nonFoldedEvent));
      expect(instancesProjection.serialize(after)).toBe(serializedBefore);
      // Not merely equal bytes — nothing was rebuilt at all.
      expect(after).toBe(before);
    });
  }

  it('quarantine reaches the board only as an ordinary instance_moved', () => {
    // The positive half of principle 9: the node DOES move to `quarantined`, but
    // via the task stream's own move record, never via the session stream's
    // `task_quarantined`.
    const state = stateFromLog([
      [createInstanceA()],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'backlog',
          toNode: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [taskQuarantined({ appSessionId: RUN_SESSION_ID, taskId: INSTANCE_A })],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'planning',
          toNode: 'quarantined',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('quarantined');
  });
});

describe('instances projection — hostile and unknown input', () => {
  const hostileEventRecords: ReadonlyArray<readonly [string, EventRecord]> = [
    [
      'an unknown event type',
      { ...recordOf(createInstanceA()), type: 'no_such_event_type' } as EventRecord,
    ],
    [
      'instance_created with a malformed payload',
      { ...recordOf(createInstanceA()), payload: { instanceId: 42 } } as unknown as EventRecord,
    ],
    [
      'instance_created with a null payload',
      { ...recordOf(createInstanceA()), payload: null } as unknown as EventRecord,
    ],
    [
      // ⚠ The RETIRED spelling on purpose: the enum guard the generic vocabulary
      // dropped still lives in the alias adapter, which parses the LEGACY schema
      // before re-shaping. A `task_created` naming a stage outside the enum is
      // still malformed, and still folds to nothing.
      'task_created with a stage outside the enum (the alias adapter still enforces it)',
      {
        ...recordOf(createTaskALegacy()),
        payload: {
          taskId: 'task-hostile',
          projectRoot: '/x',
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'not-a-stage',
        },
      } as unknown as EventRecord,
    ],
    [
      'instance_moved with a missing instanceId',
      {
        ...recordOf(
          instanceMoved({
            instanceId: INSTANCE_A,
            fromNode: 'backlog',
            toNode: 'planning',
            manualReviewRequired: false,
            proposedBy: 'dispatcher',
          }),
        ),
        payload: { toNode: 'done' },
      } as unknown as EventRecord,
    ],
    [
      'task_transitioned with a missing taskId (the retired spelling)',
      {
        ...recordOf(
          taskTransitioned({
            taskId: INSTANCE_A,
            fromStage: 'backlog',
            toStage: 'planning',
            manualReviewRequired: false,
            proposedBy: 'dispatcher',
          }),
        ),
        payload: { toStage: 'done' },
      } as unknown as EventRecord,
    ],
  ];

  for (const [caseName, hostileRecord] of hostileEventRecords) {
    it(`${caseName} leaves state unchanged and never throws`, () => {
      const before = stateFromLog([[createInstanceA()]]);
      const serializedBefore = instancesProjection.serialize(before);
      let after: InstancesState | undefined;
      expect(() => {
        after = instancesProjection.apply(before, hostileRecord);
      }).not.toThrow();
      expect(instancesProjection.serialize(after!)).toBe(serializedBefore);
      expect(after).toBe(before);
    });
  }
});

// ─── instance_run_attached ──────────────────────────────────────────────────
//
// A node run IS an ordinary session (spec §3.5). `attachedSessions` is the one
// field that ACCUMULATES, which makes it the one where folding the same fact
// twice leaves a trace.
function attachRunToInstanceA(appSessionId: string, node: string): EventInput {
  return instanceRunAttached({ instanceId: INSTANCE_A, node, appSessionId });
}

describe('instances projection — instance_run_attached', () => {
  it('appends the ref to that instance, in log order', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [attachRunToInstanceA(RUN_SESSION_ID, 'planning')],
      [attachRunToInstanceA(RUN_SESSION_B_ID, 'implementing')],
    ]);
    expect(state.instances[INSTANCE_A]!.attachedSessions).toEqual([
      { node: 'planning', appSessionId: RUN_SESSION_ID },
      { node: 'implementing', appSessionId: RUN_SESSION_B_ID },
    ]);
    // The legacy view spells the same trail `sessionRefs[].stage`, and the
    // record it produces still satisfies the slice-0 schema.
    const legacyRecord = legacyTasksViewOf(state).tasks[INSTANCE_A]!;
    expect(legacyRecord.sessionRefs).toEqual([
      { stage: 'planning', appSessionId: RUN_SESSION_ID },
      { stage: 'implementing', appSessionId: RUN_SESSION_B_ID },
    ]);
    expect(taskRecordSchema.safeParse(legacyRecord).success).toBe(true);
  });

  it('ignores an attach for an unknown instance — it never fabricates a record', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [instanceRunAttached({ instanceId: INSTANCE_B, node: 'planning', appSessionId: RUN_SESSION_ID })],
    ]);
    expect(state.instances[INSTANCE_B]).toBeUndefined();
    expect(state.instances[INSTANCE_A]!.attachedSessions).toEqual([]);
  });

  it('is IDEMPOTENT on replay — the same appSessionId is never appended twice', () => {
    // THIS test is the one holding the line — in the projection this replaces it
    // was verified by deleting the guard and watching exactly this case redden
    // while the I6 cut-point case stayed green. A duplicate append is
    // deterministic, so replay equivalence cannot see it; only an explicit
    // assertion can.
    const state = stateFromLog([
      [createInstanceA()],
      [attachRunToInstanceA(RUN_SESSION_ID, 'planning')],
      [attachRunToInstanceA(RUN_SESSION_ID, 'planning')],
      [attachRunToInstanceA(RUN_SESSION_ID, 'planning')],
    ]);
    expect(state.instances[INSTANCE_A]!.attachedSessions).toEqual([
      { node: 'planning', appSessionId: RUN_SESSION_ID },
    ]);
  });

  it('keys idempotence on appSessionId, so a SECOND run of the same node is kept', () => {
    // Deduplicating on `node` would silently swallow a re-run after a
    // quarantine — a different session doing the same node is a genuinely new
    // ref, and the board must be able to show both.
    const state = stateFromLog([
      [createInstanceA()],
      [attachRunToInstanceA(RUN_SESSION_ID, 'implementing')],
      [attachRunToInstanceA(RUN_SESSION_B_ID, 'implementing')],
    ]);
    expect(state.instances[INSTANCE_A]!.attachedSessions).toEqual([
      { node: 'implementing', appSessionId: RUN_SESSION_ID },
      { node: 'implementing', appSessionId: RUN_SESSION_B_ID },
    ]);
  });

  it('dedups ACROSS SPELLINGS — a retired attach and a generic one are the same fact', () => {
    // The migration-window case the old test could not express: production wrote
    // `task_session_attached` yesterday and `instance_run_attached` tomorrow, and
    // an at-least-once redelivery across that boundary must not sprout a phantom
    // second run.
    const state = stateFromLog([
      [createInstanceA()],
      [taskSessionAttached({ taskId: INSTANCE_A, stage: 'planning', appSessionId: RUN_SESSION_ID })],
      [attachRunToInstanceA(RUN_SESSION_ID, 'planning')],
    ]);
    expect(state.instances[INSTANCE_A]!.attachedSessions).toEqual([
      { node: 'planning', appSessionId: RUN_SESSION_ID },
    ]);
  });

  it('a malformed attach payload is a no-op and never throws', () => {
    const before = stateFromLog([[createInstanceA()]]);
    const serializedBefore = instancesProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(attachRunToInstanceA(RUN_SESSION_ID, 'planning')),
      payload: { instanceId: INSTANCE_A },
    } as unknown as EventRecord;
    let after: InstancesState | undefined;
    expect(() => {
      after = instancesProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(instancesProjection.serialize(before)).toBe(serializedBefore);
  });

  it('does not mutate the input state or the existing attachedSessions array', () => {
    // `attachedSessions` is the one field that ACCUMULATES, which makes it the
    // one an in-place `push` would corrupt across a shared snapshot.
    const frozenState = stateFromLog([
      [createInstanceA()],
      [attachRunToInstanceA(RUN_SESSION_ID, 'planning')],
    ]);
    Object.freeze(frozenState);
    Object.freeze(frozenState.instances);
    Object.freeze(frozenState.instances[INSTANCE_A]);
    Object.freeze(frozenState.instances[INSTANCE_A]!.attachedSessions);
    const serializedBefore = instancesProjection.serialize(frozenState);

    const afterAttach = instancesProjection.apply(
      frozenState,
      recordOf(attachRunToInstanceA(RUN_SESSION_B_ID, 'implementing')),
    );

    expect(afterAttach).not.toBe(frozenState);
    expect(afterAttach.instances).not.toBe(frozenState.instances);
    expect(afterAttach.instances[INSTANCE_A]).not.toBe(frozenState.instances[INSTANCE_A]);
    expect(afterAttach.instances[INSTANCE_A]!.attachedSessions).not.toBe(
      frozenState.instances[INSTANCE_A]!.attachedSessions,
    );
    expect(afterAttach.instances[INSTANCE_A]!.attachedSessions).toHaveLength(2);
    // The frozen input is byte-for-byte what it was.
    expect(instancesProjection.serialize(frozenState)).toBe(serializedBefore);
    expect(frozenState.instances[INSTANCE_A]!.attachedSessions).toHaveLength(1);
  });
});

// ── capture_recorded AUGMENTS the record, exactly like a run attach; it is NOT
// a move ─────────────────────────────────────────────────────────────────────
//
// D48: the captured blob lives in the artifact store; the LOG carries only the
// reference (the hash), so this fold's whole job is keeping `planArtifactHash`
// current. The planning -> plan-ready move is a SEPARATE `instance_moved`.
function recordPlanCaptureForA(artifactHash: string): EventInput {
  return captureRecorded({
    instanceId: INSTANCE_A,
    captureKind: 'plan',
    artifactHash,
    node: 'planning',
    attempt: 1,
    payloadRev: 0,
    capturedFrom: { appSessionId: RUN_SESSION_ID },
  });
}

describe('instances projection — capture_recorded', () => {
  it('folds the artifact hash onto an existing instance', () => {
    const state = stateFromLog([[createInstanceA()], [recordPlanCaptureForA('sha256:aaaa')]]);
    expect(state.instances[INSTANCE_A]!.planArtifactHash).toBe('sha256:aaaa');
    expect(legacyTasksViewOf(state).tasks[INSTANCE_A]!.planArtifactHash).toBe('sha256:aaaa');
    expect(taskRecordSchema.safeParse(legacyTasksViewOf(state).tasks[INSTANCE_A]).success).toBe(
      true,
    );
  });

  it('LATEST-WINS: a second capture (a re-plan) overwrites the first', () => {
    // Unlike attachedSessions' accumulation, this field is a plain overwrite:
    // the board and the handoff want the CURRENT plan, never a history of every
    // plan ever drafted.
    const state = stateFromLog([
      [createInstanceA()],
      [recordPlanCaptureForA('sha256:aaaa')],
      [recordPlanCaptureForA('sha256:bbbb')],
    ]);
    expect(state.instances[INSTANCE_A]!.planArtifactHash).toBe('sha256:bbbb');
  });

  it('ignores a capture for an unknown instance — it never fabricates a record', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [
        captureRecorded({
          instanceId: INSTANCE_B,
          captureKind: 'plan',
          artifactHash: 'sha256:cccc',
          node: 'planning',
          attempt: 1,
          payloadRev: 0,
          capturedFrom: { appSessionId: RUN_SESSION_ID },
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_B]).toBeUndefined();
    expect('planArtifactHash' in state.instances[INSTANCE_A]!).toBe(false);
  });

  it('I6 absent-stays-absent: an instance with no capture has NO planArtifactHash key', () => {
    // Verified by breaking in the projection this replaces: adding a default
    // here (e.g. `planArtifactHash: instance.planArtifactHash ?? ''`) reddens
    // exactly this assertion, in the record AND in the view.
    const state = stateFromLog([[createInstanceA()]]);
    expect('planArtifactHash' in state.instances[INSTANCE_A]!).toBe(false);
    expect('planArtifactHash' in legacyTasksViewOf(state).tasks[INSTANCE_A]!).toBe(false);
  });

  it('I6 replay-equivalence: folding a carrying-log twice is byte-identical', () => {
    const log = [[createInstanceA()], [recordPlanCaptureForA('sha256:aaaa')]];
    const firstFold = stateFromLog(log);
    const secondFold = stateFromLog(log);
    expect(instancesProjection.serialize(secondFold)).toBe(
      instancesProjection.serialize(firstFold),
    );
  });

  it('is idempotent: folding the SAME capture twice leaves a single hash (an overwrite, no trace)', () => {
    // Unlike an attach, this needs no dedicated dedup guard: an overwrite of the
    // same value with itself IS the same value, so there is nothing here for a
    // duplicate-delivery guard to catch.
    const state = stateFromLog([
      [createInstanceA()],
      [recordPlanCaptureForA('sha256:aaaa')],
      [recordPlanCaptureForA('sha256:aaaa')],
    ]);
    expect(state.instances[INSTANCE_A]!.planArtifactHash).toBe('sha256:aaaa');
  });

  it('a malformed capture payload is a no-op and never throws', () => {
    const before = stateFromLog([[createInstanceA()]]);
    const serializedBefore = instancesProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(recordPlanCaptureForA('sha256:aaaa')),
      payload: { instanceId: INSTANCE_A },
    } as unknown as EventRecord;
    let after: InstancesState | undefined;
    expect(() => {
      after = instancesProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(instancesProjection.serialize(before)).toBe(serializedBefore);
  });
});

// ── the two FIX-SEED folds (D46), now one event kind with two report kinds ────
function fileReviewForA(
  criteria: Array<{ criterionId: string; verdict: 'pass' | 'fail'; note?: string }>,
): EventInput {
  return reportFiled({
    instanceId: INSTANCE_A,
    node: 'review',
    attempt: 1,
    payloadRev: 0,
    reportKind: 'review',
    body: { criteria },
  });
}

function fileCompletionForA(decisionsMade: string[], pathsRejected: string[]): EventInput {
  return reportFiled({
    instanceId: INSTANCE_A,
    node: 'implementing',
    attempt: 1,
    payloadRev: 0,
    reportKind: 'completion',
    body: { worklog: { decisionsMade, pathsRejected } },
  });
}

describe('instances projection — report_filed(review) → lastReview', () => {
  it('folds the identity tuple AND the body, and the view rebuilds the whole legacy payload', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [fileReviewForA([{ criterionId: 'ac-1', verdict: 'fail', note: 'still stalls' }])],
    ]);
    // The generic record: the (node, attempt, payloadRev) prefix is what makes
    // the feedback attributable to a run, so it is stored beside the body.
    expect(state.instances[INSTANCE_A]!.lastReview).toEqual({
      node: 'review',
      attempt: 1,
      payloadRev: 0,
      body: { criteria: [{ criterionId: 'ac-1', verdict: 'fail', note: 'still stalls' }] },
    });
    // The legacy view re-inverts the adapter into the WHOLE original payload —
    // this is the round trip S11-A1 pins over the frozen fixture.
    const legacyRecord = legacyTasksViewOf(state).tasks[INSTANCE_A]!;
    expect(legacyRecord.lastReview).toEqual({
      taskId: INSTANCE_A,
      stage: 'review',
      attempt: 1,
      workOrderRev: 0,
      criteria: [{ criterionId: 'ac-1', verdict: 'fail', note: 'still stalls' }],
    });
    expect(taskRecordSchema.safeParse(legacyRecord).success).toBe(true);
    // AUGMENT, not a move — the node is untouched by the report itself.
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('backlog');
  });

  it('LATEST-WINS: a second review overwrites the first', () => {
    // The log keeps both (that is the audit trail); the RECORD keeps the newest,
    // because the fix-seed a fresh implementer needs is the review that JUST
    // failed it, never a history of every lap round the loop.
    const state = stateFromLog([
      [createInstanceA()],
      [fileReviewForA([{ criterionId: 'ac-1', verdict: 'fail', note: 'first' }])],
      [fileReviewForA([{ criterionId: 'ac-1', verdict: 'pass', note: 'second' }])],
    ]);
    expect(state.instances[INSTANCE_A]!.lastReview!.body.criteria).toEqual([
      { criterionId: 'ac-1', verdict: 'pass', note: 'second' },
    ]);
  });

  it('ignores a review for an unknown instance — it never fabricates a record (I8)', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [
        reportFiled({
          instanceId: INSTANCE_B,
          node: 'review',
          attempt: 1,
          payloadRev: 0,
          reportKind: 'review',
          body: { criteria: [{ criterionId: 'ac-1', verdict: 'pass' }] },
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_B]).toBeUndefined();
    expect('lastReview' in state.instances[INSTANCE_A]!).toBe(false);
  });

  it('is idempotent: folding the SAME review twice leaves one value', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [fileReviewForA([{ criterionId: 'ac-1', verdict: 'pass' }])],
      [fileReviewForA([{ criterionId: 'ac-1', verdict: 'pass' }])],
    ]);
    expect(state.instances[INSTANCE_A]!.lastReview!.body.criteria).toHaveLength(1);
  });

  it('a malformed review payload is a no-op and never throws', () => {
    const before = stateFromLog([[createInstanceA()]]);
    const serializedBefore = instancesProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(fileReviewForA([])),
      payload: { instanceId: INSTANCE_A, reportKind: 'review', body: { criteria: 'not-an-array' } },
    } as unknown as EventRecord;
    let after: InstancesState | undefined;
    expect(() => {
      after = instancesProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(instancesProjection.serialize(before)).toBe(serializedBefore);
  });

  it('a report with an UNKNOWN reportKind is a no-op — the discriminator is closed', () => {
    // The generalisation's own new failure mode, and it fails CLOSED: a third
    // report kind is a record field and a decision, not a value the fold quietly
    // files under whichever branch it fell into.
    const before = stateFromLog([[createInstanceA()]]);
    const record = {
      ...recordOf(fileReviewForA([])),
      payload: {
        instanceId: INSTANCE_A,
        node: 'review',
        attempt: 1,
        payloadRev: 0,
        reportKind: 'retrospective',
        body: {},
      },
    } as unknown as EventRecord;
    expect(instancesProjection.apply(before, record)).toBe(before);
  });
});

describe('instances projection — report_filed(completion) → lastCompletion', () => {
  it('folds the identity tuple AND the body, and the view rebuilds the whole legacy payload', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [fileCompletionForA(['used the existing helper'], ['a bespoke parser — too slow'])],
    ]);
    expect(state.instances[INSTANCE_A]!.lastCompletion).toEqual({
      node: 'implementing',
      attempt: 1,
      payloadRev: 0,
      body: {
        worklog: {
          decisionsMade: ['used the existing helper'],
          pathsRejected: ['a bespoke parser — too slow'],
        },
      },
    });
    const legacyRecord = legacyTasksViewOf(state).tasks[INSTANCE_A]!;
    expect(legacyRecord.lastCompletion).toEqual({
      taskId: INSTANCE_A,
      stage: 'implementing',
      attempt: 1,
      workOrderRev: 0,
      worklog: {
        decisionsMade: ['used the existing helper'],
        pathsRejected: ['a bespoke parser — too slow'],
      },
    });
    expect(taskRecordSchema.safeParse(legacyRecord).success).toBe(true);
    // D53: the implementing -> review move is a SEPARATE `instance_moved`; the
    // report itself never moves the node.
    expect(state.instances[INSTANCE_A]!.currentNode).toBe('backlog');
  });

  it('LATEST-WINS: a second completion overwrites the first', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [fileCompletionForA(['first decision'], ['first dead end'])],
      [fileCompletionForA(['second decision'], ['second dead end'])],
    ]);
    expect(state.instances[INSTANCE_A]!.lastCompletion!.body.worklog).toEqual({
      decisionsMade: ['second decision'],
      pathsRejected: ['second dead end'],
    });
  });

  it('ignores a completion for an unknown instance — it never fabricates a record (I8)', () => {
    const state = stateFromLog([
      [createInstanceA()],
      [
        reportFiled({
          instanceId: INSTANCE_B,
          node: 'implementing',
          attempt: 1,
          payloadRev: 0,
          reportKind: 'completion',
          body: { worklog: { decisionsMade: [], pathsRejected: [] } },
        }),
      ],
    ]);
    expect(state.instances[INSTANCE_B]).toBeUndefined();
    expect('lastCompletion' in state.instances[INSTANCE_A]!).toBe(false);
  });

  it('a malformed completion payload is a no-op and never throws', () => {
    const before = stateFromLog([[createInstanceA()]]);
    const serializedBefore = instancesProjection.serialize(before);
    const malformedRecord = {
      ...recordOf(fileCompletionForA([], [])),
      payload: {
        instanceId: INSTANCE_A,
        reportKind: 'completion',
        body: { worklog: { decisionsMade: 'nope' } },
      },
    } as unknown as EventRecord;
    let after: InstancesState | undefined;
    expect(() => {
      after = instancesProjection.apply(before, malformedRecord);
    }).not.toThrow();
    expect(after).toBe(before);
    expect(instancesProjection.serialize(before)).toBe(serializedBefore);
  });

  it('the two report kinds land on DIFFERENT fields — neither erases the other', () => {
    // The half of D46 the one-event generalisation could most easily lose: a
    // fixer needs the review that sent it back AND the worklog of the attempt
    // that ended, at the same time.
    const state = stateFromLog([
      [createInstanceA()],
      [fileReviewForA([{ criterionId: 'ac-1', verdict: 'fail' }])],
      [fileCompletionForA(['d'], ['p'])],
    ]);
    expect(state.instances[INSTANCE_A]!.lastReview).toBeDefined();
    expect(state.instances[INSTANCE_A]!.lastCompletion).toBeDefined();
  });
});

describe('instances projection — I6: the fix-seed widening is invisible when unused', () => {
  it('an instance with no review/completion report has NEITHER key present', () => {
    const state = stateFromLog([[createInstanceA()]]);
    expect('lastReview' in state.instances[INSTANCE_A]!).toBe(false);
    expect('lastCompletion' in state.instances[INSTANCE_A]!).toBe(false);
    expect('lastReview' in legacyTasksViewOf(state).tasks[INSTANCE_A]!).toBe(false);
    expect('lastCompletion' in legacyTasksViewOf(state).tasks[INSTANCE_A]!).toBe(false);
  });

  it('a no-report log views byte-identically to a hand-built pre-S7·7b record', () => {
    // Byte-identity against an INDEPENDENTLY constructed expectation, not
    // against another run of the same code: a default sneaking into the fold
    // (or a new S11 field leaking through the view) shows up here even if both
    // sides changed together.
    const state = stateFromLog([[createInstanceA()]]);
    const preS7bShape: TasksState = {
      tasks: {
        [INSTANCE_A]: {
          taskId: INSTANCE_A,
          projectRoot: PROJECT_ROOT,
          stage: 'backlog',
          manualReviewRequired: false,
          isolation: 'worktree',
          gates: {},
          sessionRefs: [],
          createdBy: 'human',
          lastHeartbeatAt: null,
          staleRetries: 0,
        },
      },
    };
    expect(serializeLegacy(state)).toBe(canonicalJson(preS7bShape));
  });

  it('I6 replay-equivalence: folding a carrying-log twice is byte-identical', () => {
    const log = [
      [createInstanceA()],
      [fileReviewForA([{ criterionId: 'ac-1', verdict: 'fail', note: 'n' }])],
      [fileCompletionForA(['d'], ['p'])],
    ];
    const firstFold = stateFromLog(log);
    const secondFold = stateFromLog(log);
    expect(instancesProjection.serialize(secondFold)).toBe(
      instancesProjection.serialize(firstFold),
    );
    // And the fold really did carry both — a vacuous double-run would pass above.
    expect(firstFold.instances[INSTANCE_A]!.lastReview).toBeDefined();
    expect(firstFold.instances[INSTANCE_A]!.lastCompletion).toBeDefined();
  });
});

describe('instances projection — purity', () => {
  it('never mutates the input state and returns a NEW object on a real change', () => {
    // Snapshots share references with live state, so a mutating fold would
    // silently corrupt a saved snapshot.
    const frozenState = stateFromLog([[createInstanceA()]]);
    Object.freeze(frozenState);
    Object.freeze(frozenState.instances);
    Object.freeze(frozenState.instances[INSTANCE_A]);
    const serializedBefore = instancesProjection.serialize(frozenState);

    const afterMove = instancesProjection.apply(
      frozenState,
      recordOf(
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'backlog',
          toNode: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ),
    );

    expect(afterMove).not.toBe(frozenState);
    expect(afterMove.instances).not.toBe(frozenState.instances);
    expect(afterMove.instances[INSTANCE_A]).not.toBe(frozenState.instances[INSTANCE_A]);
    expect(afterMove.instances[INSTANCE_A]!.currentNode).toBe('planning');
    // The frozen input is untouched — byte-for-byte what it was.
    expect(instancesProjection.serialize(frozenState)).toBe(serializedBefore);
    expect(frozenState.instances[INSTANCE_A]!.currentNode).toBe('backlog');
    // ...including the NEW accumulating fields, which a `push` would corrupt.
    expect(frozenState.instances[INSTANCE_A]!.nodeHistory).toHaveLength(0);
    expect(afterMove.instances[INSTANCE_A]!.nodeHistory).toHaveLength(1);

    const afterInsert = instancesProjection.apply(
      frozenState,
      recordOf(
        instanceCreated({
          instanceId: INSTANCE_B,
          project: PROJECT_ROOT,
          node: 'backlog',
          createdBy: 'orchestrator',
          workflow: null,
          isolation: 'worktree',
          payload: {},
        }),
      ),
    );
    expect(afterInsert).not.toBe(frozenState);
    expect(instancesProjection.serialize(frozenState)).toBe(serializedBefore);
  });
});

describe('instances projection — determinism', () => {
  it('the same event sequence always serializes byte-identically', () => {
    const buildBatches = (): EventInput[][] => [
      [createInstanceA()],
      [
        instanceCreated({
          instanceId: INSTANCE_B,
          project: '/home/user/projects/other',
          node: 'backlog',
          createdBy: 'orchestrator',
          workflow: null,
          isolation: 'shared-dir',
          payload: {},
        }),
      ],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'backlog',
          toNode: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ];
    const firstRun = instancesProjection.serialize(stateFromLog(buildBatches()));
    const secondRun = instancesProjection.serialize(stateFromLog(buildBatches()));
    expect(secondRun).toBe(firstRun);
  });

  it('two instances created in opposite orders serialize identically (key-sort proof)', () => {
    // canonicalJson sorts keys deeply, so Record insertion order cannot leak
    // into the bytes — of the instances state OR of the view derived from it.
    const createB = instanceCreated({
      instanceId: INSTANCE_B,
      project: '/home/user/projects/other',
      node: 'backlog',
      createdBy: 'orchestrator',
      workflow: null,
      isolation: 'shared-dir',
      payload: {},
    });
    const aThenB = stateFromLog([[createInstanceA()], [createB]]);
    const bThenA = stateFromLog([[createB], [createInstanceA()]]);
    expect(instancesProjection.serialize(bThenA)).toBe(instancesProjection.serialize(aThenB));
    expect(serializeLegacy(bThenA)).toBe(serializeLegacy(aThenB));
  });
});

// ─── S11-A2 — alias equivalence ──────────────────────────────────────────────
//
// The assertion that makes the alias table trustworthy rather than plausible: a
// retired kind and its generic sibling carrying the SAME facts fold to the same
// record, and a MIXED-ERA stream (legacy prefix, generic tail — exactly what the
// production log becomes the moment U2 deploys) folds to the same state as
// either pure spelling.
describe('S11-A2 — a retired kind and its generic sibling fold identically', () => {
  // Each row is (name, legacy spelling, generic spelling) of ONE fact. The
  // states are compared by SERIALIZED BYTES, so a field that adapted into the
  // wrong place shows up even when the shapes are superficially similar.
  const equivalentPairs: ReadonlyArray<readonly [string, EventInput, EventInput]> = [
    [
      'task_created / instance_created',
      taskCreated({
        taskId: INSTANCE_B,
        projectRoot: PROJECT_ROOT,
        title: 'a titled birth record',
        createdBy: 'orchestrator',
        isolation: 'shared-dir',
        stage: 'planning',
        gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
        scope: 'the authored scope',
        explicitlyOut: ['one thing'],
        acceptanceCriteria: [{ id: 'ac-1', text: 'a criterion' }],
        killCriterion: 'the kill criterion',
      }),
      instanceCreated({
        instanceId: INSTANCE_B,
        project: PROJECT_ROOT,
        node: 'planning',
        createdBy: 'orchestrator',
        workflow: null,
        isolation: 'shared-dir',
        gates: { requireHeadroom: { meterId: 'window-5h', pct: 40 } },
        payload: {
          title: 'a titled birth record',
          scope: 'the authored scope',
          explicitlyOut: ['one thing'],
          acceptanceCriteria: [{ id: 'ac-1', text: 'a criterion' }],
          killCriterion: 'the kill criterion',
        },
      }),
    ],
    [
      'task_transitioned / instance_moved',
      taskTransitioned({
        taskId: INSTANCE_A,
        fromStage: 'backlog',
        toStage: 'planning',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
      instanceMoved({
        instanceId: INSTANCE_A,
        fromNode: 'backlog',
        toNode: 'planning',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
    ],
    [
      'task_session_attached / instance_run_attached',
      taskSessionAttached({ taskId: INSTANCE_A, stage: 'planning', appSessionId: RUN_SESSION_ID }),
      instanceRunAttached({ instanceId: INSTANCE_A, node: 'planning', appSessionId: RUN_SESSION_ID }),
    ],
    [
      'work_order_amended / instance_payload_revised',
      workOrderAmended({
        taskId: INSTANCE_A,
        workOrderRev: 3,
        amendedBy: 'human',
        scope: 'the revised scope',
        acceptanceCriteria: [],
      }),
      instancePayloadRevised({
        instanceId: INSTANCE_A,
        payloadRev: 3,
        revisedBy: 'human',
        patch: { scope: 'the revised scope', acceptanceCriteria: [] },
      }),
    ],
    [
      'plan_submitted / capture_recorded',
      planSubmitted({
        taskId: INSTANCE_A,
        stage: 'planning',
        attempt: 2,
        workOrderRev: 1,
        planArtifactHash: 'sha256:aaaa',
        plannerSessionRef: { appSessionId: RUN_SESSION_ID },
      }),
      captureRecorded({
        instanceId: INSTANCE_A,
        captureKind: 'plan',
        artifactHash: 'sha256:aaaa',
        node: 'planning',
        attempt: 2,
        payloadRev: 1,
        capturedFrom: { appSessionId: RUN_SESSION_ID },
      }),
    ],
    [
      'review_reported / report_filed(review)',
      reviewReported({
        taskId: INSTANCE_A,
        stage: 'review',
        attempt: 2,
        workOrderRev: 1,
        criteria: [{ criterionId: 'ac-1', verdict: 'fail', note: 'not yet' }],
      }),
      reportFiled({
        instanceId: INSTANCE_A,
        node: 'review',
        attempt: 2,
        payloadRev: 1,
        reportKind: 'review',
        body: { criteria: [{ criterionId: 'ac-1', verdict: 'fail', note: 'not yet' }] },
      }),
    ],
    [
      'completion_reported / report_filed(completion)',
      completionReported({
        taskId: INSTANCE_A,
        stage: 'implementing',
        attempt: 2,
        workOrderRev: 1,
        worklog: { decisionsMade: ['d'], pathsRejected: ['p'] },
      }),
      reportFiled({
        instanceId: INSTANCE_A,
        node: 'implementing',
        attempt: 2,
        payloadRev: 1,
        reportKind: 'completion',
        body: { worklog: { decisionsMade: ['d'], pathsRejected: ['p'] } },
      }),
    ],
    [
      'task_transition_rejected / instance_move_rejected (both fold to nothing)',
      taskTransitionRejected({
        taskId: INSTANCE_A,
        fromStage: 'planning',
        attemptedToStage: 'done',
        reason: 'illegal-edge',
        proposedBy: 'orchestrator',
      }),
      instanceMoveRejected({
        instanceId: INSTANCE_A,
        fromNode: 'planning',
        attemptedToNode: 'done',
        reason: 'illegal-edge',
        proposedBy: 'orchestrator',
      }),
    ],
  ];

  for (const [pairName, legacySpelling, genericSpelling] of equivalentPairs) {
    it(`${pairName} fold to byte-identical state`, () => {
      const foldedLegacy = stateFromLog([[createInstanceA()], [legacySpelling]]);
      const foldedGeneric = stateFromLog([[createInstanceA()], [genericSpelling]]);
      expect(instancesProjection.serialize(foldedGeneric)).toBe(
        instancesProjection.serialize(foldedLegacy),
      );
    });
  }

  it('a MIXED-ERA stream folds to the same state as either pure spelling', () => {
    // Exactly what production becomes: events written by the old writer, then
    // events written by the new one, in one stream, replayed by one fold.
    const legacyFacts: EventInput[] = [
      createTaskALegacy(),
      taskTransitioned({
        taskId: INSTANCE_A,
        fromStage: 'backlog',
        toStage: 'planning',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
      taskSessionAttached({ taskId: INSTANCE_A, stage: 'planning', appSessionId: RUN_SESSION_ID }),
      planSubmitted({
        taskId: INSTANCE_A,
        stage: 'planning',
        attempt: 1,
        workOrderRev: 0,
        planArtifactHash: 'sha256:aaaa',
        plannerSessionRef: { appSessionId: RUN_SESSION_ID },
      }),
    ];
    const genericFacts: EventInput[] = [
      createInstanceA(),
      instanceMoved({
        instanceId: INSTANCE_A,
        fromNode: 'backlog',
        toNode: 'planning',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
      instanceRunAttached({
        instanceId: INSTANCE_A,
        node: 'planning',
        appSessionId: RUN_SESSION_ID,
      }),
      captureRecorded({
        instanceId: INSTANCE_A,
        captureKind: 'plan',
        artifactHash: 'sha256:aaaa',
        node: 'planning',
        attempt: 1,
        payloadRev: 0,
        capturedFrom: { appSessionId: RUN_SESSION_ID },
      }),
    ];
    // The mixed stream takes the first two facts in the old spelling and the
    // last two in the new one — the shape of the log across a single deploy.
    const mixedFacts: EventInput[] = [
      legacyFacts[0]!,
      legacyFacts[1]!,
      genericFacts[2]!,
      genericFacts[3]!,
    ];

    const allLegacy = instancesProjection.serialize(stateFromLog(legacyFacts.map((e) => [e])));
    const allGeneric = instancesProjection.serialize(stateFromLog(genericFacts.map((e) => [e])));
    const mixedEra = instancesProjection.serialize(stateFromLog(mixedFacts.map((e) => [e])));

    expect(allGeneric).toBe(allLegacy);
    expect(mixedEra).toBe(allLegacy);
    // Not vacuous: the fold really carried all four facts.
    const mixedState = stateFromLog(mixedFacts.map((e) => [e]));
    expect(mixedState.instances[INSTANCE_A]!.currentNode).toBe('planning');
    expect(mixedState.instances[INSTANCE_A]!.attachedSessions).toHaveLength(1);
    expect(mixedState.instances[INSTANCE_A]!.planArtifactHash).toBe('sha256:aaaa');
  });
});

// ─── S11-A3 — the alias table is TOTAL and it warns ──────────────────────────
describe('S11-A3 — the alias table covers every kind the old reducer folded', () => {
  it('has a row for exactly the eight retired kinds, asserted against a LITERAL list', () => {
    // ⚠ A LITERAL list on purpose, not one derived from `EVENT_TYPES`: the whole
    // failure this guards against is a future rename that quietly skips the
    // table, and a derived expectation would rename itself alongside it.
    expect(Object.keys(RETIRED_EVENT_KINDS).sort()).toEqual(
      [
        'task_created',
        'task_transitioned',
        'task_transition_rejected',
        'task_session_attached',
        'work_order_amended',
        'plan_submitted',
        'review_reported',
        'completion_reported',
      ].sort(),
    );
  });

  it('points every row at a kind the engine actually emits, at alias version 1', () => {
    const engineKinds = new Set<string>(Object.values(EVENT_TYPES));
    for (const [retiredKind, row] of Object.entries(RETIRED_EVENT_KINDS)) {
      expect(engineKinds.has(row.canonical), `${retiredKind} -> ${row.canonical}`).toBe(true);
      expect(row.since).toBe(1);
    }
  });

  it('deliberately EXCLUDES the three kinds this slice does not rename', () => {
    // slice-11.md "Explicitly OUT": their generic siblings arrive with the E2
    // tree store and the watchdog/dispatcher splits. Asserted so that adding one
    // is a decision somebody makes, not a diff that slips through.
    expect(RETIRED_EVENT_KINDS['task_worktree_created']).toBeUndefined();
    expect(RETIRED_EVENT_KINDS['task_quarantined']).toBeUndefined();
    expect(RETIRED_EVENT_KINDS['dispatch_refused']).toBeUndefined();
  });

  it('adapts are PURE — the same legacy payload always adapts to the same bytes', () => {
    const legacyPayload = {
      taskId: INSTANCE_A,
      projectRoot: PROJECT_ROOT,
      createdBy: 'human',
      isolation: 'worktree',
      stage: 'backlog',
    };
    const row = RETIRED_EVENT_KINDS['task_created']!;
    expect(canonicalJson(row.adapt(legacyPayload))).toBe(canonicalJson(row.adapt(legacyPayload)));
  });

  it('every adapt returns null (never throws) on a payload its legacy schema refuses', () => {
    for (const [retiredKind, row] of Object.entries(RETIRED_EVENT_KINDS)) {
      expect(() => row.adapt({ nonsense: true }), retiredKind).not.toThrow();
      expect(row.adapt({ nonsense: true }), retiredKind).toBeNull();
      expect(row.adapt(null), retiredKind).toBeNull();
    }
  });

  it("the capture catalogue and the capture event's kind enum agree", () => {
    // The one restated constant in the move (events.ts cannot import manifest.ts
    // without a cycle), so the agreement is asserted rather than assumed: a
    // second catalogue entry added on either side reddens here.
    expect([...captureKindSchema.options]).toEqual([...CAPTURE_CATALOGUE]);
  });
});

// ─── S11-A5 — replay equivalence for the NEW state ───────────────────────────
describe('S11-A5 — InstancesState honours the I6 family over generic kinds', () => {
  function buildGenericStore(): MemoryEventStore {
    const store = makeStore();
    store.append([
      createInstanceA(),
      instanceCreated({
        instanceId: INSTANCE_B,
        project: '/home/user/projects/other',
        node: 'backlog',
        createdBy: 'orchestrator',
        workflow: null,
        isolation: 'shared-dir',
        payload: { title: 'the second instance' },
      }),
    ]);
    store.append([
      instanceMoved({
        instanceId: INSTANCE_A,
        fromNode: 'backlog',
        toNode: 'planning',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
      instanceRunAttached({
        instanceId: INSTANCE_A,
        node: 'planning',
        appSessionId: RUN_SESSION_ID,
      }),
      recordPlanCaptureForA('sha256:aaaa'),
    ]);
    store.append([
      instanceMoved({
        instanceId: INSTANCE_A,
        fromNode: 'planning',
        toNode: 'implementing',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
      fileCompletionForA(['d'], ['p']),
      instanceMoved({
        instanceId: INSTANCE_A,
        fromNode: 'implementing',
        toNode: 'review',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
      fileReviewForA([{ criterionId: 'ac-1', verdict: 'fail' }]),
      instanceMoved({
        instanceId: INSTANCE_A,
        fromNode: 'review',
        toNode: 'implementing',
        manualReviewRequired: false,
        proposedBy: 'dispatcher',
      }),
    ]);
    return store;
  }

  it('boots from a snapshot at EVERY cut point to the same bytes as a replay from empty', () => {
    const store = buildGenericStore();
    const records = readAllStreamsGrouped(store);
    const fullReplay = instancesProjection.serialize(replayFromEmpty(instancesProjection, records));
    // Non-vacuity: the fold must actually move, or "equal at every cut" is a
    // statement about a projection that does nothing.
    expect(fullReplay).not.toBe(instancesProjection.serialize(instancesProjection.init()));

    for (let cut = 0; cut <= records.length; cut += 1) {
      const snapshotStore = new MemorySnapshotStore();
      snapshotStore.save(
        snapshotAfter(
          instancesProjection,
          records.slice(0, cut),
          new SteppingClock('2026-02-01T00:00:00.000Z', 1000),
        ),
      );
      const booted = bootFromSnapshot(instancesProjection, snapshotStore, store);
      expect(instancesProjection.serialize(booted), `cut ${cut}`).toBe(fullReplay);
    }
  });

  it('the legacy VIEW is equally cut-point stable', () => {
    // The alias route's answer must not depend on when the daemon last
    // snapshotted, which is the property the deployed UI silently relies on.
    const store = buildGenericStore();
    const records = readAllStreamsGrouped(store);
    const fullView = serializeLegacy(replayFromEmpty(instancesProjection, records));
    const midCut = Math.floor(records.length / 2);
    const snapshotStore = new MemorySnapshotStore();
    snapshotStore.save(
      snapshotAfter(
        instancesProjection,
        records.slice(0, midCut),
        new SteppingClock('2026-02-01T00:00:00.000Z', 1000),
      ),
    );
    expect(serializeLegacy(bootFromSnapshot(instancesProjection, snapshotStore, store))).toBe(
      fullView,
    );
  });
});

// ─── the NEW fold-derived fields ─────────────────────────────────────────────
//
// Consumed by nothing until Move 3, which is exactly why they get their own
// assertions now: a field nobody reads is a field whose first bug is found by
// the feature that finally depends on it.
describe('instances projection — nodeHistory / edgeTraversalCounts / attemptsPerNode', () => {
  // One instance walking a lap: backlog -> planning -> implementing -> review,
  // back to implementing (the failed review), and forward to review again.
  function walkALap(): EventInput[][] {
    const move = (fromNode: string, toNode: string, proposedBy: 'dispatcher' | 'orchestrator') => [
      instanceMoved({
        instanceId: INSTANCE_A,
        fromNode,
        toNode,
        manualReviewRequired: false,
        proposedBy,
      }),
    ];
    return [
      [createInstanceA()],
      move('backlog', 'planning', 'dispatcher'),
      move('planning', 'implementing', 'dispatcher'),
      move('implementing', 'review', 'dispatcher'),
      move('review', 'implementing', 'orchestrator'),
      move('implementing', 'review', 'dispatcher'),
    ];
  }

  it('counts entries per node — creation is entry 1, each move increments its destination', () => {
    const state = stateFromLog(walkALap());
    expect(state.instances[INSTANCE_A]!.attemptsPerNode).toEqual({
      backlog: 1,
      planning: 1,
      implementing: 2,
      review: 2,
    });
  });

  it('counts edge traversals with an ASCII `from->to` key, no exotic separators', () => {
    const state = stateFromLog(walkALap());
    expect(state.instances[INSTANCE_A]!.edgeTraversalCounts).toEqual({
      'backlog->planning': 1,
      'planning->implementing': 1,
      'implementing->review': 2,
      'review->implementing': 1,
    });
    // The keys are DATA in a serialized projection: printable ASCII only.
    for (const edgeKey of Object.keys(state.instances[INSTANCE_A]!.edgeTraversalCounts)) {
      expect(edgeKey).toMatch(/^[ -~]+$/);
    }
  });

  it('appends one history entry per MOVE, in log order, with the EVENT ts (never a clock)', () => {
    const store = makeStore();
    for (const batch of walkALap()) {
      store.append(batch);
    }
    const records = readAllStreamsGrouped(store);
    const state = replayFromEmpty(instancesProjection, records);
    const moveRecords = records.filter((record) => record.type === EVENT_TYPES.instanceMoved);

    expect(state.instances[INSTANCE_A]!.nodeHistory).toEqual([
      { node: 'planning', proposedBy: 'dispatcher', ts: moveRecords[0]!.ts },
      { node: 'implementing', proposedBy: 'dispatcher', ts: moveRecords[1]!.ts },
      { node: 'review', proposedBy: 'dispatcher', ts: moveRecords[2]!.ts },
      { node: 'implementing', proposedBy: 'orchestrator', ts: moveRecords[3]!.ts },
      { node: 'review', proposedBy: 'dispatcher', ts: moveRecords[4]!.ts },
    ]);
    // CREATION SEEDS NOTHING: five moves, five entries.
    expect(state.instances[INSTANCE_A]!.nodeHistory).toHaveLength(moveRecords.length);
  });

  it('the retired spelling folds all three identically — legacy history is not lost', () => {
    // `task_transitioned` already carried `proposedBy`, which is what makes the
    // history foldable from events written years before the field existed.
    const legacyLap: EventInput[][] = [
      [createTaskALegacy()],
      [
        taskTransitioned({
          taskId: INSTANCE_A,
          fromStage: 'backlog',
          toStage: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [
        taskTransitioned({
          taskId: INSTANCE_A,
          fromStage: 'planning',
          toStage: 'implementing',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ];
    const genericLap: EventInput[][] = [
      [createInstanceA()],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'backlog',
          toNode: 'planning',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
      [
        instanceMoved({
          instanceId: INSTANCE_A,
          fromNode: 'planning',
          toNode: 'implementing',
          manualReviewRequired: false,
          proposedBy: 'dispatcher',
        }),
      ],
    ];
    expect(instancesProjection.serialize(stateFromLog(genericLap))).toBe(
      instancesProjection.serialize(stateFromLog(legacyLap)),
    );
    expect(stateFromLog(legacyLap).instances[INSTANCE_A]!.nodeHistory).toHaveLength(2);
  });

  it('folds deterministically — two runs of the same lap are byte-identical', () => {
    expect(instancesProjection.serialize(stateFromLog(walkALap()))).toBe(
      instancesProjection.serialize(stateFromLog(walkALap())),
    );
  });

  it('the legacy view DROPS all three, plus `workflow` — that is the point of it', () => {
    const state = stateFromLog(walkALap());
    const legacyRecord = legacyTasksViewOf(state).tasks[INSTANCE_A]!;
    expect('nodeHistory' in legacyRecord).toBe(false);
    expect('edgeTraversalCounts' in legacyRecord).toBe(false);
    expect('attemptsPerNode' in legacyRecord).toBe(false);
    expect('workflow' in legacyRecord).toBe(false);
    // ...and what survives is still exactly a TaskRecord.
    expect(taskRecordSchema.safeParse(legacyRecord).success).toBe(true);
  });
});
