import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TASK_STAGES,
  transitionProposedBySchema,
  type TransitionProposedBy,
} from '../tasks/taskStateMachine.js';
import { parseExtensionManifest, type ParsedWorkflow } from './manifest.js';
import { engineRefusalReasonSchema, proposeMove, type MoveDecision } from './proposeMove.js';

// ─── S12·U1 (D72 Move 3) — S12-A1, the parity proof ──────────────────────────
//
// slice-12.md: "the seam moves; the behavior does not." This file is the proof
// of the second half. S10-A2 proved the DECLARED EDGE SET equals the compiled
// one; this upgrades that promise to a BEHAVIORAL one: for the full cross
// product, the declaration-reading adjudicator reaches the same verdict — with
// the same reason string — as the compiled machine it replaced.
//
// ⚠ **THE REFERENCE MACHINE IS GONE; ITS BEHAVIOR IS FROZEN HERE (S12·U3).**
// U1 ran this comparison against the live compiled machine. U2 flipped the
// daemon onto the declaration, and U3 deleted the machine — so the reference is
// now `frozenReferenceOutcome` below: the deleted machine's five precedence
// rules and its edge set, written out as DATA, frozen at its deletion (D72
// Move 3, S12·U3, 2026-08-10). The behavioral pin OUTLIVES its subject, which is
// the same trick S12-A3 plays with the edge set in `manifest.test.ts`, and live
// end-to-end behavior is still guarded by the fixture replay (S12-A2).
//
// A red here is a FINDING about the declaration or the adjudicator. The frozen
// reference is never "updated to match" — that would delete the proof.
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

// ── THE FROZEN REFERENCE — the deleted machine, written out as data ──────────
//
// Provenance: the compiled table's image and the compiled machine's refusal
// precedence, frozen at their deletion (D72 Move 3, S12·U3, 2026-08-10). The
// edge set is byte-for-byte the same 34 pairs `manifest.test.ts` freezes; each
// test file carries its OWN copy on purpose, because a test importing another
// test's data is one source pretending to be two.

const FROZEN_REFERENCE_NODES: readonly string[] = [
  'backlog',
  'planning',
  'plan-ready',
  'implementing',
  'review',
  'done',
  'blocked-external',
  'quarantined',
  'cancelled',
];

const FROZEN_REFERENCE_EDGES: ReadonlySet<string> = new Set([
  'backlog -> planning',
  'backlog -> blocked-external',
  'backlog -> cancelled',
  'planning -> plan-ready',
  'planning -> blocked-external',
  'planning -> quarantined',
  'planning -> backlog',
  'planning -> cancelled',
  'plan-ready -> implementing',
  'plan-ready -> planning',
  'plan-ready -> blocked-external',
  'plan-ready -> backlog',
  'plan-ready -> cancelled',
  'implementing -> review',
  'implementing -> blocked-external',
  'implementing -> quarantined',
  'implementing -> cancelled',
  'review -> done',
  'review -> implementing',
  'review -> blocked-external',
  'review -> quarantined',
  'review -> cancelled',
  'blocked-external -> backlog',
  'blocked-external -> planning',
  'blocked-external -> plan-ready',
  'blocked-external -> implementing',
  'blocked-external -> review',
  'blocked-external -> cancelled',
  'quarantined -> backlog',
  'quarantined -> planning',
  'quarantined -> implementing',
  'quarantined -> blocked-external',
  'quarantined -> cancelled',
  // `done` contributes nothing — the terminal node had an EMPTY out-set, which
  // is exactly how rule 3 below recognises it.
  'cancelled -> backlog',
]);

/** The ONE named forbidden pair the deleted machine hardcoded. */
const FROZEN_FORBIDDEN_PAIR = { from: 'quarantined', to: 'done' } as const;

interface ReferenceOutcome {
  readonly accepted: boolean;
  readonly reason?: string;
}

/**
 * The deleted machine's decision, reimplemented over frozen data. THE ORDER OF
 * THE FIVE RULES IS THE LOAD-BEARING PART — it is the precedence the old
 * machine documented, and the reason the safety refusal reads as itself rather
 * than as a bland `illegal-edge`:
 *
 *   1. unknown node on either end   → `unknown-stage`
 *   2. same node (the `done -> done` tie-break lands here)  → `same-stage`
 *   3. a node with an EMPTY out-edge set  → `terminal-stage`
 *   4. the one named forbidden pair  → `quarantined-cannot-complete`
 *   5. the table  → accept, or `illegal-edge`
 */
