import { describe, expect, it } from 'vitest';
import { deriveReviewOutcome } from '../tasks/reviewOutcome.js';
import type { ReportReviewPayload } from '../tasks/workOrder.js';
import {
  ENGINE_REPORT_TOOL_IDS,
  ENGINE_REPORT_TOOL_NAMES,
  ENGINE_REPORT_TOOL_SERVER,
  ENGINE_REPORT_VERB_BODIES,
  isEngineKnownToolId,
} from './reportVerbs.js';
import { evaluateAcceptance, type AcceptanceEvaluation } from './acceptance.js';
import type { ParsedAcceptance } from './manifest.js';

// ─── S20·U1 — the acceptance evaluator's assertions (slice-20 A2 / A4) ───────
//
// Two halves, and they are different KINDS of claim:
//
//   • the EQUIVALENCE suite — the declared rubric arm and the compiled
//     `deriveReviewOutcome` are the same function under the shipped declaration
//     values. It feeds A2 (the U2 differential) and is written so that U3's
//     re-point is ONE EDIT: one case table, driven through both paths.
//   • the PURE CELLS — rest, dormancy, inertness and unevaluability (A4), each
//     with its positive control beside its negative one. The house rule the
//     whole file obeys: assert ABSENCE as well as presence; one probe is not a
//     refutation.
//
// Everything here calls a pure function directly. No daemon, no clock, no IO.

// ── the shipped declaration, as data ────────────────────────────────────────
//
// Byte-for-byte the `[workflows.nodes.acceptance]` table on the `review` node of
// `packages/daemon/extensions/vimes-tasks/vimes-extension.toml` (:300–307). The
// equivalence claim is only interesting under the values that actually ship.
const REVIEW_VERB = 'vimes_report.report_review';
const COMPLETION_VERB = 'vimes_report.report_completion';

const SHIPPED_REVIEW_RUBRIC: ParsedAcceptance = {
  kind: 'rubric',
  report: REVIEW_VERB,
  criteriaFrom: 'instance.acceptanceCriteria',
  coverage: 'all-criteria-pass',
  unlistedIds: 'ignore',
  onPass: 'done',
  onFail: 'implementing',
};

type ReportedCriteria = ReportReviewPayload['criteria'];

function pass(criterionId: string): ReportedCriteria[number] {
  return { criterionId, verdict: 'pass' };
}
function fail(criterionId: string): ReportedCriteria[number] {
  return { criterionId, verdict: 'fail' };
}

function reviewEvidence(criteria: ReportedCriteria, verbId: string = REVIEW_VERB) {
  return { kind: 'report', verbId, criteria } as const;
}

/** The routed target, or a marker for the two non-routing answers. */
function routedTo(evaluation: AcceptanceEvaluation): string {
  if (evaluation.outcome === 'route') return evaluation.toNode;
  if (evaluation.outcome === 'rest') return '<rest>';
  return `<unevaluable:${evaluation.reason}>`;
}

// ── A2 — THE EQUIVALENCE SUITE ──────────────────────────────────────────────
//
// ⚠ **ONE CASE TABLE, TWO IMPLEMENTATIONS.** `deriveReviewOutcome` returns the
// STAGE LITERALS the dispatcher compiled in; the evaluator returns whatever the
// declaration named. Under the shipped table those are the same two node ids, so
// the comparison is direct — which is exactly the claim slice-20 §3.2 makes
// ("row-for-row under the declared vocabulary").
//
// At the U3 flip `deriveReviewOutcome` DELETES and this suite re-points at the
// evaluator alone — one edit, because the compiled call appears in exactly one
// place below.
const EQUIVALENCE_CASES: readonly {
  readonly name: string;
  readonly reported: ReportedCriteria;
  readonly instanceCriterionIds: readonly string[];
}[] = [
  {
    name: 'any-fail — one explicit fail sends it back regardless of the passes beside it',
    reported: [pass('c1'), fail('c2'), pass('c3')],
    instanceCriterionIds: ['c1', 'c2', 'c3'],
  },
  {
    name: 'coverage-miss — every reported verdict passes, but a criterion went unmentioned',
    reported: [pass('c1')],
    instanceCriterionIds: ['c1', 'c2'],
  },
  {
    name: 'all-pass — every instance criterion covered by a pass',
    reported: [pass('c1'), pass('c2')],
    instanceCriterionIds: ['c1', 'c2'],
  },
  {
    name: 'extra-id-ignored — an id off the list neither blocks nor forces the pass (A-17)',
    reported: [pass('c1'), pass('c2'), pass('not-on-the-list')],
    instanceCriterionIds: ['c1', 'c2'],
  },
  {
    name: 'bare-task — an empty criterion list is vacuously covered',
    reported: [],
    instanceCriterionIds: [],
  },
];

