<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { buildWorkOrderBody, type WorkOrderFormModel } from '../lib/workOrderForm.js';
import {
  describeCreateResponse,
  describeDispatchResponse,
  describeMoveResponse,
  findTaskCard,
  groupTasksForBoard,
  moveOptionsFor,
  sessionTrailOf,
  stageLabel,
  type DispatchReport,
  type MoveOption,
  type TaskBoardRecord,
  type TaskCard,
  type TaskSessionTrailEntry,
} from '../lib/taskBoard.js';
import { sessionToSubscribeAfterDispatch, sessionToSubscribeAfterTransition } from '../lib/dispatchFollow.js';
import { projectDisplayName } from '../lib/projectContext.js';
import { SHORT_SESSION_ID_LENGTH } from '../lib/sessionLabel.js';
import { buildHash } from '../lib/route.js';
import {
  buildAmendmentBody,
  correctionDoors,
  correctionDoorsAvailable,
  seedAmendFormModel,
  type AmendableTaskRecord,
  type AmendCriterionRow,
  type AmendFormModel,
  type CorrectionDoor,
} from '../lib/correctionDoors.js';
import {
  deriveWorkOrderDisplay,
  type WorkOrderDisplay,
  type WorkOrderDisplayRecord,
} from '../lib/workOrderDisplay.js';

// ─── slice 6 step 9 — THE TASK BOARD, MOBILE ────────────────────────────────
//
// ⚠ THIS FILE IS THE MOBILE PRESENTATION AND NOTHING ELSE. A DESKTOP BOARD IS A
// SEPARATE, DELIBERATE UNIT. A phone has no room for side-by-side columns, so
// the flow is stacked vertically under a PINNED exception tray; a desktop has
// the room and should use it. The two are genuinely different presentations of
// the same data, not one responsive compromise — which is why EVERY derivation
// lives in lib/taskBoard.ts and is layout-agnostic, and why ALL layout lives
// here. A desktop view consumes the identical `groupTasksForBoard` value with
// zero changes to lib/.
//
// ⚠ NO OPTIMISTIC UI, ANYWHERE IN THIS FILE. A card moves when the PROJECTION
// says it moved and at no other time. A 200 from the transitions route sets a
// notice ("accepted, waiting for the board"), never a local stage edit: the
// `task_transitioned` event arrives on the 'tasks' stream, the store re-reads
// the projection, and the card moves because the record moved. A card that
// slides into `done` and silently slides back is the worst possible behaviour
// for the surface that carries I7.
//
// Statically imported by App.vue (like CostLedgerView) and pulling in no heavy
// dependency, so it adds no lazy chunk and cannot disturb the build-manifest
// gate.

// D41: this panel's close affordance. 'close' (a desktop panel) renders ✕;
// 'back' (a phone) keeps the original back affordance. The click handler is
// UNCHANGED — only the label/aria differ.
const props = defineProps<{ backKind?: 'back' | 'close' }>();
const emit = defineEmits<{ back: [] }>();
const store = useVimesStore();

onMounted(() => {
  // Subscribes to the 'tasks' stream AND takes a first read. Live updates ride
  // that subscription — there is no polling loop here.
  store.watchTasks();
});

// S8·2 — SCOPED TO THE OPEN PROJECT when this tab has one (D42's read-time
// derivation over each task's own `projectRoot`). `groupTasksForBoard` applies
// the scope, so the group counts describe the board on screen. Null project →
// the whole board, exactly as before.
const board = computed(() =>
  groupTasksForBoard(
    store.tasksProjectionBody,
    store.sessions,
    store.currentProject?.root ?? null,
  ),
);

// Focus: tapping a section header (or a tray count) narrows the board to that
// one stage; tapping the focused header again clears it. Purely presentational,
// which is exactly why it lives here and not in lib/.
const focusedStage = ref<string | null>(null);
function toggleFocus(stage: string): void {
  focusedStage.value = focusedStage.value === stage ? null : stage;
}
function isVisible(stage: string): boolean {
  return focusedStage.value === null || focusedStage.value === stage;
}

const visibleFlow = computed(() => board.value.flow.filter((group) => isVisible(group.stage)));
const visibleExceptions = computed(() =>
  board.value.exceptions.filter((group) => isVisible(group.stage)),
);
const visibleUnknown = computed(() => board.value.unknown.filter((group) => isVisible(group.stage)));

// ── The card sheet (move + dispatch) ────────────────────────────────────────
// One sheet per card, opened by tapping the card. Tap → sheet is the whole
// interaction; drag-and-drop is a desktop affordance that fights a phone and
// would need its own accessibility story.
// Remember only the taskId; the live card (and its stage) is derived from the
// board so the sheet reacts when the projection moves the task. A task that
// vanishes from the board closes its sheet — projection is truth, no stale
// sheet over a gone task.
const openCardId = ref<string | null>(null);
const openCard = computed<TaskCard | null>(() =>
  openCardId.value === null ? null : findTaskCard(board.value, openCardId.value),
);
const moveInFlight = ref(false);
const dispatchInFlight = ref(false);
// The last answer from the machine, kept until the operator dismisses it. A 409
// is never swallowed and never collapsed into "failed".
const moveNotice = ref<{ tone: 'accepted' | 'rejected' | 'error'; sentence: string } | null>(null);
const dispatchNotice = ref<DispatchReport | null>(null);
// The appSessionId a `spawned` dispatch just started, or null. Reuses the
// SAME strict guard the store calls to decide whether to subscribe+refresh
// (S9) — so the link below only ever appears for a genuine spawn with a real
// id, and `describeDispatchResponse`'s shape stays untouched (it reads the
// raw answer body directly, not the report).
const dispatchedSessionId = ref<string | null>(null);

const moveOptions = computed<readonly MoveOption[]>(() =>
  openCard.value === null ? [] : moveOptionsFor(openCard.value.stage, store.stageEdges),
);

// S7·7g — the open card's SESSION TRAIL. `sessionTrailOf` reads `sessionRefs`
// off the wire record, which `TaskCard` deliberately does not carry (see
// lib/taskBoard.ts's note on why the trail sits standalone rather than
// widening every card). So this looks the raw record back up out of the
// projection body by the open taskId, using the SAME key-vs-own-taskId
// precedence `readTaskCards` uses internally — the two agree in every
// projection the daemon serializes (see that function's own comment).
const openTaskRecord = computed<TaskBoardRecord | null>(() => {
  const taskId = openCardId.value;
  const body = store.tasksProjectionBody as { tasks?: Record<string, unknown> } | null | undefined;
  const raw = taskId === null ? undefined : body?.tasks?.[taskId];
  return typeof raw === 'object' && raw !== null ? ({ ...raw, taskId } as TaskBoardRecord) : null;
});
const sessionTrail = computed<readonly TaskSessionTrailEntry[]>(() =>
  openTaskRecord.value === null ? [] : sessionTrailOf(openTaskRecord.value, store.sessions),
);
// `attempt N` is noise for a stage that only ran once — shown only when this
// entry's stage bucket holds more than one usable ref. The trail is tiny
// (a handful of dispatches per task), so a linear scan per row costs nothing.
function stageHasMultipleAttempts(entry: TaskSessionTrailEntry): boolean {
  return sessionTrail.value.filter((other) => other.stage === entry.stage).length > 1;
}

