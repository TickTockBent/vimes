// ─── S19·U1 (slice-19 §3.2) — the BRIEFING INPUT SET: projection + assembly ──
//
// One question, one answer: **given a node's DECLARED `inputs` rows, what does
// the engine hand the tenant's briefing composer — and nothing else?**
//
// ── the law this module exists to make executable (slice-19 §3.2, signed) ────
//
//   "The input kinds are DISJOINT, and `instance.record` is a PROJECTION."
//
// node-kit §1.8.1 calls the inputs "the security surface": a CLOSED allow-list
// from a closed vocabulary, so a reader of the manifest can see what a node's
// performer can possibly have been given. That claim is EMPTY unless the kinds
// are disjoint — the raw instance record carries `planArtifactHash`,
// `lastReview` and `lastCompletion`, which are the CONTENT OF THREE OTHER INPUT
// KINDS. Handing a composer the raw record would hand it every report its node
// never declared, and the allow-list would be decoration.
//
// So the record a composer receives is a PROJECTION: the engine core fields and
// the work-order payload at its current rev, MINUS exactly the fields another
// input kind owns. An undeclared report is then UNREACHABLE, not merely
// unhanded.
//
// ⚠ **THE HONESTY LINE, kept verbatim from the node kit (§1.8.1 limit 1).** At
// Tier 1 this is a COMPOSITION guarantee, not containment: a builtin-trust
// tenant runs in-process and could reach the store by other means. What is real
// is that the composition path cannot leak an undeclared kind, which is the
// claim this module actually supports — and no larger one.
//
// ── the rules this module is built on ────────────────────────────────────────
// Rule 0.3: **PURE.** No clock, no randomness, no I/O, no mutation. Every read
// the assembly needs is INJECTED (`BriefingInputReads`); the daemon owns the
// artifact store and the record, and this module owns only the decision about
// WHICH of those reads may happen at all.
//
// Rule: **NEVER THROWS** (given total reads — see `BriefingInputReads`). Every
// (rows, reads) pair maps to an assembly result; an unassemblable row is a
// normal, named refusal, not an exception.

import { z } from 'zod';

import type { ReportCompletionPayload, ReportReviewPayload, TaskRecord } from '../schemas.js';

// ── the PROJECTION TABLE (slice-19 §3.2 — SIGNED DATA, U1's deliverable) ─────

/**
 * The field-level projection table's KEPT half: every `TaskRecord` field that
 * survives into `instance.record`.
 *
 * THE LAW (slice-19 §3.2): `instance.record` = the engine core fields + the
 * work-order payload at its current rev, MINUS the report/plan-derived fields —
 * i.e. minus any field that IS another input kind's content. A field belongs on
 * this list iff no other declared input kind can carry it.
 *
 * ⚠ **THIS LIST IS A CLASSIFICATION, NOT A CONVENIENCE.** It exists beside
 * `EXCLUDED_INSTANCE_RECORD_FIELDS` so that the two together are TOTAL over
 * `keyof TaskRecord`, and the compile-time guard below refuses to build if they
 * are not. Adding a field to `taskRecordSchema` therefore BREAKS THIS FILE
 * until someone decides, in writing, which half it belongs to — which is the
 * whole point: a new record field must never reach a composer by silent
 * pass-through.
 */
export const PROJECTED_INSTANCE_RECORD_FIELDS = [
  // ── identity + placement (engine core) ────────────────────────────────────
  'taskId',
  'projectRoot',
  'title',
  // ── the work-order payload at its current rev (D43) ───────────────────────
  'scope',
  'explicitlyOut',
  'acceptanceCriteria',
  'killCriterion',
  'workOrderRev',
  // ── engine core state ─────────────────────────────────────────────────────
  'stage',
  'manualReviewRequired',
  'isolation',
  'gates',
  'sessionRefs',
  'createdBy',
  // ── retired-but-retained engine fields (D34) ──────────────────────────────
  // Nothing writes either one; both are RETAINED rather than deleted because
  // removing them is a breaking schema change (see `taskRecordSchema`). They
  // are kept here for the same reason: they are engine core fields, and no
  // other input kind owns them. Reclassify them if and when they are deleted.
  'lastHeartbeatAt',
  'staleRetries',
] as const satisfies readonly (keyof TaskRecord)[];