describe('S20-A2 equivalence — the declared rubric arm IS `deriveReviewOutcome`', () => {
  it.each(EQUIVALENCE_CASES)('routes identically — $name', (testCase) => {
    // The COMPILED path (deletes at U3; this is its one call site here).
    const compiled = deriveReviewOutcome(testCase.reported, testCase.instanceCriterionIds);
    // The DECLARED path.
    const declared = evaluateAcceptance(
      SHIPPED_REVIEW_RUBRIC,
      reviewEvidence(testCase.reported),
      { instanceCriterionIds: testCase.instanceCriterionIds },
    );
    expect(declared.outcome).toBe('route');
    expect(routedTo(declared)).toBe(compiled);
  });

  // Verify-by-breaking: if the table only ever produced ONE outcome, five
  // identical comparisons would pass while proving nothing about the rule.
  it('the case table really does exercise BOTH outcomes', () => {
    const compiledOutcomes = new Set(
      EQUIVALENCE_CASES.map((testCase) =>
        deriveReviewOutcome(testCase.reported, testCase.instanceCriterionIds),
      ),
    );
    expect([...compiledOutcomes].sort()).toEqual(['done', 'implementing']);
  });

  // …and the equivalence is not an artefact of both functions ignoring their
  // input: a rubric declaring DIFFERENT targets routes to those targets, which
  // is the property A3's perturbation rests on.
  it('the declaration GOVERNS the targets — perturbed targets route per the perturbation', () => {
    const perturbed: ParsedAcceptance = {
      ...SHIPPED_REVIEW_RUBRIC,
      onPass: 'plan-ready',
      onFail: 'backlog',
    };
    expect(
      evaluateAcceptance(perturbed, reviewEvidence([pass('c1')]), {
        instanceCriterionIds: ['c1'],
      }),
    ).toEqual({ outcome: 'route', toNode: 'plan-ready' });
    expect(
      evaluateAcceptance(perturbed, reviewEvidence([fail('c1')]), {
        instanceCriterionIds: ['c1'],
      }),
    ).toEqual({ outcome: 'route', toNode: 'backlog' });
  });
});

// ── A4 — REST: an unset target is no proposal, never a default one ──────────

