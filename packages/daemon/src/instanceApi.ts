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
  type WorkflowRef,
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
// routes are the surface the system is built on. Through S13·U3 the deprecated
// task-alias paths (`POST .../tasks`, `.../tasks/:taskId/transitions`,
// `.../amendments`, `.../dispatch`) survived for exactly one deploy of overlap
// (q24) — `taskApi.ts` was deleted in the SAME unit that opened the alias
// window, D72's governing rule being that a unit which leaves both paths live
// is not finished.
//
// ─── S13·U4 (D72 Move 4) — THE ALIAS WINDOW CLOSED, q24 IS DONE ──────────────
//
// The one deploy of overlap happened, the UI unit (S13·U3) switched every call
// site to the generic routes, and this unit deleted the four write aliases,
// the two read aliases (the legacy stage-edges and work-order-schema GETs —
// their generalisation, q25's declaration-introspection routes below, shipped
// in S13·U2, so nothing here waits on a Move-3+ pin any more),
// `WIRE_STAGE_EDGE_ORDER`, and the legacy tasks-projection alias branch
// (app.ts). No deprecated task-alias path and no stage-edges/work-order-schema
// route answers from this file any more — see `registerInstanceApi` below for
// the surviving, purely generic surface.
//
// ⚠ ONE HANDLER CORE PER OPERATION SURVIVES THE ALIAS'S DEATH. The create/move/
// payload-revision/dispatch cores below (`handleCreate`, `handleMove`,
// `handlePayloadRevision`, `handleDispatch`) were written to be surface-generic
// from S11·U2 on — the alias was ONE registration calling the same core, not a
// separate implementation — so deleting the alias registration removed a
// caller, not a behaviour. Everything the alias contract tested is still true
// of the generic route it shared code with.

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
  // the compiled `INITIAL_TASK_STAGE`) and `workflow.edges`/`.nodes`/
  // `.forbidden` (served VERBATIM by the q25 declaration route below — the
  // legacy `stage-edges` route's record-vocabulary-narrowed membership died
  // with it, S13·U4). This file still decides nothing.
  workflow: ParsedWorkflow;
  // ── S13·U2 (q25) — the declaration's own identity ──────────────────────────
  //
  // The SAME ref `instanceWriter` stamps on every birth record (app.ts hands
  // both the writer and this surface `shippedWorkflow.ref`), read here for
  // exactly one thing: the exact-match key the two declaration-introspection
  // routes below serve against. Never derived from the path params — a
  // request is answered FROM this pinned identity or refused, never the other
  // way round (slice-13 F3 ⟨signed⟩).
  workflowRef: WorkflowRef;
  // Injected realpath probe (fs boundary). Defaults to the real one; mirrors
  // FileApiDeps / GitApiDeps.
  realpath?: RealpathProbe;
}

// ── the wire contract — GENERIC, ONE SURFACE (the alias half died S13·U4) ────
//
// Through S13·U3 this section had a legacy half (every type whose success key
// was `task`, byte-identical to what the deployed UI parsed) and this generic
// half. The alias window closed and the legacy half is DELETED, along with the
// deprecated task-alias route registrations that were its only caller — see
// the file header.

export interface CreateInstanceResponse {
  instance: InstanceRecord;
}
export type ProposeMoveResponse =
  | {
      accepted: true;
      instance: InstanceRecord;
      // ── S7·7c: THE DISPATCH-ON-PROMOTION RIDER (D53), OPTIONAL ON PURPOSE ─────
      //
      // Present ONLY when the accepted edge was a PROMOTION INTO AN ACTIVE STAGE
      // and the route therefore made one dispatch attempt. On every other accepted
      // transition — an outcome edge, a move into a non-active stage — the key is
      // ABSENT, not `undefined`.
      //
      // It carries the dispatcher's own result VERBATIM, whatever it says. See the
      // route for why a `refused` / `spawn-failed` dispatch still rides a 200.
      dispatch?: DispatchAttemptResult;
    }
  // S13·U1: the 409 body PASSES THE STRING THROUGH. `reason` is whatever the
  // adjudicator authored — one of the engine's four node-spelled refusals, or the
  // pinned declaration's own forbidden-row string (slice-13 F1's two channels).
  // Narrowing it here would put a closed vocabulary back on the wire one layer
  // out from the record that deliberately dropped it.
  | { accepted: false; reason: string };