function frozenReferenceOutcome(from: string, to: string): ReferenceOutcome {
  if (!FROZEN_REFERENCE_NODES.includes(from) || !FROZEN_REFERENCE_NODES.includes(to)) {
    return { accepted: false, reason: 'unknown-stage' };
  }
  if (from === to) {
    return { accepted: false, reason: 'same-stage' };
  }
  const hasAnyWayOut = [...FROZEN_REFERENCE_EDGES].some((edge) => edge.startsWith(`${from} -> `));
  if (!hasAnyWayOut) {
    return { accepted: false, reason: 'terminal-stage' };
  }
  if (from === FROZEN_FORBIDDEN_PAIR.from && to === FROZEN_FORBIDDEN_PAIR.to) {
    return { accepted: false, reason: 'quarantined-cannot-complete' };
  }
  if (!FROZEN_REFERENCE_EDGES.has(`${from} -> ${to}`)) {
    return { accepted: false, reason: 'illegal-edge' };
  }
  return { accepted: true, reason: undefined };
}

describe('S12-A1 setup — the frozen reference is the whole image, not a fragment', () => {
  it('carries all 34 pairs and the nine-node vocabulary the deleted machine knew', () => {
    expect(FROZEN_REFERENCE_EDGES.size).toBe(34);
    expect(FROZEN_REFERENCE_NODES).toHaveLength(9);
    // A tripwire, not a derivation: the frozen vocabulary matched the record
    // vocabulary on the day it was frozen. A stage added to the enum later
    // reddens HERE — where it can be reasoned about — rather than silently
    // widening a cross product the frozen reference cannot answer for.
    expect([...FROZEN_REFERENCE_NODES]).toEqual([...TASK_STAGES]);
  });
});

// ── S13·U1 — the ENGINE respelling, applied at the COMPARISON boundary ───────
//
// slice-13 F1 respells the engine's own refusals node-generic. The frozen
// reference above still speaks the DELETED MACHINE'S words, and it must: it is a
// record of what that machine said on the day it was deleted, and editing it
// would delete the proof (see the file banner). So the rename is declared HERE,
// as data, and applied to the REFERENCE side at comparison time. Parity is
// therefore still proven across the whole cross product — same verdict, same
// refusal, with exactly one deliberate, enumerated rename between the two
// vocabularies and no room for a second one to sneak through.
//
// ⚠ ONLY THE ENGINE'S OWN REASONS APPEAR IN THIS MAP.
// `quarantined-cannot-complete` is deliberately ABSENT: it is TENANT CONTENT off
// the declaration's forbidden row, so it keeps its exact spelling (F2) and
// compares unchanged. If someone ever "finishes the migration" by renaming it,
// the parity test reddens — which is the point.
const S13_ENGINE_RESPELLING: Readonly<Record<string, string>> = {
  'unknown-stage': 'unknown-node',
  'same-stage': 'same-node',
  'terminal-stage': 'terminal-node',
  // Already node-generic and UNCHANGED. Listed so the map is the WHOLE engine
  // vocabulary rather than a diff of it — which is what lets the membership
  // assertion below compare it against the enum.
  'illegal-edge': 'illegal-edge',
};

function respelledReferenceReason(referenceReason: string | undefined): string | undefined {
  if (referenceReason === undefined) return undefined;
  return S13_ENGINE_RESPELLING[referenceReason] ?? referenceReason;
}

// ── S13-A1 — the engine enum's exact membership ──────────────────────────────

