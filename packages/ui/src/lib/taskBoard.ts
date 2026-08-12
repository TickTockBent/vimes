// Pure derivation for the task board (slice 6 step 9) — turns the instances
// projection (GET /api/projections/instances) into display-ready groups and
// cards, and turns the instance API's three answers (move / create / dispatch)
// into honest sentences. No Vue, no DOM, no I/O: every branch is unit-tested
// without a browser (same split as lib/costDisplay.ts and lib/meterDisplay.ts).
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠ RULE ONE: THIS MODULE IS **LAYOUT-AGNOSTIC**, AND THAT IS EXPENSIVE TO
// RETROFIT, SO DO NOT FLATTEN THE DISTINCTION.
//
// Step 9 ships the MOBILE board only (flow sections stacked vertically with a
// pinned exception tray). A DESKTOP board is a separate, deliberate unit — a
// phone and a desktop are genuinely different presentations of the same data,
// not one responsive compromise. The desktop board must be able to consume
// EVERY function here UNCHANGED and arrange the result horizontally.
//
// Concretely, nothing in this file may:
//   • pre-arrange groups for a vertical list (the group ORDER here is the
//     PIPELINE's order — backlog → done — which reads the same left-to-right as
//     it does top-to-bottom; it is semantics, not layout),
//   • emit CSS classes, widths, colours, icons or any other presentational
//     token (contrast lib/sessionRow.ts, which legitimately does — this module
//     is deliberately stricter),
//   • collapse the flow/exception distinction into one flat ordered list that
//     only makes sense stacked.
// Words ARE allowed: a human label for a stage is vocabulary, not layout.
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠ RULE TWO: **THE UI PROPOSES, THE DAEMON DECIDES.** The legality table is
// NOT copied into this source and must never be — but `moveOptionsFor` DOES
// filter to the legal targets, read from the workflow DECLARATION the daemon
// serves at runtime (`GET /api/workflows/:e/:w/:r/declaration`, S13·U2's q25
// introspection — the same declaration the adjudicator reads) and the store
// fetches. So the UI reflects that legality without owning it, and `POST
// /api/instances/:instanceId/moves` STILL enforces on submit. See
// `nodeEdgesFromDeclaration` / `moveOptionsFor` for the 2026-07-24 reversal
// (show only valid moves) and why daemon-sourcing answers the drift objection
// this comment used to rest on.
//
// @vimes/core is deliberately NOT a dependency of packages/ui (see the header of
// lib/types.ts), so the wire shapes below mirror
// packages/core/src/projections/instances.ts and the instanceApi/taskDispatcher
// envelopes NARROWLY. Unknown keys are tolerated.

import type { Liveness, SessionRecord } from './types.js';
// The project-scope predicate — the ONE browser-side mirror of core's attribution
// authority (lib/projectContext.ts). Imported rather than re-spelled here: two
// prefix matchers in one package would be the drift that file's ⚠ block exists to
// prevent.
import { cwdWithinProject } from './projectContext.js';

// ── Mirrored wire vocabulary ────────────────────────────────────────────────
//
// ⚠ The STAGE VOCABULARY is mirrored; the LEGALITY TABLE is not. The two are
// not the same kind of fact. The vocabulary is a wire shape (the same narrow
// mirroring lib/types.ts sanctions, and the board cannot render stages it cannot
// name); the edge table is a DECISION, and a copied decision is a second
// authority (principle 10). If a stage is ever added to core and not added here
// it shows up as an `unknown` group rather than vanishing — see
// `groupTasksForBoard`.

// The pipeline, in the order work moves through it. This order is the flow's
// own, not the phone's.
export const FLOW_STAGES = [
  'backlog',
  'planning',
  'plan-ready',
  'implementing',
  'review',
  'done',
] as const;

// NOT pipeline positions. The edge table makes both reachable from nearly every
// stage and both lead back out again, so rendering them inline with the flow
// would draw them as steps of a pipeline they are not part of.
//
// `cancelled` (S11, 2026-07-24) joins them for the same reason: it is reachable
// from nearly every flow stage and recovers back to `backlog` rather than
// occupying a pipeline position of its own — a give-up that can be undone.
export const EXCEPTION_STAGES = ['quarantined', 'blocked-external', 'cancelled'] as const;

export type FlowStage = (typeof FLOW_STAGES)[number];
export type ExceptionStage = (typeof EXCEPTION_STAGES)[number];
export type TaskStage = FlowStage | ExceptionStage;

// Every stage the UI knows a name for, flow first. This is the set the move
// sheet offers from — NOT a legality table.
export const KNOWN_STAGES: readonly TaskStage[] = [...FLOW_STAGES, ...EXCEPTION_STAGES];

// How a group is classified. `unknown` is the landing pad for a stage this UI
// has no name for — a stage core added, or a hostile/corrupt record. It exists
// so such a task is VISIBLE rather than silently dropped (I8).
export type StageKind = 'flow' | 'exception' | 'unknown';

const STAGE_LABEL: Readonly<Record<TaskStage, string>> = {
  backlog: 'Backlog',
  planning: 'Planning',
  'plan-ready': 'Plan ready',
  implementing: 'Implementing',
  review: 'Review',
  done: 'Done',
  quarantined: 'Quarantined',
  'blocked-external': 'Blocked (external)',
  cancelled: 'Cancelled',
};

function isKnownStage(candidate: string): candidate is TaskStage {
  return Object.prototype.hasOwnProperty.call(STAGE_LABEL, candidate);
}

// The human name for a stage. An unrecognised stage is echoed VERBATIM rather
// than replaced with "unknown": the operator needs to see what the record
// actually says, and a stage core added but this UI has not learned yet is
// perfectly legible on its own.
export function stageLabel(stage: string): string {
  return isKnownStage(stage) ? STAGE_LABEL[stage] : stage;
}