export interface DispatchResponse {
  result: DispatchAttemptResult;
}
// S7·2b. The record **as the projection folded it**, so a client reads the
// amendment's real effect (including the bumped `payloadRev`) rather than an
// echo of what it asked for.
export interface RevisePayloadResponse {
  instance: InstanceRecord;
}

// ── S13·U2 (q25) — declaration introspection, workflow-keyed (F3 ⟨signed⟩) ────
//
// The generic twins the legacy `stage-edges` and `work-order-schema` routes
// never got when THIS comment was first written (slice 12's header explained
// why: they needed a pinned declaration to introspect, and Move 3 is what pins
// one) shipped here in S13·U2 — and S13·U4 deleted the legacy routes they
// replace, closing q24/q25 together. Both routes key on the declaration's own
// identity — `extension`/`workflow`/`rev`, the SAME ref Move 3 stamps on every
// instance — not on an instance id: introspection is a property of the
// DECLARATION, so N instances of one workflow cost a client one fetch, not N
// (F3 rider 2), and an unknown-workflow renderer can answer from a ref alone
// (F3 rider 3, the D76 dependency).

/**
 * The wire form of one declared node — narrowed FROM `ParsedWorkflowNode`, not
 * equal to it. `title` is omitted (not `null`/`undefined`) when the node
 * declares none, so an unlabelled node does not put a nullish key on the wire.
 */
interface WorkflowDeclarationNode {
  id: string;
  kind: string;
  title?: string;
}

export interface WorkflowDeclarationResponse {
  ref: WorkflowRef;
  workflow: {
    id: string;
    title: string;
    initial: string;
    nodes: readonly WorkflowDeclarationNode[];
    // EXPANDED, verbatim — `ParsedWorkflow.edges` exactly as the adjudicator
    // reads it, ordering included (the declaration's own order IS the wire
    // order; no `WIRE_STAGE_EDGE_ORDER` here). Every row rides along, including
    // ones whose `from`/`to` sit outside the nine-stage record enum (the tenth
    // node, `manual-review`) — that is the FULL declared table q25 promised,
    // in contrast to the legacy `stage-edges` route's record-vocabulary
    // narrowing.
    edges: ParsedWorkflow['edges'];
    forbidden: ParsedWorkflow['forbidden'];
  };
}

export interface WorkflowPayloadSchemaResponse {
  ref: WorkflowRef;
  fields: readonly WorkOrderFieldDescriptor[];
}