function openSheet(card: TaskCard): void {
  openCardId.value = card.taskId;
  moveNotice.value = null;
  dispatchNotice.value = null;
  dispatchedSessionId.value = null;
  amendOpen.value = false;
  amendNotice.value = null;
}
function closeSheet(): void {
  openCardId.value = null;
  amendOpen.value = false;
}

async function proposeMove(toStage: string): Promise<void> {
  const card = openCard.value;
  if (card === null || moveInFlight.value) {
    return;
  }
  moveInFlight.value = true;
  dispatchNotice.value = null;
  dispatchedSessionId.value = null;
  try {
    const answer = await store.proposeTaskTransition(card.taskId, toStage);
    const outcome = describeMoveResponse(answer.status, answer.body);
    moveNotice.value = { tone: outcome.kind, sentence: outcome.sentence };
    // ⚠ NOTHING MOVES HERE. Not even on `accepted` — the sheet stays open with
    // the machine's answer on it, and the board redraws when the projection
    // catches up.

    // S7·7e — THE D53 DISPATCH RIDER. A promotion into an active stage makes
    // its own dispatch attempt (taskApi.ts's transitions route), and an
    // accepted envelope carries that attempt's result on a top-level
    // `dispatch` field — see `ProposeTransitionResponse`. When it is present,
    // re-wrap it in the `{ result }` shape `describeDispatchResponse` already
    // reads and hand it to that SAME describer, rather than writing a second
    // one for a field that carries the identical `DispatchAttemptResult`
    // shape (principle 9: one description per fact, not one per call site).
    // `dispatchedSessionId` reuses its own strict guard the same way, which is
    // what lets the existing notice markup below grow the "Open session" link
    // for a promotion exactly as it already does for an explicit dispatch —
    // no markup change needed, the link derives from the same report shape.
    const body = answer.body;
    if (typeof body === 'object' && body !== null && 'dispatch' in body) {
      dispatchNotice.value = describeDispatchResponse(200, { result: (body as { dispatch: unknown }).dispatch });
      dispatchedSessionId.value = sessionToSubscribeAfterTransition(answer.status, answer.body);
    }
  } finally {
    moveInFlight.value = false;
  }
}

async function dispatch(): Promise<void> {
  const card = openCard.value;
  if (card === null || dispatchInFlight.value) {
    return;
  }
  dispatchInFlight.value = true;
  moveNotice.value = null;
  try {
    const answer = await store.dispatchTask(card.taskId);
    dispatchNotice.value = describeDispatchResponse(answer.status, answer.body);
    dispatchedSessionId.value = sessionToSubscribeAfterDispatch(answer.status, answer.body);
  } finally {
    dispatchInFlight.value = false;
  }
}

// The dispatched session's panel link, or null when there is none (deferred/
// refused/failed notices stay plain text). `buildHash` owns the encoding —
// nothing here hand-crafts the `#/session/…` shape.
const dispatchedSessionHref = computed(() =>
  dispatchedSessionId.value === null
    ? null
    // `buildHash` already returns the full hash (leading `#` included) — do NOT
    // prepend another, or the href becomes `##/session/…` and degrades to the
    // fallback route instead of opening the session.
    : buildHash({ view: 'stream', appSessionId: dispatchedSessionId.value }),
);

// ── The two correction doors (S7·8, D46/D53) ────────────────────────────────
// D46 gave stage-run corrections exactly two legitimate doors, and named the
// T7 failure as the doors not being LABELED, not being absent — so this
// section renders `correctionDoors`' descriptors verbatim rather than a bare
// button. `correctionTaskRecord` re-reads the SAME raw record `openTaskRecord`
// already resolved (S7·7g), cast to `correctionDoors.ts`'s own narrow mirror:
// `TaskBoardRecord` is the CARD's inputs and does not carry `workOrderRev` /
// `scope` / etc, so this is a second narrow VIEW of the identical wire object,
// not a second lookup.
const correctionTaskRecord = computed<AmendableTaskRecord | null>(() =>
  openTaskRecord.value === null ? null : (openTaskRecord.value as unknown as AmendableTaskRecord),
);
const correctionAvailable = computed<boolean>(
  () => correctionTaskRecord.value !== null && correctionDoorsAvailable(correctionTaskRecord.value),
);
const correctionDoorList = computed<readonly CorrectionDoor[]>(() =>
  correctionTaskRecord.value === null ? [] : correctionDoors(correctionTaskRecord.value),
);
// Shown near the doors only when the record actually carries a numeric rev —
// absent/malformed stays silent rather than printing a guessed "rev 0" next
// to doors that already say so in their own detail strings.
const correctionRevDisplay = computed<number | null>(() => {
  const rev = correctionTaskRecord.value?.workOrderRev;
  return typeof rev === 'number' ? rev : null;
});

// ── The work-order INSPECTION section (S8·6b) ───────────────────────────────
// Read-only rendering of the SAME wire fields `correctionTaskRecord` above
// seeds the amend door from — a THIRD narrow view of the identical
// `openTaskRecord` object, not a third lookup. Same cast idiom as
// `correctionTaskRecord`: `TaskBoardRecord` and `WorkOrderDisplayRecord` are
// two independently-narrow mirrors of the identical wire record and share no
// declared keys, so TS's weak-type (no-common-properties) check rejects a
// direct pass — `as unknown as` states the runtime fact (the object really
// does carry these fields; the TYPE is just a narrower view of it) rather
// than fighting the checker. Closes the gap this unit exists for: until now
// the ONLY surface rendering scope/explicitly-out/acceptance-criteria/
// kill-criterion was the amend FORM — an inspection surface that is secretly
// an edit form is not one, and the Gate-2 trial requires grading authored
// work-orders from the board.
const workOrderDisplay = computed<WorkOrderDisplay | null>(() =>
  openTaskRecord.value === null
    ? null
    : deriveWorkOrderDisplay(openTaskRecord.value as unknown as WorkOrderDisplayRecord),
);

function openCorrectionDoor(kind: CorrectionDoor['kind']): void {
  if (kind === 'steer') {
    // The steer door IS the existing dispatch handler, relabeled with its
    // meaning (D46: same workOrderRev, a fresh attempt) — not a new action.
    void dispatch();
  } else {
    openAmend();
  }
}

