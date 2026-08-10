import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaskRecord, TaskStage } from '../schemas.js';
import { taskRecordSchema } from '../schemas.js';
import {
  TASK_STAGES,
  proposeTransition,
  transitionProposedBySchema,
  type TransitionProposedBy,
} from '../tasks/taskStateMachine.js';
import { parseExtensionManifest, type ParsedWorkflow } from './manifest.js';
import { proposeMove, type MoveDecision } from './proposeMove.js';

// ─── S12·U1 (D72 Move 3) — S12-A1, the parity proof ──────────────────────────
//
// slice-12.md: "the seam moves; the behavior does not." This file is the proof
// of the second half, run at the moment it is cheapest — with the old machine
// still standing as the reference. S10-A2 proved the DECLARED EDGE SET equals
// the compiled one; this upgrades that promise to a BEHAVIORAL one: for the
// full cross product, the declaration-reading adjudicator and the compiled-table
// machine reach the same verdict, with the same reason string.
//
// ⚠ The fixture manifest is FROZEN and READ-ONLY. This file reads it; nothing
// here ever writes it.

// packages/core/src/extensions/ -> src/ -> core/ -> packages/ -> repo root.
const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../fixtures/extensions/vimes-tasks/vimes-extension.toml', import.meta.url),
);

const ADJUDICATOR_SOURCE_PATH = fileURLToPath(new URL('./proposeMove.ts', import.meta.url));

function resolveSoftwareWorkflow(): ParsedWorkflow {
  const result = parseExtensionManifest(readFileSync(FIXTURE_PATH, 'utf8'));
  if (!result.ok) {
    throw new Error(`the frozen fixture must parse; got ${JSON.stringify(result.errors, null, 2)}`);
  }
  const workflow = result.manifest.workflows.find((candidate) => candidate.id === 'software');
  if (workflow === undefined) {
    throw new Error('the frozen fixture must declare the `software` workflow');
  }
  return workflow;
}

const softwareWorkflow = resolveSoftwareWorkflow();

describe('S12-A1 setup — the declaration resolves before anything is compared', () => {
  it('parses the frozen fixture and resolves the `software` workflow', () => {
    expect(softwareWorkflow.id).toBe('software');
    expect(softwareWorkflow.nodes.length).toBeGreaterThan(0);
    expect(softwareWorkflow.edges.length).toBeGreaterThan(0);
  });
});

// ── the minimal valid record the old machine needs ───────────────────────────
//
// The old machine takes a whole `TaskRecord`; the new one takes a node id. So
// the parity harness builds the smallest record `taskRecordSchema` accepts —
// and VALIDATES it, so a schema widening cannot quietly turn this harness into
// a comparison of two rejections of a malformed input.

function buildMinimalRecord(stage: TaskStage, manualReviewRequired: boolean): TaskRecord {
  return {
    taskId: 'parity-fixture-task',
    projectRoot: '/parity/fixture',
    stage,
    manualReviewRequired,
    isolation: 'shared-dir',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
  };
}

describe('S12-A1 setup — the harness record is a VALID record', () => {
  it('validates against `taskRecordSchema`', () => {
    for (const stage of TASK_STAGES) {
      for (const manualReviewRequired of [true, false]) {
        expect(() => taskRecordSchema.parse(buildMinimalRecord(stage, manualReviewRequired))).not.toThrow();
      }
    }
  });
});

// ── the cross product ────────────────────────────────────────────────────────

const PROPOSER_CLASSES: readonly TransitionProposedBy[] = transitionProposedBySchema.options;
const PROPOSAL_FLAG_STATES: readonly (boolean | undefined)[] = [true, false, undefined];
const RECORD_FLAG_STATES: readonly boolean[] = [true, false];

/** Both machines flattened to the SAME comparable shape: verdict + reason. */
interface ComparableVerdict {
  readonly label: string;
  readonly accepted: boolean;
  readonly reason: string | undefined;
}

function reasonOf(decision: MoveDecision): string | undefined {
  return decision.accepted ? undefined : decision.reason;
}

