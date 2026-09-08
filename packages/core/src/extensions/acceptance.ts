import type { ParsedAcceptance } from './manifest.js';
import type { ReportReviewPayload } from '../tasks/workOrder.js';

// ─── S20·U1 (slice-20 §3.1/§3.2/§3.4/§3.5/§3.6) — THE ACCEPTANCE EVALUATOR ───
//
// One question, one answer: **given what a node DECLARED it accepts, and the
// evidence that just arrived, where does the instance go?**
//
// PURE, TOTAL, DETERMINISTIC (rule 0.3). No clock, no IO, no filesystem, no
// randomness — and it NEVER THROWS on any input. Every shape it cannot judge is
// a typed `unevaluable`, never an exception: the caller (the dispatcher, U2)
// turns that into a warning and proposes nothing, and a throw at this depth
// would surface as an unhandled rejection inside a report-filing callback.
//
// ⚠ **IT DECIDES, IT DOES NOT ACT.** Like `deriveReviewOutcome` before it
// (deleted at the S20·U3 flip — slice-20 §3.2 — once this evaluator was proven
// to reproduce it row-for-row), this returns a DECISION. The dispatcher reads
// it and proposes the move through the state
// machine (I7); the writer keeps everything it owns — legality, `max_traversals`
// exhaustion → manual-review, evented rejections. Nothing here proposes, and
// nothing here can bypass the writer.
//
// ── the three answers, and why REST is not FAILURE (§3.4, §3.6) ──────────────
//
//   • `route`       — the declaration named a target for what happened.
//   • `rest`        — evaluated fine; the declaration named NO target for this
//                     outcome (an unset `on_pass`/`on_fail`), or the evidence is
//                     genuinely incomplete (some captures still outstanding).
//                     The report/capture still RECORDED — fact before
//                     consequence — the node simply rests and something else
//                     proposes the move (node-kit §1.8.4 property 4).
//   • `unevaluable` — this engine cannot judge this table against this evidence
//                     at Tier 1. A named, inspectable reason; never a guess.
//
// The distinction that took a Sol round to get right (round-2 P2): ABSENT
// EVIDENCE IS NOT FAILURE. A capture list with one of three names recorded rests
// awaiting the other two; it does not route `on_fail`. Only a rubric's explicit
// `fail` verdict, or a coverage miss on a report that WAS filed, is failure.

/** A `criteria` body's rows, as `report_review` files them — DERIVED, not retyped. */
export type ReportedCriteria = ReportReviewPayload['criteria'];

/**
 * The evidence an acceptance table is evaluated against. A DISCRIMINATED UNION,
 * because the two channels are genuinely different facts and collapsing them
 * into one optional-riddled bag is how an evaluator ends up judging a rubric
 * against a capture list.
 *
 *   • `report`   — a report was filed through the declared verb. `criteria` is
 *     present only when the verb's body carries them (`report_review`); a
 *     `worklog` body files with `criteria` absent, and the `report` KIND never
 *     looks at it either way (§3.5's asymmetry: existence-only).
 *   • `captures` — the capture names recorded on the instance (e.g. `['plan']`).
 */
export type AcceptanceEvidence =
  | { readonly kind: 'report'; readonly verbId: string; readonly criteria?: ReportedCriteria }
  | { readonly kind: 'captures'; readonly recorded: readonly string[] };

/**
 * What the INSTANCE contributes. `criteria_from = "instance.acceptanceCriteria"`
 * is a closed vocabulary of exactly one value (§3.2, refused at parse otherwise),
 * so the one lookup it names is resolved by the caller and handed in here — the
 * evaluator holds no path language and reads no instance record.
 */
export interface AcceptanceContext {
  /** The ids on the instance's own acceptance list — the COVERAGE BAR. */
  readonly instanceCriterionIds: readonly string[];
}

/**
 * Why a table could not be judged. A CLOSED vocabulary rather than free prose:
 * every member is a decision recorded in slice-20 §3, and a caller that wants to
 * warn differently per reason can switch on it.
 */
export type AcceptanceUnevaluableReason =
  /** §3.5 — a dormant kind. Parsed vocabulary, no Tier-1 invocation path. */
  | 'scalar-kind-dormant'
  /** §3.5 — a dormant kind. Answered through `on_answer`, never by a report. */
  | 'human-gate-kind-dormant'
  /** §3.6 — a `requires` entry that is not `capture:<name>`; no probe exists. */
  | 'artifact-requires-path-form'
  /** §3.6 — an `artifact` table with no `requires` list at all (parser-unreachable). */
  | 'artifact-declares-no-requires'
  /** A `rubric`/`report` table with no `report` verb declared (parser-unreachable). */
  | 'acceptance-declares-no-report-verb'
  /** The evidence CHANNEL does not match the kind (a rubric handed captures, say). */
  | 'evidence-kind-mismatch'
  /** A report of some OTHER verb than the one this table declared. */
  | 'evidence-verb-mismatch'
  /** §3.2 — a rubric handed a report body that carries no criteria rows. */
  | 'rubric-evidence-carries-no-criteria'
  /** §3.2 — a `coverage`/`unlisted_ids` value outside the one-member vocabularies. */
  | 'rubric-vocabulary-unsupported';

