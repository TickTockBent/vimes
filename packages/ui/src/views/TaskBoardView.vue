<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
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

const moveOptions = computed<readonly MoveOption[]>(() =>
  openCard.value === null ? [] : moveOptionsFor(openCard.value.stage),
);

function openSheet(card: TaskCard): void {
  openCard.value = card;
  moveNotice.value = null;
  dispatchNotice.value = null;
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
  } finally {
    dispatchInFlight.value = false;
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

const rootOptions = computed(() => store.roots ?? []);

function openCreate(): void {
  createOpen.value = true;
  createNotice.value = null;
  if (createProjectRoot.value === '' && rootOptions.value.length > 0) {
    createProjectRoot.value = rootOptions.value[0]!;
  }
}

async function submitCreate(): Promise<void> {
  if (createInFlight.value || createProjectRoot.value === '') {
    return;
  }
  createInFlight.value = true;
  try {
    const trimmedTitle = createTitle.value.trim();
    const answer = await store.createTask({
      projectRoot: createProjectRoot.value,
      // Absent stays absent all the way to the birth record — a blank box must
      // not become a task titled with an empty string.
      ...(trimmedTitle === '' ? {} : { title: trimmedTitle }),
    });
    const outcome = describeCreateResponse(answer.status, answer.body);
    createNotice.value = outcome.sentence;
    if (outcome.kind === 'created') {
      createTitle.value = '';
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
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  waiting:
    'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  refused:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  failed:
    'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200',
  unknown:
    'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
};

const MOVE_TONE_CLASS: Readonly<Record<'accepted' | 'rejected' | 'error', string>> = {
  accepted:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  // A rejection is the machine working, not the board breaking — amber, not red.
  rejected:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  error:
    'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200',
};

const LIVENESS_CLASS: Readonly<Record<string, string>> = {
  spawning: 'bg-sky-500 text-white',
  running: 'bg-emerald-500 text-white',
  dormant: 'bg-slate-400 text-white',
  interrupted: 'bg-amber-500 text-white',
  dead: 'bg-rose-600 text-white',
};
function livenessClass(liveness: string): string {
  return LIVENESS_CLASS[liveness] ?? 'bg-slate-300 text-slate-800';
}
</script>

<template>
  <div class="mx-auto flex max-w-lg flex-col gap-4 p-4">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          :aria-label="props.backKind === 'close' ? 'Close panel' : 'Back'"
          @click="emit('back')"
        >
          {{ props.backKind === 'close' ? '✕' : '‹ Back' }}
        </button>
        <h1 class="text-lg font-semibold">Tasks</h1>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          @click="openCreate"
        >
          + New
        </button>
        <button
          type="button"
          class="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
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
      class="sticky top-0 z-20 flex gap-2 rounded-lg border border-slate-200 bg-white/95 p-2 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"
      aria-label="Exception tray"
    >
      <button
        v-for="group in board.exceptions"
        :key="`tray:${group.stage}`"
        type="button"
        class="flex min-h-[44px] flex-1 flex-col items-start justify-center rounded-md border px-3 py-1 text-left"
        :class="
          focusedStage === group.stage
            ? 'border-slate-900 bg-slate-100 dark:border-slate-300 dark:bg-slate-800'
            : 'border-slate-200 dark:border-slate-700'
        "
        :aria-pressed="focusedStage === group.stage"
        @click="toggleFocus(group.stage)"
      >
        <span class="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{{ group.label }}</span>
        <span
          class="text-lg font-bold tabular-nums"
          :class="group.count === 0 ? 'text-slate-400 dark:text-slate-500' : ''"
        >
          {{ group.count }}
        </span>
      </button>
    </section>

    <p v-if="store.tasksLoading" class="rounded-lg border border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
      Reading the tasks projection…
    </p>
    <p
      v-else-if="board.totalTasks === 0"
      class="rounded-lg border border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
    >
      No tasks have been created yet. This is an empty board, not a failed read — every stage below is real and
      waiting.
    </p>

    <p v-if="focusedStage !== null" class="text-xs text-slate-500 dark:text-slate-400">
      Focused on <span class="font-semibold">{{ stageLabel(focusedStage) }}</span
      >. Tap its header again to show the whole board.
    </p>

    <!-- The exception stages' OWN sections, so a focused tray count has
         somewhere to show its cards. Rendered above the flow because a blocked
         or quarantined task is the thing you came to look at. -->
    <section
      v-for="group in visibleExceptions"
      :key="`section:${group.stage}`"
      class="flex flex-col gap-2 rounded-lg border border-amber-200 p-3 dark:border-amber-900/60"
    >
      <button
        type="button"
        class="flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
        :aria-pressed="focusedStage === group.stage"
        @click="toggleFocus(group.stage)"
      >
        <h2 class="text-sm font-semibold">{{ group.label }}</h2>
        <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">
          {{ group.count }}
        </span>
      </button>
      <p v-if="group.count === 0" class="text-xs text-slate-400 dark:text-slate-500">Nothing here.</p>
      <ul v-else class="flex flex-col gap-2">
        <li v-for="card in group.tasks" :key="card.taskId">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-1 rounded-md border border-slate-200 p-3 text-left active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-900"
            @click="openSheet(card)"
          >
            <span
              class="w-full truncate text-sm font-medium"
              :class="card.labelIsFallback ? 'font-mono text-slate-500 dark:text-slate-400' : ''"
            >
              {{ card.label }}
            </span>
            <span class="flex w-full flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span v-if="card.projectName !== null" class="truncate">{{ card.projectName }}</span>
              <span v-if="card.createdBy !== null">· {{ card.createdBy }}</span>
              <span
                v-if="card.isolatedInWorktree"
                class="rounded-full bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                worktree
              </span>
              <span
                v-if="card.manualReviewRequired"
                class="rounded-full bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900 dark:bg-amber-900/60 dark:text-amber-100"
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
                class="rounded-full bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400"
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
      class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
    >
      <button
        type="button"
        class="flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
        :aria-pressed="focusedStage === group.stage"
        @click="toggleFocus(group.stage)"
      >
        <h2 class="text-sm font-semibold">{{ group.label }}</h2>
        <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {{ group.count }}
        </span>
      </button>
      <p v-if="group.count === 0" class="text-xs text-slate-400 dark:text-slate-500">Nothing here.</p>
      <ul v-else class="flex flex-col gap-2">
        <li v-for="card in group.tasks" :key="card.taskId">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-1 rounded-md border border-slate-200 p-3 text-left active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-900"
            @click="openSheet(card)"
          >
            <span
              class="w-full truncate text-sm font-medium"
              :class="card.labelIsFallback ? 'font-mono text-slate-500 dark:text-slate-400' : ''"
            >
              {{ card.label }}
            </span>
            <span class="flex w-full flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span v-if="card.projectName !== null" class="truncate">{{ card.projectName }}</span>
              <span v-if="card.createdBy !== null">· {{ card.createdBy }}</span>
              <span
                v-if="card.isolatedInWorktree"
                class="rounded-full bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                worktree
              </span>
              <span
                v-if="card.manualReviewRequired"
                class="rounded-full bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900 dark:bg-amber-900/60 dark:text-amber-100"
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
                class="rounded-full bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400"
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
      class="flex flex-col gap-2 rounded-lg border border-dashed border-rose-300 p-3 dark:border-rose-800"
    >
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-mono text-sm font-semibold">{{ group.label }}</h2>
        <span class="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-rose-900 dark:bg-rose-900/60 dark:text-rose-100">
          {{ group.count }}
        </span>
      </div>
      <p class="text-[11px] text-slate-500 dark:text-slate-400">
        This board does not recognise that stage. It is shown verbatim rather than hidden — the record says what it
        says.
      </p>
      <ul class="flex flex-col gap-2">
        <li v-for="card in group.tasks" :key="card.taskId">
          <button
            type="button"
            class="flex w-full flex-col items-start gap-1 rounded-md border border-slate-200 p-3 text-left active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-900"
            @click="openSheet(card)"
          >
            <span class="w-full truncate text-sm font-medium" :class="card.labelIsFallback ? 'font-mono' : ''">
              {{ card.label }}
            </span>
            <span v-if="card.projectName !== null" class="truncate text-[11px] text-slate-500 dark:text-slate-400">
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
      <div class="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-slate-950">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="truncate text-base font-semibold" :class="openCard.labelIsFallback ? 'font-mono' : ''">
              {{ openCard.label }}
            </h2>
            <p class="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">{{ openCard.taskId }}</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              in {{ openCard.stage === '' ? '(no stage recorded)' : stageLabel(openCard.stage) }}
            </p>
          </div>
          <button
            type="button"
            class="min-h-[44px] shrink-0 rounded-md border border-slate-300 px-3 text-sm font-medium dark:border-slate-700"
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
          <p v-if="dispatchNotice.idleNote !== null" class="mt-2 text-xs">{{ dispatchNotice.idleNote }}</p>
        </div>

        <!-- ⚠ EVERY STAGE BUT THE CURRENT ONE IS OFFERED, and the list is NOT
             filtered by transition legality. The UI proposes; the machine
             decides; the refusal is enumerated, evented (I7) and shown above.
             Mirroring TASK_STAGE_EDGES here would make this a second authority
             on legality — which 0.3 and principle 10 forbid — and would hide the
             very invariant this board exists to demonstrate. -->
        <h3 class="mt-4 text-sm font-semibold">Move to…</h3>
        <p class="mb-2 text-[11px] text-slate-500 dark:text-slate-400">
          Every stage is offered. VIMES decides which moves are legal, and says why when it refuses.
        </p>
        <ul class="flex flex-col gap-1.5">
          <li v-for="option in moveOptions" :key="option.stage">
            <button
              type="button"
              class="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border px-3 text-left text-sm font-medium disabled:opacity-50"
              :class="
                option.kind === 'exception'
                  ? 'border-amber-300 dark:border-amber-800'
                  : 'border-slate-300 dark:border-slate-700'
              "
              :disabled="moveInFlight"
              @click="proposeMove(option.stage)"
            >
              <span>{{ option.label }}</span>
              <span aria-hidden="true" class="text-slate-400">›</span>
            </button>
          </li>
        </ul>

        <h3 class="mt-4 text-sm font-semibold">Run it</h3>
        <button
          type="button"
          class="mt-2 min-h-[44px] w-full rounded-md border border-slate-900 bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
          :disabled="dispatchInFlight"
          @click="dispatch"
        >
          {{ dispatchInFlight ? 'Dispatching…' : 'Dispatch' }}
        </button>
        <p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          One attempt, no retry. A dispatched session is currently told NOTHING — stage instructions are not written
          yet, so it will spawn and sit idle until you talk to it.
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
      <div class="w-full rounded-t-2xl bg-white p-4 dark:bg-slate-950">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-base font-semibold">New task</h2>
          <button
            type="button"
            class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium dark:border-slate-700"
            @click="createOpen = false"
          >
            Close
          </button>
        </div>

        <label class="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300" for="new-task-title">
          Title (optional)
        </label>
        <input
          id="new-task-title"
          v-model="createTitle"
          type="text"
          class="mt-1 min-h-[44px] w-full rounded-md border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          placeholder="what this task is"
        />

        <label class="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300" for="new-task-root">
          Project root
        </label>
        <select
          id="new-task-root"
          v-model="createProjectRoot"
          class="mt-1 min-h-[44px] w-full rounded-md border border-slate-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option v-for="root in rootOptions" :key="root" :value="root">{{ root }}</option>
        </select>
        <p v-if="rootOptions.length === 0" class="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
          No project roots are known yet, so there is nowhere to create a task. Nothing has been written.
        </p>

        <p class="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
          A task is created in the backlog with worktree isolation (D32). The title cannot be changed afterwards —
          there is no rename.
        </p>

        <button
          type="button"
          class="mt-3 min-h-[44px] w-full rounded-md border border-slate-900 bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
          :disabled="createInFlight || createProjectRoot === ''"
          @click="submitCreate"
        >
          {{ createInFlight ? 'Creating…' : 'Create' }}
        </button>
        <p v-if="createNotice !== null" class="mt-2 text-xs text-slate-600 dark:text-slate-300" role="status">
          {{ createNotice }}
        </p>
      </div>
    </div>
  </div>
</template>