describe('S12-A1 the parity proof — proposeMove(declaration) === proposeTransition(table)', () => {
  it('agrees on EVERY (from, to, proposer, proposal flag, record flag) combination', () => {
    let comparisonCount = 0;

    for (const fromStage of TASK_STAGES) {
      for (const toStage of TASK_STAGES) {
        for (const proposedBy of PROPOSER_CLASSES) {
          for (const proposalFlag of PROPOSAL_FLAG_STATES) {
            for (const recordFlag of RECORD_FLAG_STATES) {
              const label = `${fromStage} -> ${toStage} by ${proposedBy} (proposal flag ${String(proposalFlag)}, record flag ${String(recordFlag)})`;

              const oldOutcome = proposeTransition(buildMinimalRecord(fromStage, recordFlag), {
                toStage,
                proposedBy,
                manualReviewRequired: proposalFlag,
              });
              const newDecision = proposeMove(
                fromStage,
                { toNode: toStage, proposedBy },
                softwareWorkflow,
              );

              const oldVerdict: ComparableVerdict = {
                label,
                accepted: oldOutcome.accepted,
                reason: oldOutcome.accepted ? undefined : oldOutcome.reason,
              };
              const newVerdict: ComparableVerdict = {
                label,
                accepted: newDecision.accepted,
                reason: reasonOf(newDecision),
              };

              // The label rides INSIDE the compared object so a red run names
              // the exact edge that disagreed rather than printing `false !== true`.
              expect(newVerdict).toEqual(oldVerdict);
              comparisonCount += 1;
            }
          }
        }
      }
    }

    // A silently-short loop cannot fake green: 9 x 9 x 3 x 3 x 2.
    expect(comparisonCount).toBe(
      TASK_STAGES.length *
        TASK_STAGES.length *
        PROPOSER_CLASSES.length *
        PROPOSAL_FLAG_STATES.length *
        RECORD_FLAG_STATES.length,
    );
    expect(comparisonCount).toBe(1458);
  });

  it('enumerates the vocabularies it claims to enumerate', () => {
    // The loop bounds are themselves assertable: a stage added to the enum
    // enters the coverage automatically, and a stage silently REMOVED reddens
    // here rather than shrinking the cross product unnoticed.
    expect(TASK_STAGES).toHaveLength(9);
    expect(PROPOSER_CLASSES).toEqual(['human', 'orchestrator', 'dispatcher']);
  });
});

// ── the named refusals, pinned individually (belt over the cross product) ────

describe('S12-A1 belt — the named refusals, pinned one by one', () => {
  it('refuses `quarantined -> done` with the DECLARED reason, in both machines', () => {
    const oldOutcome = proposeTransition(buildMinimalRecord('quarantined', false), {
      toStage: 'done',
      proposedBy: 'human',
    });
    const newDecision = proposeMove(
      'quarantined',
      { toNode: 'done', proposedBy: 'human' },
      softwareWorkflow,
    );

    expect(oldOutcome).toEqual({ accepted: false, reason: 'quarantined-cannot-complete' });
    expect(newDecision).toEqual({ accepted: false, reason: 'quarantined-cannot-complete' });

    // …and in the NEW machine the reason arrived as DATA, off the forbidden
    // row, not off a hardcoded engine branch. node-kit §1.4.4 is why `forbidden`
    // exists at all, so the provenance is the assertion, not a detail.
    expect(softwareWorkflow.forbidden).toContainEqual({
      from: 'quarantined',
      to: 'done',
      reason: 'quarantined-cannot-complete',
    });
    // The row is genuinely absent from the legality table, not merely shadowed —
    // so step 5 alone would already have refused, just with the wrong reason.
    expect(
      softwareWorkflow.edges.some((edge) => edge.from === 'quarantined' && edge.to === 'done'),
    ).toBe(false);
  });

  it('resolves the terminal self-proposal as `same-stage` (the tie-break)', () => {
    const oldOutcome = proposeTransition(buildMinimalRecord('done', false), {
      toStage: 'done',
      proposedBy: 'human',
    });
    expect(oldOutcome).toEqual({ accepted: false, reason: 'same-stage' });
    expect(proposeMove('done', { toNode: 'done', proposedBy: 'human' }, softwareWorkflow)).toEqual({
      accepted: false,
      reason: 'same-stage',
    });
  });

  it('refuses `done -> backlog` as `terminal-stage` in both machines', () => {
    const oldOutcome = proposeTransition(buildMinimalRecord('done', false), {
      toStage: 'backlog',
      proposedBy: 'human',
    });
    expect(oldOutcome).toEqual({ accepted: false, reason: 'terminal-stage' });
    expect(
      proposeMove('done', { toNode: 'backlog', proposedBy: 'human' }, softwareWorkflow),
    ).toEqual({ accepted: false, reason: 'terminal-stage' });
    // The derivation that produces it: `done` declares no way out.
    expect(softwareWorkflow.edges.some((edge) => edge.from === 'done')).toBe(false);
  });

  it('ACCEPTS `cancelled -> backlog` in both machines — the empty-out-set derivation does not misfire', () => {
    const oldOutcome = proposeTransition(buildMinimalRecord('cancelled', false), {
      toStage: 'backlog',
      proposedBy: 'human',
    });
    expect(oldOutcome.accepted).toBe(true);
    expect(
      proposeMove('cancelled', { toNode: 'backlog', proposedBy: 'human' }, softwareWorkflow),
    ).toEqual({ accepted: true });
    // `cancelled` is a give-up that can be undone: it HAS a declared way out,
    // which is exactly what separates it from a terminal node.
    expect(softwareWorkflow.edges.some((edge) => edge.from === 'cancelled')).toBe(true);
  });
});

