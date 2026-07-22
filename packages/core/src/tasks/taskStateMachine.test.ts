import { describe, expect, it } from 'vitest';
import {
  INITIAL_TASK_STAGE,
  TASK_STAGES,
  TASK_STAGE_EDGES,
  isLegalTaskEdge,
  proposeTransition,
  type TaskStage,
  type TransitionProposal,
  type TransitionRejectionReason,
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

// ─── the enumeration harness ─────────────────────────────────────────────────
//
// Everything below is driven off the EXPORTED table (`TASK_STAGE_EDGES`) and the
// EXPORTED stage list (`TASK_STAGES`, itself derived from `taskRecordSchema`).
// There is deliberately NO hand-copied edge list in this file: a table plus a
// transcribed test list is two sources of one truth, and they drift. Add a stage
// to the schema or an edge to the table and these tests re-derive their own
// coverage — the legal set, the illegal set, and the expected refusal for each.

// Every (from, to) pair the table permits.
const LEGAL_EDGES: Array<[TaskStage, TaskStage]> = [...TASK_STAGE_EDGES.entries()].flatMap(
  ([fromStage, allowedToStages]) =>
    [...allowedToStages].map((toStage): [TaskStage, TaskStage] => [fromStage, toStage]),
);

// The FULL stage × stage cross product.
const ALL_EDGES: Array<[TaskStage, TaskStage]> = TASK_STAGES.flatMap((fromStage) =>
  TASK_STAGES.map((toStage): [TaskStage, TaskStage] => [fromStage, toStage]),
);

// The cross product minus the legal set — every edge that must be REJECTED.
const ILLEGAL_EDGES: Array<[TaskStage, TaskStage]> = ALL_EDGES.filter(
  ([fromStage, toStage]) => !isLegalTaskEdge(fromStage, toStage),
);

// The refusal each illegal edge must produce, derived from the documented
// precedence rather than transcribed per-case (see `proposeTransition`'s doc
// comment). This mirrors the ORDER of the checks, not their implementation.
function expectedRejectionFor(fromStage: TaskStage, toStage: TaskStage): TransitionRejectionReason {
  if (fromStage === toStage) return 'same-stage';
  if (fromStage === 'done') return 'terminal-stage';
  if (fromStage === 'quarantined' && toStage === 'done') return 'quarantined-cannot-complete';
  return 'illegal-edge';
}

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

describe('the transition table itself', () => {
  it('covers every schema stage and nothing else (no stage silently escapes)', () => {
    expect([...TASK_STAGE_EDGES.keys()].sort()).toEqual([...TASK_STAGES].sort());
    for (const allowedToStages of TASK_STAGE_EDGES.values()) {
      for (const toStage of allowedToStages) {
        expect(TASK_STAGES).toContain(toStage);
      }
    }
  });

  it('starts tasks in backlog', () => {
    expect(INITIAL_TASK_STAGE).toBe('backlog');
    expect(taskRecordSchema.shape.stage.options).toContain(INITIAL_TASK_STAGE);
  });

  it('partitions the cross product into legal + illegal with no overlap or gap', () => {
    expect(LEGAL_EDGES.length + ILLEGAL_EDGES.length).toBe(ALL_EDGES.length);
    expect(ALL_EDGES.length).toBe(TASK_STAGES.length * TASK_STAGES.length);
  });
});

// ── assertion 1 ──────────────────────────────────────────────────────────────
describe('assertion 1 — every legal edge in the table is ACCEPTED', () => {
  it.each(LEGAL_EDGES)('%s -> %s is accepted', (fromStage, toStage) => {
    const outcome = proposeTransition(taskAtStage(fromStage), proposal(toStage));
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.nextTask.stage).toBe(toStage);
    }
  });
});

// ── assertion 2 ──────────────────────────────────────────────────────────────
describe('assertion 2 — every edge NOT in the table is REJECTED', () => {
  it.each(ILLEGAL_EDGES)('%s -> %s is rejected with the derived reason', (fromStage, toStage) => {
    const outcome = proposeTransition(taskAtStage(fromStage), proposal(toStage));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) {
      expect(outcome.reason).toBe(expectedRejectionFor(fromStage, toStage));
    }
  });

  it('never throws for any edge in the cross product (rejection is not an exception)', () => {
    for (const [fromStage, toStage] of ALL_EDGES) {
      expect(() => proposeTransition(taskAtStage(fromStage), proposal(toStage))).not.toThrow();
    }
  });
});