// ── The amend sheet (S7·8) ──────────────────────────────────────────────────
// D46's second door: writes a NEW workOrderRev via `POST
// /api/tasks/:taskId/amendments` (S7·2b) and dispatches NOTHING (D53 — no
// chaining; whether to re-run against the new revision is a later, explicit
// act). Reuses the create sheet's own field-rendering pattern (driven by the
// SAME `store.workOrderSchema` descriptor) rather than inventing a parallel
// one, seeded from the record via `seedAmendFormModel` instead of starting
// blank.
const amendOpen = ref(false);
// The form as it was PREFILLED at open — the diff base `buildAmendmentBody`
// compares the edited model against. Frozen at open time so an in-flight edit
// is diffed against what the operator actually started from, not against a
// record the projection may have moved underneath the open sheet.
const amendSeedModel = ref<AmendFormModel | null>(null);
// `scope` / `killCriterion` — the two `longtext` fields.
const amendText = reactive<Record<string, string>>({});
// `explicitlyOut` / `acceptanceCriteria` — both repeatable fields, represented
// UNIFORMLY as `AmendCriterionRow[]` so one add/remove/update row family
// serves both: a plain list row's `id` is always `null` and dropped on submit,
// a criterion row's `id` rides invisibly through edits (rewording keeps it).
const amendRows = reactive<Record<string, AmendCriterionRow[]>>({});
const amendInFlight = ref(false);
// The last refusal's message, or null. A 200 closes the sheet outright — this
// only ever holds an ERROR (matching the create sheet's `createNotice`, which
// also only surfaces on a non-success path here, unlike the card sheet's
// notices which show the accepted case too — amending has nothing further to
// report once it worked, since the amended record itself is the news).
const amendNotice = ref<string | null>(null);

function openAmend(): void {
  const record = correctionTaskRecord.value;
  if (record === null) {
    return;
  }
  const seed = seedAmendFormModel(record);
  amendSeedModel.value = seed;
  amendText.scope = seed.scope;
  amendText.killCriterion = seed.killCriterion;
  // Start an empty list from ONE blank row to type into, same idiom as the
  // create sheet's `resetWorkOrderForm` — an untouched row is dropped by
  // `buildAmendmentBody`'s cleaning step, so this costs nothing.
  amendRows.explicitlyOut =
    seed.explicitlyOut.length > 0 ? seed.explicitlyOut.map((text) => ({ id: null, text })) : [{ id: null, text: '' }];
  amendRows.acceptanceCriteria =
    seed.acceptanceCriteria.length > 0 ? seed.acceptanceCriteria.map((row) => ({ ...row })) : [{ id: null, text: '' }];
  amendNotice.value = null;
  amendOpen.value = true;
}

function closeAmend(): void {
  amendOpen.value = false;
}

function addAmendRow(fieldKey: string): void {
  (amendRows[fieldKey] ??= []).push({ id: null, text: '' });
}

function removeAmendRow(fieldKey: string, rowIndex: number): void {
  const rows = amendRows[fieldKey];
  if (rows === undefined) {
    return;
  }
  rows.splice(rowIndex, 1);
  // Always leave one row present so the field never disappears entirely.
  if (rows.length === 0) {
    rows.push({ id: null, text: '' });
  }
}

// Write one row's TEXT back into the model, preserving its `id` — the same
// explicit-setter idiom `updateRow` uses on the create sheet, for the same
// `noUncheckedIndexedAccess` reason, plus the one thing that idiom did not
// need to protect: a rewording must never touch the id it is keyed to.
function updateAmendRowText(fieldKey: string, rowIndex: number, value: string): void {
  const rows = amendRows[fieldKey];
  if (rows === undefined) {
    return;
  }
  const row = rows[rowIndex];
  if (row === undefined) {
    return;
  }
  rows[rowIndex] = { id: row.id, text: value };
}

// The amend route's error vocabulary, in plain words. Not exported/tested
// (house rule — the .vue is manual): every branch here is presentation of an
// already-classified daemon answer, not a decision.
function amendErrorMessage(status: number, body: unknown): string {
  if (status === 0) {
    return 'The request never reached the daemon. Nothing was amended.';
  }
  if (status === 404) {
    return 'The daemon has no task with that id — nothing was amended.';
  }
  const parsed = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const detail = typeof parsed.detail === 'string' ? parsed.detail : null;
  if (detail === 'unknown-criterion') {
    const criterionId = typeof parsed.criterionId === 'string' ? parsed.criterionId : '(id not given)';
    return `That criteria row is stale — the record no longer has a criterion with id "${criterionId}". Close and reopen Amend to pick up the current list, then redo the edit.`;
  }
  if (detail === 'empty-amendment') {
    // Reachable only if the daemon and this form's own client-side mirror
    // (buildAmendmentBody returning null) somehow disagree — kept honest
    // rather than assumed unreachable.
    return 'The daemon read that as changing nothing, so nothing was written.';
  }
  return `The daemon answered ${status}${detail === null ? '' : `: ${detail}`}. Nothing was amended.`;
}

async function submitAmend(): Promise<void> {
  const record = correctionTaskRecord.value;
  const seed = amendSeedModel.value;
  if (record === null || seed === null || amendInFlight.value) {
    return;
  }
  const edited: AmendFormModel = {
    scope: amendText.scope ?? '',
    killCriterion: amendText.killCriterion ?? '',
    explicitlyOut: (amendRows.explicitlyOut ?? []).map((row) => row.text),
    acceptanceCriteria: amendRows.acceptanceCriteria ?? [],
  };
  const body = buildAmendmentBody(seed, edited);
  if (body === null) {
    // Nothing changed — close with no POST. The client-side mirror of the
    // amendments route's own `empty-amendment` refusal, so a no-op submit
    // never reaches the network (and never bumps a rev for nothing).
    amendOpen.value = false;
    return;
  }
  amendInFlight.value = true;
  try {
    const answer = await store.amendTask(record.taskId, body);
    if (answer.status === 200) {
      // ⚠ NO LOCAL PATCH, same NO-OPTIMISTIC-UI posture as every other write in
      // this file. The 'tasks' stream carries the amendment's fold, the store
      // re-reads the projection, and `openTaskRecord`/`correctionTaskRecord`
      // re-derive from it — the sheet closes back to the (already-reactive)
      // card sheet rather than hand-patching anything.
      amendOpen.value = false;
      return;
    }
    // ⚠ NO DISPATCH CALL, HERE OR ANYWHERE IN THIS FLOW (D53). The amend
    // door's own detail string already told the operator dispatch is a
    // separate, later step.
    amendNotice.value = amendErrorMessage(answer.status, answer.body);
  } finally {
    amendInFlight.value = false;
  }
}

// ── The create sheet ────────────────────────────────────────────────────────
// The board has to be able to get its first card without leaving the phone.
// Creation only — there is deliberately no rename and no post-creation edit.
const createOpen = ref(false);
const createTitle = ref('');
const createProjectRoot = ref('');
const createInFlight = ref(false);
const createNotice = ref<string | null>(null);

// S7·3 — the four AUTHORED work-order fields. The FIELD LIST is not hard-coded:
// the sheet renders whatever `store.workOrderSchema` (served by the daemon)
// says, keyed by descriptor `key`. `workOrderText` holds the `longtext` fields;
// `workOrderRows` holds the repeatable `list`/`criteria-list` rows (one string
// per row). Both are seeded from the descriptor when the sheet opens, so nothing
// here names a field the daemon did not serve. `buildWorkOrderBody` (pure,
// tested) turns this raw model into the create-body fragment with empties omitted.
const workOrderText = reactive<Record<string, string>>({});
const workOrderRows = reactive<Record<string, string[]>>({});