describe('S20-A4 rest — an UNSET target proposes nothing (§3.4)', () => {
  it('unset `on_pass` on a PASSING rubric rests (and the set one routes — the control)', () => {
    const { onPass: _dropped, ...withoutOnPass } = SHIPPED_REVIEW_RUBRIC;
    const evidence = reviewEvidence([pass('c1')]);
    const context = { instanceCriterionIds: ['c1'] };

    expect(evaluateAcceptance(withoutOnPass, evidence, context)).toEqual({ outcome: 'rest' });
    // POSITIVE CONTROL — the same evidence against the same table WITH the
    // target routes, so "rest" above is the missing key and not a broken pass.
    expect(evaluateAcceptance(SHIPPED_REVIEW_RUBRIC, evidence, context)).toEqual({
      outcome: 'route',
      toNode: 'done',
    });
  });

  it('unset `on_fail` on a FAILING rubric rests (and the set one routes — the control)', () => {
    const { onFail: _dropped, ...withoutOnFail } = SHIPPED_REVIEW_RUBRIC;
    const evidence = reviewEvidence([fail('c1')]);
    const context = { instanceCriterionIds: ['c1'] };

    expect(evaluateAcceptance(withoutOnFail, evidence, context)).toEqual({ outcome: 'rest' });
    expect(evaluateAcceptance(SHIPPED_REVIEW_RUBRIC, evidence, context)).toEqual({
      outcome: 'route',
      toNode: 'implementing',
    });
    // …and the COVERAGE-MISS row of the same rubric rests too — both roads to
    // `on_fail` are closed by the one missing key, not just the explicit fail.
    expect(
      evaluateAcceptance(withoutOnFail, reviewEvidence([pass('c1')]), {
        instanceCriterionIds: ['c1', 'c2'],
      }),
    ).toEqual({ outcome: 'rest' });
  });

  it('unset `on_pass` on a `report` table rests', () => {
    const evidence = { kind: 'report', verbId: COMPLETION_VERB } as const;
    const context = { instanceCriterionIds: [] };
    expect(
      evaluateAcceptance({ kind: 'report', report: COMPLETION_VERB }, evidence, context),
    ).toEqual({ outcome: 'rest' });
    expect(
      evaluateAcceptance(
        { kind: 'report', report: COMPLETION_VERB, onPass: 'review' },
        evidence,
        context,
      ),
    ).toEqual({ outcome: 'route', toNode: 'review' });
  });
});

// ── §3.5 — the REPORT arm is EXISTENCE-ONLY ─────────────────────────────────

describe('S20 §3.5 — `kind = "report"` never reads the body', () => {
  const table: ParsedAcceptance = {
    kind: 'report',
    report: COMPLETION_VERB,
    onPass: 'review',
  };
  const context = { instanceCriterionIds: ['c1', 'c2'] };

  it('routes `on_pass` on existence alone — with no criteria, and with FAILING ones', () => {
    // No body detail at all.
    expect(
      evaluateAcceptance(table, { kind: 'report', verbId: COMPLETION_VERB }, context),
    ).toEqual({ outcome: 'route', toNode: 'review' });
    // ⚠ THE ASYMMETRY'S RUNTIME HALF: a criteria-carrying body full of FAILS,
    // and an instance whose criteria are entirely uncovered, still routes
    // `on_pass` — because existence is the whole test. If this ever routed
    // `on_fail`, `report` would have quietly become a rubric.
    expect(
      evaluateAcceptance(
        { ...table, onFail: 'implementing' },
        { kind: 'report', verbId: COMPLETION_VERB, criteria: [fail('c1'), fail('c2')] },
        context,
      ),
    ).toEqual({ outcome: 'route', toNode: 'review' });
  });

  it('a report of some OTHER verb is unevaluable, not a route (the negative control)', () => {
    expect(evaluateAcceptance(table, { kind: 'report', verbId: REVIEW_VERB }, context)).toEqual({
      outcome: 'unevaluable',
      reason: 'evidence-verb-mismatch',
    });
  });
});

// ── §3.6 — the ARTIFACT arm: capture-refs, REST on partial, inert `on_fail` ──