// ── assertion 3 ──────────────────────────────────────────────────────────────
describe('assertion 3 — done is terminal', () => {
  const targetsOtherThanDone = TASK_STAGES.filter((stage) => stage !== 'done');

  it.each([...targetsOtherThanDone])('done -> %s rejects terminal-stage', (toStage) => {
    const outcome = proposeTransition(taskAtStage('done'), proposal(toStage));
    expect(outcome).toEqual({ accepted: false, reason: 'terminal-stage' });
  });

  it('done has no outgoing edges at all in the table', () => {
    expect([...(TASK_STAGE_EDGES.get('done') ?? [])]).toEqual([]);
  });

  // The one tie-break the table cannot express: done -> done is BOTH a no-op and
  // a proposal touching a terminal stage. Documented precedence resolves it as
  // same-stage (nothing was proposed to LEAVE done). Asserted directly so the
  // choice is visible rather than incidental.
  it('done -> done is the documented same-stage tie-break, not terminal-stage', () => {
    const outcome = proposeTransition(taskAtStage('done'), proposal('done'));
    expect(outcome).toEqual({ accepted: false, reason: 'same-stage' });
  });
});

// ── assertion 4 ──────────────────────────────────────────────────────────────
describe('assertion 4 — quarantined can never complete', () => {
  it('quarantined -> done rejects quarantined-cannot-complete, NOT illegal-edge', () => {
    const outcome = proposeTransition(taskAtStage('quarantined'), proposal('done'));
    expect(outcome).toEqual({ accepted: false, reason: 'quarantined-cannot-complete' });
  });

  it('the named refusal wins over the generic edge check for that exact edge', () => {
    // Both are absent from the table; only this one gets the specific reason.
    expect(isLegalTaskEdge('quarantined', 'done')).toBe(false);
    expect(isLegalTaskEdge('quarantined', 'plan-ready')).toBe(false);

    const completing = proposeTransition(taskAtStage('quarantined'), proposal('done'));
    const other = proposeTransition(taskAtStage('quarantined'), proposal('plan-ready'));
    expect(completing).toEqual({ accepted: false, reason: 'quarantined-cannot-complete' });
    expect(other).toEqual({ accepted: false, reason: 'illegal-edge' });
  });

  it('a quarantined run can still go back through work or be parked', () => {
    for (const toStage of ['backlog', 'planning', 'implementing', 'blocked-external'] as const) {
      expect(proposeTransition(taskAtStage('quarantined'), proposal(toStage)).accepted).toBe(true);
    }
  });

  it('setting manualReviewRequired does not buy a quarantined run a completion', () => {
    const outcome = proposeTransition(
      taskAtStage('quarantined'),
      proposal('done', { manualReviewRequired: true }),
    );
    expect(outcome).toEqual({ accepted: false, reason: 'quarantined-cannot-complete' });
  });
});

// ── assertion 5 ──────────────────────────────────────────────────────────────
describe('assertion 5 — a same-stage proposal is a no-op rejection', () => {
  it.each([...TASK_STAGES])('%s -> %s rejects same-stage', (stage) => {
    const outcome = proposeTransition(taskAtStage(stage), proposal(stage));
    expect(outcome).toEqual({ accepted: false, reason: 'same-stage' });
  });
});

// ── assertion 6 ──────────────────────────────────────────────────────────────
describe('assertion 6 — the convergence exit (manualReviewRequired)', () => {
  it('review -> done WITH the flag accepts and sets it', () => {
    const outcome = proposeTransition(
      taskAtStage('review'),
      proposal('done', { manualReviewRequired: true, note: 'rework stopped converging' }),
    );
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.nextTask.stage).toBe('done');
      expect(outcome.nextTask.manualReviewRequired).toBe(true);
    }
  });

  it('review -> done WITHOUT the flag leaves it false', () => {
    const outcome = proposeTransition(taskAtStage('review'), proposal('done'));
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.nextTask.manualReviewRequired).toBe(false);
    }
  });

  it('review -> done with the flag explicitly false leaves it false', () => {
    const outcome = proposeTransition(
      taskAtStage('review'),
      proposal('done', { manualReviewRequired: false }),
    );
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.nextTask.manualReviewRequired).toBe(false);
    }
  });

  it('the flag is IGNORED on every accepted transition whose target is not done', () => {
    const nonDoneLegalEdges = LEGAL_EDGES.filter(([, toStage]) => toStage !== 'done');
    expect(nonDoneLegalEdges.length).toBeGreaterThan(0);

    for (const [fromStage, toStage] of nonDoneLegalEdges) {
      const outcome = proposeTransition(
        taskAtStage(fromStage),
        proposal(toStage, { manualReviewRequired: true }),
      );
      expect(outcome.accepted).toBe(true);
      if (outcome.accepted) {
        expect(outcome.nextTask.manualReviewRequired).toBe(false);
      }
    }
  });
});