/** The evaluator's total answer. Never a throw, never `undefined`. */
export type AcceptanceEvaluation =
  | { readonly outcome: 'route'; readonly toNode: string }
  | { readonly outcome: 'rest' }
  | { readonly outcome: 'unevaluable'; readonly reason: AcceptanceUnevaluableReason };

const REST: AcceptanceEvaluation = { outcome: 'rest' };

function unevaluable(reason: AcceptanceUnevaluableReason): AcceptanceEvaluation {
  return { outcome: 'unevaluable', reason };
}

/**
 * §3.4 — **UNSET MEANS REST.** The single place a declared target becomes a
 * routing decision, so the "no target declared → no proposal" rule is written
 * once and cannot be half-applied on one arm.
 */
function routeTo(target: string | undefined): AcceptanceEvaluation {
  if (target === undefined) return REST;
  return { outcome: 'route', toNode: target };
}

/** The reserved reference §1.8.3 gives a captured artifact. */
const CAPTURE_REF_PREFIX = 'capture:';

/**
 * Evaluate ONE node's acceptance table against ONE piece of evidence.
 *
 * ⚠ **EXHAUSTIVE SWITCH, NO `default:` ARM.** A sixth acceptance kind must break
 * this build rather than fall silently into one of today's five — an
 * unclassified kind would either route a real instance somewhere nobody declared
 * or swallow a filed report without a word.
 */
export function evaluateAcceptance(
  acceptance: ParsedAcceptance,
  evidence: AcceptanceEvidence,
  context: AcceptanceContext,
): AcceptanceEvaluation {
  switch (acceptance.kind) {
    case 'rubric':
      return evaluateRubric(acceptance, evidence, context);
    case 'report':
      return evaluateReport(acceptance, evidence);
    case 'artifact':
      return evaluateArtifact(acceptance, evidence);
    // ── the DORMANT kinds (§3.5) ────────────────────────────────────────────
    //
    // Both are parsed vocabulary with no Tier-1 invocation path, and the arms
    // exist so the switch is exhaustive and the claim is TESTED rather than
    // asserted in prose. `report_filed` is a CLOSED review/completion union, so
    // a scalar could only ever be fed a body its `dimensions` were never
    // validated against (node-kit property 2: "the report is validated, never
    // trusted"); a human-gate is answered through `on_answer` via the engine's
    // gate surface, which no report ever reaches. The machinery for each arrives
    // with its first consumer (rule 0.5), and until then this is the honest
    // answer rather than a fabricated verdict.
    case 'scalar':
      return unevaluable('scalar-kind-dormant');
    case 'human-gate':
      return unevaluable('human-gate-kind-dormant');
  }
}

// ── §3.2 — the RUBRIC arm: `deriveReviewOutcome`, row for row ───────────────
//
// The compiled function this reproduced was `tasks/reviewOutcome.ts:22`
// (DELETED at the S20·U3 flip, once `acceptance.test.ts`'s equivalence suite
// proved this arm agreed with it cell for cell — the suite now checks this
// arm against that function's frozen image instead of a live second
// implementation). The rows, in that function's order:
//
//   • any reported 'fail'                      -> on_fail   (the fix loop)
//   • a context criterion NOT covered by a pass -> on_fail  (incomplete review)
//   • every context criterion covered by a pass -> on_pass
//   • an EMPTY context criterion list           -> on_pass  (vacuously covered)
//   • an EXTRA reported id off the list         -> ignored  (`unlisted_ids`)
//
// The one difference is the TARGET: the compiled function returns the stage
// literals `'implementing'`/`'done'`; this one returns whatever the declaration
// named, and REST when it named nothing (§3.4).
function evaluateRubric(
  acceptance: ParsedAcceptance,
  evidence: AcceptanceEvidence,
  context: AcceptanceContext,
): AcceptanceEvaluation {
  // The declared vocabularies are one-member closed enums the parser already
  // enforces (§0.4), so neither branch below is reachable through a parsed
  // manifest. They exist because this function is TOTAL over its declared TYPE,
  // not over the parser's current output: the day a second `coverage` rule is
  // declared, this refuses to guess which one it is instead of silently applying
  // the old one to a table that asked for something else.
  if (acceptance.coverage !== undefined && acceptance.coverage !== 'all-criteria-pass') {
    return unevaluable('rubric-vocabulary-unsupported');
  }
  if (acceptance.unlistedIds !== undefined && acceptance.unlistedIds !== 'ignore') {
    return unevaluable('rubric-vocabulary-unsupported');
  }
  if (acceptance.report === undefined) return unevaluable('acceptance-declares-no-report-verb');
  if (evidence.kind !== 'report') return unevaluable('evidence-kind-mismatch');
  if (evidence.verbId !== acceptance.report) return unevaluable('evidence-verb-mismatch');
  const reportedCriteria = evidence.criteria;
  if (reportedCriteria === undefined) return unevaluable('rubric-evidence-carries-no-criteria');

  // Any explicit fail sends it to the declared failure target, regardless of
  // what else was (or was not) reported.
  if (reportedCriteria.some((criterion) => criterion.verdict === 'fail')) {
    return routeTo(acceptance.onFail);
  }
  // Only 'pass' verdicts count toward coverage; a criterion the reviewer never
  // mentioned is uncovered by definition.
  const passedCriterionIds = new Set(
    reportedCriteria
      .filter((criterion) => criterion.verdict === 'pass')
      .map((criterion) => criterion.criterionId),
  );
  // `every` over an empty list is vacuously true → a bare instance (no criteria)
  // is covered and routes `on_pass`. An extra reported id is simply never
  // consulted here, which IS `unlisted_ids = "ignore"`: it neither blocks nor
  // forces the pass (A-17).
  const allCriteriaCovered = context.instanceCriterionIds.every((criterionId) =>
    passedCriterionIds.has(criterionId),
  );
  return allCriteriaCovered ? routeTo(acceptance.onPass) : routeTo(acceptance.onFail);
}