// ── S13·U2b (q25 addendum, added 2026-08-12 at U3 recon) — the DISCOVERY half ─
//
// The two ref-keyed routes above have no discovery half: at zero instances a
// client holds no ref to key them with. `GET /api/workflows` is that half —
// the index of declarations this daemon resolves. Today that is exactly one
// entry (the boot-resolved declaration); the array is the rule-0.5
// reservation for the multi-workflow future, not a claim that more exist yet.
export interface WorkflowIndexResponse {
  workflows: ReadonlyArray<{ ref: WorkflowRef }>;
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
// Through S13·U3 this was ONE SET OF FIELD SCHEMAS, SHARED BY REFERENCE between
// the alias body and the generic body — they differed in EXACTLY two keys
// (`projectRoot`→`project`, `stage`→`node`), everything else the literal same
// schema object, so a cap change, an added field or a tightened enum landed on
// both doors at once (principle 9). S13·U4 deleted the alias's door; the shared
// shape itself is unchanged and unmoved — there was never a second copy to prune.
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

// POST /api/instances body — THE CONTRACT. Through S13·U3 this shared the
// `createBodyCommonShape` fields with the alias schema `createTaskBodySchema`
// (`projectRoot`/`stage` rather than `project`/`node` — the two renames q13's
// core field list made); S13·U4 deleted the alias schema with the route that
// was its only caller. `createBodyCommonShape` itself survives unrenamed and
// unmoved — it was always the shared source, never alias-specific.
export const createInstanceBodySchema = z.object({
  project: z.string(),
  // OPTIONAL, not `.default('backlog')` — S12·U2. The wire contract is UNCHANGED
  // (a body that omits it still creates on the starting node, a body that names
  // one is still validated against the record vocabulary); what moved is WHERE
  // the absent case is filled in, from this constant to the surface that can see
  // the boot-resolved `workflow.initial`.
  node: z.enum(TASK_STAGE_VALUES).optional(),
  ...createBodyCommonShape,
});

// What the create body carries once the renamed location fields are set
// aside. Derived from the schema rather than hand-written, so it cannot drift
// from what is actually validated.
type CreateBodyCommonFields = Omit<z.infer<typeof createInstanceBodySchema>, 'project' | 'node'>;

// ── S7·3: the work-order authoring descriptor (SINGLE SOURCE, served) ─────────
//
// The board's create sheet renders the four authored work-order fields from THIS
// descriptor rather than a hand-mirrored field list in the UI — see
// `WorkflowPayloadSchemaResponse` above for why it is served and not imported.
// The point of the exercise is ONE definition: every cap here is the SAME const
// `createInstanceBodySchema` validates against (MAX_WORK_ORDER_TEXT / _LINE /
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

// The move body, minus the renamed destination field. Through S13·U3 this was
// shared by reference between the alias (`proposeTransitionBodySchema`,
// deleted S13·U4) and the generic surface below; the shared shape itself was
// never alias-specific and survives unmoved.
const moveBodyCommonShape = {
  manualReviewRequired: z.boolean().optional(),
  proposedBy: z.enum(PROPOSED_BY_VALUES),
  note: z.string().optional(),
};

// POST /api/instances/:instanceId/moves body — THE CONTRACT.
//
// ⚠ THE DESTINATION IS VALIDATED AS A PLAIN STRING, NOT THE STAGE ENUM, AND THAT
// IS DELIBERATE. Step 1 typed `task_transition_rejected`'s stage fields as
// `z.string()` precisely so an `unknown-node` rejection stays RECORDABLE. If zod
// refused an unknown stage here, that rejection reason would become structurally
// unreachable through the API, I7 would lose a branch, and the one case where
// the record matters most (slice 7's hostile input) would produce a 400 with
// nothing written down. So an unknown stage is let through to the writer, and
// the DECLARATION-READING ADJUDICATOR refuses it — on the record.
const proposeMoveBodySchema = z.object({
  toNode: z.string(),
  ...moveBodyCommonShape,
});

type MoveBodyCommonFields = Omit<z.infer<typeof proposeMoveBodySchema>, 'toNode'>;

// The payload-revision body (S7·2b), for `/api/instances/:instanceId/payload-
// revisions`. Nothing in it names a node or a project, so the alias/generic
// rename never touched it — this was the ONE body shared VERBATIM by both
// surfaces through S13·U3, and it is unchanged by the alias's S13·U4 deletion.
//
// The PATCH half of `createInstanceBodySchema`, bounded by the SAME caps — one
// policy for work-order text, whichever door it arrives through, so an
// amendment cannot smuggle in a scope the create route would have refused.
// Every work-order field is optional here; naming NONE of them is not a schema
// error but an `empty-amendment` (the writer's outcome, a 400 below), because
// "you sent a well-formed request that asks for nothing" is a different fact
// from "your body was not a request".
//
// ⚠ THE CRITERION SHAPE IS `{ id?, text }` — DIFFERENT FROM THE CREATE ROUTE'S
// `{ text }`, deliberately. On create there is nothing to keep, so every id is
// minted; on amend the caller RESTATES the criteria it is keeping, by the ids the
// record already carries, and the writer mints only for entries without one. That
// is what lets a reworded work order preserve the per-criterion identity
// `report_review` keys its verdicts to (see `RevisePayloadInput`).
//
// ⚠ THE AUTHOR FIELD IS STILL SPELLED `amendedBy`. The writer maps it to the
// payload's `revisedBy` (S11·U2); re-spelling the WIRE field is a change to a
// request contract that q24's alias removal did not touch and this unit does
// not widen into.
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
// is shaped. Through S13·U3 there were two surfaces per operation (the alias
// and its generic twin) sharing one core; S13·U4 deleted the alias's
// registration, leaving one surface per operation below. The split itself is
// left in place rather than collapsed — a route helper that could answer a
// request DIFFERENTLY still belongs in the core, not here, and nothing about
// that discipline changed with the alias's death. Collapsing the generic
// parameterisation into inline logic is a simplification pass, not an alias
// deletion, and this unit does not widen into it.

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
    // it here instead would make `unknown-node` unreachable (see the schema).
    toStage: toNode as TransitionProposal['toStage'],
    proposedBy: body.proposedBy,
    ...(body.manualReviewRequired === undefined
      ? {}
      : { manualReviewRequired: body.manualReviewRequired }),
    ...(body.note === undefined ? {} : { note: body.note }),
  };
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
  //     refusal returns 409 — the engine's four, including the unknown-node one,
  //     AND every reason a workflow's forbidden row declares (S13·U1: the reason
  //     is a string on this wire, not an enum). One code for "the machine refused"
  //     keeps clients (and slice 7's MCP client) reading the `reason` FIELD rather
  //     than branching on HTTP semantics we would then be obliged to keep stable
  //     forever — which is exactly what makes an open declared channel safe here.
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
          // The envelope carries no record, so the (deleted) alias and this route
          // answered with the same bytes here; the rejection is a fact about the
          // proposal, not about a spelling.
          const response: ProposeMoveResponse = { accepted: false, reason: result.reason };
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
  //     `RevisePayloadResponse`). Not a 201: the thing a client cares about is
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
  // ⚠ NOT PARAMETERISED BY SURFACE, AND THAT WAS THE FINDING RATHER THAN AN
  // OVERSIGHT WHILE THE ALIAS LIVED: the dispatch result vocabulary is already
  // engine-shaped and workflow-blind, so the (now-deleted) alias and this route
  // returned literally the same bytes. There is nothing here to re-spell.
  const handleDispatch = async (context: Context, instanceId: string): Promise<Response> => {
    const result = await deps.dispatchTask(instanceId);
    if (result.outcome === 'unknown-task') {
      return context.json({ error: 'not found' }, 404);
    }
    const response: DispatchResponse = { result };
    return context.json(response, 200);
  };

  // ── the routes — THE CONTRACT (the alias set died S13·U4; this is all of it) ─

  app.post('/api/instances', async (context) =>
    handleCreate(context, {
      schema: createInstanceBodySchema,
      projectOf: (body) => body.project,
      // The declaration's `initial` fills the absent case (S12·U2).
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
          // Spread rather than set: ABSENT stays absent on a non-promoting move.
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

  // ── S13·U2 (q25) — the generic twins, workflow-keyed ────────────────────────
  //
  // See the response-type comments above for the full rationale; this is the
  // key check and the two route bodies.
  //
  // ⚠ EXACT-MATCH KEY, ELSE 404 — NEVER "SERVE THE CURRENT ONE INSTEAD" (F3
  // ⟨signed⟩). This daemon holds exactly ONE boot-resolved declaration; a
  // request naming any other extension/workflow/rev is a request for a
  // declaration this daemon does not have, and a rev-keyed endpoint that
  // answered anyway would break the immutable-caching promise below — a
  // client caching by ref would cache the WRONG rev's bytes under the right
  // rev's key.
  const isRequestedWorkflow = (context: Context): boolean =>
    context.req.param('extension') === deps.workflowRef.extension &&
    context.req.param('workflow') === deps.workflowRef.workflow &&
    context.req.param('rev') === deps.workflowRef.rev;

  // Immutable for the ref it answers under (F3 ⟨signed⟩ property 1): the same
  // extension/workflow/rev will never answer with different bytes, so a client
  // (or an intermediate cache) may hold this response forever. `private`
  // because the route sits behind the Access auth wall like everything else on
  // this app — a shared cache must not serve one tenant's declaration to
  // another. Set on 200s ONLY; the 404 carries no cache header; because "no
  // declaration under this ref" is not a fact this daemon is the authority on
  // forever — a later deploy could pin a different rev.
  const IMMUTABLE_DECLARATION_CACHE_CONTROL = 'private, max-age=31536000, immutable';

  // GET /api/workflows — the discovery half (S13·U2b, q25 addendum). Lists
  // the declarations this daemon resolves, today exactly the one boot ref.
  //
  // ⚠ THE ENTRY LIST IS, BY CONSTRUCTION, THE SET OF REFS THE TWO ROUTES
  // BELOW WILL ANSWER 200 FOR. That correspondence is this route's whole
  // contract: every `ref` listed here must be one `isRequestedWorkflow`
  // accepts, and nothing else. Today that is trivial (one boot-resolved
  // declaration, one list entry, built from the SAME `deps.workflowRef`
  // `isRequestedWorkflow` matches against) — the invariant is what a future
  // multi-workflow daemon must keep true when this array grows past one.
  //
  // ⚠ NO CACHE-CONTROL HEADER, UNLIKE THE PER-REF ROUTES BELOW. Each
  // declaration is immutable once served under its ref, but the SET of refs
  // this daemon resolves is a fact about THIS deploy, not about any one ref —
  // a later deploy can pin a different rev, growing or shrinking the list.
  // Caching the index long-term would let a client miss a newly-resolvable
  // workflow, or keep offering a create sheet for one this daemon dropped.
  app.get('/api/workflows', (context) => {
    const response: WorkflowIndexResponse = { workflows: [{ ref: deps.workflowRef }] };
    return context.json(response);
  });

  // GET /api/workflows/:extension/:workflow/:rev/declaration — the FULL
  // declared table (nodes/edges/forbidden), verbatim from `deps.workflow`.
  //
  // ⚠ THIS ROUTE INTERPRETS NOTHING. It reshapes (narrows nodes to
  // id/kind/title, drops `record`) but never asks what a node MEANS — no
  // stage-vocabulary filtering, no legality re-derivation, nothing an
  // extension-blind route could get wrong about a tenant's workflow. Serving
  // this would require the engine to hold a tenant opinion, which is slice
  // kill criterion 2 (docs/slice-13.md §6.2) and did not come up: the
  // declaration is already the wire shape, node-kit-parsed and PINNED, and
  // this route only omits the two things rule 0.5 says have no consumer yet
  // (node `properties`/`briefing`/`acceptance`, dispatch-side machinery) and
  // the one thing that is meaningless off this host (`record`, an
  // extension-relative file path — its own generic story is the sibling
  // endpoint below).
  app.get('/api/workflows/:extension/:workflow/:rev/declaration', (context) => {
    if (!isRequestedWorkflow(context)) {
      return context.text('not found', 404);
    }
    const response: WorkflowDeclarationResponse = {
      ref: deps.workflowRef,
      workflow: {
        id: deps.workflow.id,
        title: deps.workflow.title,
        initial: deps.workflow.initial,
        nodes: deps.workflow.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          ...(node.title === undefined ? {} : { title: node.title }),
        })),
        edges: deps.workflow.edges,
        forbidden: deps.workflow.forbidden,
      },
    };
    return context.json(response, 200, { 'Cache-Control': IMMUTABLE_DECLARATION_CACHE_CONTROL });
  });

  // GET /api/workflows/:extension/:workflow/:rev/payload-schema — the SAME
  // `WORK_ORDER_FIELD_DESCRIPTORS` constant the deleted legacy work-order-
  // schema alias used to serve (not forked, not copied — one definition, so the
  // descriptor↔`createInstanceBodySchema` drift test in instanceApi.test.ts
  // keeps tying THIS response to what the create door actually validates).
  app.get('/api/workflows/:extension/:workflow/:rev/payload-schema', (context) => {
    if (!isRequestedWorkflow(context)) {
      return context.text('not found', 404);
    }
    const response: WorkflowPayloadSchemaResponse = {
      ref: deps.workflowRef,
      fields: WORK_ORDER_FIELD_DESCRIPTORS,
    };
    return context.json(response, 200, { 'Cache-Control': IMMUTABLE_DECLARATION_CACHE_CONTROL });
  });

  // ── NO `GET /api/instances` — deliberately ──────────────────────────────────
  //
  // `GET /api/projections/instances` already serves instance state (app.ts),
  // behind the same auth wall, and the kanban UI reads it. A second reader of
  // the same fact is exactly the drift principle 9 forbids, and rule 0.5 says
  // machinery waits for its consumer. Nothing in this file needs one — inventing
  // one here would be a second source of record for a fact one route already
  // answers.
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
// ⚠ THE BODY, including the string `'task store finding'`, is UNCHANGED by the
// alias's S13·U4 deletion. Through S13·U3 it was shared word-for-word by both
// surfaces so neither answered a projection/log divergence differently; now
// that only one surface exists the string could be re-spelled, but doing so is
// its own deliberate wire-contract change and this unit does not widen into it
// (the deletion list is instanceApi.ts's header, and this is not on it).
function findingResponse(context: Context, error: unknown): Response {
  if (error instanceof InstanceProjectionDisagreementError) {
    return context.json({ error: 'task store finding', detail: error.message }, 500);
  }
  throw error;
}