// ── assertion 7 ──────────────────────────────────────────────────────────────
describe('assertion 7 — purity and immutability (rule 0.3)', () => {
  it('never mutates the input TaskRecord on an accepted transition', () => {
    const task = Object.freeze(taskAtStage('implementing'));
    const before = JSON.parse(JSON.stringify(task));

    const outcome = proposeTransition(task, proposal('review'));

    expect(outcome.accepted).toBe(true);
    expect(JSON.parse(JSON.stringify(task))).toEqual(before);
    expect(task.stage).toBe('implementing');
    if (outcome.accepted) {
      // A NEW object, not the input with a field swapped.
      expect(outcome.nextTask).not.toBe(task);
      expect(outcome.nextTask.stage).toBe('review');
    }
  });

  it('never mutates the input TaskRecord on a rejected proposal', () => {
    const task = Object.freeze(taskAtStage('backlog'));
    const before = JSON.parse(JSON.stringify(task));

    expect(proposeTransition(task, proposal('done')).accepted).toBe(false);
    expect(JSON.parse(JSON.stringify(task))).toEqual(before);
  });

  it('carries every non-stage field through unchanged', () => {
    const task = taskAtStage('plan-ready', {
      taskId: 'task-carry',
      isolation: 'shared-dir',
      gates: { requireHeadroom: { meterId: 'weekly', pct: 20 } },
      sessionRefs: [{ stage: 'planning', appSessionId: 'app-7' }],
      createdBy: 'orchestrator',
      lastHeartbeatAt: '2026-07-22T00:00:00.000Z',
      staleRetries: 2,
    });
    const outcome = proposeTransition(task, proposal('implementing'));

    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.nextTask).toEqual({ ...task, stage: 'implementing' });
      expect(taskRecordSchema.safeParse(outcome.nextTask).success).toBe(true);
    }
  });

  it('is deterministic — identical inputs give identical outputs, every edge', () => {
    for (const [fromStage, toStage] of ALL_EDGES) {
      const firstRun = proposeTransition(taskAtStage(fromStage), proposal(toStage));
      const secondRun = proposeTransition(taskAtStage(fromStage), proposal(toStage));
      expect(firstRun).toEqual(secondRun);
    }
  });
});

// ── assertion 8 ──────────────────────────────────────────────────────────────
describe('assertion 8 — review -> implementing is the fix loop', () => {
  it('is accepted: a rejected review sends work BACK, it does not fail the task', () => {
    const outcome = proposeTransition(taskAtStage('review'), proposal('implementing'));
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.nextTask.stage).toBe('implementing');
      expect(outcome.nextTask.manualReviewRequired).toBe(false);
    }
  });

  it('the loop can run repeatedly (implementing -> review -> implementing)', () => {
    let task = taskAtStage('implementing');
    for (let loopIndex = 0; loopIndex < 3; loopIndex += 1) {
      const toReview = proposeTransition(task, proposal('review'));
      expect(toReview.accepted).toBe(true);
      if (!toReview.accepted) return;
      const backToImplementing = proposeTransition(toReview.nextTask, proposal('implementing'));
      expect(backToImplementing.accepted).toBe(true);
      if (!backToImplementing.accepted) return;
      task = backToImplementing.nextTask;
    }
    expect(task.stage).toBe('implementing');
  });
});