/**
 * The field-level projection table's EXCLUDED half: the three `TaskRecord`
 * fields that ARE another input kind's content, and therefore may never ride in
 * on the record.
 *
 *   • `planArtifactHash` → the `artifact:plan` input kind (the hash is the
 *     reference to the blob the plan text comes from; handing over the hash
 *     hands over the plan to anything that can read the store).
 *   • `lastReview`       → the `report:last-review` input kind.
 *   • `lastCompletion`   → the `report:last-completion` input kind.
 *
 * All three are OPTIONAL on `taskRecordSchema`, which is why a projected record
 * remains assignable to a `TaskRecord`-shaped parameter: the projection removes
 * keys that were always allowed to be absent.
 */
export const EXCLUDED_INSTANCE_RECORD_FIELDS = [
  'planArtifactHash',
  'lastReview',
  'lastCompletion',
] as const satisfies readonly (keyof TaskRecord)[];

/** A field kept by the projection. */
export type ProjectedInstanceRecordField = (typeof PROJECTED_INSTANCE_RECORD_FIELDS)[number];
/** A field the projection removes because another input kind owns it. */
export type ExcludedInstanceRecordField = (typeof EXCLUDED_INSTANCE_RECORD_FIELDS)[number];

// ── the COMPILE-TIME totality guard (the "breaks this file" half of §3.2) ────
//
// Two directions, both required:
//   • every `TaskRecord` key is classified — a NEW record field reddens the
//     build here until it is put on one of the two lists above;
//   • every classified key is a real `TaskRecord` key — a RENAMED or DELETED
//     record field reddens here too, so the table cannot rot into fiction.
//
// Spelled as assignments rather than bare types so `tsc` reports them at a
// source position a reader can act on.
type UnclassifiedRecordField = Exclude<
  keyof TaskRecord,
  ProjectedInstanceRecordField | ExcludedInstanceRecordField
>;
type PhantomClassifiedField = Exclude<
  ProjectedInstanceRecordField | ExcludedInstanceRecordField,
  keyof TaskRecord
>;
/**
 * `true` iff every `TaskRecord` field has been classified above; otherwise the
 * annotation resolves to `never` and this assignment FAILS THE BUILD, naming
 * this line. That failure is the intended way to learn that a new record field
 * needs a classification decision.
 */
const everyRecordFieldIsClassified: [UnclassifiedRecordField] extends [never] ? true : never = true;
/**
 * `true` iff every classified field is still a real `TaskRecord` field — the
 * other direction, so a rename or deletion cannot leave this table as fiction.
 */
const everyClassifiedFieldStillExists: [PhantomClassifiedField] extends [never] ? true : never =
  true;
void everyRecordFieldIsClassified;
void everyClassifiedFieldStillExists;

/**
 * The record a briefing composer receives for the `instance.record` input kind:
 * `TaskRecord` minus exactly the three fields another input kind owns.
 */
export type ProjectedInstanceRecord = Pick<TaskRecord, ProjectedInstanceRecordField>;

/**
 * Project a task record down to the `instance.record` input kind. PURE and
 * TOTAL — every record maps to a projection, nothing throws.
 *
 * ⚠ **AN EXPLICIT KEY-LIST COPY, NEVER AN OBJECT-REST-MINUS.** `const {
 * lastReview, ...rest } = task` would pass a future `TaskRecord` field straight
 * through to the composer, silently, with nobody having decided that it should.
 * Every key below is named, and the compile-time guard above makes an
 * unclassified field a build failure rather than a leak.
 *
 * ⚠ **ABSENT STAYS ABSENT.** The six optional fields are spread in only when
 * they are PRESENT, never assigned `undefined`: `'title' in record` must stay
 * false for a task created without one, exactly as it is on the record itself,
 * because a present-but-undefined key is a different fact and different bytes
 * (the discipline `taskRecordSchema` documents at length).
 */