// ── unknown vocabulary ───────────────────────────────────────────────────────

describe('S12-A1 belt — an id outside the vocabulary refuses identically', () => {
  const NONSENSE = 'no-such-node';

  it('refuses `unknown-stage` from either end, in both machines', () => {
    // The old machine widens its stage params to `string` internally precisely
    // so a value outside the enum can physically reach the defensive check; the
    // cast at the call boundary is how its own tests reach it.
    const cases: readonly { from: string; to: string }[] = [
      { from: NONSENSE, to: 'backlog' },
      { from: 'backlog', to: NONSENSE },
      { from: NONSENSE, to: NONSENSE },
    ];
    for (const testCase of cases) {
      const oldOutcome = proposeTransition(
        buildMinimalRecord(testCase.from as TaskStage, false),
        { toStage: testCase.to as TaskStage, proposedBy: 'human' },
      );
      const newDecision = proposeMove(
        testCase.from,
        { toNode: testCase.to, proposedBy: 'human' },
        softwareWorkflow,
      );
      expect(oldOutcome).toEqual({ accepted: false, reason: 'unknown-stage' });
      expect(newDecision).toEqual({ accepted: false, reason: 'unknown-stage' });
    }
  });
});

// ── the two DOCUMENTED divergences (knowledge pins, not parity failures) ─────
//
// slice-12.md, "Explicitly OUT: Node-vocabulary relaxation — the record/event
// schemas keep the 9-stage enum (`taskStageSchema`); `manual-review` remains
// unreachable upstream of the adjudicator by schema fencing, which is exactly
// what keeps this slice behavior-identical."
//
// So the declaration has a TENTH node the record vocabulary cannot name. Both
// cases below are unreachable in production — no record can carry the tenth
// value while `taskStageSchema` fences the vocabulary — and both are pinned
// here as KNOWLEDGE, so the day the fence is relaxed these reddening tests are
// the ones that say what changed.

describe('the two documented divergences — the tenth node the record cannot reach', () => {
  const TENTH_NODE = 'manual-review';

  it('declares the tenth node with out-edges and NO in-edges', () => {
    expect(softwareWorkflow.nodes.some((node) => node.id === TENTH_NODE)).toBe(true);
    expect(softwareWorkflow.edges.some((edge) => edge.to === TENTH_NODE)).toBe(false);
    expect(softwareWorkflow.edges.some((edge) => edge.from === TENTH_NODE)).toBe(true);
  });

  it('`backlog -> manual-review`: OLD says unknown-stage, NEW says illegal-edge', () => {
    // The old machine's vocabulary IS the compiled table, so the tenth node is
    // an unknown word. The new machine knows the word and finds no edge.
    const oldOutcome = proposeTransition(buildMinimalRecord('backlog', false), {
      toStage: TENTH_NODE as TaskStage,
      proposedBy: 'human',
    });
    expect(oldOutcome).toEqual({ accepted: false, reason: 'unknown-stage' });
    expect(
      proposeMove('backlog', { toNode: TENTH_NODE, proposedBy: 'human' }, softwareWorkflow),
    ).toEqual({ accepted: false, reason: 'illegal-edge' });
  });

  it('`manual-review -> done`: OLD says unknown-stage, NEW accepts (the declared table says so)', () => {
    const oldOutcome = proposeTransition(buildMinimalRecord(TENTH_NODE as TaskStage, false), {
      toStage: 'done',
      proposedBy: 'human',
    });
    expect(oldOutcome).toEqual({ accepted: false, reason: 'unknown-stage' });
    expect(
      proposeMove(TENTH_NODE, { toNode: 'done', proposedBy: 'human' }, softwareWorkflow),
    ).toEqual({ accepted: true });
    // Unreachable in production: the record vocabulary cannot hold the value,
    // so nothing can be sitting on this node to make the proposal.
    expect(TASK_STAGES).not.toContain(TENTH_NODE);
  });
});