describe('S20 §3.6 — artifact acceptance is the CAPTURE-REF form', () => {
  const shippedPlanning: ParsedAcceptance = {
    kind: 'artifact',
    requires: ['capture:plan'],
    onPass: 'plan-ready',
  };
  const context = { instanceCriterionIds: [] };

  it('routes `on_pass` when every declared capture is recorded', () => {
    expect(
      evaluateAcceptance(shippedPlanning, { kind: 'captures', recorded: ['plan'] }, context),
    ).toEqual({ outcome: 'route', toNode: 'plan-ready' });
    // Extra recorded captures are not a problem — the test is "all required
    // present", never "exactly these".
    expect(
      evaluateAcceptance(
        shippedPlanning,
        { kind: 'captures', recorded: ['plan', 'something-else'] },
        context,
      ),
    ).toEqual({ outcome: 'route', toNode: 'plan-ready' });
  });

  it('RESTS on a partially satisfied capture list — absent evidence is not failure', () => {
    const twoCaptures: ParsedAcceptance = {
      kind: 'artifact',
      requires: ['capture:plan', 'capture:design'],
      onPass: 'plan-ready',
    };
    expect(
      evaluateAcceptance(twoCaptures, { kind: 'captures', recorded: ['plan'] }, context),
    ).toEqual({ outcome: 'rest' });
    expect(evaluateAcceptance(twoCaptures, { kind: 'captures', recorded: [] }, context)).toEqual({
      outcome: 'rest',
    });
    // POSITIVE CONTROL — the same table with BOTH recorded routes, so the rests
    // above are the missing capture and not a broken arm.
    expect(
      evaluateAcceptance(twoCaptures, { kind: 'captures', recorded: ['plan', 'design'] }, context),
    ).toEqual({ outcome: 'route', toNode: 'plan-ready' });
  });

  it('a declared `on_fail` on an artifact table is LEGAL BUT INERT (§3.6, stated not undefined)', () => {
    // Nothing in this engine produces NEGATIVE existence evidence, so no
    // evidence shape can reach `on_fail`. Drive every shape there is and assert
    // the ABSENCE: `deadEnd` is never routed to.
    const withDeadEnd: ParsedAcceptance = {
      kind: 'artifact',
      requires: ['capture:plan', 'capture:design'],
      onPass: 'plan-ready',
      onFail: 'deadEnd',
    };
    const everyCaptureShape: readonly string[][] = [[], ['plan'], ['design'], ['unrelated']];
    for (const recorded of everyCaptureShape) {
      const evaluation = evaluateAcceptance(withDeadEnd, { kind: 'captures', recorded }, context);
      expect(evaluation).toEqual({ outcome: 'rest' });
      expect(routedTo(evaluation)).not.toBe('deadEnd');
    }
    // POSITIVE CONTROL that `deadEnd` is a reachable-looking target at all: the
    // SAME id on a rubric's `on_fail` does route, so the inertness above is a
    // property of the artifact KIND and not of the string.
    expect(
      evaluateAcceptance(
        { ...SHIPPED_REVIEW_RUBRIC, onFail: 'deadEnd' },
        reviewEvidence([fail('c1')]),
        { instanceCriterionIds: ['c1'] },
      ),
    ).toEqual({ outcome: 'route', toNode: 'deadEnd' });
  });

  it('ANY path-form `requires` entry is unevaluable — no probe exists (§3.6)', () => {
    const pathForm: ParsedAcceptance = {
      kind: 'artifact',
      requires: ['docs/plan.md'],
      onPass: 'plan-ready',
    };
    expect(evaluateAcceptance(pathForm, { kind: 'captures', recorded: ['plan'] }, context)).toEqual(
      { outcome: 'unevaluable', reason: 'artifact-requires-path-form' },
    );
    // MIXED is unevaluable too — "EVERY entry" is the narrowing, not "any".
    const mixed: ParsedAcceptance = {
      kind: 'artifact',
      requires: ['capture:plan', 'docs/plan.md'],
      onPass: 'plan-ready',
    };
    expect(
      evaluateAcceptance(mixed, { kind: 'captures', recorded: ['plan'] }, context),
    ).toEqual({ outcome: 'unevaluable', reason: 'artifact-requires-path-form' });
    // NEGATIVE CONTROL — the pure capture-ref sibling of the same shape routes.
    expect(
      evaluateAcceptance(
        { kind: 'artifact', requires: ['capture:plan'], onPass: 'plan-ready' },
        { kind: 'captures', recorded: ['plan'] },
        context,
      ),
    ).toEqual({ outcome: 'route', toNode: 'plan-ready' });
  });
});

// ── §3.5 — the DORMANT kinds ────────────────────────────────────────────────