describe('S13-A1 — the engine refusal enum is closed, node-spelled, and tenant-free', () => {
  it('contains EXACTLY the four node-spelled engine reasons', () => {
    // Exact membership, not a superset check: a fifth member would mean the
    // engine had started authoring a refusal it has no business owning, and a
    // missing one would mean a branch of the adjudicator lost its name.
    expect([...engineRefusalReasonSchema.options].sort()).toEqual([
      'illegal-edge',
      'same-node',
      'terminal-node',
      'unknown-node',
    ]);
  });

  it('contains no tenant string and no legacy spelling', () => {
    const engineReasons: readonly string[] = engineRefusalReasonSchema.options;
    // The tenant string that used to sit in the enum beside the engine's four.
    // It kept its spelling and changed CHANNEL (F2) — so its absence from HERE is
    // the whole S13·U1 split, stated as an assertion.
    expect(engineReasons).not.toContain('quarantined-cannot-complete');
    // No node name of any tenant, and no `-stage` spelling anywhere.
    for (const reason of engineReasons) {
      expect(reason).not.toContain('stage');
      for (const taskStage of TASK_STAGES) {
        expect(reason).not.toContain(taskStage);
      }
    }
  });

  it('is exactly the image of the S13 respelling map — no engine reason is unaccounted for', () => {
    // Ties the enum to the parity translation above: every engine reason the
    // deleted machine could produce maps to a member, and the map's image is the
    // enum entire. A new engine reason added without a map row (or vice versa)
    // reddens here rather than quietly weakening the parity proof.
    expect(new Set(Object.values(S13_ENGINE_RESPELLING))).toEqual(
      new Set(engineRefusalReasonSchema.options),
    );
    expect(Object.keys(S13_ENGINE_RESPELLING)).toHaveLength(
      engineRefusalReasonSchema.options.length,
    );
  });

  it('refuses a declared tenant string — the DECLARED channel is not this enum', () => {
    // The open channel is open precisely because this enum does not describe it.
    expect(engineRefusalReasonSchema.safeParse('quarantined-cannot-complete').success).toBe(false);
    expect(engineRefusalReasonSchema.safeParse('sealed-by-the-archivist').success).toBe(false);
  });
});

// ── S13-A1 — a DECLARED reason round-trips verbatim out of the adjudicator ───

describe('S13-A1 — a declared refusal reason the engine has never heard of', () => {
  // A string that appears nowhere in engine source, is not task-flavoured, and
  // could not be mistaken for a vocabulary entry someone forgot to add.
  const ALIEN_REASON = 'sealed-by-the-archivist';

  it('comes back out of the adjudicator byte-for-byte', () => {
    // The frozen fixture is READ-ONLY and is not touched: this declaration is
    // derived from it in memory, with one extra forbidden row on an edge the
    // fixture declares as LEGAL. Without the row the move is accepted, so the
    // refusal can only have come from the row.
    const workflowWithAlienForbiddenRow: ParsedWorkflow = {
      ...softwareWorkflow,
      forbidden: [
        ...softwareWorkflow.forbidden,
        { from: 'backlog', to: 'planning', reason: ALIEN_REASON },
      ],
    };

    expect(
      proposeMove('backlog', { toNode: 'planning', proposedBy: 'human' }, softwareWorkflow),
    ).toEqual({ accepted: true });
    expect(
      proposeMove(
        'backlog',
        { toNode: 'planning', proposedBy: 'human' },
        workflowWithAlienForbiddenRow,
      ),
    ).toEqual({ accepted: false, reason: ALIEN_REASON });
  });

  it('is not a member of the engine enum, and does not have to be', () => {
    expect(engineRefusalReasonSchema.options).not.toContain(ALIEN_REASON);
  });
});

// ── the cross product ────────────────────────────────────────────────────────

const PROPOSER_CLASSES: readonly TransitionProposedBy[] = transitionProposedBySchema.options;

/** Both machines flattened to the SAME comparable shape: verdict + reason. */
interface ComparableVerdict {
  readonly label: string;
  readonly accepted: boolean;
  readonly reason: string | undefined;
}

function reasonOf(decision: MoveDecision): string | undefined {
  return decision.accepted ? undefined : decision.reason;
}