export function projectInstanceRecord(task: TaskRecord): ProjectedInstanceRecord {
  return {
    // ── required fields: always present on the record, always copied ────────
    taskId: task.taskId,
    projectRoot: task.projectRoot,
    stage: task.stage,
    manualReviewRequired: task.manualReviewRequired,
    isolation: task.isolation,
    gates: task.gates,
    sessionRefs: task.sessionRefs,
    createdBy: task.createdBy,
    lastHeartbeatAt: task.lastHeartbeatAt,
    staleRetries: task.staleRetries,
    // ── optional fields: absent stays absent ────────────────────────────────
    ...(task.title === undefined ? {} : { title: task.title }),
    ...(task.scope === undefined ? {} : { scope: task.scope }),
    ...(task.explicitlyOut === undefined ? {} : { explicitlyOut: task.explicitlyOut }),
    ...(task.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: task.acceptanceCriteria }),
    ...(task.killCriterion === undefined ? {} : { killCriterion: task.killCriterion }),
    ...(task.workOrderRev === undefined ? {} : { workOrderRev: task.workOrderRev }),
  };
}

// ── the declared rows the engine can assemble (node-kit §1.8.1's vocabulary) ─

/** The projected instance record. */
export const INSTANCE_RECORD_ROW = 'instance.record';
/** The approved plan's text — the blob the daemon fetches by content hash. */
export const PLAN_ARTIFACT_ROW = 'artifact:plan';
/** The review that failed the previous attempt (the fix-seed's first half). */
export const LAST_REVIEW_ROW = 'report:last-review';
/** The previous attempt's worklog (the fix-seed's second half). */
export const LAST_COMPLETION_ROW = 'report:last-completion';

/**
 * The CLOSED set of declared rows this engine knows how to assemble. The
 * manifest parser's vocabulary is WIDER than this on purpose (it also accepts
 * `capture:<name>` rows and extension-relative paths, node-kit §1.8.1) — those
 * are manifest-legal and have no engine assembler, so they are refused HERE
 * rather than at parse time. Fail-closed: a row nobody can assemble must never
 * degrade into silence.
 */
export const ASSEMBLABLE_BRIEFING_INPUT_ROWS: readonly string[] = [
  INSTANCE_RECORD_ROW,
  PLAN_ARTIFACT_ROW,
  LAST_REVIEW_ROW,
  LAST_COMPLETION_ROW,
];

// ── the input set ────────────────────────────────────────────────────────────

/**
 * What the engine assembled for one node's briefing — **ONLY the kinds that
 * node DECLARED**, and among those only the ones that turned out to be present.
 *
 * ⚠ Every field is OPTIONAL, and the two reasons are different:
 *   • UNDECLARED — the row is not in the node's `inputs`, so the read never
 *     happened and the kind is unreachable (§3.2's disjointness);
 *   • DECLARED-BUT-ABSENT — the read happened and returned nothing (a task with
 *     no plan yet, a first pass with no prior review). ABSENT STAYS ABSENT: the
 *     key is not written at all, never set to `undefined`.
 * Neither is an error, and this type deliberately does not distinguish them —
 * a composer's job is the same either way.
 */
export interface BriefingInputSet {
  /** `instance.record` — the projection, never the raw record. */
  readonly record?: ProjectedInstanceRecord;
  /** `artifact:plan` — the approved plan's text. */
  readonly planText?: string;
  /** `report:last-review` — the review that failed the previous attempt. */
  readonly lastReview?: ReportReviewPayload;
  /** `report:last-completion` — the previous attempt's worklog. */
  readonly lastCompletion?: ReportCompletionPayload;
}

/**
 * The reads the assembly is INJECTED (rule 0.3: the I/O stays at the daemon
 * boundary and is passed in, exactly as the plan blob already is).
 *
 * ⚠ **EVERY READ MUST BE TOTAL — return `undefined`, never throw.** The degrade
 * the dispatcher already keeps around the artifact store (a fetch that throws,
 * or a present hash whose blob is null, degrades to "no plan" rather than
 * failing the dispatch) belongs in the ADAPTER that supplies `readPlanText`,
 * not here: this module is pure and its totality is only as good as its reads.
 *
 * ⚠ **A READ IS CALLED AT MOST ONCE, AND ONLY IF ITS ROW IS DECLARED.** That is
 * the executable half of §3.2 — an undeclared kind is not merely dropped from
 * the set, its read is never invoked, so the data never enters the process.
 */
export interface BriefingInputReads {
  /** The instance's current record, straight off the projection. */
  readonly readInstanceRecord: () => TaskRecord;
  /** The approved plan's text, or `undefined` when there is none to fetch. */
  readonly readPlanText: () => string | undefined;
  /** The stored review that failed the previous attempt, if any. */
  readonly readLastReview: () => ReportReviewPayload | undefined;
  /** The stored worklog of the previous attempt, if any. */
  readonly readLastCompletion: () => ReportCompletionPayload | undefined;
}