describe('S20 §3.5 — `scalar` and `human-gate` are dormant, and say so', () => {
  const context = { instanceCriterionIds: ['c1'] };

  it('scalar is unevaluable under EVERY evidence shape', () => {
    const scalar: ParsedAcceptance = {
      kind: 'scalar',
      report: 'tenant.some_verb',
      dimensions: ['clarity'],
      aggregate: 'min',
      threshold: 3,
      onPass: 'done',
      onFail: 'implementing',
    };
    expect(evaluateAcceptance(scalar, reviewEvidence([pass('c1')]), context)).toEqual({
      outcome: 'unevaluable',
      reason: 'scalar-kind-dormant',
    });
    expect(evaluateAcceptance(scalar, { kind: 'captures', recorded: ['plan'] }, context)).toEqual({
      outcome: 'unevaluable',
      reason: 'scalar-kind-dormant',
    });
    // The ABSENCE that matters: a declared `on_pass` on a dormant kind is never
    // routed to, however satisfying the evidence looks.
    expect(
      evaluateAcceptance(scalar, { kind: 'report', verbId: 'tenant.some_verb' }, context).outcome,
    ).not.toBe('route');
  });

  it('human-gate is unevaluable under EVERY evidence shape', () => {
    const gate: ParsedAcceptance = {
      kind: 'human-gate',
      prompt: 'Ship it?',
      onAnswer: { yes: 'done', no: 'implementing' },
    };
    expect(evaluateAcceptance(gate, reviewEvidence([pass('c1')]), context)).toEqual({
      outcome: 'unevaluable',
      reason: 'human-gate-kind-dormant',
    });
    expect(evaluateAcceptance(gate, { kind: 'captures', recorded: ['plan'] }, context)).toEqual({
      outcome: 'unevaluable',
      reason: 'human-gate-kind-dormant',
    });
  });
});

// ── totality — the shapes a parsed manifest cannot produce, but a type can ───