describe('S12-A1 the parity proof — proposeMove(declaration) === the frozen reference', () => {
  it('agrees on EVERY (from, to, proposer) combination', () => {
    let comparisonCount = 0;

    for (const fromStage of TASK_STAGES) {
      for (const toStage of TASK_STAGES) {
        for (const proposedBy of PROPOSER_CLASSES) {
          const label = `${fromStage} -> ${toStage} by ${proposedBy}`;

          const reference = frozenReferenceOutcome(fromStage, toStage);
          const newDecision = proposeMove(
            fromStage,
            { toNode: toStage, proposedBy },
            softwareWorkflow,
          );

          const referenceVerdict: ComparableVerdict = {
            label,
            accepted: reference.accepted,
            // S13·U1: the reference's ENGINE words, respelled node-generic by the
            // enumerated map above. The declared reason passes through untouched.
            reason: respelledReferenceReason(reference.reason),
          };
          const newVerdict: ComparableVerdict = {
            label,
            accepted: newDecision.accepted,
            reason: reasonOf(newDecision),
          };

          // The label rides INSIDE the compared object so a red run names
          // the exact edge that disagreed rather than printing `false !== true`.
          expect(newVerdict).toEqual(referenceVerdict);
          comparisonCount += 1;
        }
      }
    }

    // A silently-short loop cannot fake green: 9 x 9 x 3.
    //
    // The convergence-flag axes the U1 form also swept (proposal flag x record
    // flag, 1458 comparisons) are gone with the machine that carried them: the
    // adjudicator returns a DECISION ONLY (F5) and never sees a flag. That rule
    // is pinned where it now lives — the four quadrants on
    // `nextTaskForAcceptedTransition` in `tasks/taskStateMachine.test.ts`.
    expect(comparisonCount).toBe(
      TASK_STAGES.length * TASK_STAGES.length * PROPOSER_CLASSES.length,
    );
    expect(comparisonCount).toBe(243);
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
  it('refuses `quarantined -> done` with the DECLARED reason — the deleted machine said the same', () => {
    const newDecision = proposeMove(
      'quarantined',
      { toNode: 'done', proposedBy: 'human' },
      softwareWorkflow,
    );

    expect(frozenReferenceOutcome('quarantined', 'done')).toEqual({
      accepted: false,
      reason: 'quarantined-cannot-complete',
    });
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

  it('resolves the terminal self-proposal as `same-node` (the tie-break)', () => {
    // The deleted machine called this `same-stage`; S13·U1 respells the ENGINE's
    // half of the vocabulary node-generic. The tie-break itself is untouched —
    // which is what the reference assertion below still proves.
    expect(frozenReferenceOutcome('done', 'done')).toEqual({
      accepted: false,
      reason: 'same-stage',
    });
    expect(proposeMove('done', { toNode: 'done', proposedBy: 'human' }, softwareWorkflow)).toEqual({
      accepted: false,
      reason: 'same-node',
    });
  });

  it('refuses `done -> backlog` as `terminal-node`, the deleted machine reason respelled', () => {
    expect(frozenReferenceOutcome('done', 'backlog')).toEqual({
      accepted: false,
      reason: 'terminal-stage',
    });
    expect(
      proposeMove('done', { toNode: 'backlog', proposedBy: 'human' }, softwareWorkflow),
    ).toEqual({ accepted: false, reason: 'terminal-node' });
    // The derivation that produces it: `done` declares no way out.
    expect(softwareWorkflow.edges.some((edge) => edge.from === 'done')).toBe(false);
  });

  it('ACCEPTS `cancelled -> backlog` — the empty-out-set derivation does not misfire', () => {
    expect(frozenReferenceOutcome('cancelled', 'backlog').accepted).toBe(true);
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

  it('refuses `unknown-node` from either end, the deleted machine reason respelled', () => {
    const cases: readonly { from: string; to: string }[] = [
      { from: NONSENSE, to: 'backlog' },
      { from: 'backlog', to: NONSENSE },
      { from: NONSENSE, to: NONSENSE },
    ];
    for (const testCase of cases) {
      const newDecision = proposeMove(
        testCase.from,
        { toNode: testCase.to, proposedBy: 'human' },
        softwareWorkflow,
      );
      expect(frozenReferenceOutcome(testCase.from, testCase.to)).toEqual({
        accepted: false,
        reason: 'unknown-stage',
      });
      // S13·U1: same refusal, engine-generic spelling.
      expect(newDecision).toEqual({ accepted: false, reason: 'unknown-node' });
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

  it('`backlog -> manual-review`: the deleted machine said unknown-stage, the live one says illegal-edge', () => {
    // The deleted machine's vocabulary WAS the compiled table, so the tenth node
    // was an unknown word to it. The live one knows the word and finds no edge.
    expect(frozenReferenceOutcome('backlog', TENTH_NODE)).toEqual({
      accepted: false,
      reason: 'unknown-stage',
    });
    expect(
      proposeMove('backlog', { toNode: TENTH_NODE, proposedBy: 'human' }, softwareWorkflow),
    ).toEqual({ accepted: false, reason: 'illegal-edge' });
  });

  it('`manual-review -> done`: the deleted machine said unknown-stage, the live one accepts (the declared table says so)', () => {
    expect(frozenReferenceOutcome(TENTH_NODE, 'done')).toEqual({
      accepted: false,
      reason: 'unknown-stage',
    });
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
          reason: 'unknown-node',
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