function resetWorkOrderForm(): void {
  for (const field of store.workOrderSchema ?? []) {
    if (field.kind === 'longtext') {
      workOrderText[field.key] = '';
    } else {
      // Start every repeatable field with one empty row to type into. An
      // untouched row is dropped by buildWorkOrderBody, so this costs nothing.
      workOrderRows[field.key] = [''];
    }
  }
}

function addRow(fieldKey: string): void {
  (workOrderRows[fieldKey] ??= []).push('');
}

function removeRow(fieldKey: string, rowIndex: number): void {
  const rows = workOrderRows[fieldKey];
  if (rows === undefined) {
    return;
  }
  rows.splice(rowIndex, 1);
  // Always leave one row present so the field never disappears entirely.
  if (rows.length === 0) {
    rows.push('');
  }
}

// Write one row's text back into the model. An explicit setter (rather than a
// `v-model` into an indexed array) keeps `noUncheckedIndexedAccess` honest — the
// array may not exist for a key the descriptor did not seed.
function updateRow(fieldKey: string, rowIndex: number, value: string): void {
  const rows = workOrderRows[fieldKey];
  if (rows === undefined) {
    return;
  }
  rows[rowIndex] = value;
}

const rootOptions = computed(() => store.roots ?? []);

function openCreate(): void {
  createNotice.value = null;
  // ⚠ THE OPEN PROJECT IS THE DEFAULT projectRoot (S8·2). Inside johnny, "new
  // task" means a task in johnny — and a task created against the wrong root
  // spawns its session in the wrong directory AND vanishes from the board that
  // created it. This REPLACES whatever the box held, deliberately: a stale
  // hand-typed path from a previous project is the exact value to overwrite.
  const openProjectRoot = store.currentProject?.root;
  if (openProjectRoot !== undefined) {
    createProjectRoot.value = openProjectRoot;
  }
  // Seed the work-order form from the served descriptor (fetched on mount by
  // watchTasks, the same place stage-edges is fetched). Falls back to no fields
  // until the descriptor lands — never a hard-coded list.
  resetWorkOrderForm();
  createOpen.value = true;
  if (createProjectRoot.value === '' && rootOptions.value.length > 0) {
    // Prefill with the projects container (the shortest known root — a container
    // is shorter than any project path inside it) plus a trailing slash, so the
    // operator just types the rest of the path. Text entry is deliberate and
    // TEMPORARY: project selection moves to the start of the app soon (the
    // project-centric reframe), after which New Task defaults to the opened
    // project. The daemon walls projectRoot to the allowlist, so a mistyped path
    // gets a clean 403, never a bad spawn.
    const projectsBase = [...rootOptions.value].sort(
      (first, second) => first.length - second.length,
    )[0]!;
    createProjectRoot.value = projectsBase.endsWith('/') ? projectsBase : `${projectsBase}/`;
  }
}

async function submitCreate(): Promise<void> {
  if (createInFlight.value || createProjectRoot.value === '') {
    return;
  }
  createInFlight.value = true;
  try {
    const trimmedTitle = createTitle.value.trim();
    // Build the work-order fragment from the raw form model. `buildWorkOrderBody`
    // OMITS every empty field/row, so an unauthored create is byte-identical to a
    // title-only POST (absent stays absent — enforced there, not here).
    const workOrderFormModel: WorkOrderFormModel = {
      scope: workOrderText.scope ?? '',
      killCriterion: workOrderText.killCriterion ?? '',
      explicitlyOut: workOrderRows.explicitlyOut ?? [],
      acceptanceCriteria: workOrderRows.acceptanceCriteria ?? [],
    };
    const answer = await store.createTask({
      projectRoot: createProjectRoot.value,
      // Absent stays absent all the way to the birth record — a blank box must
      // not become a task titled with an empty string.
      ...(trimmedTitle === '' ? {} : { title: trimmedTitle }),
      ...buildWorkOrderBody(workOrderFormModel),
    });
    const outcome = describeCreateResponse(answer.status, answer.body);
    createNotice.value = outcome.sentence;
    if (outcome.kind === 'created') {
      createTitle.value = '';
      resetWorkOrderForm();
      createOpen.value = false;
    }
  } finally {
    createInFlight.value = false;
  }
}

// ── Presentation helpers (layout/colour ONLY — no decisions) ────────────────

const DISPATCH_TONE_CLASS: Readonly<Record<DispatchReport['tone'], string>> = {
  // `waiting` is deliberately NOT the failure palette: a deferred dispatch is
  // the gate doing its job, and dressing it in red would train an operator to
  // fear a healthy state.
  ok: 'border-ok/30 bg-ok/10 text-ok',
  waiting: 'border-accent/30 bg-accent/10 text-accent',
  refused: 'border-warn/30 bg-warn/10 text-warn',
  failed: 'border-crit/30 bg-crit/10 text-crit',
  unknown: 'border-line bg-panel-sunken text-ink',
};

const MOVE_TONE_CLASS: Readonly<Record<'accepted' | 'rejected' | 'error', string>> = {
  accepted: 'border-ok/30 bg-ok/10 text-ok',
  // A rejection is the machine working, not the board breaking — warn, not crit.
  rejected: 'border-warn/30 bg-warn/10 text-warn',
  error: 'border-crit/30 bg-crit/10 text-crit',
};

// ⚠ DUPLICATE OF lib/sessionRow.ts's LIVENESS_STYLE — this board keeps its own
// hardcoded liveness colour table. Tokenized IN PLACE to MATCH sessionRow.ts's
// 4a·2 mapping exactly (text-accent-fg is the on-fill foreground for every solid
// tone/accent fill; dormant is the quiet neutral bg-ink-dim). A future unit may
// dedup this against the lib — out of scope for the styling sweep.
const LIVENESS_CLASS: Readonly<Record<string, string>> = {
  spawning: 'bg-accent text-accent-fg',
  running: 'bg-ok text-accent-fg',
  dormant: 'bg-ink-dim text-ground',
  interrupted: 'bg-warn text-accent-fg',
  dead: 'bg-crit text-accent-fg',
};
function livenessClass(liveness: string): string {
  // Fallback for an unrecognised liveness string: a muted neutral badge,
  // distinct from the tone fills above (no bare-palette default).
  return LIVENESS_CLASS[liveness] ?? 'bg-panel-sunken text-ink-dim';
}
</script>

