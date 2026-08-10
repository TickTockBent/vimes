import { describe, expect, it } from 'vitest';
import {
  TASK_STAGES,
  nextTaskForAcceptedTransition,
  taskStageSchema,
  transitionProposedBySchema,
  transitionRejectionReasonSchema,
  type TaskStage,
  type TransitionProposal,
} from './taskStateMachine.js';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  taskCreated,
  taskCreatedPayloadSchema,
  taskTransitioned,
  taskTransitionedPayloadSchema,
  taskTransitionRejected,
  taskTransitionRejectedPayloadSchema,
} from '../events.js';
import { taskRecordSchema, type TaskRecord } from '../schemas.js';

// ─── the transitional vocabulary module's own tests (D72 Move 3, S12·U3) ─────
//
// This file used to enumerate a compiled legality table and drive a compiled
// machine over the full stage cross product. Both are GONE: legality is declared
// in the `vimes-tasks` extension manifest, adjudicated by
// `extensions/proposeMove.ts`, and proved there — the declared-vs-frozen
// differential lives in `extensions/manifest.test.ts` (S12-A3) and the
// behavioural pins in `extensions/proposeMove.test.ts`.
//
// What remains here is what remains in the module: the tenant's VOCABULARIES
// (stages, proposer classes, refusal reasons) and the ONE rule about what an
// accepted move RECORDS. Nothing below decides legality, and nothing may start.

function taskAtStage(stage: TaskStage, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-1',
    projectRoot: '/home/wes/projects/vimes',
    stage,
    manualReviewRequired: false,
    // D32: the pinned default. Named explicitly so no fixture implies one.
    isolation: 'worktree',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

function proposal(
  toStage: TaskStage,
  overrides: Partial<TransitionProposal> = {},
): TransitionProposal {
  return { toStage, proposedBy: 'dispatcher', ...overrides };
}

// ── the stage vocabulary ─────────────────────────────────────────────────────

describe("TASK_STAGES — the record vocabulary, in the schema's own order", () => {
  it('is the nine shipped stages and nothing else', () => {
    expect(TASK_STAGES).toHaveLength(9);
    expect([...TASK_STAGES].sort()).toEqual([
      'backlog',
      'blocked-external',
      'cancelled',
      'done',
      'implementing',
      'plan-ready',
      'planning',
      'quarantined',
      'review',
    ]);
  });

  // ⚠ THE ORDER IS WIRE-LOAD-BEARING, not cosmetic. S12·U2 derives the key order
  // of `GET /api/tasks/stage-edges` from this vocabulary, and that response is a
  // contract the deployed UI parses (slice-12 F4, and the frozen wire literal in
  // the daemon's `instanceApi.test.ts` is its byte-level pin). Re-ordering the
  // enum in `schemas.ts` is a wire change; this test is where it announces itself.
  it('rides the enum declaration order, which the served stage-edges keys inherit', () => {
    expect([...TASK_STAGES]).toEqual([
      'backlog',
      'planning',
      'plan-ready',
      'implementing',
      'review',
      'done',
      'blocked-external',
      'quarantined',
      'cancelled',
    ]);
    // Derived, never transcribed: the list IS the schema's options.
    expect([...TASK_STAGES]).toEqual([...taskStageSchema.options]);
  });

  it('is the same vocabulary `taskRecordSchema` accepts for `stage`', () => {
    for (const stage of TASK_STAGES) {
      expect(taskRecordSchema.safeParse(taskAtStage(stage)).success).toBe(true);
    }
    expect(taskRecordSchema.shape.stage.options).toEqual(taskStageSchema.options);
  });
});

// ── the proposer vocabulary ──────────────────────────────────────────────────

describe('transitionProposedBySchema — who may propose', () => {
  it('is exactly the three proposer classes, in their declared order', () => {
    expect(transitionProposedBySchema.options).toEqual(['human', 'orchestrator', 'dispatcher']);
  });

  it('is deliberately WIDER than `createdBy` — the dispatcher moves what it never created', () => {
    expect(transitionProposedBySchema.safeParse('dispatcher').success).toBe(true);
    expect(taskRecordSchema.shape.createdBy.options).toEqual(['human', 'orchestrator']);
  });

  it('refuses a class outside the set (the `watchdog` class is declared, not shipped)', () => {
    expect(transitionProposedBySchema.safeParse('watchdog').success).toBe(false);
    expect(transitionProposedBySchema.safeParse('').success).toBe(false);
  });
});

// ── the refusal vocabulary ───────────────────────────────────────────────────

describe('transitionRejectionReasonSchema — the enumerated refusals', () => {
  it('is exactly the five reasons the adjudicator can return', () => {
    expect([...transitionRejectionReasonSchema.options].sort()).toEqual([
      'illegal-edge',
      'quarantined-cannot-complete',
      'same-stage',
      'terminal-stage',
      'unknown-stage',
    ]);
  });

  it('refuses a reason outside the enumerated set', () => {
    expect(transitionRejectionReasonSchema.safeParse('because-i-said-so').success).toBe(false);
  });

  // I7's record: EVERY refusal the adjudicator can produce must be EVENTABLE. An
  // unrecordable rejection is, as far as I7 is concerned, one that never
  // happened — so this walks the vocabulary itself rather than a sample.
  it('every reason validates inside a `task_transition_rejected` payload', () => {
    for (const reason of transitionRejectionReasonSchema.options) {
      const input = taskTransitionRejected({
        taskId: 'task-1',
        fromStage: 'review',
        attemptedToStage: 'done',
        reason,
        proposedBy: 'orchestrator',
      });
      expect(input.stream).toBe('tasks');
      expect(input.type).toBe(EVENT_TYPES.taskTransitionRejected);
      expect(taskTransitionRejectedPayloadSchema.safeParse(input.payload).success).toBe(true);
      expect(
        EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.taskTransitionRejected].safeParse(input.payload).success,
      ).toBe(true);
    }
  });

  // `unknown-stage` exists FOR hostile/malformed input, and the whole point of
  // the event is to RECORD what was refused — so the rejected event's stage
  // fields must accept a value outside the enum. If this ever tightens to the
  // enum, an unknown-stage rejection becomes unrecordable and I7 fails silently
  // exactly where it matters most.
  it('records an unknown-stage refusal verbatim, outside the enum', () => {
    const input = taskTransitionRejected({
      taskId: 'task-1',
      fromStage: 'review',
      attemptedToStage: 'shipped-it',
      reason: 'unknown-stage',
      proposedBy: 'orchestrator',
    });
    expect(taskTransitionRejectedPayloadSchema.safeParse(input.payload).success).toBe(true);
    expect(input.payload).toMatchObject({ attemptedToStage: 'shipped-it', reason: 'unknown-stage' });
  });

  it('rejects a payload carrying a reason outside the enumerated set', () => {
    const parsed = taskTransitionRejectedPayloadSchema.safeParse({
      taskId: 'task-1',
      fromStage: 'review',
      attemptedToStage: 'done',
      reason: 'because-i-said-so',
      proposedBy: 'orchestrator',
    });
    expect(parsed.success).toBe(false);
  });
});