// ── refusals: the CLOSED engine channel, mirroring `proposeMove`'s idiom ─────

/**
 * Why an assembly refused. CLOSED and authored nowhere but this file, for the
 * same reason `engineRefusalReasonSchema` is: membership has to be assertable
 * from outside, and a caller mapping these onto its own wire vocabulary
 * (slice-19 §3.5's `briefing-unresolvable:<sub-reason>`) must be able to prove
 * its map is total.
 */
export const briefingInputRefusalReasonSchema = z.enum([
  /** An `artifact:` row naming an artifact this engine does not fetch. */
  'unknown-artifact-id',
  /** A `report:` row naming a report kind this engine does not fold. */
  'unknown-report-kind',
  /** Anything else: a `capture:` row, an extension-relative path, a typo. */
  'unknown-input-kind',
]);
export type BriefingInputRefusalReason = z.infer<typeof briefingInputRefusalReasonSchema>;

/** The outcome of one assembly. */
export type BriefingInputAssembly =
  | { readonly assembled: true; readonly inputs: BriefingInputSet }
  | {
      readonly assembled: false;
      readonly reason: BriefingInputRefusalReason;
      /** The declared row that could not be assembled, echoed verbatim. */
      readonly row: string;
    };

/** Classify one declared row, without reading anything. */
function classifyRow(
  row: string,
): { readonly kind: string } | { readonly reason: BriefingInputRefusalReason } {
  if (ASSEMBLABLE_BRIEFING_INPUT_ROWS.includes(row)) return { kind: row };
  if (row.startsWith('artifact:')) return { reason: 'unknown-artifact-id' };
  if (row.startsWith('report:')) return { reason: 'unknown-report-kind' };
  return { reason: 'unknown-input-kind' };
}

/**
 * Assemble one node's declared input rows into the set its composer receives.
 * PURE (given the injected reads) and TOTAL.
 *
 * TWO PASSES, and the order is load-bearing:
 *
 *   1. **CLASSIFY every row, reading nothing.** A declaration carrying even one
 *      unassemblable row refuses BEFORE any read happens — fail-closed, so a
 *      half-assembled set can never be handed anywhere. The FIRST unassemblable
 *      row in declaration order is the one named, so the refusal is stable.
 *   2. **READ only the declared kinds**, each at most once (a row declared
 *      twice is the same fact declared twice, not two reads).
 *
 * Declaration ORDER does not affect the result — an input set is a set. What
 * order does affect is which row a refusal names, and that is deliberate.
 */
export function assembleBriefingInputs(
  declaredRows: readonly string[],
  reads: BriefingInputReads,
): BriefingInputAssembly {
  const declaredKinds = new Set<string>();
  for (const row of declaredRows) {
    const classification = classifyRow(row);
    if ('reason' in classification) {
      return { assembled: false, reason: classification.reason, row };
    }
    declaredKinds.add(classification.kind);
  }

  // ⚠ Each branch is guarded by its OWN declaration. There is deliberately no
  // "read everything, filter afterwards" shortcut: filtering after the fact
  // would still have pulled the undeclared report into memory, and §3.2's claim
  // is about the read, not about the field list.
  const record = declaredKinds.has(INSTANCE_RECORD_ROW)
    ? projectInstanceRecord(reads.readInstanceRecord())
    : undefined;
  const planText = declaredKinds.has(PLAN_ARTIFACT_ROW) ? reads.readPlanText() : undefined;
  const lastReview = declaredKinds.has(LAST_REVIEW_ROW) ? reads.readLastReview() : undefined;
  const lastCompletion = declaredKinds.has(LAST_COMPLETION_ROW)
    ? reads.readLastCompletion()
    : undefined;

  // ABSENT STAYS ABSENT — the same spread idiom the dispatcher already uses to
  // keep an empty context byte-identical to no context at all.
  return {
    assembled: true,
    inputs: {
      ...(record === undefined ? {} : { record }),
      ...(planText === undefined ? {} : { planText }),
      ...(lastReview === undefined ? {} : { lastReview }),
      ...(lastCompletion === undefined ? {} : { lastCompletion }),
    },
  };
}