// ── principle #16, executable ────────────────────────────────────────────────

describe('principle #16 — the adjudicator source contains no tenant word', () => {
  const TENANT_WORDS: readonly string[] = [
    'backlog',
    'planning',
    'plan-ready',
    'implementing',
    'review',
    'blocked-external',
    'quarantined',
    'done',
    'cancelled',
    'manual-review',
  ];

  it('greps clean', () => {
    // node-kit §1.10 states the assertable form of #16 as a grep of the engine's
    // source. This is that grep, aimed at the one file this unit adds — the
    // whole file, prose included, so the gate stays trivially clean.
    const source = readFileSync(ADJUDICATOR_SOURCE_PATH, 'utf8');
    const offenders = TENANT_WORDS.filter((word) => source.includes(word));
    expect(offenders).toEqual([]);
  });
});

// ── purity, totality, and F5's no-payload rule ───────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

describe('the adjudicator is pure, total, and decision-only', () => {
  it('is deterministic: identical calls yield deeply-equal decisions', () => {
    for (const fromStage of TASK_STAGES) {
      for (const toStage of TASK_STAGES) {
        const first = proposeMove(fromStage, { toNode: toStage, proposedBy: 'human' }, softwareWorkflow);
        const second = proposeMove(fromStage, { toNode: toStage, proposedBy: 'human' }, softwareWorkflow);
        expect(first).toEqual(second);
      }
    }
  });

  it('mutates nothing: a DEEP-FROZEN declaration survives a full cross-product run unchanged', () => {
    const frozenWorkflow = deepFreeze(resolveSoftwareWorkflow());
    const before = structuredClone(frozenWorkflow);
    for (const fromStage of TASK_STAGES) {
      for (const toStage of TASK_STAGES) {
        for (const proposedBy of PROPOSER_CLASSES) {
          // A frozen object would throw on write in module scope (ESM is
          // strict), so this run is a mutation detector as well as a comparison.
          expect(() =>
            proposeMove(fromStage, { toNode: toStage, proposedBy }, frozenWorkflow),
          ).not.toThrow();
        }
      }
    }
    expect(frozenWorkflow).toEqual(before);
  });

  it('never throws, on any input — a refusal is a normal outcome', () => {
    const emptyWorkflow: ParsedWorkflow = {
      id: 'empty',
      title: 'Empty',
      initial: 'nowhere',
      nodes: [],
      edges: [],
      forbidden: [],
    };
    const hostileValues = ['', ' ', '\u0000', '__proto__', 'constructor', 'no-such-node'];
    for (const from of hostileValues) {
      for (const to of hostileValues) {
        expect(() => proposeMove(from, { toNode: to, proposedBy: '' }, emptyWorkflow)).not.toThrow();
        expect(proposeMove(from, { toNode: to, proposedBy: '' }, emptyWorkflow)).toEqual({
          accepted: false,
          reason: 'unknown-stage',
        });
        expect(() =>
          proposeMove(from, { toNode: to, proposedBy: 'nobody' }, softwareWorkflow),
        ).not.toThrow();
      }
    }
  });

  it('F5: an accepted decision carries ONLY `accepted` — no payload smuggling', () => {
    let acceptedCount = 0;
    for (const fromStage of TASK_STAGES) {
      for (const toStage of TASK_STAGES) {
        const decision = proposeMove(
          fromStage,
          { toNode: toStage, proposedBy: 'dispatcher' },
          softwareWorkflow,
        );
        if (!decision.accepted) continue;
        expect(Object.keys(decision)).toEqual(['accepted']);
        acceptedCount += 1;
      }
    }
    // …and the assertion above actually ran on something.
    expect(acceptedCount).toBeGreaterThan(0);
  });

  it('ignores `proposedBy` entirely this slice (the allow-list is explicitly out)', () => {
    // Every declared edge names its `by` list; none of it is consulted yet, so
    // the decision must not move when the proposer class does. The day the
    // allow-list activates, THIS test is the one that reddens and says so.
    for (const fromStage of TASK_STAGES) {
      for (const toStage of TASK_STAGES) {
        const decisions = [...PROPOSER_CLASSES, 'watchdog', 'extension', ''].map((proposedBy) =>
          proposeMove(fromStage, { toNode: toStage, proposedBy }, softwareWorkflow),
        );
        for (const decision of decisions) expect(decision).toEqual(decisions[0]);
      }
    }
  });
});