// ── the convergence flag rule (F1: retires with the bounded-loop move) ───────
//
// All four quadrants pinned DIRECTLY on `nextTaskForAcceptedTransition`. They
// were previously proven through the deleted machine's accept branch; the rule
// outlives it, so the pins move onto the rule itself rather than vanishing with
// their old caller.

describe('the convergence flag — the rule for what an accepted move RECORDS', () => {
  it('into `done` WITH the flag: sets it', () => {
    const next = nextTaskForAcceptedTransition(
      taskAtStage('review'),
      proposal('done', { manualReviewRequired: true, note: 'rework stopped converging' }),
    );
    expect(next.stage).toBe('done');
    expect(next.manualReviewRequired).toBe(true);
  });

  it('into `done` with the flag explicitly FALSE: leaves it false', () => {
    const next = nextTaskForAcceptedTransition(
      taskAtStage('review'),
      proposal('done', { manualReviewRequired: false }),
    );
    expect(next.manualReviewRequired).toBe(false);
  });

  it("into `done` with the flag ABSENT: false, never the record's old value", () => {
    // The distinction that matters: absent is not "inherit". A task that arrives
    // at the completion edge carrying `true` and completes WITHOUT the flag
    // completes clean.
    expect(
      nextTaskForAcceptedTransition(taskAtStage('review'), proposal('done')).manualReviewRequired,
    ).toBe(false);
    expect(
      nextTaskForAcceptedTransition(
        taskAtStage('review', { manualReviewRequired: true }),
        proposal('done'),
      ).manualReviewRequired,
    ).toBe(false);
  });

  it("any OTHER target ignores the proposal flag and rides the RECORD's value through", () => {
    const otherTargets = TASK_STAGES.filter((stage) => stage !== 'done');
    expect(otherTargets).toHaveLength(8);

    for (const toStage of otherTargets) {
      for (const recordFlag of [true, false]) {
        for (const proposalFlag of [true, false, undefined]) {
          const next = nextTaskForAcceptedTransition(
            taskAtStage('implementing', { manualReviewRequired: recordFlag }),
            proposal(toStage, { manualReviewRequired: proposalFlag }),
          );
          expect({ toStage, flag: next.manualReviewRequired }).toEqual({
            toStage,
            flag: recordFlag,
          });
        }
      }
    }
  });

  it('writes the proposed node and nothing else about the stage', () => {
    for (const toStage of TASK_STAGES) {
      expect(nextTaskForAcceptedTransition(taskAtStage('implementing'), proposal(toStage)).stage).toBe(
        toStage,
      );
    }
  });
});

// ── purity (rule 0.3) ────────────────────────────────────────────────────────