describe('S20 §3.1 — the evaluator is TOTAL and never throws', () => {
  const context = { instanceCriterionIds: ['c1'] };

  it('a rubric handed CAPTURE evidence is unevaluable, not a route', () => {
    expect(
      evaluateAcceptance(SHIPPED_REVIEW_RUBRIC, { kind: 'captures', recorded: ['plan'] }, context),
    ).toEqual({ outcome: 'unevaluable', reason: 'evidence-kind-mismatch' });
  });

  it('an artifact handed REPORT evidence is unevaluable, not a route', () => {
    expect(
      evaluateAcceptance(
        { kind: 'artifact', requires: ['capture:plan'], onPass: 'plan-ready' },
        { kind: 'report', verbId: REVIEW_VERB },
        context,
      ),
    ).toEqual({ outcome: 'unevaluable', reason: 'evidence-kind-mismatch' });
  });

  it('a rubric handed a body with NO criteria rows is unevaluable, not a vacuous pass', () => {
    // The dangerous alternative: treating an absent criteria list as "no fails,
    // nothing uncovered" and routing `on_pass` on an empty-criteria instance.
    expect(
      evaluateAcceptance(
        SHIPPED_REVIEW_RUBRIC,
        { kind: 'report', verbId: REVIEW_VERB },
        { instanceCriterionIds: [] },
      ),
    ).toEqual({ outcome: 'unevaluable', reason: 'rubric-evidence-carries-no-criteria' });
    // NEGATIVE CONTROL — an EMPTY list is not the same as an ABSENT one; it is
    // the bare-task row and it passes.
    expect(
      evaluateAcceptance(SHIPPED_REVIEW_RUBRIC, reviewEvidence([]), {
        instanceCriterionIds: [],
      }),
    ).toEqual({ outcome: 'route', toNode: 'done' });
  });

  it('an out-of-vocabulary `coverage` / `unlisted_ids` is unevaluable, not silently the old rule', () => {
    expect(
      evaluateAcceptance(
        { ...SHIPPED_REVIEW_RUBRIC, coverage: 'any-criterion-pass' },
        reviewEvidence([pass('c1')]),
        { instanceCriterionIds: ['c1'] },
      ),
    ).toEqual({ outcome: 'unevaluable', reason: 'rubric-vocabulary-unsupported' });
    expect(
      evaluateAcceptance(
        { ...SHIPPED_REVIEW_RUBRIC, unlistedIds: 'fail' },
        reviewEvidence([pass('c1')]),
        { instanceCriterionIds: ['c1'] },
      ),
    ).toEqual({ outcome: 'unevaluable', reason: 'rubric-vocabulary-unsupported' });
    // NEGATIVE CONTROL — an ABSENT `unlisted_ids` is legal (the parser makes it
    // optional) and routes normally.
    const { unlistedIds: _dropped, ...withoutUnlistedIds } = SHIPPED_REVIEW_RUBRIC;
    expect(
      evaluateAcceptance(withoutUnlistedIds, reviewEvidence([pass('c1')]), {
        instanceCriterionIds: ['c1'],
      }),
    ).toEqual({ outcome: 'route', toNode: 'done' });
  });

  it('a table with no declared verb / no `requires` is unevaluable rather than a throw', () => {
    expect(evaluateAcceptance({ kind: 'report' }, { kind: 'report', verbId: 'x' }, context)).toEqual(
      { outcome: 'unevaluable', reason: 'acceptance-declares-no-report-verb' },
    );
    expect(
      evaluateAcceptance({ kind: 'rubric' }, { kind: 'report', verbId: 'x' }, context),
    ).toEqual({ outcome: 'unevaluable', reason: 'acceptance-declares-no-report-verb' });
    expect(
      evaluateAcceptance({ kind: 'artifact' }, { kind: 'captures', recorded: [] }, context),
    ).toEqual({ outcome: 'unevaluable', reason: 'artifact-declares-no-requires' });
    expect(
      evaluateAcceptance(
        { kind: 'artifact', requires: [] },
        { kind: 'captures', recorded: [] },
        context,
      ),
    ).toEqual({ outcome: 'unevaluable', reason: 'artifact-declares-no-requires' });
  });
});

// ── §3.5 — the RE-HOMED catalogue, asserted at its new home ─────────────────
//
// The daemon's `briefingDeclarations.test.ts` still asserts these same
// constants through the re-export and is UNCHANGED by the relocation — that
// file is the relocation guard. These cells assert the thing the move ADDED:
// the body map, and that it is derived rather than re-spelled.
describe('S20 §3.5 — the engine report-verb catalogue has one home', () => {
  it('ids are derived from the server + names, and the body map is keyed by those ids', () => {
    expect([...ENGINE_REPORT_TOOL_IDS]).toEqual(
      ENGINE_REPORT_TOOL_NAMES.map((name) => `${ENGINE_REPORT_TOOL_SERVER}.${name}`),
    );
    expect(Object.keys(ENGINE_REPORT_VERB_BODIES)).toEqual([...ENGINE_REPORT_TOOL_IDS]);
  });

  it('every catalogue id has a body kind, and the two bodies are the two that ship', () => {
    for (const toolId of ENGINE_REPORT_TOOL_IDS) {
      expect(isEngineKnownToolId(toolId)).toBe(true);
      expect(['criteria', 'worklog']).toContain(ENGINE_REPORT_VERB_BODIES[toolId]);
    }
    expect(ENGINE_REPORT_VERB_BODIES['vimes_report.report_review']).toBe('criteria');
    expect(ENGINE_REPORT_VERB_BODIES['vimes_report.report_completion']).toBe('worklog');
    // ABSENCE — a verb the engine cannot mount is absent from BOTH surfaces, so
    // "is it known" and "what body does it file" can never disagree.
    expect(isEngineKnownToolId('vimes_report.report_scalar')).toBe(false);
    expect(ENGINE_REPORT_VERB_BODIES['vimes_report.report_scalar']).toBeUndefined();
  });
});