// ── the defensive refusal ────────────────────────────────────────────────────
describe('unknown-stage — the defensive refusal (slice 7 hardens this)', () => {
  it('rejects a proposed stage outside the enum without throwing', () => {
    const hostileProposal = { toStage: 'shipped-it' as TaskStage, proposedBy: 'orchestrator' as const };
    const outcome = proposeTransition(taskAtStage('review'), hostileProposal);
    expect(outcome).toEqual({ accepted: false, reason: 'unknown-stage' });
  });

  it('rejects a task whose own stage is outside the enum without throwing', () => {
    const corruptTask = { ...taskAtStage('review'), stage: 'limbo' as TaskStage };
    const outcome = proposeTransition(corruptTask, proposal('done'));
    expect(outcome).toEqual({ accepted: false, reason: 'unknown-stage' });
  });
});

// ── assertion 9 ──────────────────────────────────────────────────────────────
describe('assertion 9 — the task event constructors validate against their schemas', () => {
  it('task_created carries the birth record on the tasks stream', () => {
    const input = taskCreated({
      taskId: 'task-1',
      projectRoot: '/home/wes/projects/vimes',
      createdBy: 'human',
      // D32: worktree is the pinned default isolation.
      isolation: 'worktree',
      stage: INITIAL_TASK_STAGE,
    });
    expect(input.stream).toBe('tasks');
    expect(input.type).toBe(EVENT_TYPES.taskCreated);
    expect(taskCreatedPayloadSchema.safeParse(input.payload).success).toBe(true);
    expect(EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.taskCreated].safeParse(input.payload).success).toBe(
      true,
    );
  });

  it('task_transitioned records a real ACCEPTED transition end to end', () => {
    const task = taskAtStage('review');
    const outcome = proposeTransition(
      task,
      proposal('done', { manualReviewRequired: true, proposedBy: 'human', note: 'handing off' }),
    );
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;

    const input = taskTransitioned({
      taskId: task.taskId,
      fromStage: task.stage,
      toStage: outcome.nextTask.stage,
      manualReviewRequired: outcome.nextTask.manualReviewRequired,
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

  // I7's record: every rejection the machine can produce must be EVENTABLE.
  it('task_transition_rejected carries a REAL rejection reason, for every reason', () => {
    const realRejections: Array<[TaskStage, TaskStage]> = [
      ['backlog', 'done'], // illegal-edge
      ['done', 'planning'], // terminal-stage
      ['backlog', 'backlog'], // same-stage
      ['quarantined', 'done'], // quarantined-cannot-complete
    ];
    const observedReasons = new Set<string>();

    for (const [fromStage, toStage] of realRejections) {
      const outcome = proposeTransition(taskAtStage(fromStage), proposal(toStage));
      expect(outcome.accepted).toBe(false);
      if (outcome.accepted) continue;
      observedReasons.add(outcome.reason);

      const input = taskTransitionRejected({
        taskId: 'task-1',
        fromStage,
        attemptedToStage: toStage,
        reason: outcome.reason,
        proposedBy: 'orchestrator',
      });
      expect(input.stream).toBe('tasks');
      expect(input.type).toBe(EVENT_TYPES.taskTransitionRejected);
      expect(taskTransitionRejectedPayloadSchema.safeParse(input.payload).success).toBe(true);
      expect(
        EVENT_PAYLOAD_SCHEMAS[EVENT_TYPES.taskTransitionRejected].safeParse(input.payload).success,
      ).toBe(true);
    }

    expect([...observedReasons].sort()).toEqual([
      'illegal-edge',
      'quarantined-cannot-complete',
      'same-stage',
      'terminal-stage',
    ]);
  });

  // The reason `unknown-stage` exists is hostile/malformed input, and the whole
  // point of the event is to RECORD what was refused — so the rejected event's
  // stage fields must accept a value outside the enum. If this ever tightens to
  // the enum, an unknown-stage rejection becomes unrecordable and I7 fails
  // silently exactly where it matters most.
  it('task_transition_rejected can record an unknown-stage refusal verbatim', () => {
    const outcome = proposeTransition(taskAtStage('review'), {
      toStage: 'shipped-it' as TaskStage,
      proposedBy: 'orchestrator',
    });
    expect(outcome).toEqual({ accepted: false, reason: 'unknown-stage' });
    if (outcome.accepted) return;

    const input = taskTransitionRejected({
      taskId: 'task-1',
      fromStage: 'review',
      attemptedToStage: 'shipped-it',
      reason: outcome.reason,
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
