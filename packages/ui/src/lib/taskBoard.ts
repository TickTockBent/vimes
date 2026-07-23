// Pure derivation for the task board (slice 6 step 9) — turns the tasks
// projection (GET /api/projections/tasks) into display-ready groups and cards,
// and turns the task API's three answers (transition / dispatch) into honest
// sentences. No Vue, no DOM, no I/O: every branch is unit-tested without a
// browser (same split as lib/costDisplay.ts and lib/meterDisplay.ts).
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
// ⚠ RULE TWO: **THE UI PROPOSES, THE MACHINE DECIDES.** `TASK_STAGE_EDGES` is
// NOT mirrored here and must never be. `moveOptionsFor` offers every stage
// except the current one and lets `POST /api/tasks/:taskId/transitions` refuse —
// see that function's own note for why hiding illegal moves would be a bug and
// not a courtesy.
//
// @vimes/core is deliberately NOT a dependency of packages/ui (see the header of
// lib/types.ts), so the wire shapes below mirror packages/core/src/schemas.ts
// and the taskApi/taskDispatcher envelopes NARROWLY. Unknown keys are tolerated.

import type { Liveness, SessionRecord } from './types.js';

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
export const EXCEPTION_STAGES = ['quarantined', 'blocked-external'] as const;

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

// ── Mirrored record shape ───────────────────────────────────────────────────
//
// Every field but `taskId` is optional/loose ON PURPOSE. This is parsed from a
// projection body over the wire, and I8 says hostile or degenerate input must
// never crash a reader and must never silently swallow a record. `stage` is
// typed `string`, not `TaskStage`, for exactly the reason
// `proposeTransitionBodySchema` types `toStage` as a plain string in the daemon:
// a value outside the enum physically reaches us, and refusing to model it is
// how it disappears.
export interface TaskBoardRecord {
  readonly taskId: string;
  readonly projectRoot?: unknown;
  readonly title?: unknown;
  readonly stage?: unknown;
  readonly manualReviewRequired?: unknown;
  readonly isolation?: unknown;
  readonly createdBy?: unknown;
  readonly sessionRefs?: unknown;
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
  readonly createdBy: string | null;
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
  const rawTitle = asString(task.title);
  // ⚠ A WHITESPACE-ONLY TITLE FALLS BACK TOO. The daemon records `''` verbatim
  // (it bounds length, it does not editorialise), which is the right call there
  // and would be a blank card here. "Never a blank card" is decided in exactly
  // one place, and this is it.
  const usableTitle = rawTitle !== null && rawTitle.trim().length > 0 ? rawTitle.trim() : null;

  const rawStage = asString(task.stage);
  const stage = rawStage ?? '';
  const projectRoot = asString(task.projectRoot);

  return {
    taskId: task.taskId,
    label: usableTitle ?? shortTaskId(task.taskId),
    labelIsFallback: usableTitle === null,
    stage,
    stageKind: stageKind(stage),
    projectName: projectRoot === null ? null : basenameOf(projectRoot),
    createdBy: asString(task.createdBy),
    isolatedInWorktree: task.isolation === 'worktree',
    manualReviewRequired: task.manualReviewRequired === true,
    latestSession: latestSessionOf(task, sessionsById),
  };
}

function latestSessionOf(
  task: TaskBoardRecord,
  sessionsById: Readonly<Record<string, SessionRecord>>,
): TaskCard['latestSession'] {
  if (!Array.isArray(task.sessionRefs)) {
    return null;
  }
  // `sessionRefs` is a CHRONOLOGICAL trail (the projection appends, never
  // sorts), so the most recent run is the last usable entry — walked backwards
  // so a malformed entry at the tail does not hide a good one behind it.
  for (let index = task.sessionRefs.length - 1; index >= 0; index -= 1) {
    const candidate = task.sessionRefs[index] as { stage?: unknown; appSessionId?: unknown } | null;
    const appSessionId = asString(candidate?.appSessionId);
    if (appSessionId === null) {
      continue;
    }
    return {
      appSessionId,
      stage: asString(candidate?.stage) ?? '',
      // Absent from the projection → null, NOT a guess. A ref whose session we
      // cannot see is a known unknown; rendering it as 'dead' would be a lie
      // about a session that may well be running.
      liveness: sessionsById[appSessionId]?.liveness ?? null,
    };
  }
  return null;
}

