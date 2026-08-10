import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  shouldDispatchOnTransition,
  type InstanceRecord,
  type InstancesState,
  type ParsedWorkflow,
  type TaskRecord,
  type TaskStage,
  type TransitionProposal,
  type TransitionProposedBy,
  type TransitionRejectionReason,
  type WorkOrderAmendedPayload,
} from '@vimes/core';
import { resolveWithinRoots, realpathProbe, type RealpathProbe } from './filePaths.js';
import {
  InstanceProjectionDisagreementError,
  type CreateInstanceInput,
  type InstanceWriter,
} from './instanceWriter.js';
import type { DispatchAttemptResult } from './taskDispatcher.js';

// ─── slice 6 step 4b — the task API (REST, behind the auth wall) ─────────────
//
// The first caller of the decisions steps 1–4a built, and the first place task
// state is written by anything other than a test.
//
// ⚠ THIS FILE IS A PROPOSER, NEVER A SECOND WRITER (principle 10, I7).
// A route here MAY NOT compute a next stage, MAY NOT decide a dispatch, and MAY
// NOT construct an `instance_moved` from its own reasoning. It parses input at
// the boundary, hands it to `InstanceWriter` / `TaskDispatcher`, and reports
// exactly what came back. Everything that DECIDES lives in packages/core;
// everything that WRITES lives in `instanceWriter.ts`; this file is the adapter
// between HTTP and
// those two, and it holds no state of its own.
//
// ⚠ SLICE 7'S MCP SURFACE WILL BE A THIN CLIENT OF THESE ROUTES (slice-6
// "explicitly out": the MCP server is never a second writer to the store). The
// boundary set here is the one it inherits, so it is written as the public
// contract it is — envelopes over status-code semantics, enumerated reasons over
// prose, and one route per verb.
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()` anywhere in this
// file. Every route runs to completion inside the request that invoked it.
//
// ─── S11·U3 (D72 Move 2) — this file is `taskApi.ts` RE-HOMED ────────────────
//
// Not a rewrite: every behaviour above and below is the one that shipped. What
// changed is which SPELLING is the contract. The generic `/api/instances/*`
// routes are now the surface the system is built on; the `/api/tasks/*` paths
// survive as DEPRECATED ALIASES for exactly one deploy (see the inventory
// below). `taskApi.ts` is deleted in this same unit — D72's governing rule is
// that a unit which leaves both paths live is not finished.
//
// ⚠ ONE HANDLER CORE PER OPERATION, TWO SURFACE REGISTRATIONS. The alias and
// its generic twin are the SAME code path: they differ only in how the request
// body spells the location fields (`projectRoot`/`stage` vs `project`/`node`),
// which path param carries the id, and which key the success envelope hangs the
// record on (`task` vs `instance`). Everything that could drift BEHAVIOURALLY —
// validation, the allowlist wall, the writer call, the status codes, the error
// bodies, the dispatch rider — is shared, so the two surfaces cannot answer
// differently while both exist (S11-A4).
//
// ─── THE ALIAS INVENTORY (q24 — ONE DEPLOY OF OVERLAP, then these die) ───────
//
// This deploy serves the generic routes AND every alias below; the deployed UI
// keeps working untouched (a UI that learned the new vocabulary would ship
// itself ahead of the daemon via ci-gate — the D37 failure class). A LATER UI
// unit switches the client to the generic routes; the daemon deploy AFTER that
// deletes this list. Exactly one deploy of overlap, as decided.
//
//   • POST /api/tasks                        → POST /api/instances
//   • POST /api/tasks/:taskId/transitions    → POST /api/instances/:instanceId/moves
//   • POST /api/tasks/:taskId/amendments     → POST /api/instances/:instanceId/payload-revisions
//   • POST /api/tasks/:taskId/dispatch       → POST /api/instances/:instanceId/dispatch
//   • GET  /api/projections/tasks            → (app.ts, S11·U1: `legacyTasksViewOf`
//                                              of the instances fold — same window,
//                                              listed here so the inventory is in
//                                              ONE place)
//
// ⚠ TWO ROUTES ARE NOT ON THAT LIST AND HAVE NO GENERIC TWIN THIS SLICE:
// `GET /api/tasks/stage-edges` and `GET /api/tasks/work-order-schema` move
// VERBATIM, old paths only. Their generalisation is DECLARATION INTROSPECTION
// (q25) and needs pinned workflow/node declarations to introspect — Move 3+,
// not here. Inventing a `/api/instances/edges` that served the compiled task
// table would be declared truth over observed (rule 0.7).

export interface InstanceApiDeps {
  // The SOLE instance writer (step 4b, re-homed S11·U2). Not an emit function:
  // routing every write through the one class is what keeps step 5's in-process
  // watchdog and this HTTP surface from becoming two writers.
  instanceWriter: InstanceWriter;
  // ONE explicit dispatch attempt. Deliberately a narrow function rather than the
  // `TaskDispatcher` itself, so no route can reach past it into the session host.
  //
  // ⚠ ASYNC SINCE STEP 8, because worktree creation is a subprocess. This is the
  // whole of the async ripple's reach into the API layer — the RESULT SHAPES are
  // unchanged field-for-field, so the response envelope below is byte-identical for
  // every outcome that existed before it.
  dispatchTask: (taskId: string) => Promise<DispatchAttemptResult>;
  // The live allowlist union (config.projectRoots ∪ host.liveSessionCwds()), read
  // fresh per request — the SAME union and the SAME shape the file/git/search
  // APIs use.
  getAllowedRoots: () => readonly string[];
  // S11·U3: the INSTANCE fold, read fresh per response for the generic routes'
  // envelopes. Deliberately a second read rather than a widened writer return:
  // the writer's return is the LEGACY narrowing (`TaskRecord`, a Move-3 leftover
  // — see InstanceWriterDeps.readTasks), and widening it here would put the
  // instance shape on the write path before Move 3 asks for it. Reading the fold
  // back is also the same I12 posture the writer itself takes: the record a
  // client receives is the record the log produced, never an echo.
  readInstances: () => InstancesState;
  // ── S12·U2 (D72 Move 3): the boot-resolved declaration ─────────────────────
  //
  // INJECTED (rule 0.3) — `app.ts` resolves the shipped manifest once at
  // construction and hands the SAME `ParsedWorkflow` object to this surface and
  // to the writer, so the door that defaults a starting node, the route that
  // publishes the legality table and the adjudicator that enforces it all read
  // ONE declaration. Two routes reading two parses would be two authorities.
  //
  // Read for exactly two things here, both of them derivations and neither a
  // decision: `workflow.initial` (the create doors' starting node, in place of
  // the compiled `INITIAL_TASK_STAGE`) and `workflow.edges` (the stage-edges
  // route's membership). This file still decides nothing.
  workflow: ParsedWorkflow;
  // Injected realpath probe (fs boundary). Defaults to the real one; mirrors
  // FileApiDeps / GitApiDeps.
  realpath?: RealpathProbe;
}

// ── the wire contract ────────────────────────────────────────────────────────
//
// ⚠ THE LEGACY HALF OF THIS SECTION IS THE ALIAS CONTRACT, FROZEN. Every type
// below whose success key is `task` is what an `/api/tasks/*` alias serves, and
// it is byte-identical to what shipped — the deployed UI parses these exact
// shapes. They die with the aliases (q24), not before.

export interface CreateTaskResponse {
  task: TaskRecord;
}
export type ProposeTransitionResponse =
  | {
      accepted: true;
      task: TaskRecord;
      // ── S7·7c: THE DISPATCH-ON-PROMOTION RIDER (D53), OPTIONAL ON PURPOSE ─────
      //
      // Present ONLY when the accepted edge was a PROMOTION INTO AN ACTIVE STAGE
      // and the route therefore made one dispatch attempt. On every other accepted
      // transition — an outcome edge, a move into a non-active stage — the key is
      // ABSENT, not `undefined`, so those envelopes stay byte-identical to what
      // they were before this unit and no existing client sees a new field.
      //
      // It carries the dispatcher's own result VERBATIM, whatever it says. See the
      // route for why a `refused` / `spawn-failed` dispatch still rides a 200.
      dispatch?: DispatchAttemptResult;
    }
  | { accepted: false; reason: TransitionRejectionReason };
export interface DispatchResponse {
  result: DispatchAttemptResult;
}
// S7·2b. The SAME `{ task }` shape the create route returns, and for the same
// reason: the body is the record **as the projection folded it**, so a client
// reads the amendment's real effect (including the bumped `workOrderRev`) rather
// than an echo of what it asked for.
export interface AmendWorkOrderResponse {
  task: TaskRecord;
}

// ── the generic half — THE CONTRACT FROM THIS SLICE ON ───────────────────────
//
// Same envelopes, same status codes, same optional-key discipline; the record is
// the INSTANCE record as `readInstances()` folded it, under `instance`.
// `DispatchResponse` above is shared by both surfaces unchanged — the dispatch
// result vocabulary is already engine-shaped and workflow-blind, so there is
// nothing in it to re-spell.

export interface CreateInstanceResponse {
  instance: InstanceRecord;
}
export type ProposeMoveResponse =
  | {
      accepted: true;
      instance: InstanceRecord;
      // The S7·7c rider, unchanged and still ABSENT rather than `undefined` on a
      // non-promoting move — see `ProposeTransitionResponse` above for the whole
      // reasoning; the two surfaces make ONE dispatch decision in ONE place.
      dispatch?: DispatchAttemptResult;
    }
  | { accepted: false; reason: TransitionRejectionReason };
export interface RevisePayloadResponse {
  instance: InstanceRecord;
}

// S8: the legal-edge table, served so the move sheet can filter to legal next
// stages without the UI copying the table (the drift `taskBoard.ts`'s comment
// used to warn against). Static and read-only — as of S12·U2 it is a pure
// derivation of the BOOT-RESOLVED DECLARATION (see the route), so it still
// touches neither the writer nor the log.
export interface StageEdgesResponse {
  edges: Record<TaskStage, TaskStage[]>;
}
// S7·3: the work-order authoring descriptor, served for the SAME reason the
// legal-edge table is (Wes, 2026-07-25) — the board's create sheet must render
// the four authored work-order fields, but `packages/ui` cannot import the zod
// that defines them (`@vimes/core` is a deliberate non-dependency of the UI, and
// `createTaskBodySchema` lives here). So the daemon owns the field shape once (in
// `createTaskBodySchema`, S7·2a) and serves a descriptor derived from the SAME
// cap constants; the UI reflects it without a second hand-mirrored field list.
// The descriptor↔schema drift test in instanceApi.test.ts is what keeps the two
// halves honest, exactly as `exhaustiveVocabulary` guards the re-declared enums.
export interface WorkOrderSchemaResponse {
  fields: readonly WorkOrderFieldDescriptor[];
}

// ── the boundary vocabularies ────────────────────────────────────────────────
//
// ⚠ RE-DECLARED HERE RATHER THAN IMPORTED FROM CORE, AND THE REASON IS BORING BUT
// REAL: `packages/core` validates with **zod 3**, while the daemon's tree resolves
// **zod 4** (the Anthropic SDK pulls it in). A v3 schema object nested inside a v4
// `z.object()` type-checks but degrades every inferred field to `unknown`, so the
// route would lose the very typing the validation exists to give it. wsHub.ts
// already declares its own literal enums for the same reason.
//
// Re-declaring a vocabulary is exactly the drift principle 9 warns about, so each
// tuple is BOUND to core's own union by `exhaustiveVocabulary`: a value added to
// (or renamed in) `taskRecordSchema` / `transitionProposedBySchema` fails the
// BUILD here rather than silently becoming un-proposable over HTTP.
function exhaustiveVocabulary<UnionType extends string>() {
  return <const TupleType extends readonly UnionType[]>(
    values: [UnionType] extends [TupleType[number]] ? TupleType : never,
  ): TupleType => values;
}

const CREATED_BY_VALUES = exhaustiveVocabulary<TaskRecord['createdBy']>()([
  'human',
  'orchestrator',
]);
const ISOLATION_VALUES = exhaustiveVocabulary<TaskRecord['isolation']>()([
  'shared-dir',
  'worktree',
]);
// ⚠ THIRD MIRROR of the stage vocabulary. Adding a stage means updating THREE
// places in lockstep: core's `taskRecordSchema.stage` enum (the source), this
// array, and the UI's mirror in `packages/ui/src/lib/taskBoard.ts`. This copy
// exists because of the zod3/zod4 split noted above; `exhaustiveVocabulary` binds
// it to core's union at the type level, so a missing value fails typecheck (which
// is exactly how `cancelled` was caught, S11 2026-07-24) — the guard works, but
// it is a manual sync until the zod versions converge.
//
// ⚠ THE GENERIC CREATE ROUTE VALIDATES `node` AGAINST THIS SAME TUPLE, and that
// is honest rather than lazy: adjudication is explicitly OUT of slice 11, so the
// only node vocabulary that exists today is the compiled task machine's. A
// generic route that accepted any string would be claiming a freedom nothing
// downstream can honour. Widening it belongs with the pinned declarations (q25,
// Move 3+) that will define what a node IS.
const TASK_STAGE_VALUES = exhaustiveVocabulary<TaskRecord['stage']>()([
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
const PROPOSED_BY_VALUES = exhaustiveVocabulary<TransitionProposedBy>()([
  'human',
  'orchestrator',
  'dispatcher',
]);
// S7·2b. **TWO VALUES, one fewer than `PROPOSED_BY_VALUES` above**, and the gap is
// the design: `dispatcher` cannot amend (D53 — an amendment is a decision, and the
// mechanics never author one). Bound to the EVENT payload's own union rather than
// re-typed, so widening `amendedBy` in core fails the build here instead of
// silently leaving a new author un-proposable over HTTP.
const AMENDED_BY_VALUES = exhaustiveVocabulary<WorkOrderAmendedPayload['amendedBy']>()([
  'human',
  'orchestrator',
]);

// The gates a creator may name, mirroring `taskRecordSchema.gates`. Both halves
// stay optional: a task that names only `requireHeadroom` must not acquire a
// `deferUntilReset` it never asked for. The `satisfies` binds this shape to the
// record's own, so a reshaped gate fails the build here too.
const taskGatesSchema = z.object({
  deferUntilReset: z.string().optional(),
  requireHeadroom: z.object({ meterId: z.string(), pct: z.number() }).optional(),
});
const _gatesMatchTheRecord = {} as z.infer<typeof taskGatesSchema> satisfies TaskRecord['gates'];
const _recordGatesMatchTheSchema = {} as TaskRecord['gates'] satisfies z.infer<
  typeof taskGatesSchema
>;

// The create body. Validated at the boundary — a daemon route never trusts a
// request shape (I8: hostile input must not crash anything, and must not reach a
// decision function as something it is not).
//
// `isolation` defaults to **'worktree'** — **D32** (spike S2 refuted shared-dir's
// only claimed benefit: caching is not directory-scoped on this host, so a fresh
// worktree took a 100% cache hit). This is the FIRST PLACE IN CODE that default
// becomes real; slice-6 step 8 makes it actually isolate. Per-task override
// retained, which is why the field is still accepted.
//
// The starting node defaults to **whatever the boot-resolved declaration calls
// `initial`** (S12·U2, D72 Move 3) — no longer the compiled `INITIAL_TASK_STAGE`.
// It is still stated in the birth record rather than assumed downstream, so the
// projection folds a named node; what changed is who names it. The default moved
// OFF the body schemas (which are module-level constants and cannot see a
// runtime declaration) and onto the surfaces below, where the resolved workflow
// is in scope — so the field is `.optional()` here and defaulted there.
//
// ⚠ THE TITLE CAP (step 9, I8). A title is FREE TEXT FROM AN UNTRUSTED CALLER
// that lands in a durable append-only record and on a rendered card, so it is
// bounded HERE, at the boundary, and nowhere deeper — `taskRecordSchema.title`
// stays an unbounded optional string on purpose, so a record written before this
// cap existed (or under a different one) still parses and still replays (I6). A
// cap enforced by the record schema would be a migration; a cap enforced by the
// route is a policy, and policies may change without rewriting history.
//
// ⟨200⟩ IS NOT A ⟨tune⟩ — nothing about the system's behaviour changes with it,
// so Gate-D does not apply. It is a boundary, chosen as the smallest number that
// cannot plausibly refuse a real title: ~2 lines at phone width, comfortably
// above a git subject line (72) and in the same class as GitHub's issue-title
// limit (256). Anything longer is a description, and a task has no description
// field — inventing one here would widen the record by accident.
const MAX_TASK_TITLE_LENGTH = 200;

// ── S7·2a: the work-order input caps (I8, boundary-only) ──────────────────────
//
// The four authored work-order fields are FREE TEXT FROM AN UNTRUSTED CALLER that
// land in a durable append-only record, so they are bounded HERE, at the boundary,
// and nowhere deeper — `taskRecordSchema`'s work-order fields stay unbounded
// optional strings/arrays on purpose, so a record written before (or under a
// different) cap still parses and still replays (I6). A cap enforced by the record
// schema would be a migration; a cap enforced by the route is a policy.
//
// These are the SAME CLASS of input guard as `MAX_TASK_TITLE_LENGTH` — bounds,
// not behaviour-shaping ⟨tune⟩s (nothing about the system's behaviour changes with
// the exact number), so Gate-D does not apply and they are pinned directly. Over
// any cap → the WHOLE body fails to parse → 400 with **NO EVENT**, the established
// idiom (a body that was never a valid proposal writes nothing).
//
//   • MAX_WORK_ORDER_TEXT — the prose fields (`scope`, `killCriterion`): generous
//     paragraphs, comfortably above any real work-order section.
//   • MAX_WORK_ORDER_LINE — one list ENTRY (an `explicitlyOut` line, one
//     criterion's text): a sentence or two, not a paragraph.
//   • MAX_LIST_ITEMS — how many entries a list may hold, so a hostile caller
//     cannot send a hundred-thousand-element array and force a huge birth record.
const MAX_WORK_ORDER_TEXT = 8000;
const MAX_WORK_ORDER_LINE = 2000;
const MAX_LIST_ITEMS = 100;

// ── the create body, MINUS the two renamed location fields ───────────────────
//
// ⚠ ONE SET OF FIELD SCHEMAS, SHARED BY BOTH SURFACES BY REFERENCE — not two
// copies that happen to agree today. The alias body and the generic body differ
// in EXACTLY two keys (`projectRoot`→`project`, `stage`→`node`); everything else
// is literally the same schema object, so a cap change, an added field or a
// tightened enum lands on both doors at once and cannot drift (principle 9).
//
// The five authored fields stay TOP-LEVEL in the wire body on the generic route
// too, even though the record and the event nest them under `payload`: the wire
// body is an AUTHORING surface, not the event. The writer is the one place the
// authoring shape becomes the payload shape (S11·U2), and moving that mapping
// out here would make two places responsible for it.
const createBodyCommonShape = {
  // Over the cap → the whole body fails to parse → 400 with **NO EVENT**, the
  // same idiom every other malformed proposal follows (a proposal that was never
  // a proposal writes nothing). Optional: creation without a title still
  // succeeds exactly as it did before step 9.
  title: z.string().max(MAX_TASK_TITLE_LENGTH).optional(),
  createdBy: z.enum(CREATED_BY_VALUES),
  isolation: z.enum(ISOLATION_VALUES).default('worktree'),
  gates: taskGatesSchema.optional(),
  // ── S7·2a: the four AUTHORED work-order fields, bounded (see caps above) ─────
  //
  // ⚠ THE ACCEPTANCE-CRITERION INPUT SHAPE IS `{ text }` — TEXT ONLY, NO id. The
  // id is MINTED SERVER-SIDE in `InstanceWriter.createInstance` from the injected id
  // source; the client/form never supplies it (see the CreateInstanceInput note in
  // instanceWriter.ts). The record/event shape is `{ id, text }`; these are
  // deliberately different and must not be unified. Each field is optional, so an
  // unauthored creation still succeeds exactly as it did before slice 7.
  scope: z.string().min(1).max(MAX_WORK_ORDER_TEXT).optional(),
  explicitlyOut: z.array(z.string().min(1).max(MAX_WORK_ORDER_LINE)).max(MAX_LIST_ITEMS).optional(),
  acceptanceCriteria: z
    .array(z.object({ text: z.string().min(1).max(MAX_WORK_ORDER_LINE) }))
    .max(MAX_LIST_ITEMS)
    .optional(),
  killCriterion: z.string().min(1).max(MAX_WORK_ORDER_TEXT).optional(),
};

// POST /api/tasks body — THE ALIAS SPELLING (q24), byte-identical to what
// shipped: `projectRoot` and `stage`, with the same defaults and the same caps.
//
// Exported for the S7·3 drift guard ONLY (instanceApi.test.ts), which binds
// `WORK_ORDER_FIELD_DESCRIPTORS` to this schema's shape, optionality, and caps so
// the served descriptor can never drift from what the route actually validates.
// It stays bound to THIS schema (rather than the generic twin) because the
// descriptor is served on the alias path `/api/tasks/work-order-schema`, which
// the deployed UI reads.
export const createTaskBodySchema = z.object({
  projectRoot: z.string(),
  // OPTIONAL, not `.default('backlog')` — S12·U2. The wire contract is UNCHANGED
  // (a body that omits it still creates on the starting node, a body that names
  // one is still validated against the record vocabulary); what moved is WHERE
  // the absent case is filled in, from this constant to the surface that can see
  // the boot-resolved `workflow.initial`.
  stage: z.enum(TASK_STAGE_VALUES).optional(),
  ...createBodyCommonShape,
});

// POST /api/instances body — THE CONTRACT. Same fields, same caps, same
// defaults; `projectRoot`→`project` and `stage`→`node`, which are exactly the
// two renames q13's core field list makes.
export const createInstanceBodySchema = z.object({
  project: z.string(),
  node: z.enum(TASK_STAGE_VALUES).optional(),
  ...createBodyCommonShape,
});

// What both create bodies carry once the two renamed location fields are set
// aside. Derived from the alias schema rather than hand-written, so it cannot
// drift from what is actually validated.
type CreateBodyCommonFields = Omit<z.infer<typeof createTaskBodySchema>, 'projectRoot' | 'stage'>;

// ── S7·3: the work-order authoring descriptor (SINGLE SOURCE, served) ─────────
//
// The board's create sheet renders the four authored work-order fields from THIS
// descriptor rather than a hand-mirrored field list in the UI — see
// `WorkOrderSchemaResponse` above for why it is served and not imported. The
// point of the exercise is ONE definition: every cap here is the SAME const
// `createTaskBodySchema` validates against (MAX_WORK_ORDER_TEXT / _LINE /
// MAX_LIST_ITEMS), so a future cap change touches one place, and the drift test
// in instanceApi.test.ts binds this array to the schema (same keys, same
// optionality, same caps) so the two cannot diverge unnoticed.
//
// The `kind` tells the form HOW to render:
//   • longtext      → a <textarea> (the prose fields, scope / killCriterion).
//   • list          → repeatable plain-string rows (explicitlyOut lines).
//   • criteria-list → repeatable rows, each ONE criterion's TEXT. The id is
//     minted server-side in InstanceWriter.createInstance; the form sends `{ text }`
//     only (S7·2a), which is why this is a distinct kind from `list`.
export interface WorkOrderFieldDescriptor {
  key: 'scope' | 'explicitlyOut' | 'acceptanceCriteria' | 'killCriterion';
  kind: 'longtext' | 'list' | 'criteria-list';
  label: string;
  // One-line authoring guidance shown under the field. This is REAL UX (D43): a
  // work-order authored on the board is the schema's first ergonomic test, and
  // this copy is the scaffolding that makes it bearable.
  help: string;
  maxLength?: number; // longtext → MAX_WORK_ORDER_TEXT
  maxItems?: number; // list / criteria-list → MAX_LIST_ITEMS
  itemMaxLength?: number; // list item / criterion text → MAX_WORK_ORDER_LINE
}

export const WORK_ORDER_FIELD_DESCRIPTORS: readonly WorkOrderFieldDescriptor[] = [
  {
    key: 'scope',
    kind: 'longtext',
    label: 'Scope',
    help: 'What this task builds — the vertical slice in a sentence or two. Concrete beats grand.',
    maxLength: MAX_WORK_ORDER_TEXT,
  },
  {
    key: 'explicitlyOut',
    kind: 'list',
    label: 'Explicitly out',
    help: 'One exclusion per line. Naming what you are NOT doing makes scope creep a diff against a list.',
    maxItems: MAX_LIST_ITEMS,
    itemMaxLength: MAX_WORK_ORDER_LINE,
  },
  {
    key: 'acceptanceCriteria',
    kind: 'criteria-list',
    label: 'Acceptance criteria',
    help: 'One checkable outcome per line — the reviewer passes or fails each. Write what "done" looks like.',
    maxItems: MAX_LIST_ITEMS,
    itemMaxLength: MAX_WORK_ORDER_LINE,
  },
  {
    key: 'killCriterion',
    kind: 'longtext',
    label: 'Kill criterion',
    help: 'The observation that means stop and write a decision record — not push through. When is this task a mistake?',
    maxLength: MAX_WORK_ORDER_TEXT,
  },
];

// The move body, minus the renamed destination field. Shared by reference
// between the two surfaces for the same reason `createBodyCommonShape` is.
const moveBodyCommonShape = {
  manualReviewRequired: z.boolean().optional(),
  proposedBy: z.enum(PROPOSED_BY_VALUES),
  note: z.string().optional(),
};

// POST /api/tasks/:taskId/transitions body — THE ALIAS SPELLING (q24).
//
// ⚠ THE DESTINATION IS VALIDATED AS A PLAIN STRING, NOT THE STAGE ENUM, AND THAT
// IS DELIBERATE — on BOTH surfaces. Step 1 typed `task_transition_rejected`'s
// stage fields as `z.string()` precisely so an `unknown-stage` rejection stays
// RECORDABLE. If zod refused an unknown stage here, that rejection reason would
// become structurally unreachable through the API, I7 would lose a branch, and
// the one case where the record matters most (slice 7's hostile input) would
// produce a 400 with nothing written down. So an unknown stage is let through to
// `proposeTransition`, and the MACHINE refuses it — on the record.
const proposeTransitionBodySchema = z.object({
  toStage: z.string(),
  ...moveBodyCommonShape,
});

// POST /api/instances/:instanceId/moves body — THE CONTRACT. `toStage`→`toNode`,
// still a plain string, for the reason stated above.
const proposeMoveBodySchema = z.object({
  toNode: z.string(),
  ...moveBodyCommonShape,
});

type MoveBodyCommonFields = Omit<z.infer<typeof proposeTransitionBodySchema>, 'toStage'>;

// The payload-revision body (S7·2b), SHARED VERBATIM BY BOTH SURFACES — the four
// patchable fields and the author, spelled identically on the alias and on
// `/api/instances/:instanceId/payload-revisions`. Nothing in it names a node or a
// project, so the rename had nothing to touch.
//
// The PATCH half of `createTaskBodySchema`, bounded by the SAME caps — one policy
// for work-order text, whichever door it arrives through, so an amendment cannot
// smuggle in a scope the create route would have refused. Every work-order field
// is optional here; naming NONE of them is not a schema error but an
// `empty-amendment` (the writer's outcome, a 400 below), because "you sent a
// well-formed request that asks for nothing" is a different fact from "your body
// was not a request".
//
// ⚠ THE CRITERION SHAPE IS `{ id?, text }` — DIFFERENT FROM THE CREATE ROUTE'S
// `{ text }`, deliberately. On create there is nothing to keep, so every id is
// minted; on amend the caller RESTATES the criteria it is keeping, by the ids the
// record already carries, and the writer mints only for entries without one. That
// is what lets a reworded work order preserve the per-criterion identity
// `report_review` keys its verdicts to (see `RevisePayloadInput`).
//
// ⚠ THE AUTHOR FIELD IS STILL SPELLED `amendedBy` ON BOTH DOORS. The writer maps
// it to the payload's `revisedBy` (S11·U2); re-spelling the WIRE field is a
// change to a request contract, which belongs with the alias removal rather than
// with a unit whose whole point is that nothing observable changed.
const amendWorkOrderBodySchema = z.object({
  amendedBy: z.enum(AMENDED_BY_VALUES),
  scope: z.string().min(1).max(MAX_WORK_ORDER_TEXT).optional(),
  explicitlyOut: z.array(z.string().min(1).max(MAX_WORK_ORDER_LINE)).max(MAX_LIST_ITEMS).optional(),
  acceptanceCriteria: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        text: z.string().min(1).max(MAX_WORK_ORDER_LINE),
      }),
    )
    .max(MAX_LIST_ITEMS)
    .optional(),
  killCriterion: z.string().min(1).max(MAX_WORK_ORDER_TEXT).optional(),
});

// ── the surface descriptors ──────────────────────────────────────────────────
//
// A SURFACE is everything about a route that is NOT behaviour: how its body
// spells the location fields, where its id lives, and how its success envelope
// is shaped. Two surfaces per operation, one core. Anything you find yourself
// wanting to put in here that could answer a request DIFFERENTLY belongs in the
// core instead — that is the whole point of the split.

interface CreateSurface<BodyType extends CreateBodyCommonFields> {
  readonly schema: z.ZodType<BodyType, unknown>;
  readonly projectOf: (body: BodyType) => string;
  readonly nodeOf: (body: BodyType) => TaskStage;
  readonly created: (context: Context, record: TaskRecord) => Response;
}

interface MoveSurface<BodyType extends MoveBodyCommonFields> {
  readonly schema: z.ZodType<BodyType, unknown>;
  readonly toNodeOf: (body: BodyType) => string;
  readonly accepted: (
    context: Context,
    record: TaskRecord,
    dispatch: DispatchAttemptResult | undefined,
  ) => Response;
}

// The writer's still-task-shaped input, built ONCE from whichever body arrived.
// `projectRoot` is the RESOLVED path and the node is the surface's, so the two
// doors hand the writer literally the same object for equivalent requests.
//
// Absent stays absent, field by field, all the way down to the birth record —
// never `''`, never an `undefined`-valued key. The writer's payload assembly
// depends on that discipline (I6), so it is preserved here rather than
// re-derived.
function createInstanceInputFrom(
  body: CreateBodyCommonFields,
  resolvedProjectRoot: string,
  node: TaskStage,
): CreateInstanceInput {
  return {
    // The RESOLVED path, never the raw input — so the record cannot carry a
    // `..` segment or a symlink that resolves somewhere else later. The
    // allowlist is checked once, at the boundary; what gets persisted is what
    // was checked.
    projectRoot: resolvedProjectRoot,
    ...(body.title === undefined ? {} : { title: body.title }),
    createdBy: body.createdBy,
    isolation: body.isolation,
    // ⚠ STILL SPELLED `stage` ON THE WRITER'S INPUT (S11·U2's note): the writer
    // takes the task-shaped input and maps it to the generic payload at its own
    // emit. This route names the node; the writer names the event.
    stage: node,
    ...(body.gates === undefined ? {} : { gates: body.gates }),
    // The four AUTHORED work-order fields (S7·2a), passed straight through.
    // `acceptanceCriteria` is the `{ text }[]` INPUT shape here; the writer mints
    // each `{ id, text }` before it reaches the event.
    ...(body.scope === undefined ? {} : { scope: body.scope }),
    ...(body.explicitlyOut === undefined ? {} : { explicitlyOut: body.explicitlyOut }),
    ...(body.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: body.acceptanceCriteria }),
    ...(body.killCriterion === undefined ? {} : { killCriterion: body.killCriterion }),
  };
}

// The proposal, built ONCE from whichever body arrived.
function transitionProposalFrom(body: MoveBodyCommonFields, toNode: string): TransitionProposal {
  return {
    // ⚠ CAST ON PURPOSE, and the ONLY cast in this file. `TransitionProposal`
    // types `toStage` to the enum, but step 1 widened the machine's own check to
    // `string` precisely because a value outside the enum physically reaches it
    // across this boundary — TypeScript's guarantee stops at the wire. Refusing
    // it here instead would make `unknown-stage` unreachable (see the schema).
    toStage: toNode as TransitionProposal['toStage'],
    proposedBy: body.proposedBy,
    ...(body.manualReviewRequired === undefined
      ? {}
      : { manualReviewRequired: body.manualReviewRequired }),
    ...(body.note === undefined ? {} : { note: body.note }),
  };
}

// ── S12·U2 (F4): the stage-edges wire ORDER, frozen ──────────────────────────
//
// ⚠ **PRESENTATION ORDER ONLY. THIS CONSTANT DECIDES NOTHING.** It says in what
// sequence a stage's legal targets appear in `GET /api/tasks/stage-edges`, and
// that is all: an entry here that the DECLARATION does not declare is filtered
// out and never served, so this table can neither grant an edge nor keep a
// removed one alive. Legality lives in the declaration; a completeness tripwire
// in instanceApi.test.ts asserts the two agree as SETS, per stage, both
// directions.
//
// PROVENANCE: a literal copy of what `taskStageEdgesRecord()` returned at
// 2026-08-10, i.e. `TASK_STAGE_EDGES`'s own insertion order, captured at Move 3
// so the response stays BYTE-IDENTICAL across the flip while the deployed UI
// still reads it mid-alias-window (F4). The declaration groups its rows by
// intent and would order several stages differently.
//
// LIFESPAN: this dies with the route's generic twin (q25), where declaration
// introspection serves the full declared table and the order question is
// answered by the declaration itself. It is not a second source of legality and
// must never become one.
export const WIRE_STAGE_EDGE_ORDER: Record<TaskStage, readonly TaskStage[]> = {
  backlog: ['planning', 'blocked-external', 'cancelled'],
  planning: ['plan-ready', 'blocked-external', 'quarantined', 'backlog', 'cancelled'],
  'plan-ready': ['implementing', 'planning', 'blocked-external', 'backlog', 'cancelled'],
  implementing: ['review', 'blocked-external', 'quarantined', 'cancelled'],
  review: ['done', 'implementing', 'blocked-external', 'quarantined', 'cancelled'],
  done: [],
  'blocked-external': ['backlog', 'planning', 'plan-ready', 'implementing', 'review', 'cancelled'],
  quarantined: ['backlog', 'planning', 'implementing', 'blocked-external', 'cancelled'],
  cancelled: ['backlog'],
};

/**
 * The declared edge table, restricted to the record vocabulary — the MEMBERSHIP
 * half of the stage-edges response (S12-A4). Exported for the completeness
 * tripwire, which asserts this and `WIRE_STAGE_EDGE_ORDER` agree as sets.
 *
 * A row whose `from` or `to` is outside the nine stages is dropped: that is
 * exactly the tenth node (`manual-review`), which the record schema cannot hold
 * and no reachable path can put an instance on this slice.
 */