describe('the record rule is pure — a NEW object, the input untouched', () => {
  it('never mutates the input record', () => {
    const task = Object.freeze(taskAtStage('implementing'));
    const before = JSON.parse(JSON.stringify(task));

    const next = nextTaskForAcceptedTransition(task, proposal('review'));

    expect(JSON.parse(JSON.stringify(task))).toEqual(before);
    expect(task.stage).toBe('implementing');
    expect(next).not.toBe(task);
    expect(next.stage).toBe('review');
  });

  it('carries every non-stage field through unchanged, work-order fields included', () => {
    // The widest record the rule can be handed (S7·1 work-order fields + S7·5a's
    // `planArtifactHash`). If any of them perturbed the spread, this is where it
    // would show — and the result is still a VALID record.
    const task = taskAtStage('plan-ready', {
      taskId: 'task-carry',
      isolation: 'shared-dir',
      gates: { requireHeadroom: { meterId: 'weekly', pct: 20 } },
      sessionRefs: [{ stage: 'planning', appSessionId: 'app-7' }],
      createdBy: 'orchestrator',
      lastHeartbeatAt: '2026-07-22T00:00:00.000Z',
      staleRetries: 2,
      scope: 'add the S7·1 reserved schemas',
      explicitlyOut: ['wiring any consumer'],
      acceptanceCriteria: [
        { id: 'crit-1', text: 'typecheck is green' },
        { id: 'crit-2', text: 'the core test suite is green' },
      ],
      killCriterion: 'a reserved shape forces a projection default',
      workOrderRev: 3,
      planArtifactHash: 'sha256:aaaa',
    });

    const next = nextTaskForAcceptedTransition(task, proposal('implementing'));

    expect(next).toEqual({ ...task, stage: 'implementing' });
    expect(taskRecordSchema.safeParse(next).success).toBe(true);
  });

  it('is deterministic — identical inputs, identical records', () => {
    for (const toStage of TASK_STAGES) {
      const first = nextTaskForAcceptedTransition(taskAtStage('backlog'), proposal(toStage));
      const second = nextTaskForAcceptedTransition(taskAtStage('backlog'), proposal(toStage));
      expect(first).toEqual(second);
    }
  });
});

// ── the task event constructors ──────────────────────────────────────────────
//
// Kept: their subject (the constructors and their payload schemas) is untouched
// by the deletion. Only the way each test SOURCES a stage or a reason changed —
// off literals and the record rule instead of off a compiled machine.

describe('the task event constructors validate against their schemas', () => {
  it('task_created carries the birth record on the tasks stream', () => {
    const input = taskCreated({
      taskId: 'task-1',
      projectRoot: '/home/wes/projects/vimes',
      createdBy: 'human',
      // D32: worktree is the pinned default isolation.
      isolation: 'worktree',
      // Where a task starts life is the DECLARATION's `initial`, resolved at
      // boot (see `createTaskTool.ts`'s D53 note); this constructor just needs a
      // valid stage.
      stage: 'backlog',
    });
    expect(input.stream).toBe('tasks');
    expect(input.type).toBe(EVENT_TYPES.taskCreated);
    expect(taskCreatedPayloadSchema.safeParse(input.payload).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.taskCreated].safeParse(input.payload).success).toBe(
      true,
    );
  });

  it('task_transitioned records a real ACCEPTED move end to end', () => {
    const task = taskAtStage('review');
    const next = nextTaskForAcceptedTransition(
      task,
      proposal('done', { manualReviewRequired: true, proposedBy: 'human', note: 'handing off' }),
    );

    const input = taskTransitioned({
      taskId: task.taskId,
      fromStage: task.stage,
      toStage: next.stage,
      manualReviewRequired: next.manualReviewRequired,
      proposedBy: 'human',
      note: 'handing off',
    });
    expect(input.stream).toBe('tasks');
    expect(input.type).toBe(EVENT_TYPES.taskTransitioned);
    expect(taskTransitionedPayloadSchema.safeParse(input.payload).success).toBe(true);
    expect(input.payload).toMatchObject({
      fromStage: 'review',
      toStage: 'done',
      manualReviewRequired: true,
    });
  });

  it('task_transitioned accepts a payload without the optional note', () => {
    const input = taskTransitioned({
      taskId: 'task-1',
      fromStage: 'backlog',
      toStage: 'planning',
      manualReviewRequired: false,
      proposedBy: 'dispatcher',
    });
    expect(taskTransitionedPayloadSchema.safeParse(input.payload).success).toBe(true);
  });
});

// ── the two reserved events must be untouched ────────────────────────────────
describe('the slice-0 reserved task events are unchanged', () => {
  it('task_quarantined and dispatch_refused keep their original shapes', () => {
    expect(EVENT_TYPES.taskQuarantined).toBe('task_quarantined');
    expect(EVENT_TYPES.dispatchRefused).toBe('dispatch_refused');
    expect(
      EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.taskQuarantined].safeParse({
        appSessionId: 'app-1',
        taskId: 'task-1',
      }).success,
    ).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.dispatchRefused].safeParse({
        taskId: 'task-1',
        reason: 'headroom',
      }).success,
    ).toBe(true);
  });
});