export function stageKind(stage: string): StageKind {
  if ((FLOW_STAGES as readonly string[]).includes(stage)) {
    return 'flow';
  }
  if ((EXCEPTION_STAGES as readonly string[]).includes(stage)) {
    return 'exception';
  }
  return 'unknown';
}

// ── Mirrored record shape (S13·U3: the INSTANCES shape) ─────────────────────
//
// Every field but `instanceId` is optional/loose ON PURPOSE. This is parsed
// from a projection body over the wire, and I8 says hostile or degenerate input
// must never crash a reader and must never silently swallow a record.
// `currentNode` is typed `string`, not `TaskStage`, for exactly the reason
// `proposeMoveBodySchema` types `toNode` as a plain string in the daemon: a
// value outside the enum physically reaches us, and refusing to model it is how
// it disappears.
//
// ⚠ S13·U3 REPLACED THE LEGACY NARROWING (q24's shape alias, now retired).
// This board used to read a derived task-shaped view of the instances fold; it
// now reads `GET /api/projections/instances` directly. Four fields that
// narrowing HID — `nodeHistory`, `edgeTraversalCounts`, `attemptsPerNode`,
// `workflow` — are therefore present on the wire; they are deliberately NOT
// mirrored here, because rendering them is a later unit with its own design
// (slice-13 §2). `title` sits under `payload` on the instances shape (q13's
// payload split), so `deriveTaskCard` reads it through `payloadOf`.
export interface TaskBoardRecord {
  readonly instanceId: string;
  readonly project?: unknown;
  readonly payload?: unknown;
  readonly currentNode?: unknown;
  readonly manualReviewRequired?: unknown;
  readonly isolation?: unknown;
  readonly createdBy?: unknown;
  readonly attachedSessions?: unknown;
}

// One card, as the board renders it. Everything here comes from the record;
// NOTHING is invented (rule 0.8's posture, pillar 4 — this board is a meter).
export interface TaskCard {
  readonly taskId: string;
  // NEVER blank. The title when the record carries a usable one, otherwise a
  // short form of the taskId.
  readonly label: string;
  // True when `label` is the taskId fallback rather than a real title, so the
  // view can render it as an identifier (mono, muted) instead of as a name.
  readonly labelIsFallback: boolean;
  readonly stage: string;
  readonly stageKind: StageKind;
  // The BASENAME of `projectRoot`. Null when the record carries no usable path —
  // never the string "unknown", which would look like a directory called
  // "unknown".
  readonly projectName: string | null;
  // The FULL `projectRoot` the record carries, null when it carries no usable
  // one. Kept ALONGSIDE the basename rather than replacing it (S8·2): the
  // basename is what a card RENDERS, the full path is what project scoping
  // MATCHES on (`cwdWithinProject`, lib/projectContext.ts). Matching on the
  // basename would attribute every `~/anything/vimes` to the vimes project —
  // which is the same mistake the segment-boundary guard exists to prevent, one
  // level up.
  readonly projectRoot: string | null;
  readonly createdBy: string | null;
  // ── S8·6: the PROVENANCE chip ───────────────────────────────────────────────
  //
  // True ONLY for a task the standing orchestrator authored (`createdBy` is the
  // exact string `'orchestrator'`). The Gate-2 pivot criterion is how often
  // authored work-orders need substantial human rewrite, which is a question
  // nobody can answer from a board where authored and hand-made cards look
  // identical — so it has to be legible at a glance.
  //
  // ⚠ FAILS TO NO-CHIP, and that direction is chosen: hand-made is the UNMARKED
  // default, so absent, unknown, malformed and `'human'` all render nothing. The
  // failure mode of the other direction is a chip claiming the orchestrator wrote
  // something it did not — which would corrupt the very measurement the chip
  // exists to make.
  readonly authoredByOrchestrator: boolean;
  // Rendered only when the task really asked for worktree isolation; a
  // `shared-dir` task shows nothing rather than a "shared" badge nobody asked
  // for.
  readonly isolatedInWorktree: boolean;
  readonly manualReviewRequired: boolean;
  // The MOST RECENT attached session, if the record names one AND the sessions
  // projection knows it. `liveness: null` means "we have a ref but no session
  // record for it" — an honest gap, never rendered as 'dead'.
  readonly latestSession: {
    readonly appSessionId: string;
    readonly stage: string;
    readonly liveness: Liveness | null;
  } | null;
}

export interface TaskStageGroup {
  readonly stage: string;
  readonly label: string;
  readonly kind: StageKind;
  readonly count: number;
  readonly tasks: readonly TaskCard[];
}