<template>
  <div class="mx-auto flex h-full max-w-lg flex-col gap-4 overflow-y-auto overscroll-contain p-4">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-line px-3 text-sm font-medium active:bg-panel-sunken"
          :aria-label="props.backKind === 'close' ? 'Close panel' : 'Back'"
          @click="emit('back')"
        >
          {{ props.backKind === 'close' ? '✕' : '‹ Back' }}
        </button>
        <h1 class="flex min-w-0 items-baseline gap-2 text-lg font-semibold uppercase tracking-[0.08em] text-ink">
          Tasks
          <!-- The scope indicator (S8·2): this board is FILTERED, and every count
               on it is scoped too. A filtered board that does not say so reads as
               a project with no work in it. -->
          <span
            v-if="store.currentProject"
            class="min-w-0 truncate text-xs font-medium normal-case tracking-normal text-ink-dim"
          >
            in {{ projectDisplayName(store.currentProject) }}
          </span>
        </h1>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-line px-3 text-sm font-medium active:bg-panel-sunken"
          @click="openCreate"
        >
          + New
        </button>
        <button
          type="button"
          class="min-h-[44px] min-w-[44px] rounded-md border border-line px-3 text-sm font-medium active:bg-panel-sunken"
          aria-label="Refresh the task board"
          @click="store.fetchTasks()"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
    </div>

    <!-- THE EXCEPTION TRAY — pinned, and always rendered even at zero.
         `quarantined` and `blocked-external` are NOT pipeline positions: the
         edge table makes them reachable from nearly every stage and they lead
         back out, so they must not sit in the flow as if they were steps. A zero
         count still renders: "no blocked work" is a fact worth showing, and a
         tray that vanishes teaches you not to look for it. -->
    <section
      class="sticky top-0 z-20 flex gap-2 rounded-lg border border-line bg-panel/95 p-2 backdrop-blur"
      aria-label="Exception tray"
    >
      <button
        v-for="group in board.exceptions"
        :key="`tray:${group.stage}`"
        type="button"
        class="flex min-h-[44px] flex-1 flex-col items-start justify-center rounded-md border px-3 py-1 text-left"
        :class="
          focusedStage === group.stage
            ? 'border-ink bg-panel-sunken'
            : 'border-line'
        "
        :aria-pressed="focusedStage === group.stage"
        @click="toggleFocus(group.stage)"
      >
        <span class="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-dim">{{ group.label }}</span>
        <span
          class="text-lg font-bold font-mono tabular-nums"
          :class="group.count === 0 ? 'text-ink-dim' : ''"
        >
          {{ group.count }}
        </span>
      </button>
    </section>

    <p v-if="store.tasksLoading" class="rounded-lg border border-line p-4 text-sm text-ink-dim">
      Reading the tasks projection…
    </p>
    <p
      v-else-if="board.totalTasks === 0"
      class="rounded-lg border border-line p-4 text-sm text-ink-dim"
    >
      No tasks have been created yet. This is an empty board, not a failed read — every stage below is real and
      waiting.
    </p>

    <p v-if="focusedStage !== null" class="text-xs text-ink-dim">
      Focused on <span class="font-semibold">{{ stageLabel(focusedStage) }}</span
      >. Tap its header again to show the whole board.
    </p>

    <!-- The exception stages' OWN sections, so a focused tray count has
         somewhere to show its cards. Rendered above the flow because a blocked
         or quarantined task is the thing you came to look at. -->
    <section
      v-for="group in visibleExceptions"
      :key="`section:${group.stage}`"
      class="flex flex-col gap-2 rounded-lg border border-warn/30 p-3"
    >
      <button
        type="button"
        class="flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
        :aria-pressed="focusedStage === group.stage"
        @click="toggleFocus(group.stage)"
      >
        <h2 class="text-sm font-semibold font-mono uppercase tracking-[0.08em]">{{ group.label }}</h2>
        <span class="rounded-full bg-warn/10 px-2 py-0.5 text-xs font-semibold font-mono tabular-nums text-warn">
          {{ group.count }}
        </span>
      </button>
      <p v-if="group.count === 0" class="text-xs text-ink-dim">Nothing here.</p>
      <ul v-else class="flex flex-col gap-2">
        <li v-for="card in group.tasks" :key="card.taskId">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-1 rounded-md border border-line p-3 text-left active:bg-panel-sunken"
            @click="openSheet(card)"
          >
            <span
              class="w-full truncate text-sm font-medium"
              :class="card.labelIsFallback ? 'font-mono text-ink-dim' : ''"
            >
              {{ card.label }}
            </span>
            <span class="flex w-full flex-wrap items-center gap-1.5 text-[11px] text-ink-dim">
              <span v-if="card.projectName !== null" class="truncate">{{ card.projectName }}</span>
              <!-- S8·6: the PROVENANCE chip. Only orchestrator-authored work is
                   marked — hand-made is the unmarked default, and the derivation
                   fails to no-chip (lib/taskBoard.ts). It replaces the plain
                   "· human"/"· orchestrator" text this row used to carry: a chip
                   the eye can find beats a word it has to read, and the Gate-2
                   pivot criterion needs the difference legible at a glance. -->
              <span
                v-if="card.authoredByOrchestrator"
                class="rounded-full bg-panel-sunken px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim"
              >
                authored
              </span>
              <span
                v-if="card.isolatedInWorktree"
                class="rounded-full bg-panel-sunken px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim"
              >
                worktree
              </span>
              <span
                v-if="card.manualReviewRequired"
                class="rounded-full bg-warn/10 px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-warn"
              >
                manual review
              </span>
              <span
                v-if="card.latestSession !== null && card.latestSession.liveness !== null"
                class="rounded-full px-1.5 py-0.5 font-semibold"
                :class="livenessClass(card.latestSession.liveness)"
              >
                {{ card.latestSession.liveness }}
              </span>
              <!-- A ref we have, a session record we do not. An honest gap,
                   never rendered as 'dead'. -->
              <span
                v-else-if="card.latestSession !== null"
                class="rounded-full bg-panel-sunken px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim"
              >
                session unknown
              </span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <!-- THE FLOW, in pipeline order. An empty stage still renders its header and
         its count — an empty column is information ("nothing in review"), not an
         absence. -->
    <section
      v-for="group in visibleFlow"
      :key="`section:${group.stage}`"
      class="flex flex-col gap-2 rounded-lg border border-line p-3"
    >
      <button
        type="button"
        class="flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
        :aria-pressed="focusedStage === group.stage"
        @click="toggleFocus(group.stage)"
      >
        <h2 class="text-sm font-semibold font-mono uppercase tracking-[0.08em]">{{ group.label }}</h2>
        <span class="rounded-full bg-panel-sunken px-2 py-0.5 text-xs font-semibold font-mono tabular-nums text-ink-dim">
          {{ group.count }}
        </span>
      </button>
      <p v-if="group.count === 0" class="text-xs text-ink-dim">Nothing here.</p>
      <ul v-else class="flex flex-col gap-2">
        <li v-for="card in group.tasks" :key="card.taskId">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-1 rounded-md border border-line p-3 text-left active:bg-panel-sunken"
            @click="openSheet(card)"
          >
            <span
              class="w-full truncate text-sm font-medium"
              :class="card.labelIsFallback ? 'font-mono text-ink-dim' : ''"
            >
              {{ card.label }}
            </span>
            <span class="flex w-full flex-wrap items-center gap-1.5 text-[11px] text-ink-dim">
              <span v-if="card.projectName !== null" class="truncate">{{ card.projectName }}</span>
              <!-- S8·6: the PROVENANCE chip. Only orchestrator-authored work is
                   marked — hand-made is the unmarked default, and the derivation
                   fails to no-chip (lib/taskBoard.ts). It replaces the plain
                   "· human"/"· orchestrator" text this row used to carry: a chip
                   the eye can find beats a word it has to read, and the Gate-2
                   pivot criterion needs the difference legible at a glance. -->
              <span
                v-if="card.authoredByOrchestrator"
                class="rounded-full bg-panel-sunken px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim"
              >
                authored
              </span>
              <span
                v-if="card.isolatedInWorktree"
                class="rounded-full bg-panel-sunken px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim"
              >
                worktree
              </span>
              <span
                v-if="card.manualReviewRequired"
                class="rounded-full bg-warn/10 px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-warn"
              >
                manual review
              </span>
              <span
                v-if="card.latestSession !== null && card.latestSession.liveness !== null"
                class="rounded-full px-1.5 py-0.5 font-semibold"
                :class="livenessClass(card.latestSession.liveness)"
              >
                {{ card.latestSession.liveness }}
              </span>
              <span
                v-else-if="card.latestSession !== null"
                class="rounded-full bg-panel-sunken px-1.5 py-0.5 font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim"
              >
                session unknown
              </span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <!-- Stages this board has no name for. Rendered, never hidden: a task in a
         stage we do not understand is exactly the task an operator most needs to
         see (I8 — nothing is silently dropped). -->
    <section
      v-for="group in visibleUnknown"
      :key="`unknown:${group.stage}`"
      class="flex flex-col gap-2 rounded-lg border border-dashed border-crit/30 p-3"
    >
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-mono text-sm font-semibold uppercase tracking-[0.08em]">{{ group.label }}</h2>
        <span class="rounded-full bg-crit/10 px-2 py-0.5 text-xs font-semibold font-mono tabular-nums text-crit">
          {{ group.count }}
        </span>
      </div>
      <p class="text-[11px] text-ink-dim">
        This board does not recognise that stage. It is shown verbatim rather than hidden — the record says what it
        says.
      </p>
      <ul class="flex flex-col gap-2">
        <li v-for="card in group.tasks" :key="card.taskId">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-1 rounded-md border border-line p-3 text-left active:bg-panel-sunken"
            @click="openSheet(card)"
          >
            <span class="w-full truncate text-sm font-medium" :class="card.labelIsFallback ? 'font-mono' : ''">
              {{ card.label }}
            </span>
            <span v-if="card.projectName !== null" class="truncate text-[11px] text-ink-dim">
              {{ card.projectName }}
            </span>
          </button>
        </li>
      </ul>
    </section>

    <!-- ── THE CARD SHEET: move + dispatch ─────────────────────────────────── -->
    <div
      v-if="openCard !== null"
      class="fixed inset-0 z-40 flex items-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Task actions"
      @click.self="closeSheet"
    >
      <div class="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-panel p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="truncate text-base font-semibold" :class="openCard.labelIsFallback ? 'font-mono' : ''">
              {{ openCard.label }}
            </h2>
            <p class="truncate font-mono text-[11px] text-ink-dim">{{ openCard.taskId }}</p>
            <p class="text-xs text-ink-dim">
              in {{ openCard.stage === '' ? '(no stage recorded)' : stageLabel(openCard.stage) }}
            </p>
          </div>
          <button
            type="button"
            class="min-h-[44px] shrink-0 rounded-md border border-line px-3 text-sm font-medium"
            @click="closeSheet"
          >
            Close
          </button>
        </div>

        <!-- The machine's answer to the last proposal. A 409 shows the enumerated
             reason in plain words — never swallowed, never a generic "failed". -->
        <p
          v-if="moveNotice !== null"
          class="mt-3 rounded-md border p-3 text-sm"
          :class="MOVE_TONE_CLASS[moveNotice.tone]"
          role="status"
        >
          {{ moveNotice.sentence }}
        </p>

        <div v-if="dispatchNotice !== null" class="mt-3 rounded-md border p-3 text-sm" :class="DISPATCH_TONE_CLASS[dispatchNotice.tone]" role="status">
          <p class="font-semibold">{{ dispatchNotice.headline }}</p>
          <p v-if="dispatchNotice.detail !== null" class="mt-1 break-words font-mono text-[11px]">
            {{ dispatchNotice.detail }}
          </p>
          <!-- Only a genuine spawn (dispatchedSessionHref !== null) gets a link — a
               deferred/refused/failed notice stays plain text. In-app hash links are
               handled globally by lib/panelLinkClick.ts; a plain <a href> is the
               established pattern, no click handler needed here. -->
          <p v-if="dispatchedSessionHref !== null" class="mt-1 break-words text-[11px]">
            <a :href="dispatchedSessionHref" class="font-mono underline decoration-dotted break-all">
              Open session {{ dispatchedSessionId }}
            </a>
          </p>
          <p v-if="dispatchNotice.idleNote !== null" class="mt-2 text-xs">{{ dispatchNotice.idleNote }}</p>
        </div>

        <!-- ── THE WORK ORDER (read-only) — S8·6b ──────────────────────────────
             Above the doors deliberately: this is what an operator reads
             BEFORE deciding whether to move, steer or amend. `workOrderDisplay`
             is null for a task authored with no work-order fields at all — the
             one-line note is the whole section then, never an empty skeleton
             pretending there is something to read. A quiet reading surface:
             dim labels, normal-weight body text, no verdict styling (that is
             later work, with the review-visibility unit). -->
        <h3 class="mt-4 text-sm font-semibold font-mono uppercase tracking-[0.08em]">Work order</h3>
        <p v-if="workOrderDisplay === null" class="mt-1 text-xs text-ink-dim">No work-order authored.</p>
        <div v-else class="mt-1 flex flex-col gap-3 text-sm">
          <div>
            <p class="text-[11px] font-medium font-mono uppercase tracking-[0.08em] text-ink-dim">Scope</p>
            <p class="mt-0.5 whitespace-pre-wrap text-ink">{{ workOrderDisplay.scope ?? '—' }}</p>
          </div>
          <div v-if="workOrderDisplay.explicitlyOut !== null">
            <p class="text-[11px] font-medium font-mono uppercase tracking-[0.08em] text-ink-dim">Explicitly out</p>
            <ul class="mt-0.5 list-disc pl-4 text-ink">
              <li v-for="(line, index) in workOrderDisplay.explicitlyOut" :key="index">{{ line }}</li>
            </ul>
          </div>
          <div v-if="workOrderDisplay.acceptanceCriteria !== null">
            <p class="text-[11px] font-medium font-mono uppercase tracking-[0.08em] text-ink-dim">
              Acceptance criteria
            </p>
            <ol class="mt-0.5 list-decimal pl-4 text-ink">
              <li v-for="criterion in workOrderDisplay.acceptanceCriteria" :key="criterion.id">
                {{ criterion.text }}
                <span class="font-mono text-[11px] text-ink-dim">{{ criterion.id }}</span>
              </li>
            </ol>
          </div>
          <div>
            <p class="text-[11px] font-medium font-mono uppercase tracking-[0.08em] text-ink-dim">Kill criterion</p>
            <p class="mt-0.5 whitespace-pre-wrap text-ink">{{ workOrderDisplay.killCriterion ?? '—' }}</p>
          </div>
          <!-- `rev` reuses the SAME 0-default `correctionDoors` prints next to the
               doors below; `authoredByOrchestrator` reuses S8·6's chip derivation
               verbatim rather than re-deriving provenance a third time. -->
          <p class="text-[11px] text-ink-dim">
            rev {{ workOrderDisplay.workOrderRev ?? 0 }} · authored by
            {{ openCard.authoredByOrchestrator ? 'orchestrator' : 'human' }}
          </p>
        </div>

        <!-- ⚠ EVERY STAGE BUT THE CURRENT ONE IS OFFERED, and the list is NOT
             filtered by transition legality. The UI proposes; the machine
             decides; the refusal is enumerated, evented (I7) and shown above.
             Mirroring TASK_STAGE_EDGES here would make this a second authority
             on legality — which 0.3 and principle 10 forbid — and would hide the
             very invariant this board exists to demonstrate. -->
        <h3 class="mt-4 text-sm font-semibold font-mono uppercase tracking-[0.08em]">Move to…</h3>
        <p class="mb-2 text-[11px] text-ink-dim">
          Every stage is offered. VIMES decides which moves are legal, and says why when it refuses.
        </p>
        <ul class="flex flex-col gap-1.5">
          <li v-for="option in moveOptions" :key="option.stage">
            <button
              type="button"
              class="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border px-3 text-left text-sm font-medium disabled:opacity-50"
              :class="
                option.kind === 'exception'
                  ? 'border-warn/40'
                  : 'border-line'
              "
              :disabled="moveInFlight"
              @click="proposeMove(option.stage)"
            >
              <span>{{ option.label }}</span>
              <span aria-hidden="true" class="text-ink-dim">›</span>
            </button>
          </li>
        </ul>

        <h3 class="mt-4 text-sm font-semibold font-mono uppercase tracking-[0.08em]">Run it</h3>

        <!-- S7·8 — THE TWO LABELED CORRECTION DOORS (D46/D53), once the task
             has run at least once. A never-dispatched task has nothing to
             steer or amend against yet, so it keeps the plain Dispatch button
             in the `v-else` branch below, unchanged. -->
        <template v-if="correctionAvailable">
          <p v-if="correctionRevDisplay !== null" class="mt-1 text-[11px] text-ink-dim">
            work-order rev {{ correctionRevDisplay }}
          </p>
          <ul class="mt-2 flex flex-col gap-1.5">
            <li v-for="door in correctionDoorList" :key="door.kind">
              <button
                type="button"
                class="flex min-h-[44px] w-full flex-col items-start gap-0.5 rounded-md border border-line px-3 py-2 text-left disabled:opacity-50"
                :disabled="door.kind === 'steer' ? dispatchInFlight : amendInFlight"
                @click="openCorrectionDoor(door.kind)"
              >
                <span class="text-sm font-semibold">
                  {{ door.kind === 'steer' && dispatchInFlight ? 'Dispatching…' : door.title }}
                </span>
                <span class="text-[11px] text-ink-dim">{{ door.detail }}</span>
              </button>
            </li>
          </ul>
        </template>
        <button
          v-else
          type="button"
          class="mt-2 min-h-[44px] w-full rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg active:bg-accent/90 disabled:opacity-50"
          :disabled="dispatchInFlight"
          @click="dispatch"
        >
          {{ dispatchInFlight ? 'Dispatching…' : 'Dispatch' }}
        </button>
        <p class="mt-2 text-[11px] text-ink-dim">
          One attempt, no retry. The worker is told its task, stage and directory.
        </p>

        <!-- ── THE SESSION TRAIL (S7·7g) ─────────────────────────────────────
             Every dispatched run for this task, oldest first — each id links to
             its stream, same affordance as "Open session" above. Rendered only
             when the trail is non-empty: a task never dispatched shows nothing
             here rather than an empty heading. Per-ref OUTCOME is deliberately
             absent (see `sessionTrailOf`'s own note) — this is a log of WHO ran
             WHEN, not a verdict history. -->
        <template v-if="sessionTrail.length > 0">
          <h3 class="mt-4 text-sm font-semibold font-mono uppercase tracking-[0.08em]">Sessions</h3>
          <ul class="flex flex-col gap-1.5">
            <li
              v-for="entry in sessionTrail"
              :key="`${entry.stage}:${entry.attempt}:${entry.appSessionId}`"
              class="flex flex-wrap items-center gap-1.5 rounded-md border border-line px-3 py-2 text-[11px] text-ink-dim"
            >
              <span class="font-medium text-ink">
                {{ entry.stage === '' ? '(no stage recorded)' : stageLabel(entry.stage) }}
              </span>
              <span v-if="stageHasMultipleAttempts(entry)">attempt {{ entry.attempt }}</span>
              <span
                v-if="entry.liveness !== null"
                class="rounded-full px-1.5 py-0.5 font-semibold"
                :class="livenessClass(entry.liveness)"
              >
                {{ entry.liveness }}
              </span>
              <a
                :href="buildHash({ view: 'stream', appSessionId: entry.appSessionId })"
                class="font-mono underline decoration-dotted break-all"
              >
                {{ entry.appSessionId.slice(0, SHORT_SESSION_ID_LENGTH) }}
              </a>
            </li>
          </ul>
        </template>
      </div>
    </div>

    <!-- ── THE AMEND SHEET (S7·8) ──────────────────────────────────────────────
         D46's second door: writes a NEW workOrderRev, dispatches NOTHING
         (D53 — no chaining). Opened by the Amend door in the card sheet above,
         so it stacks OVER it (z-50 vs the card sheet's z-40). Reuses the
         create sheet's own field-rendering pattern below, driven by the same
         `store.workOrderSchema` descriptor, seeded from the record rather than
         starting blank. -->
    <div
      v-if="amendOpen"
      class="fixed inset-0 z-50 flex items-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Amend work order"
      @click.self="closeAmend"
    >
      <div class="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-panel p-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-base font-semibold">Amend work order</h2>
          <button
            type="button"
            class="min-h-[44px] rounded-md border border-line px-3 text-sm font-medium"
            @click="closeAmend"
          >
            Close
          </button>
        </div>
        <p class="mt-1 text-[11px] text-ink-dim">
          Writes a new work-order revision. Dispatch is a separate, later step — amending never starts a run.
        </p>
        <p class="mt-1 text-[11px] text-ink-dim">
          Leaving Scope or Kill criterion blank keeps it UNCHANGED — the wire cannot express clearing prose. Emptying
          Explicitly out or Acceptance criteria really does clear it.
        </p>

        <!-- The AUTHORED work-order fields, rendered from `store.workOrderSchema`
             (S7·3's descriptor) — the SAME source the create sheet renders from,
             never a second hard-coded field list. Repeatable rows are
             `AmendCriterionRow`s here rather than plain strings: a criterion
             row's id rides invisibly through `updateAmendRowText`, a plain list
             row's id is always null and dropped on submit. -->
        <template v-for="field in store.workOrderSchema ?? []" :key="field.key">
          <label
            class="mt-3 block text-xs font-medium font-mono uppercase tracking-[0.08em] text-ink-dim"
            :for="`amend-wo-${field.key}`"
          >
            {{ field.label }}
          </label>

          <textarea
            v-if="field.kind === 'longtext'"
            :id="`amend-wo-${field.key}`"
            v-model="amendText[field.key]"
            :maxlength="field.maxLength"
            rows="3"
            class="mt-1 w-full resize-y rounded-md border border-line bg-panel-sunken px-3 py-2 text-sm"
          ></textarea>

          <div v-else class="mt-1 space-y-2">
            <div
              v-for="(_row, rowIndex) in amendRows[field.key] ?? []"
              :key="rowIndex"
              class="flex items-center gap-2"
            >
              <input
                :value="amendRows[field.key]?.[rowIndex]?.text ?? ''"
                type="text"
                :maxlength="field.itemMaxLength"
                class="min-h-[44px] w-full flex-1 rounded-md border border-line bg-panel-sunken px-3 text-sm"
                placeholder="one per line"
                @input="updateAmendRowText(field.key, rowIndex, ($event.target as HTMLInputElement).value)"
              />
              <button
                type="button"
                class="min-h-[44px] shrink-0 rounded-md border border-line px-3 text-sm text-ink-dim"
                :aria-label="`Remove ${field.label} row`"
                @click="removeAmendRow(field.key, rowIndex)"
              >
                −
              </button>
            </div>
            <button
              type="button"
              class="min-h-[44px] w-full rounded-md border border-line px-3 text-sm text-ink-dim"
              @click="addAmendRow(field.key)"
            >
              + Add row
            </button>
          </div>

          <p class="mt-1 text-[11px] text-ink-dim">{{ field.help }}</p>
        </template>

        <button
          type="button"
          class="mt-3 min-h-[44px] w-full rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg active:bg-accent/90 disabled:opacity-50"
          :disabled="amendInFlight"
          @click="submitAmend"
        >
          {{ amendInFlight ? 'Amending…' : 'Save amendment' }}
        </button>
        <p v-if="amendNotice !== null" class="mt-2 rounded-md border border-warn/30 bg-warn/10 p-3 text-sm text-warn" role="status">
          {{ amendNotice }}
        </p>
      </div>
    </div>

    <!-- ── THE CREATE SHEET ────────────────────────────────────────────────── -->
    <div
      v-if="createOpen"
      class="fixed inset-0 z-40 flex items-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      @click.self="createOpen = false"
    >
      <div class="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-panel p-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-base font-semibold">New task</h2>
          <button
            type="button"
            class="min-h-[44px] rounded-md border border-line px-3 text-sm font-medium"
            @click="createOpen = false"
          >
            Close
          </button>
        </div>

        <label class="mt-3 block text-xs font-medium font-mono uppercase tracking-[0.08em] text-ink-dim" for="new-task-title">
          Title (optional)
        </label>
        <input
          id="new-task-title"
          v-model="createTitle"
          type="text"
          class="mt-1 min-h-[44px] w-full rounded-md border border-line bg-panel-sunken px-3 text-sm"
          placeholder="what this task is"
        />

        <label class="mt-3 block text-xs font-medium font-mono uppercase tracking-[0.08em] text-ink-dim" for="new-task-root">
          Project root
        </label>
        <input
          id="new-task-root"
          v-model="createProjectRoot"
          type="text"
          class="mt-1 min-h-[44px] w-full rounded-md border border-line bg-panel-sunken px-3 font-mono text-sm"
          placeholder="path to the project directory"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
        />
        <p class="mt-1 text-[11px] text-ink-dim">
          Full path to the project directory. Must be within an allowed project root — the daemon refuses anything outside it.
        </p>

        <!-- ── The AUTHORED work-order fields (S7·3) ──────────────────────────
             Rendered from `store.workOrderSchema` (served by the daemon), never a
             hard-coded field list. Every field is optional; empties are dropped
             by buildWorkOrderBody on submit. -->
        <template v-for="field in store.workOrderSchema ?? []" :key="field.key">
          <label
            class="mt-3 block text-xs font-medium font-mono uppercase tracking-[0.08em] text-ink-dim"
            :for="`new-task-wo-${field.key}`"
          >
            {{ field.label }} (optional)
          </label>

          <textarea
            v-if="field.kind === 'longtext'"
            :id="`new-task-wo-${field.key}`"
            v-model="workOrderText[field.key]"
            :maxlength="field.maxLength"
            rows="3"
            class="mt-1 w-full resize-y rounded-md border border-line bg-panel-sunken px-3 py-2 text-sm"
          ></textarea>

          <div v-else class="mt-1 space-y-2">
            <div
              v-for="(_row, rowIndex) in workOrderRows[field.key] ?? []"
              :key="rowIndex"
              class="flex items-center gap-2"
            >
              <input
                :value="workOrderRows[field.key]?.[rowIndex] ?? ''"
                type="text"
                :maxlength="field.itemMaxLength"
                class="min-h-[44px] w-full flex-1 rounded-md border border-line bg-panel-sunken px-3 text-sm"
                placeholder="one per line"
                @input="updateRow(field.key, rowIndex, ($event.target as HTMLInputElement).value)"
              />
              <button
                type="button"
                class="min-h-[44px] shrink-0 rounded-md border border-line px-3 text-sm text-ink-dim"
                :aria-label="`Remove ${field.label} row`"
                @click="removeRow(field.key, rowIndex)"
              >
                −
              </button>
            </div>
            <button
              type="button"
              class="min-h-[44px] w-full rounded-md border border-line px-3 text-sm text-ink-dim"
              @click="addRow(field.key)"
            >
              + Add row
            </button>
          </div>

          <p class="mt-1 text-[11px] text-ink-dim">{{ field.help }}</p>
        </template>

        <p class="mt-3 text-[11px] text-ink-dim">
          A task is created in the backlog with worktree isolation (D32). The title cannot be changed afterwards —
          there is no rename.
        </p>

        <button
          type="button"
          class="mt-3 min-h-[44px] w-full rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg active:bg-accent/90 disabled:opacity-50"
          :disabled="createInFlight || createProjectRoot === ''"
          @click="submitCreate"
        >
          {{ createInFlight ? 'Creating…' : 'Create' }}
        </button>
        <p v-if="createNotice !== null" class="mt-2 text-xs text-ink-dim" role="status">
          {{ createNotice }}
        </p>
      </div>
    </div>
  </div>
</template>