// ── §3.5 — the REPORT arm: EXISTENCE ONLY ───────────────────────────────────
//
// node-kit §1.8.4 (e): "a valid report of the declared kind was filed; no
// verdict is derived from its contents" — the degenerate case of rubric. The
// tool's own schema validated the body before it ever became evidence; this arm
// deliberately IGNORES it, which is exactly why `report` + `report_review` is a
// legal binding (§3.5's asymmetry, Sol round-4 P1‴) even though nothing here
// would read the criteria it carries.
//
// There is no failure row: existence is the whole test, so `on_fail` cannot be
// reached from here either.
function evaluateReport(
  acceptance: ParsedAcceptance,
  evidence: AcceptanceEvidence,
): AcceptanceEvaluation {
  if (acceptance.report === undefined) return unevaluable('acceptance-declares-no-report-verb');
  if (evidence.kind !== 'report') return unevaluable('evidence-kind-mismatch');
  if (evidence.verbId !== acceptance.report) return unevaluable('evidence-verb-mismatch');
  return routeTo(acceptance.onPass);
}

// ── §3.6 — the ARTIFACT arm, NARROWED to the capture-ref form ───────────────
//
// The kit's §1.8.4 (d) admits multiple `requires` entries and ordinary PATHS
// (node-kit.md:503–508). A pure evaluator cannot probe a path — that is the
// whole of rule 0.3 — so the live domain is narrowed EXPLICITLY here rather than
// discovered later: every entry of the `capture:<name>` form, or nothing routes.
//
// Three rows:
//   • every capture name recorded         -> on_pass
//   • SOME missing                        -> REST (absent evidence is not
//                                            failure; the node awaits the rest)
//   • ANY path-form entry                 -> unevaluable (the capture still
//                                            RECORDED; the probe waits for its
//                                            first consumer, §2-out)
//
// ⚠ **`on_fail` ON AN ARTIFACT TABLE IS LEGAL BUT INERT AT TIER 1**, and that is
// stated here rather than left undefined. Nothing in this engine produces
// NEGATIVE existence evidence — a capture is recorded or it is outstanding — so
// there is no row above that could reach a failure target. A manifest may still
// declare one (the parser accepts it, §1.8.4 (d) lists the key); it simply never
// fires, and a unit test pins that inertness.
function evaluateArtifact(
  acceptance: ParsedAcceptance,
  evidence: AcceptanceEvidence,
): AcceptanceEvaluation {
  const requires = acceptance.requires;
  // Parser-unreachable (`requires` is required and non-empty for the artifact
  // kind), kept for totality over the declared type.
  if (requires === undefined || requires.length === 0) {
    return unevaluable('artifact-declares-no-requires');
  }
  if (!requires.every((requirement) => requirement.startsWith(CAPTURE_REF_PREFIX))) {
    return unevaluable('artifact-requires-path-form');
  }
  if (evidence.kind !== 'captures') return unevaluable('evidence-kind-mismatch');
  const recorded = new Set(evidence.recorded);
  const allPresent = requires.every((requirement) =>
    recorded.has(requirement.slice(CAPTURE_REF_PREFIX.length)),
  );
  return allPresent ? routeTo(acceptance.onPass) : REST;
}