/**
 * Read the tasks projection body into a classified board.
 *
 * TOTAL AND NON-THROWING over any body (I8, assertion 11): a null body, a
 * missing `tasks` key, `tasks` as an array/string/number, null task values and
 * records missing every field all produce a board rather than an exception.
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
): TaskBoard {
  const cards = readTaskCards(body, sessionsById);

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
  const tasks = (body as { tasks?: unknown }).tasks;
  if (typeof tasks !== 'object' || tasks === null || Array.isArray(tasks)) {
    return [];
  }

  const cards: TaskCard[] = [];
  for (const [key, value] of Object.entries(tasks as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      // A null/primitive value under a real key is still evidence a task exists.
      // It is kept with the MAP KEY as its id rather than dropped — the key is
      // the taskId in the projection's own shape, so this fabricates nothing.
      cards.push(deriveTaskCard({ taskId: key }, sessionsById));
      continue;
    }
    const record = value as Record<string, unknown>;
    // The record's own taskId when it has one, otherwise the map key it is
    // filed under. They agree in every projection the daemon serializes; when
    // they do not, the key is the addressable one.
    cards.push(
      deriveTaskCard({ ...record, taskId: asString(record.taskId) ?? key }, sessionsById),
    );
  }
  return cards;
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

// ── The move sheet ──────────────────────────────────────────────────────────

export interface MoveOption {
  readonly stage: TaskStage;
  readonly label: string;
  readonly kind: StageKind;
}

/**
 * The stages the move sheet offers: **EVERY known stage except the task's
 * current one.**
 *
 * ⚠ **DELIBERATELY NOT FILTERED BY LEGALITY, AND A FUTURE "HELPFUL" EDGE TABLE
 * HERE WOULD BE A BUG.** Three reasons, and the third is the one that matters:
 *
 *  1. `@vimes/core` is not a dependency of packages/ui, so `TASK_STAGE_EDGES`
 *     would have to be COPIED — and a copied vocabulary drifts. That is the
 *     exact drift `taskApi.ts` binds against with `exhaustiveVocabulary`, and
 *     nothing here could bind against anything.
 *  2. Filtering would make this UI a SECOND AUTHORITY on transition legality,
 *     which rule 0.3 and principle 10 forbid outright: UIs propose transitions,
 *     they never own them.
 *  3. The refusal is already built, enumerated and EVENTED (I7). Surfacing it is
 *     not a fallback — **it is the feature.** A board that hides illegal moves
 *     hides the invariant; a board that asks and reports the machine's answer
 *     demonstrates it, every time anyone taps.
 *
 * The current stage is excluded for one reason only, and it is not legality:
 * offering it would be offering a no-op. (The machine agrees, and says
 * `same-stage` — which is why that reason still has a sentence below.)
 */
export function moveOptionsFor(currentStage: string): readonly MoveOption[] {
  return KNOWN_STAGES.filter((stage) => stage !== currentStage).map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    kind: stageKind(stage),
  }));
}

// ── The machine's answer, in human words ────────────────────────────────────

// Every enumerated `TransitionRejectionReason` (packages/core
// tasks/taskStateMachine.ts), each with its OWN sentence. A shared "that move
// isn't allowed" would throw away the one thing the 409 is carrying.
const REJECTION_SENTENCE: Readonly<Record<string, string>> = {
  'illegal-edge': 'That move is not one of the edges out of this stage. The task has not moved.',
  'terminal-stage':
    'Done is final. Reopening finished work mints a NEW task rather than resurrecting this one, so the audit trail stays honest.',
  'same-stage': 'The task is already in that stage, so nothing was proposed.',
  'quarantined-cannot-complete':
    'A quarantined run may not complete. Send it back through planning or implementing, park it as blocked, or return it to the backlog — it cannot go straight to done.',
  'unknown-stage':
    'The machine does not recognise one of the stages in that proposal. The refusal is in the log.',
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
 * Classify the response to `POST /api/tasks/:taskId/transitions`.
 *
 * The status-code contract is `taskApi.ts`'s, read as it is written there:
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
    const movedTo = asString((parsed.task as Record<string, unknown> | undefined)?.stage) ?? '';
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
 * Classify the response to `POST /api/tasks`.
 *
 * ⚠ THE TITLE CAP IS NOT MIRRORED HERE, for the same reason the edge table is
 * not: it is the daemon's policy, it may change without this client changing,
 * and a copy would eventually disagree with it. The 400 message NAMES the likely
 * cause without asserting a number this board cannot know is still true.
 */
export function describeCreateResponse(status: number, body: unknown): CreateOutcome {
  const parsed = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  if (status === 201) {
    const task = (typeof parsed.task === 'object' && parsed.task !== null ? parsed.task : {}) as Record<
      string,
      unknown
    >;
    return {
      kind: 'created',
      taskId: asString(task.taskId) ?? '',
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
 * Classify the body of `POST /api/tasks/:taskId/dispatch`.
 *
 * Every outcome the dispatcher can produce gets its OWN report — `spawned`,
 * `resumed`, `deferred`, `refused`, `spawn-failed`, `resume-failed`,
 * `worktree-failed` — because collapsing any two of them loses the distinction
 * the dispatcher went out of its way to keep (a DECISION not to run is not the
 * same fact as an ATTEMPT that failed).
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
    case 'resumed':
      return {
        outcome,
        tone: 'ok',
        headline: 'Resumed the session that authored the work',
        detail: asString(result.appSessionId),
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
    case 'resume-failed':
      return {
        outcome,
        tone: 'failed',
        headline: 'The session host could not resume that session',
        detail:
          reason === null
            ? asString(result.appSessionId)
            : `${reason}${asString(result.appSessionId) === null ? '' : ` (session ${asString(result.appSessionId)})`}`,
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