// The whole board, classified. Deliberately BOTH the full ordered list and the
// three kind-partitions: a phone renders `exceptions` as a pinned tray above a
// stack of `flow` sections, a desktop renders `flow` as side-by-side columns
// with `exceptions` docked somewhere else entirely — from this identical value.
export interface TaskBoard {
  readonly groups: readonly TaskStageGroup[];
  readonly flow: readonly TaskStageGroup[];
  readonly exceptions: readonly TaskStageGroup[];
  readonly unknown: readonly TaskStageGroup[];
  readonly totalTasks: number;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// The instance's tenant-shaped payload as a plain bag, or an empty one when the
// record carries none / carries something that is not an object. TOTAL by
// design (I8): the payload is opaque to the engine and arbitrary to this
// reader, so every field is looked up through `asString`-style guards after
// this and nothing here may throw.
function payloadOf(record: { readonly payload?: unknown }): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

// The short form of a taskId, for a card with no title. The FRONT of the id,
// not the back: ids are minted as UUIDs whose leading characters carry the
// entropy, and a leading fragment is what an operator can match against a log
// line or a `curl` they just ran.
const SHORT_TASK_ID_LENGTH = 8;
export function shortTaskId(taskId: string): string {
  return taskId.length <= SHORT_TASK_ID_LENGTH ? taskId : taskId.slice(0, SHORT_TASK_ID_LENGTH);
}

// The basename of a path, with trailing slashes ignored. Returns null rather
// than '' for a path that has no segments (e.g. '/'), so a card can omit the
// field instead of rendering an empty pill.
function basenameOf(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : null;
}

/**
 * One card from one record. TOTAL over its input: no shape of `task` throws.
 *
 * `sessionsById` is the sessions projection the store already holds. It is
 * passed IN rather than imported so this stays pure and so the board never
 * becomes a second reader deciding what a session's liveness is.
 */
export function deriveTaskCard(
  task: TaskBoardRecord,
  sessionsById: Readonly<Record<string, SessionRecord>> = {},
): TaskCard {
  // q13's payload split: the authored title is tenant content and lives under
  // `payload`, not on the core record.
  const rawTitle = asString(payloadOf(task).title);
  // ⚠ A WHITESPACE-ONLY TITLE FALLS BACK TOO. The daemon records `''` verbatim
  // (it bounds length, it does not editorialise), which is the right call there
  // and would be a blank card here. "Never a blank card" is decided in exactly
  // one place, and this is it.
  const usableTitle = rawTitle !== null && rawTitle.trim().length > 0 ? rawTitle.trim() : null;

  const rawStage = asString(task.currentNode);
  const stage = rawStage ?? '';
  const projectRoot = asString(task.project);

  return {
    taskId: task.instanceId,
    label: usableTitle ?? shortTaskId(task.instanceId),
    labelIsFallback: usableTitle === null,
    stage,
    stageKind: stageKind(stage),
    projectName: projectRoot === null ? null : basenameOf(projectRoot),
    projectRoot,
    createdBy: asString(task.createdBy),
    // Exact-string equality on the raw value, the same shape as
    // `isolatedInWorktree` below it — anything that is not the word is not the
    // orchestrator (see the field's note).
    authoredByOrchestrator: task.createdBy === 'orchestrator',
    isolatedInWorktree: task.isolation === 'worktree',
    manualReviewRequired: task.manualReviewRequired === true,
    latestSession: latestSessionOf(task, sessionsById),
  };
}

function latestSessionOf(
  task: TaskBoardRecord,
  sessionsById: Readonly<Record<string, SessionRecord>>,
): TaskCard['latestSession'] {
  if (!Array.isArray(task.attachedSessions)) {
    return null;
  }
  // `attachedSessions` is a CHRONOLOGICAL trail (the projection appends, never
  // sorts), so the most recent run is the last usable entry — walked backwards
  // so a malformed entry at the tail does not hide a good one behind it.
  for (let index = task.attachedSessions.length - 1; index >= 0; index -= 1) {
    const candidate = task.attachedSessions[index] as { node?: unknown; appSessionId?: unknown } | null;
    const appSessionId = asString(candidate?.appSessionId);
    if (appSessionId === null) {
      continue;
    }
    return {
      appSessionId,
      stage: asString(candidate?.node) ?? '',
      // Absent from the projection → null, NOT a guess. A ref whose session we
      // cannot see is a known unknown; rendering it as 'dead' would be a lie
      // about a session that may well be running.
      liveness: sessionsById[appSessionId]?.liveness ?? null,
    };
  }
  return null;
}

// One entry in an instance's session trail (S7·7g). `latestSessionOf`'s SIBLING,
// not its replacement: that function answers "what is the card's badge right
// now" (the single most recent usable ref, walked backwards); this one
// answers "what is the task's whole history" (every usable ref, walked
// forwards, numbered per stage). Both share the same malformed-entry
// tolerance because they read the identical wire field.
export interface TaskSessionTrailEntry {
  readonly appSessionId: string;
  // '' when the ref is missing/malformed on stage — echoed empty rather than
  // guessed, same posture as `latestSessionOf`'s `stage`.
  readonly stage: string;
  // 1-based ordinal AMONG THIS STAGE'S usable refs (a ref with `stage: ''`
  // counts in its own '' bucket), matching how the dispatcher derives an
  // attempt number from ref counts.
  readonly attempt: number;
  // Joined from `sessionsById`; null means "we have a ref but no session
  // record for it" — a known unknown, never a guess.
  readonly liveness: Liveness | null;
}

/**
 * The task's full session trail, chronological (first dispatch → latest).
 * TOTAL over `task.attachedSessions`: a non-array, or an array of nulls/numbers,
 * never throws — a malformed entry with no usable `appSessionId` is skipped
 * (it can neither be linked nor counted); a usable id with a malformed stage
 * is kept with `stage: ''`.
 *
 * ⚠ NO PER-REF OUTCOME. `attachedSessions` does not carry one, and inventing
 * one from stage position (e.g. "the run before a later stage must have
 * succeeded") would be a guess dressed as a fact — exactly what this board
 * exists not to do. The trail says WHO ran WHEN, not how each run ended.
 */
export function sessionTrailOf(
  task: TaskBoardRecord,
  sessionsById: Readonly<Record<string, SessionRecord>>,
): TaskSessionTrailEntry[] {
  if (!Array.isArray(task.attachedSessions)) {
    return [];
  }
  const trail: TaskSessionTrailEntry[] = [];
  const attemptByStage = new Map<string, number>();
  // Walked FORWARDS — `attachedSessions` is append-only, so index order already
  // is chronological order (contrast `latestSessionOf`'s backwards walk, which
  // only needs the tail).
  for (const raw of task.attachedSessions) {
    const candidate = raw as { node?: unknown; appSessionId?: unknown } | null;
    const appSessionId = asString(candidate?.appSessionId);
    if (appSessionId === null) {
      continue;
    }
    const stage = asString(candidate?.node) ?? '';
    const attempt = (attemptByStage.get(stage) ?? 0) + 1;
    attemptByStage.set(stage, attempt);
    trail.push({
      appSessionId,
      stage,
      attempt,
      liveness: sessionsById[appSessionId]?.liveness ?? null,
    });
  }
  return trail;
}

/**
 * Read the instances projection body into a classified board.
 *
 * TOTAL AND NON-THROWING over any body (I8, assertion 11): a null body, a
 * missing `instances` key, `instances` as an array/string/number, null record
 * values and records missing every field all produce a board rather than an
 * exception.
 *
 * ⚠ **NOTHING IS EVER SILENTLY DROPPED.** A task whose stage is absent, not a
 * string, or outside the vocabulary this UI knows lands in an `unknown` group
 * that the view is required to render. A board that quietly hides a task it
 * does not understand is worse than one that shows it oddly — the operator
 * would have no way to learn the task exists.
 *
 * The six flow stages and the two exception stages ALWAYS appear, even at zero:
 * an empty stage is information ("nothing in review"), and a tray that vanishes
 * when it is empty teaches you not to look for it.
 */
export function groupTasksForBoard(
  body: unknown,
  sessionsById: Readonly<Record<string, SessionRecord>> = {},
  // S8·2 — the project scope, or null for the whole board. Applied HERE rather
  // than in the view so `count` and `totalTasks` describe the board actually on
  // screen: a "review 3" header over one visible card would be a meter that lies.
  //
  // A task with NO usable `project` is EXCLUDED from a scoped board, and
  // included in an unscoped one. It cannot be shown to belong here, and D42's
  // whole posture is that a boundary is proved, never assumed.
  projectRoot: string | null = null,
): TaskBoard {
  const allCards = readTaskCards(body, sessionsById);
  const cards =
    projectRoot === null
      ? allCards
      : allCards.filter(
          (card) => card.projectRoot !== null && cwdWithinProject(card.projectRoot, projectRoot),
        );

  const cardsByStage = new Map<string, TaskCard[]>();
  for (const card of cards) {
    const bucket = cardsByStage.get(card.stage);
    if (bucket === undefined) {
      cardsByStage.set(card.stage, [card]);
    } else {
      bucket.push(card);
    }
  }

  const groupFor = (stage: string): TaskStageGroup => {
    const tasks = cardsByStage.get(stage) ?? [];
    return {
      stage,
      label: stage === '' ? '(no stage recorded)' : stageLabel(stage),
      kind: stageKind(stage),
      count: tasks.length,
      tasks,
    };
  };

  const flow = FLOW_STAGES.map(groupFor);
  const exceptions = EXCEPTION_STAGES.map(groupFor);
  // Only the unrecognised stages that ACTUALLY OCCUR — unlike the flow and the
  // tray, an empty unknown group would be noise about a stage that does not
  // exist. Sorted so the board is deterministic regardless of record order.
  const unknownStages = [...cardsByStage.keys()].filter((stage) => stageKind(stage) === 'unknown');
  unknownStages.sort();
  const unknown = unknownStages.map(groupFor);

  return {
    groups: [...flow, ...exceptions, ...unknown],
    flow,
    exceptions,
    unknown,
    totalTasks: cards.length,
  };
}

function readTaskCards(
  body: unknown,
  sessionsById: Readonly<Record<string, SessionRecord>>,
): TaskCard[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const instances = (body as { instances?: unknown }).instances;
  if (typeof instances !== 'object' || instances === null || Array.isArray(instances)) {
    return [];
  }

  const cards: TaskCard[] = [];
  for (const [key, value] of Object.entries(instances as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      // A null/primitive value under a real key is still evidence an instance
      // exists. It is kept with the MAP KEY as its id rather than dropped — the
      // key is the instanceId in the projection's own shape, so this fabricates
      // nothing.
      cards.push(deriveTaskCard({ instanceId: key }, sessionsById));
      continue;
    }
    const record = value as Record<string, unknown>;
    // The record's own instanceId when it has one, otherwise the map key it is
    // filed under. They agree in every projection the daemon serializes; when
    // they do not, the key is the addressable one.
    cards.push(
      deriveTaskCard({ ...record, instanceId: asString(record.instanceId) ?? key }, sessionsById),
    );
  }
  return cards;
}

/**
 * The card for one taskId in a freshly-derived board, or null when the board has
 * no such task. The move sheet remembers a taskId — NOT a card snapshot — and
 * re-reads the live card through this on every projection change, so a task that
 * moves stage while its sheet is open re-derives its own move options instead of
 * freezing on the stage it had at open. Walks `board.groups` (flow + exceptions +
 * unknown — every card the board holds). Total; never throws.
 */
export function findTaskCard(board: TaskBoard, taskId: string): TaskCard | null {
  for (const group of board.groups) {
    for (const card of group.tasks) {
      if (card.taskId === taskId) {
        return card;
      }
    }
  }
  return null;
}

// One answer from the task API, exactly as it came back. The store returns this
// VERBATIM and classifies nothing — every interpretation happens in the
// `describe*` functions below, where it is testable, and nowhere else.
//
// `status: 0` is the sentinel for "the request never reached the daemon".
// Deliberately not dressed up as an HTTP status: nothing was proposed and
// nothing was written, and the board must not imply otherwise.
export interface TaskApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

// ── q25 declaration introspection, read client-side (S13·U3) ────────────────
//
// Two routes replace the legacy stage-edges alias (q24, deleted in S13·U4):
//   • `GET /api/workflows` — the DISCOVERY half (S13·U2b). At zero instances a
//     client holds no ref to key the per-ref routes with, so the index is what
//     lets a fresh client render a create sheet on an empty board.
//   • `GET /api/workflows/:e/:w/:r/declaration` — the FULL declared table for
//     one ref, immutable for that ref (the daemon says so in its cache header;
//     the browser cache is the persistence, this module builds none).
//
// The client fetches ONE declaration per REF, never one per instance (F3
// ⟨signed⟩ rider 2) — `workflowRefKey` is that dedupe key.

/** The declaration's identity, as `GET /api/workflows` lists it. */
export interface WorkflowRefLike {
  readonly extension: string;
  readonly workflow: string;
  readonly rev: string;
}

/**
 * The dedupe/cache key for one ref. Plain, printable, and derived only from
 * the three identity fields — the same three the daemon's route matches on.
 */
export function workflowRefKey(ref: WorkflowRefLike): string {
  return `${ref.extension}/${ref.workflow}/${ref.rev}`;
}

/**
 * The refs `GET /api/workflows` lists, deduped by key and in index order.
 *
 * TOTAL over hostile input (I8): a null body, a missing/`non-array`
 * `workflows`, an entry that is not an object, and a `ref` missing any of its
 * three string fields all degrade to "not a ref I can key with" rather than
 * throwing. An unreadable index yields `[]`, which the store treats exactly as
 * "nothing to fetch yet" — the same safe empty a failed fetch produces.
 */
export function readWorkflowRefs(body: unknown): WorkflowRefLike[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const listed = (body as { workflows?: unknown }).workflows;
  if (!Array.isArray(listed)) {
    return [];
  }
  const refs: WorkflowRefLike[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const raw = (entry as { ref?: unknown }).ref;
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const candidate = raw as { extension?: unknown; workflow?: unknown; rev?: unknown };
    const extension = asString(candidate.extension);
    const workflow = asString(candidate.workflow);
    const rev = asString(candidate.rev);
    if (extension === null || workflow === null || rev === null) {
      continue;
    }
    const ref: WorkflowRefLike = { extension, workflow, rev };
    const key = workflowRefKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * The legal-target table the move sheet filters against, derived from the
 * declaration body: for each node, the nodes its declared out-edges reach.
 *
 * ⚠ **RESTRICTED TO THE NINE STAGES THIS BOARD KNOWS (`KNOWN_STAGES`), BOTH
 * ENDS OF EVERY EDGE — AND THAT RESTRICTION IS LOAD-BEARING, NOT TIDYING.**
 * The legacy stage-edges alias served declaration membership already narrowed
 * to the record vocabulary (the daemon dropped every row touching the tenth
 * node, `manual-review`); the q25 declaration route serves the FULL declared
 * table, so the narrowing moved here. Two reasons it must stay:
 *
 *   1. **§2 — no screen gains a capability.** Offering `manual-review` in the
 *      move sheet would be a new destination the board has never offered.
 *   2. **The record enum cannot hold it.** A proposal to a node outside the
 *      nine would reach a record whose stage vocabulary has no such value —
 *      the daemon would refuse, and the sheet would have baited the operator
 *      into a refusal that is a UI bug rather than a machine decision.
 *
 * This is NOT a copied legality DECISION (rule two at the top of this file):
 * membership comes wholly from the served declaration. What is applied here is
 * the BOARD's own vocabulary — the nine stages it already mirrors and can name
 * — which is the tasks extension's own surface knowing its own nodes.
 *
 * ⚠ ORDER IS THE DECLARATION'S, not the frozen `WIRE_STAGE_EDGE_ORDER` the
 * legacy route imposed. Accepted cosmetic delta (orchestrator ruling
 * 2026-08-12): the buttons in the move sheet may appear in a different order
 * than they did; the SET is identical. No order-preservation machinery.
 *
 * TOTAL over hostile input (I8): `null` (nothing fetched yet, or an unreadable
 * body) returns `null`, which `moveOptionsFor` already treats as "not loaded"
 * and answers with a safe empty — never all-stages.
 */
export function nodeEdgesFromDeclaration(declaration: unknown): Record<string, string[]> | null {
  if (typeof declaration !== 'object' || declaration === null) {
    return null;
  }
  const workflow = (declaration as { workflow?: unknown }).workflow;
  if (typeof workflow !== 'object' || workflow === null) {
    return null;
  }
  const edges = (workflow as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) {
    return null;
  }
  // Every known stage gets a key, including a terminal one whose set stays
  // empty — the legacy route did the same, and `moveOptionsFor` reads an empty
  // array and an absent key identically anyway.
  const targetsByStage = new Map<string, string[]>();
  for (const stage of KNOWN_STAGES) {
    targetsByStage.set(stage, []);
  }
  for (const raw of edges) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const edge = raw as { from?: unknown; to?: unknown };
    const from = asString(edge.from);
    const to = asString(edge.to);
    if (from === null || to === null || !isKnownStage(from) || !isKnownStage(to)) {
      continue;
    }
    const targets = targetsByStage.get(from)!;
    // The declaration is the expanded table and may list a pair more than once
    // (a wildcard row expanded onto a row somebody also wrote by hand); the
    // sheet must not show the same destination twice.
    if (!targets.includes(to)) {
      targets.push(to);
    }
  }
  return Object.fromEntries(targetsByStage);
}

// ── The move sheet ──────────────────────────────────────────────────────────

export interface MoveOption {
  readonly stage: TaskStage;
  readonly label: string;
  readonly kind: StageKind;
}

/**
 * The stages the move sheet offers: the task's LEGAL next stages, filtered
 * against the daemon-served edge table — never the full stage list.
 *
 * ⟨Wes ruling, 2026-07-24, reversing this function's original "surface every
 * move, let the machine refuse" stance.⟩ Options that can never be valid from
 * the current stage read as deceptive, not as a demonstration of I7. So the
 * sheet shows only legal targets. The original three objections are ANSWERED,
 * not ignored:
 *   1. The edge table is NOT copied into the UI (the drift hazard) — it is
 *      derived by `nodeEdgesFromDeclaration` from the workflow declaration the
 *      daemon SERVES (the one source), and passed in here. An edge added to
 *      the declaration flows through; nothing here re-declares legality.
 *   2. This is not a second AUTHORITY: the UI reflects the machine's own rules
 *      and the server STILL enforces on submit — a forced illegal edge is still
 *      409 + an evented task_transition_rejected, so I7 stays assertable and is
 *      demonstrated by the API and its tests, not by baiting an operator into an
 *      illegal tap.
 *   3. The refusal path is unchanged and still the record; it is simply no
 *      longer the primary way to discover the graph.
 *
 * Current stage is excluded (a no-op; the machine says same-node). No declared
 * edges yet, or a stage with an empty edge set (e.g. terminal `done`) → no
 * options, which is correct.
 */
export function moveOptionsFor(
  currentStage: string,
  stageEdges: Record<string, readonly string[]> | null,
): readonly MoveOption[] {
  if (stageEdges === null) {
    return [];
  }
  const legalTargets = stageEdges[currentStage];
  if (legalTargets === undefined) {
    return [];
  }
  return legalTargets.map((stage) => ({
    stage: stage as TaskStage,
    label: stageLabel(stage),
    kind: stageKind(stage),
  }));
}

// ── The machine's answer, in human words ────────────────────────────────────

// Every refusal reason a move can carry, each with its OWN sentence. A shared
// "that move isn't allowed" would throw away the one thing the 409 is carrying.
//
// TWO SPELLING FAMILIES LIVE HERE, PERMANENTLY (S13·U1 F1, assertion S13-A9):
//
//   • the NODE-GENERIC engine reasons — `unknown-node`, `same-node`,
//     `terminal-node` — which is what the engine emits from S13·U1 onward;
//   • the LEGACY STAGE-SPELLED engine reasons — `unknown-stage`, `same-stage`,
//     `terminal-stage` — which is what every refusal recorded BEFORE that unit
//     says, forever.
//
// ⚠ **DELETING THE LEGACY ROWS IS A REGRESSION, NOT A CLEANUP.** History is
// never rewritten (q21): the old spellings persist in the log and may surface
// through any historical read, and these rows are their permanent read-side
// alias — the same treatment q21 gives every retired spelling. The mixed
// vocabulary is the DESIGNED outcome of F1+F2, not an incomplete migration.
//
// `illegal-edge` is engine vocabulary that never named a node, so it is
// unchanged. `quarantined-cannot-complete` is TENANT content declared in the
// manifest's forbidden row (F2) — not respelled, and it reaches this map
// through the declared channel rather than an engine enum.
const REJECTION_SENTENCE: Readonly<Record<string, string>> = {
  'illegal-edge': 'That move is not one of the edges out of this stage. The task has not moved.',
  // ── the node-generic engine spellings (S13·U1) ────────────────────────────
  'terminal-node':
    'Done is final. Reopening finished work mints a NEW task rather than resurrecting this one, so the audit trail stays honest.',
  'same-node': 'The task is already in that stage, so nothing was proposed.',
  'unknown-node':
    'The machine does not recognise one of the stages in that proposal. The refusal is in the log.',
  // ── the legacy stage-spelled engine reasons — KEEP FOREVER (S13-A9) ───────
  'terminal-stage':
    'Done is final. Reopening finished work mints a NEW task rather than resurrecting this one, so the audit trail stays honest.',
  'same-stage': 'The task is already in that stage, so nothing was proposed.',
  'unknown-stage':
    'The machine does not recognise one of the stages in that proposal. The refusal is in the log.',
  // ── declared, tenant-authored (F2) ────────────────────────────────────────
  'quarantined-cannot-complete':
    'A quarantined run may not complete. Send it back through planning or implementing, park it as blocked, or return it to the backlog — it cannot go straight to done.',
};

/**
 * A rejection reason as a sentence an operator can act on.
 *
 * ⚠ AN UNRECOGNISED REASON MUST STILL RENDER SOMETHING HONEST (rule 0.6): a
 * reason added to core after this UI shipped must NOT produce an empty error.
 * It is echoed verbatim inside a sentence that says plainly that this client has
 * no words for it yet — which is true, useful, and self-diagnosing, where a
 * blank or a generic "failed" would be none of those.
 */
export function describeRejectionReason(reason: unknown): string {
  const named = asString(reason);
  if (named === null) {
    return 'The machine refused the move but sent no reason this client could read. The refusal is in the log.';
  }
  return (
    REJECTION_SENTENCE[named] ??
    `The machine refused the move: “${named}”. This board has no plain-words description for that reason yet — the refusal is in the log.`
  );
}

export type MoveOutcome =
  | { readonly kind: 'accepted'; readonly stage: string; readonly sentence: string }
  | { readonly kind: 'rejected'; readonly reason: string; readonly sentence: string }
  | { readonly kind: 'error'; readonly sentence: string };

/**
 * Classify the response to `POST /api/instances/:instanceId/moves`.
 *
 * The status-code contract is `instanceApi.ts`'s, read as it is written there:
 *   • 200 → the machine ACCEPTED. The card must still not move until the
 *     PROJECTION says it did (no optimistic UI) — this only reports the answer.
 *   • 409 → the machine REFUSED, and the refusal IS IN THE LOG (I7). Never
 *     swallowed, never shown as a generic failure.
 *   • 400 / 403 / 404 → this was never a proposal; NOTHING was written. Each
 *     gets its own sentence, because they are three different problems.
 */
export function describeMoveResponse(status: number, body: unknown): MoveOutcome {
  const parsed = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  if (status === 200) {
    // The accepted envelope is `{ accepted, instance, dispatch? }` — the
    // moved-to node is the instance's own `currentNode`.
    const movedTo = asString((parsed.instance as Record<string, unknown> | undefined)?.currentNode) ?? '';
    return {
      kind: 'accepted',
      stage: movedTo,
      sentence:
        movedTo === ''
          ? 'Accepted. Waiting for the board to catch up.'
          : `Accepted — moved to ${stageLabel(movedTo)}. Waiting for the board to catch up.`,
    };
  }
  if (status === 409) {
    return {
      kind: 'rejected',
      reason: asString(parsed.reason) ?? '',
      sentence: describeRejectionReason(parsed.reason),
    };
  }
  if (status === 400) {
    return {
      kind: 'error',
      sentence:
        'The daemon could not read that as a proposal, so nothing was written. This is a bug in the board, not a refusal by the machine.',
    };
  }
  if (status === 403) {
    return {
      kind: 'error',
      sentence: 'Refused at the allowlist wall. Nothing was written.',
    };
  }
  if (status === 404) {
    return {
      kind: 'error',
      sentence:
        'The daemon has no task with that id — nothing was written, and no rejection was recorded either.',
    };
  }
  if (status === 0) {
    return {
      kind: 'error',
      sentence:
        'The proposal never reached the daemon, so nothing was written and nothing was refused. Check the connection banner.',
    };
  }
  return {
    kind: 'error',
    sentence: `The daemon answered ${status}, which this board does not have a description for. Nothing here can say whether anything was written; check the log.`,
  };
}

export type CreateOutcome =
  | { readonly kind: 'created'; readonly taskId: string; readonly sentence: string }
  | { readonly kind: 'error'; readonly sentence: string };

/**
 * Classify the response to `POST /api/instances`.
 *
 * ⚠ THE TITLE CAP IS NOT MIRRORED HERE, for the same reason the edge table is
 * not: it is the daemon's policy, it may change without this client changing,
 * and a copy would eventually disagree with it. The 400 message NAMES the likely
 * cause without asserting a number this board cannot know is still true.
 */
export function describeCreateResponse(status: number, body: unknown): CreateOutcome {
  const parsed = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  if (status === 201) {
    const instance = (
      typeof parsed.instance === 'object' && parsed.instance !== null ? parsed.instance : {}
    ) as Record<string, unknown>;
    return {
      kind: 'created',
      taskId: asString(instance.instanceId) ?? '',
      sentence: 'Created. Waiting for the board to catch up.',
    };
  }
  if (status === 400) {
    return {
      kind: 'error',
      sentence:
        'The daemon could not read that as a task, so nothing was written. An over-long title is the likeliest cause — the cap is the daemon’s, and this board deliberately does not keep a copy of it.',
    };
  }
  if (status === 403) {
    return {
      kind: 'error',
      sentence:
        'That project root is outside the daemon’s allowlist. Nothing was written — a task is a durable instruction to run a process in a directory, so the wall is checked before anything is recorded.',
    };
  }
  if (status === 0) {
    return {
      kind: 'error',
      sentence: 'The request never reached the daemon. Nothing was proposed and nothing was written.',
    };
  }
  return {
    kind: 'error',
    sentence: `The daemon answered ${status}, which this board does not have a description for. Check the log rather than assuming either outcome.`,
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

// The dispatcher's DECISION vocabulary (packages/core tasks/dispatchDecision.ts).
const REFUSE_SENTENCE: Readonly<Record<string, string>> = {
  'stage-not-dispatchable': 'This stage does not run a worker, so there was nothing to dispatch.',
  'already-running': 'A run is already live for this task. VIMES never double-spawns.',
  'headroom-insufficient':
    'The task asked for meter headroom and the meter says there is not enough. Nothing was spawned.',
  'headroom-unknown':
    'The task asked for meter headroom and the meter could not be read — never observed, gone stale, or carrying no percentage. That is NOT the same as "not enough": nothing was spawned because nothing could be checked.',
};

const DEFER_SENTENCE: Readonly<Record<string, string>> = {
  'awaiting-meter-reset':
    'Waiting for the gated meter to roll over. The task is queued behind its own gate — nothing has failed.',
  'reset-time-unknown':
    'Waiting, but we cannot see WHEN the gated meter rolls over. A schedule we cannot read, not an unmet requirement — nothing has failed.',
};

// How loudly the view should render an outcome. `waiting` exists precisely so a
// `deferred` never borrows the failure styling: a defer is the gate doing its
// job, and dressing it in red would train an operator to fear a healthy state.
export type DispatchTone = 'ok' | 'waiting' | 'refused' | 'failed' | 'unknown';

export interface DispatchReport {
  readonly outcome: string;
  readonly tone: DispatchTone;
  readonly headline: string;
  // The machine's own words when it has any — a refusal reason, or git's
  // verbatim stderr on a failed worktree. Never paraphrased away.
  readonly detail: string | null;
  // ⚠ THE HONEST LINE ABOUT AN IDLE WORKER. `composeStageInstruction` currently
  // defaults to sending NOTHING (step 7 deferred the prompt content to Wes), so
  // a freshly dispatched session spawns and then sits there. Saying so is the
  // difference between "this is how it works today" and "it hung".
  readonly idleNote: string | null;
}

const NOTHING_TO_SAY_NOTE =
  'The session was started but told NOTHING — stage instructions are not written yet, so it will sit idle until you talk to it. That is the current design, not a hang.';

/**
 * Classify the body of `POST /api/instances/:instanceId/dispatch` (and,
 * re-wrapped, a D53 promotion's `dispatch` rider — see `dispatchFollow.ts`).
 *
 * Every outcome the dispatcher can produce gets its OWN report — `spawned`,
 * `deferred`, `refused`, `spawn-failed`, `worktree-failed`, `in-flight` —
 * because collapsing any two of them loses the distinction the dispatcher
 * went out of its way to keep (a DECISION not to run is not the same fact as
 * an ATTEMPT that failed, and neither is the same fact as an attempt that
 * never got to decide because a sibling attempt was already running).
 *
 * S7·7e removed `resumed` / `resume-failed` from this switch along with the
 * daemon-side union variants they read — D46 (2026-07-27, S7·7b) deleted the
 * resume path before this unit landed, so neither string has been producible
 * since, and both now fall to the honest default branch below like any other
 * retired or unrecognised outcome. See taskBoard.test.ts for the pinned degrade.
 *
 * TOTAL: an unrecognised outcome, a missing body, and a non-object body all
 * produce a report rather than a throw or a blank.
 */
export function describeDispatchResponse(status: number, body: unknown): DispatchReport {
  if (status === 0) {
    return {
      outcome: 'not-sent',
      tone: 'failed',
      headline: 'The request never reached the daemon',
      detail: 'Nothing was attempted. Check the connection banner.',
      idleNote: null,
    };
  }
  if (status === 404) {
    return {
      outcome: 'unknown-task',
      tone: 'failed',
      headline: 'No such task',
      detail: 'The daemon has no task with that id, so nothing was attempted.',
      idleNote: null,
    };
  }

  const envelope = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const result = (
    typeof envelope.result === 'object' && envelope.result !== null ? envelope.result : {}
  ) as Record<string, unknown>;
  const outcome = asString(result.outcome) ?? '';
  const reason = asString(result.reason);

  switch (outcome) {
    case 'spawned':
      return {
        outcome,
        tone: 'ok',
        headline: 'Spawned a stage run',
        detail: asString(result.cwd),
        idleNote: instructionNote(result),
      };
    case 'deferred':
      return {
        outcome,
        tone: 'waiting',
        headline: 'Deferred — waiting on a gate',
        detail:
          reason === null
            ? null
            : (DEFER_SENTENCE[reason] ?? `Deferred: ${reason}.`) +
              (asString(result.meterId) === null ? '' : ` (meter: ${asString(result.meterId)})`),
        idleNote: null,
      };
    case 'refused':
      return {
        outcome,
        tone: 'refused',
        headline: 'Refused — the dispatcher decided not to run this',
        detail:
          reason === null
            ? null
            : (REFUSE_SENTENCE[reason] ??
              `The dispatcher refused: “${reason}”. This board has no plain-words description for that reason yet — the refusal is in the log.`),
        idleNote: null,
      };
    case 'spawn-failed':
      return {
        outcome,
        tone: 'failed',
        headline: 'The session host did not produce a session',
        // The host's own reason, verbatim.
        detail: reason,
        idleNote: null,
      };
    case 'worktree-failed':
      return {
        outcome,
        tone: 'failed',
        headline: 'The isolated worktree could not be created — nothing ran',
        // ⚠ GIT'S OWN WORDS, CARRIED VERBATIM. The task did NOT fall back to
        // running in projectRoot, and this is the only place the operator gets
        // to see why not.
        detail: reason,
        idleNote: null,
      };
    case 'in-flight':
      // D54's per-task lock. This attempt lost a race to a sibling attempt for
      // the SAME task, arrived while the winner was still between its decision
      // and its `task_session_attached` — see taskDispatcher.ts's own note on
      // the window. Nothing was judged, spawned, or written for THIS attempt,
      // so `waiting` (not `refused`, not `failed`) is the honest tone: exactly
      // like `deferred`, this is the gate doing its job, not a denial.
      return {
        outcome,
        tone: 'waiting',
        headline: 'A dispatch for this task is already in flight',
        detail:
          'Nothing was attempted — another dispatch attempt is mid-flight right now, and its own result is the record. This clears itself when that attempt settles.',
        idleNote: null,
      };
    default:
      return {
        outcome,
        tone: 'unknown',
        headline:
          outcome === ''
            ? 'The daemon answered, but the board could not read the outcome'
            : `Unrecognised dispatch outcome: “${outcome}”`,
        detail:
          'This board has not learned that outcome yet. Whatever happened is in the log — do not read this as either success or failure.',
        idleNote: null,
      };
  }
}

// What, if anything, the freshly-running session was told. Three distinct
// states, and only one of them is silence.
function instructionNote(result: Record<string, unknown>): string | null {
  const delivery = result.instructionDelivery;
  if (typeof delivery !== 'object' || delivery === null) {
    return NOTHING_TO_SAY_NOTE;
  }
  const status = asString((delivery as Record<string, unknown>).status);
  if (status === 'sent') {
    return null;
  }
  const undeliveredReason = asString((delivery as Record<string, unknown>).reason);
  return `An instruction was composed but NOT delivered${undeliveredReason === null ? '' : `: ${undeliveredReason}`}. The session is running and attached, but it never received its brief.`;
}