export function declaredStageEdgeMembership(
  workflow: ParsedWorkflow,
): Record<TaskStage, Set<TaskStage>> {
  const membership = {} as Record<TaskStage, Set<TaskStage>>;
  for (const stage of TASK_STAGE_VALUES) membership[stage] = new Set<TaskStage>();
  const recordVocabulary = z.enum(TASK_STAGE_VALUES);
  for (const edge of workflow.edges) {
    const from = recordVocabulary.safeParse(edge.from);
    const to = recordVocabulary.safeParse(edge.to);
    if (!from.success || !to.success) continue;
    membership[from.data].add(to.data);
  }
  return membership;
}

/**
 * The stage-edges response: DECLARED membership, WIRE order (F4). Keys are
 * emitted in the record vocabulary's own order, which is the order
 * `taskStageEdgesRecord()` emitted them in — `JSON.stringify` preserves
 * insertion order, so key order is part of the bytes this route promises.
 */
export function stageEdgesFromDeclaration(
  workflow: ParsedWorkflow,
): Record<TaskStage, TaskStage[]> {
  const membership = declaredStageEdgeMembership(workflow);
  const edges = {} as Record<TaskStage, TaskStage[]>;
  for (const stage of TASK_STAGE_VALUES) {
    edges[stage] = WIRE_STAGE_EDGE_ORDER[stage].filter((target) => membership[stage].has(target));
  }
  return edges;
}

