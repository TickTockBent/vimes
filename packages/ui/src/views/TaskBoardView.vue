<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { buildWorkOrderBody, type WorkOrderFormModel } from '../lib/workOrderForm.js';
import {
  describeCreateResponse,
  describeDispatchResponse,
  describeMoveResponse,
  groupTasksForBoard,
  moveOptionsFor,
  stageLabel,
  type DispatchReport,
  type MoveOption,
  type TaskCard,
} from '../lib/taskBoard.js';
import { sessionToSubscribeAfterDispatch } from '../lib/dispatchFollow.js';
import { buildHash } from '../lib/route.js';

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

const board = computed(() => groupTasksForBoard(store.tasksProjectionBody, store.sessions));

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
const openCard = ref<TaskCard | null>(null);
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

function openSheet(card: TaskCard): void {
  openCard.value = card;
  moveNotice.value = null;
  dispatchNotice.value = null;
  dispatchedSessionId.value = null;
}
function closeSheet(): void {
  openCard.value = null;
}

async function proposeMove(toStage: string): Promise<void> {
  const card = openCard.value;
  if (card === null || moveInFlight.value) {
    return;
  }
  moveInFlight.value = true;
  dispatchNotice.value = null;
  try {
    const answer = await store.proposeTaskTransition(card.taskId, toStage);
    const outcome = describeMoveResponse(answer.status, answer.body);
    moveNotice.value = { tone: outcome.kind, sentence: outcome.sentence };
    // ⚠ NOTHING MOVES HERE. Not even on `accepted` — the sheet stays open with
    // the machine's answer on it, and the board redraws when the projection
    // catches up.
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
        <h1 class="text-lg font-semibold uppercase tracking-[0.08em] text-ink">Tasks</h1>
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
              <span v-if="card.createdBy !== null">· {{ card.createdBy }}</span>
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
              <span v-if="card.createdBy !== null">· {{ card.createdBy }}</span>
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
        <button
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