// ── S12·U2: the declaration's starting node, narrowed to the record vocabulary ─
//
// `ParsedWorkflow.initial` is a plain declared string; `CreateInstanceInput.stage`
// is the nine-value record enum. This is the one place the two meet, and it
// THROWS rather than falling back — it runs at route registration (i.e. during
// `createDaemon`, before any listener binds), and a declaration whose starting
// node the record schema cannot hold is the same class of misbuild as a manifest
// that will not parse: every instance created under it would be unrecordable.
// Node-vocabulary relaxation is explicitly out of this slice (the record keeps
// its 9-stage enum), so the narrowing is honest rather than restrictive.
export function resolveInitialNode(workflow: ParsedWorkflow): TaskStage {
  const narrowed = z.enum(TASK_STAGE_VALUES).safeParse(workflow.initial);
  if (!narrowed.success) {
    throw new Error(
      `the resolved workflow "${workflow.id}" declares initial = "${workflow.initial}", which is not one of the record vocabulary's nodes (${TASK_STAGE_VALUES.join(', ')})`,
    );
  }
  return narrowed.data;
}

export function registerInstanceApi(app: Hono, deps: InstanceApiDeps): void {
  const realpath = deps.realpath ?? realpathProbe;
  // Resolved ONCE per registration, from the ONE injected declaration — the two
  // create doors below share it, so they cannot start instances on different
  // nodes (they are the same fact wearing two body spellings).
  const declaredInitialNode = resolveInitialNode(deps.workflow);

  // The instance record as the fold produced it, for the generic envelopes.
  //
  // ⚠ THE READ-BACK IS THE POINT, NOT A FORMALITY — the same I12 reasoning
  // `InstanceWriter.createInstance` states for its own: an envelope built by
  // hand would agree with itself by construction. A missing record here means
  // the log and the projection disagree, which is a rule-0.1 FINDING, so it
  // raises the writer's own error class and surfaces as the 500 below rather
  // than as a plausible-looking 200.
  const instanceRecordOf = (instanceId: string): InstanceRecord => {
    const instance = deps.readInstances().instances[instanceId];
    if (instance === undefined) {
      throw new InstanceProjectionDisagreementError(
        `the instances projection does not hold ${instanceId} immediately after a write that returned it`,
      );
    }
    return instance;
  };

  // ── the CREATE core ────────────────────────────────────────────────────────
  //
  // ⚠ THE SECURITY BOUNDARY IS THE PROJECT ROOT, AND IT IS LOAD-BEARING.
  // `sessionHost.spawnSession()` does NOT validate `cwd` — the only guard in the
  // daemon today is inside `wsHub.handleSpawn`, on the WS spawn path. An INSTANCE
  // is a DURABLE INSTRUCTION to spawn a Claude process in a directory, so an
  // unvalidated project root here would be an allowlist bypass WITH A PERSISTENCE
  // LAYER: written once, honoured by the dispatcher on every later attempt.
  //
  // The guard is `resolveWithinRoots` — the same symlink-aware helper the
  // file/git/search APIs share, against the same allowlist union — and a refusal
  // is a 403 with **NO EVENT EMITTED**. A refused creation must not leave an
  // instance-shaped record in the log.
  const handleCreate = async <BodyType extends CreateBodyCommonFields>(
    context: Context,
    surface: CreateSurface<BodyType>,
  ): Promise<Response> => {
    const parsedBody = await parseJsonBody(context.req.raw, surface.schema);
    if (!parsedBody.ok) {
      // 400: this was never a proposal. Nothing reached the writer, so there is
      // nothing to record — see the status-code note on the move core.
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    const resolvedProjectRoot = resolveWithinRoots(
      surface.projectOf(parsedBody.value),
      deps.getAllowedRoots(),
      realpath,
    );
    if (!resolvedProjectRoot.ok) {
      // No path echo, matching the file/git APIs: a refusal names the class of
      // failure and never confirms what does or does not exist outside the roots.
      return context.json({ error: 'forbidden', detail: resolvedProjectRoot.reason }, 403);
    }

    try {
      const created = deps.instanceWriter.createInstance(
        createInstanceInputFrom(
          parsedBody.value,
          resolvedProjectRoot.absolute,
          surface.nodeOf(parsedBody.value),
        ),
      );
      return surface.created(context, created);
    } catch (error) {
      return findingResponse(context, error);
    }
  };

  // ── the MOVE core (I7's route) ─────────────────────────────────────────────
  //
  // STATUS-CODE RATIONALE, WRITTEN DOWN BECAUSE SLICE 7 INHERITS IT:
  //
  //   • **409 = "the machine said no"**, and the rejection IS IN THE LOG. EVERY
  //     enumerated `TransitionRejectionReason` returns 409 — including
  //     `unknown-stage`. One code for "the machine refused" keeps clients (and
  //     slice 7's MCP client) reading the `reason` FIELD rather than branching on
  //     HTTP semantics we would then be obliged to keep stable forever.
  //   • **400 = "this was not a proposal"**, and NOTHING is in the log. The body
  //     never reached the state machine, so there is no proposal to record. A 400
  //     that evented would put proposals in the log that were never made.
  //   • **404 = "no such instance"**, nothing in the log — fabricating a rejection
  //     for an id no birth record introduced would put a phantom instance there.
  //
  // ── S7·7c: THIS ROUTE NOW PERFORMS AT MOST ONE DISPATCH ATTEMPT (D53) ────────
  //
  // D53's third category — *dispatch is MECHANICS* — says entering an ACTIVE stage
  // starts the work: *"Why would you move it to Implementing and NOT want it to
  // begin implementation? The promotion should be the decision."* So an ACCEPTED
  // transition that `shouldDispatchOnTransition` calls a promotion into `planning`
  // or `implementing` is followed by ONE `deps.dispatchTask` call, and the result
  // rides the 200 as an optional `dispatch` field.
  //
  // ⚠ THE ROUTE STILL DECIDES NOTHING (principle 10, and the file header above).
  // The predicate is core's, imported not re-derived; the attempt is the
  // dispatcher's; this handler only sequences the two and reports what came back.
  //
  // Boundaries, stated so none of them is re-litigated by accident:
  //   • **AT MOST ONE ATTEMPT, and no loop or retry** — a rejected transition
  //     attempts nothing, and an accepted one attempts exactly once. The dispatch
  //     route's own "one request, one attempt" contract below is UNCHANGED; this
  //     is a second caller of the same narrow function, not a second policy.
  //   • **CREATION NEVER AUTO-DISPATCHES.** A create with `node: 'planning'`
  //     writes a birth record and stops. A birth record is not a promotion —
  //     nobody decided anything by writing one — and moves are the only movement
  //     D53 gave to mechanics.
  //   • **REVIEW IS A HOLDING PEN**, so entering it starts nothing, and an OUTCOME
  //     edge (`proposedBy: 'dispatcher'` — a reported plan, completion or verdict)
  //     starts nothing either. The verdict bounce `review → implementing` therefore
  //     lands UN-dispatched; starting the fixer is the orchestrator's explicit
  //     dispatch call. No chaining, anywhere.
  const handleMove = async <BodyType extends MoveBodyCommonFields>(
    context: Context,
    // The id comes from the REGISTRATION, where the route pattern types it — the
    // one thing a surface descriptor cannot carry, because a `Context` that has
    // forgotten its path pattern has also forgotten that `:taskId` is always
    // present. The two path params are the only difference.
    instanceId: string,
    surface: MoveSurface<BodyType>,
  ): Promise<Response> => {
    const parsedBody = await parseJsonBody(context.req.raw, surface.schema);
    if (!parsedBody.ok) {
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    const proposal = transitionProposalFrom(parsedBody.value, surface.toNodeOf(parsedBody.value));

    try {
      const result = deps.instanceWriter.proposeMove(instanceId, proposal);
      switch (result.outcome) {
        case 'unknown-task':
          return context.json({ error: 'not found' }, 404);
        case 'rejected': {
          // The writer ALREADY emitted the `instance_move_rejected`. This branch
          // only reports it — I7 is satisfied by the record, not by this response.
          // The envelope carries no record, so BOTH surfaces answer with the same
          // bytes here; the rejection is a fact about the proposal, not about a
          // spelling.
          const response: ProposeTransitionResponse = { accepted: false, reason: result.reason };
          return context.json(response, 409);
        }
        case 'accepted': {
          // ⚠ READ THE MACHINE'S RESULTING NODE, NOT THE PROPOSAL'S. The recorded
          // edge is the edge THE MACHINE ACCEPTED; the proposal is only what was
          // asked for, and it crossed the wire as an unvalidated string (see the
          // cast above). Asking the predicate about the proposal would be asking
          // about a node the instance may not be on.
          const dispatch = shouldDispatchOnTransition({
            toStage: result.task.stage,
            proposedBy: proposal.proposedBy,
          })
            ? await deps.dispatchTask(instanceId)
            : undefined;
          // ⚠ **EVERY DISPATCH OUTCOME RIDES THE 200 VERBATIM** — `refused`,
          // `deferred`, `spawn-failed`, `worktree-failed`, `in-flight`, and even
          // `unknown-task` (unreachable here, since the instance just moved, but
          // carried honestly rather than translated if it ever appears). Two facts
          // happened and both are reported: **the move was ACCEPTED and is in the
          // log**, and the dispatch attempt did whatever it did. Turning a refused
          // dispatch into a 4xx would retroactively deny an accepted, evented move,
          // and would push clients toward retry machinery for what is really "here
          // is what happened" — the same rationale the dispatch core below states
          // for its own 200-with-the-envelope convention.
          return surface.accepted(context, result.task, dispatch);
        }
      }
    } catch (error) {
      return findingResponse(context, error);
    }
  };

  // ── the PAYLOAD-REVISION core (S7·2b, D43) ─────────────────────────────────
  //
  // Plural noun on both doors: the collection this POST appends to is the
  // instance's revision history, and D43's whole discipline is that a work order
  // is corrected by APPENDING a revision rather than editing the record — which
  // is also why this is not a PATCH on the instance.
  //
  // The status codes, in the same vocabulary the move core established:
  //   • **200 + the record** — revised, and the record is the FOLD (see
  //     `AmendWorkOrderResponse`). Not a 201: the thing a client cares about is
  //     the instance's new state, and there is no per-revision resource to point a
  //     `Location` at — the event lives in the log, which is not addressable here.
  //   • **404** — no such instance, nothing written.
  //   • **400 + the offending id** — a criterion id that is not on the record's
  //     current list. The id IS echoed, unlike the 403's path suppression on the
  //     create core: it came from the caller's own body and names nothing outside
  //     the instance, so returning it is how a form tells the human WHICH row is
  //     stale.
  //   • **400** — a revision that names no work-order field at all. A rev bump
  //     that changes nothing is log noise; the writer refuses it and writes
  //     nothing.
  //
  // ⚠ **NO DISPATCH CALL ANYWHERE IN THIS CORE, AND THAT IS THE POINT** (D53).
  // Its sibling above calls `shouldDispatchOnTransition` because a promotion IS a
  // decision to start work; a revision is not — it changes what the work order
  // SAYS, and whether the running (or next) attempt should be re-run against the
  // new revision is a separate decision, taken with an explicit dispatch call.
  // No chaining, here or anywhere.
  const handlePayloadRevision = async (
    context: Context,
    instanceId: string,
    revised: (context: Context, record: TaskRecord) => Response,
  ): Promise<Response> => {
    const parsedBody = await parseJsonBody(context.req.raw, amendWorkOrderBodySchema);
    if (!parsedBody.ok) {
      // 400: this was never a revision. Nothing reached the writer, so there is
      // nothing to record — the same idiom as the create/move cores.
      return context.json({ error: 'bad request', detail: parsedBody.reason }, 400);
    }

    try {
      const result = deps.instanceWriter.revisePayload(instanceId, {
        amendedBy: parsedBody.value.amendedBy,
        // Absent stays absent all the way down to the event — and here the fold
        // READS that absence to decide what to leave alone, so an `undefined`-valued
        // key would not merely be untidy, it would change the revision's meaning.
        ...(parsedBody.value.scope === undefined ? {} : { scope: parsedBody.value.scope }),
        ...(parsedBody.value.explicitlyOut === undefined
          ? {}
          : { explicitlyOut: parsedBody.value.explicitlyOut }),
        ...(parsedBody.value.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: parsedBody.value.acceptanceCriteria }),
        ...(parsedBody.value.killCriterion === undefined
          ? {}
          : { killCriterion: parsedBody.value.killCriterion }),
      });
      switch (result.outcome) {
        case 'unknown-task':
          return context.json({ error: 'not found' }, 404);
        case 'unknown-criterion':
          return context.json(
            { error: 'bad request', detail: 'unknown-criterion', criterionId: result.criterionId },
            400,
          );
        case 'empty-amendment':
          return context.json({ error: 'bad request', detail: 'empty-amendment' }, 400);
        case 'amended':
          return revised(context, result.task);
      }
    } catch (error) {
      return findingResponse(context, error);
    }
  };

  // ── the DISPATCH core — ONE explicit attempt ───────────────────────────────
  //
  // Calls `TaskDispatcher.dispatchTask(instanceId)` EXACTLY ONCE. **No loop, no
  // timer, no scheduling** — step 4a's boundary holds unchanged: scheduling policy,
  // and the event-spam question that arrives with a polling loop, is deliberately
  // out of this slice step. One request, one attempt.
  //
  // CONVENTION: **200 + the `DispatchAttemptResult` envelope for every honest
  // outcome** — `spawned`, `deferred`, `refused` and `spawn-failed` alike. This
  // mirrors `/api/usage/refresh` (documented in app.ts): a refusal is a complete,
  // honest answer rather than an HTTP error, and 4xx-ing it would push clients
  // toward retry/backoff machinery for what is really "here is what happened."
  // The one exception is an unknown instance — there was nothing to attempt.
  //
  // ⚠ The handler is ASYNC as of step 8 (worktree creation is a subprocess). Hono
  // handlers may be async, and the ENVELOPE IS UNCHANGED: same 200, same
  // `{ result }` body, same 404 for an unknown instance. Step 8's new
  // `worktree-failed` outcome rides the SAME 200 envelope as its sibling
  // `spawn-failed`, for the same reason — it is a complete, honest answer about
  // what happened, not an HTTP error.
  //
  // ⚠ NOT PARAMETERISED BY SURFACE, AND THAT IS THE FINDING RATHER THAN AN
  // OVERSIGHT: the dispatch result vocabulary is already engine-shaped and
  // workflow-blind, so the alias and the generic twin return literally the same
  // bytes. There is nothing here to re-spell.
  const handleDispatch = async (context: Context, instanceId: string): Promise<Response> => {
    const result = await deps.dispatchTask(instanceId);
    if (result.outcome === 'unknown-task') {
      return context.json({ error: 'not found' }, 404);
    }
    const response: DispatchResponse = { result };
    return context.json(response, 200);
  };

  // ── the generic routes — THE CONTRACT ──────────────────────────────────────

  app.post('/api/instances', async (context) =>
    handleCreate(context, {
      schema: createInstanceBodySchema,
      projectOf: (body) => body.project,
      // The declaration's `initial` fills the absent case (S12·U2) — the SAME
      // resolved value the alias door below uses.
      nodeOf: (body) => body.node ?? declaredInitialNode,
      created: (responseContext, record) => {
        const response: CreateInstanceResponse = { instance: instanceRecordOf(record.taskId) };
        return responseContext.json(response, 201);
      },
    }),
  );

  app.post('/api/instances/:instanceId/moves', async (context) =>
    handleMove(context, context.req.param('instanceId'), {
      schema: proposeMoveBodySchema,
      toNodeOf: (body) => body.toNode,
      accepted: (responseContext, record, dispatch) => {
        const response: ProposeMoveResponse = {
          accepted: true,
          instance: instanceRecordOf(record.taskId),
          // Spread rather than set: ABSENT stays absent on a non-promoting move,
          // exactly as on the alias.
          ...(dispatch === undefined ? {} : { dispatch }),
        };
        return responseContext.json(response, 200);
      },
    }),
  );

  app.post('/api/instances/:instanceId/payload-revisions', async (context) =>
    handlePayloadRevision(context, context.req.param('instanceId'), (responseContext, record) => {
      const response: RevisePayloadResponse = { instance: instanceRecordOf(record.taskId) };
      return responseContext.json(response, 200);
    }),
  );

  app.post('/api/instances/:instanceId/dispatch', async (context) =>
    handleDispatch(context, context.req.param('instanceId')),
  );

  // ── the ALIAS routes — deprecated, ONE DEPLOY (q24) ────────────────────────
  //
  // Each of the four below is the SAME core as its generic twin above, wearing
  // the legacy body spelling and the legacy response key. They exist so the
  // DEPLOYED UI keeps working, unrestarted and untouched, through this slice's
  // daemon deploy; they are deleted in the daemon deploy after the UI unit
  // switches to the generic paths. See the full alias inventory in the file
  // header.

  // ALIAS (q24) — twin of POST /api/instances.
  app.post('/api/tasks', async (context) =>
    handleCreate(context, {
      schema: createTaskBodySchema,
      projectOf: (body) => body.projectRoot,
      nodeOf: (body) => body.stage ?? declaredInitialNode,
      created: (responseContext, record) => {
        const response: CreateTaskResponse = { task: record };
        return responseContext.json(response, 201);
      },
    }),
  );

  // ALIAS (q24) — twin of POST /api/instances/:instanceId/moves.
  app.post('/api/tasks/:taskId/transitions', async (context) =>
    handleMove(context, context.req.param('taskId'), {
      schema: proposeTransitionBodySchema,
      toNodeOf: (body) => body.toStage,
      accepted: (responseContext, record, dispatch) => {
        const response: ProposeTransitionResponse = {
          accepted: true,
          task: record,
          // Spread rather than set: ABSENT stays absent on a non-promoting
          // transition, so its envelope is byte-identical to the pre-S7·7c one.
          ...(dispatch === undefined ? {} : { dispatch }),
        };
        return responseContext.json(response, 200);
      },
    }),
  );

  // ALIAS (q24) — twin of POST /api/instances/:instanceId/payload-revisions.
  app.post('/api/tasks/:taskId/amendments', async (context) =>
    handlePayloadRevision(context, context.req.param('taskId'), (responseContext, record) => {
      const response: AmendWorkOrderResponse = { task: record };
      return responseContext.json(response, 200);
    }),
  );

  // ALIAS (q24) — twin of POST /api/instances/:instanceId/dispatch. The response
  // is identical on both paths (see the dispatch core), so this alias differs
  // from its twin in the URL and nothing else.
  app.post('/api/tasks/:taskId/dispatch', async (context) =>
    handleDispatch(context, context.req.param('taskId')),
  );

  // ── GET /api/tasks/stage-edges — the legal-edge table (S8) ──────────────────
  //
  // Wes ruled 2026-07-24: the move sheet must offer only LEGAL next stages, not
  // every stage — but the UI must not gain a second copy of `TASK_STAGE_EDGES` to
  // do it (principle 9: one source of record per fact). So the table is SERVED
  // from here, behind the same auth wall as every other route on this app, and
  // the board fetches it instead of re-declaring it. Static, read-only, events
  // nothing — `taskStageEdgesRecord()` is a pure derivation of core's own table.
  //
  // This does NOT reopen the "no `GET /api/tasks`" decision below: that route
  // would be a second reader of TASK STATE (the projection already serves it).
  // This route serves the TRANSITION RULES, a fact nothing else exposes.
  //
  // ⚠ MOVED VERBATIM, OLD PATH ONLY, AND NO GENERIC TWIN THIS SLICE (q25).
  // Generalising this route means serving DECLARATION INTROSPECTION over the
  // FULL declared table (the tenth node's out-edges included) and giving the
  // route its generic twin — deferred to q25, whose trigger is now half-armed:
  // a pinned declaration exists as of this unit; the route shape question does
  // not.
  //
  // ─── S12·U2 (D72 Move 3): DERIVED FROM THE DECLARATION, WIRE-STABLE (F4) ────
  //
  // The response is now computed from `deps.workflow` — the same declaration the
  // adjudicator reads — instead of from the compiled `taskStageEdgesRecord()`.
  // Two rules, and the split between them is the whole of F4:
  //
  //   • LEGALITY (membership) comes from the DECLARATION, restricted to the nine
  //     stages the record vocabulary holds. That restriction drops exactly the
  //     tenth node's rows (`manual-review`, unreachable upstream by schema
  //     fencing this slice) and nothing else.
  //   • PRESENTATION (order) comes from the frozen constant below. The
  //     declaration groups its edges by INTENT — the spine, then the review/fix
  //     loop, then quarantine, then the park — which does not reproduce the
  //     hand-ordered arrays this route has served since S8 (`review` declares
  //     `quarantined` before `blocked-external`; the wire has them the other way
  //     round). Deriving order from the declaration would change the bytes the
  //     DEPLOYED UI reads, mid-alias-window, for no behavioural reason.
  app.get('/api/tasks/stage-edges', (context) => {
    const response: StageEdgesResponse = { edges: stageEdgesFromDeclaration(deps.workflow) };
    return context.json(response);
  });

  // ── GET /api/tasks/work-order-schema — the authoring descriptor (S7·3) ──────
  //
  // The exact sibling of `stage-edges`: static, read-only, events nothing, behind
  // the same auth wall. The board's create sheet fetches this and renders the
  // four authored work-order fields from it, so the UI reflects the field shape
  // without a second copy of it (principle 9). The descriptor is derived from the
  // SAME caps `createTaskBodySchema` validates against; the drift test in
  // instanceApi.test.ts is the guard that they never fall out of step.
  //
  // ⚠ MOVED VERBATIM, OLD PATH ONLY, AND NO GENERIC TWIN THIS SLICE (q25) — the
  // same fence as `stage-edges` above, and for the same reason: the generic form
  // of "what may be authored here" is a NODE-KIND declaration's payload schema,
  // which Move 3+ pins. Until then this descriptor describes the tasks
  // extension's work order, and the tasks extension does not exist yet either
  // (q29).
  app.get('/api/tasks/work-order-schema', (context) => {
    const response: WorkOrderSchemaResponse = { fields: WORK_ORDER_FIELD_DESCRIPTORS };
    return context.json(response);
  });

  // ── NO `GET /api/instances` (and no `GET /api/tasks`) — deliberately ───────
  //
  // `GET /api/projections/tasks` already serves instance state (as the legacy
  // view, S11·U1), behind the same auth wall, and the kanban UI (step 9) reads
  // it. A second reader of the same fact is exactly the drift principle 9
  // forbids, and rule 0.5 says machinery waits for its consumer. Nothing in this
  // unit needed one — and inventing one HERE, in the unit whose contract is "the
  // aliases answer exactly as they did", is how an alias window grows a feature.
}

// ── boundary helpers ─────────────────────────────────────────────────────────

type ParseResult<ValueType> =
  | { ok: true; value: ValueType }
  | { ok: false; reason: 'invalid-json' | 'schema' };

// Read + validate a JSON body. TOTAL: unparseable bytes, a non-object body and a
// schema mismatch are all classified refusals, never a throw (I8) — a daemon that
// crashes on a malformed body is a daemon a single bad client can take down.
// The classified reason is returned; the offending VALUE never is (it would echo
// hostile input straight back to the caller).
async function parseJsonBody<OutputType>(
  request: Request,
  schema: z.ZodType<OutputType, unknown>,
): Promise<ParseResult<OutputType>> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, reason: 'schema' };
  }
  return { ok: true, value: parsed.data };
}

// A projection/log divergence is a rule-0.1 FINDING, not a request error: the
// event was written and the fold did not produce the record it describes. It
// surfaces as a 500 carrying the finding — never a plausible-looking 200 — which
// is the same posture `GET /api/cost/ledger` already takes for a tree that fails
// to reconcile. Any other throw is re-raised: swallowing an unknown failure here
// would turn a bug into a quiet wrong answer.
//
// ⚠ THE BODY IS SHARED BY BOTH SURFACES, WORD FOR WORD — including the string
// `'task store finding'`. The alias contract is byte-identity with what shipped,
// and giving the generic twin a differently-worded 500 would be the one place the
// two surfaces answered differently. Re-spelling it belongs with the alias
// removal, which is the last moment both spellings exist.
function findingResponse(context: Context, error: unknown): Response {
  if (error instanceof InstanceProjectionDisagreementError) {
    return context.json({ error: 'task store finding', detail: error.message }, 500);
  }
  throw error;
}
