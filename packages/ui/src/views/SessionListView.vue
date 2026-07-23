<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { deriveSessionRow, type SessionRow } from '../lib/sessionRow.js';
import { partitionSessionsByRecency } from '../lib/sessionListPartition.js';
import type { SessionRecord } from '../lib/types.js';
import {
  initialKillConfirmState,
  isConfirmingKill,
  reduceKillConfirm,
  type KillConfirmState,
} from '../lib/killConfirm.js';
import { isBellActionable, pushStateLabel } from '../lib/pushState.js';
import {
  cacheBadgeChipLabel,
  cacheWarmth,
  cacheWarmthTone,
  deriveCacheBadge,
  ttlTierLabel,
  type CacheTtlTone,
} from '../lib/cacheBadge.js';
import {
  refreshNotice,
  usageStripModel,
  type MeterRow,
  type MeterTone,
  type RefreshNoticeTone,
} from '../lib/meterDisplay.js';

// `expandMeters` is how the `/#/meters` route is claimed (slice 5 step 4c): the
// threshold-notification push deep-links there, and the user who tapped a usage
// alert wants every meter, not the one-line summary. It reuses the strip's own
// expanded state rather than building a second surface — no new component, no
// new lazy chunk, nothing for the build-manifest gate to trip over.
const props = withDefaults(defineProps<{ expandMeters?: boolean }>(), { expandMeters: false });

const emit = defineEmits<{
  open: [appSessionId: string];
  openFiles: [];
  openSearch: [];
  openTerminal: [];
  openGit: [];
  openCost: [];
  // Slice 6 step 9 — the task board (mobile).
  openTasks: [];
}>();
const store = useVimesStore();

const LAST_CWD_KEY = 'vimes:lastCwd';
const cwd = ref(localStorage.getItem(LAST_CWD_KEY) ?? '');
const channel = ref<'sdk' | 'pty'>('sdk');
const spawning = ref(false);

// Q1 (scratchpad/QUEUE.md) — the spawn form moved to a collapsed affordance at
// the TOP of the view so "New session" is reachable with zero scrolling past a
// few dozen historical sessions. This is plain component state, same pattern
// as `metersExpanded` below: a `ref<boolean>` with no branching worth a lib/
// module and nothing pure to unit-test — the toggle IS the logic.
// Collapsed is the default on load (spec: "Collapsed is the default").
const spawnFormExpanded = ref(false);

function toggleSpawnForm(): void {
  spawnFormExpanded.value = !spawnFormExpanded.value;
}

// Confirm-tap-again state for kill (no browser confirm(), D-scope).
const killConfirm = ref<KillConfirmState>(initialKillConfirmState);
// The row currently being renamed inline, and its draft text.
const renamingId = ref<string | null>(null);
const renameDraft = ref('');

// Q2 (docs/QUEUE.md) — the "Show N older sessions" reveal. Plain component
// state (a `ref<boolean>`), same pattern as `spawnFormExpanded`/`metersExpanded`
// above: there is no branching worth a lib/ module here, the toggle IS the
// logic. The TESTED logic is the partition itself (lib/sessionListPartition.ts)
// — this ref only decides whether the `older` bucket it produces is rendered.
// Collapsed by default: that is the "age out" (fully reversible, one tap away).
const showOlderSessions = ref(false);

function toggleOlderSessions(): void {
  showOlderSessions.value = !showOlderSessions.value;
}

// Clock-free: session identity + sort only. The cache badge (which ticks its age
// live) is a SEPARATE clock-dependent map below, so a one-second age tick never
// re-sorts the whole list. Kept as raw SessionRecords (not yet derived to
// SessionRow) because the Q2 age-out partition needs `createdAt`, which
// SessionRow does not carry — deriving happens AFTER partitioning, below.
const sortedSessions = computed<SessionRecord[]>(() =>
  Object.values(store.sessions)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
);

function spawn(): void {
  const trimmedCwd = cwd.value.trim();
  if (trimmedCwd.length === 0 || spawning.value) {
    return;
  }
  localStorage.setItem(LAST_CWD_KEY, trimmedCwd);
  spawning.value = true;
  store.spawnSession(channel.value, trimmedCwd, {
    onSpawned: (appSessionId) => {
      spawning.value = false;
      emit('open', appSessionId);
    },
    // A refused spawn (e.g. cwd-outside-project-roots) must still clear the
    // local pending flag — the refusal itself surfaces via store.lastRefusal
    // and its dismiss banner (App.vue), same as any other refused op. That
    // banner is sticky at the App.vue root, driven purely by store state, and
    // is entirely independent of `spawnFormExpanded` below (Q1) — so a
    // refusal is visible whether the collapsed affordance is open or closed.
    // We deliberately do NOT auto-collapse the form here: it only closes on
    // an explicit tap of the toggle, so on a refusal the operator sees BOTH
    // the still-open form (with its now-cleared spawning state) and the
    // global banner — belt and suspenders, no second refusal surface built.
    onRefused: () => {
      spawning.value = false;
    },
  });
}

function tapKill(appSessionId: string): void {
  const result = reduceKillConfirm(killConfirm.value, { type: 'tap', appSessionId });
  killConfirm.value = result.state;
  if (result.fire) {
    store.killSession(appSessionId);
  }
}

function killLabel(appSessionId: string): string {
  return isConfirmingKill(killConfirm.value, appSessionId) ? 'Tap again to kill' : 'Kill';
}

function adopt(appSessionId: string): void {
  store.adoptSession(appSessionId);
}

function startRename(appSessionId: string, currentLabel: string): void {
  renamingId.value = appSessionId;
  renameDraft.value = currentLabel;
}

function commitRename(appSessionId: string): void {
  const name = renameDraft.value.trim();
  if (name.length > 0 && name.length <= 120) {
    store.renameSession(appSessionId, name);
  }
  renamingId.value = null;
  renameDraft.value = '';
}

function cancelRename(): void {
  renamingId.value = null;
  renameDraft.value = '';
}

function refreshDiscover(): void {
  store.discover();
}

// The bell's icon per push state (never auto-prompts — the tap IS the gesture).
function bellIcon(): string {
  switch (store.pushState) {
    case 'on':
      return '🔔';
    case 'denied':
      return '🔕';
    case 'unsupported':
      return '🚫';
    default:
      return '🔔';
  }
}

// ── Cache-observability badge (slice 4 step 4; reshaped to WARMTH in Q4) — a
// compact chip joining the step-2 projection to this row by appSessionId. It now
// shows the observed TTL tier + how long since the last observed cache write,
// styled warm/cold, NEVER a hit rate or a countdown (pillar 4). Small on purpose
// (principle 11): it informs, it doesn't dominate the row. Only the tone KEY
// comes from cacheBadge.ts — the colour mapping lives here.
const TONE_CLASS: Readonly<Record<CacheTtlTone, string>> = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

// `nowMs` is INJECTED (rule 0.3): the age lives in cacheWarmth, never a clock
// read here. The clock is the meters' own ticking `localNowMs` (below) — the
// SAME source the usage-meter ages count against, so the badge does not spin up
// a second now.
function cacheBadgeFor(appSessionId: string, nowMs: number) {
  const badge = deriveCacheBadge(store.cacheObservability[appSessionId]);
  if (badge === null) {
    return null;
  }
  const warmth = cacheWarmth(badge.latestBlockAt, badge.ttlTier, nowMs);
  // The observed basis, kept on the tooltip so a "cold" chip (which abbreviates
  // the age to the word "cold") still shows how old the last write actually is.
  const ageBasis = warmth.ageLabel !== null ? ` · last write ${warmth.ageLabel}` : '';
  return {
    label: cacheBadgeChipLabel(badge.ttlTier, warmth),
    toneClass: TONE_CLASS[cacheWarmthTone(warmth.state)],
    title: `cache: ${ttlTierLabel(badge.ttlTier)} · ${warmth.state}${ageBasis}`,
  };
}

// ── Usage meters strip (slice 5 step 3, extended in step 4c) — "can I afford to
// start this?" on the home screen. Every derivation is in lib/meterDisplay.ts;
// this block only maps semantic tone keys to colour classes and owns the
// ticking clock.
//
// THE INTEGRITY RULE, enforced in the template below: a percentage figure is
// rendered ONLY where `displayPercent !== null`, and that is null for anything
// not freshly observed. Stale/unknown rows say so in words and show no number,
// no bar fill, and no absolute (D26: the source has no absolutes to show).
//
// THE SHARPENED INVARIANT (step 4c): every row also renders its AGE, always,
// and that age counts up on screen. Freshness is a gradient the user can see,
// not a binary the code decides for them.

// The ages and countdowns need a moving "now". One second, because the age line
// shows seconds and a minute-granularity tick would make it visibly stutter.
// The tick only bumps a ref that the meter computeds read — the session rows do
// not depend on it, so nothing else re-renders.
const METER_CLOCK_TICK_MS = 1_000;
const localNowMs = ref(Date.now());
let meterClockHandle: ReturnType<typeof setInterval> | null = null;

// ── Session list age-out (Q2, docs/QUEUE.md) — DISPLAY ONLY ─────────────────
// The tested split lives in lib/sessionListPartition.ts; this block only picks
// the presentation constants and feeds the partition a STABLE clock.
//
// Defaults (presentation constants, not a ⟨tune⟩ band — no Gate-D):
// - recencyWindowMs = 7 days. "The sessions you're actually using are always
//   right there without scrolling; the long tail is one tap away."
// - minVisible = 12. Enough that a normal working set never touches the
//   disclosure, small enough that the frame (below) does not need to grow to
//   fit it on a phone.
const SESSION_LIST_RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_LIST_MIN_VISIBLE = 12;

// THE CLOCK: reuses `localNowMs` (no second now-source, per the work order) but
// QUANTIZES it to the minute, so the partition recomputes at most once a
// minute instead of on every one-second meter tick — recomputing membership
// every second would let a row hop the visible/older boundary mid-scroll. This
// is a `computed` derived FROM `localNowMs`, not a second `setInterval`: it
// only produces a new value when `localNowMs` crosses into a new minute
// bucket, and it also naturally jumps on mount (localNowMs's initial value)
// and whenever the component re-renders after a session-set change (the
// partition computed below also depends on `sortedSessions`, so an add/remove
// recomputes immediately regardless of the clock bucket).
const SESSION_LIST_CLOCK_QUANTUM_MS = 60_000;
const sessionListNowMs = computed(
  () => Math.floor(localNowMs.value / SESSION_LIST_CLOCK_QUANTUM_MS) * SESSION_LIST_CLOCK_QUANTUM_MS,
);

// Pillar 5 (attention is scarce): a session that is live or actively flagged
// must never be tucked behind "show older" just because it is chronologically
// old — e.g. a long-running session started three weeks ago that is STILL
// running, or one sitting on a gate waiting for a decision. Lean, stated per
// the work order: an actionable bell (`needsAttention !== null`) OR a live
// liveness ('running'/'spawning') is always-visible, regardless of age.
function isSessionAlwaysVisible(session: SessionRecord): boolean {
  return session.needsAttention !== null || session.liveness === 'running' || session.liveness === 'spawning';
}

const sessionPartition = computed(() =>
  partitionSessionsByRecency(sortedSessions.value, sessionListNowMs.value, {
    recencyWindowMs: SESSION_LIST_RECENCY_WINDOW_MS,
    minVisible: SESSION_LIST_MIN_VISIBLE,
    isAlwaysVisible: isSessionAlwaysVisible,
  }),
);

// Derive to SessionRow AFTER partitioning (partitioning needs `createdAt`,
// which SessionRow does not carry — see the `sortedSessions` comment above).
const visibleRows = computed(() => sessionPartition.value.visible.map((session) => deriveSessionRow(session)));
const olderRows = computed(() => sessionPartition.value.older.map((session) => deriveSessionRow(session)));

// A discriminated render-list so the row template appears ONCE (Q2 fix: the
// row markup was previously duplicated verbatim across `visibleRows` and
// `olderRows` v-fors). The toggle sits between the visible rows and the
// (conditionally shown) older rows as a non-row interleaved item.
type SessionListItem = { kind: 'row'; row: SessionRow } | { kind: 'toggle' };

const sessionListItems = computed<SessionListItem[]>(() => {
  const items: SessionListItem[] = visibleRows.value.map((row) => ({ kind: 'row', row }));
  if (olderRows.value.length > 0) {
    items.push({ kind: 'toggle' });
    if (showOlderSessions.value) {
      for (const row of olderRows.value) items.push({ kind: 'row', row });
    }
  }
  return items;
});

// The cache-warmth chip per session, aged against the SAME ticking clock the
// meter ages use. Isolated from `sortedSessions`/`visibleRows`/`olderRows` so
// the once-a-second age tick recomputes only these small chips, never the
// session sort or the (deliberately once-a-minute) age-out partition. A
// session with no cache-observability record has no entry → the template
// shows no chip.
const cacheBadges = computed(() => {
  const nowMs = localNowMs.value;
  const byAppSessionId: Record<string, ReturnType<typeof cacheBadgeFor>> = {};
  for (const appSessionId of Object.keys(store.cacheObservability)) {
    byAppSessionId[appSessionId] = cacheBadgeFor(appSessionId, nowMs);
  }
  return byAppSessionId;
});

const metersExpanded = ref(props.expandMeters);
// Arriving on `/#/meters` (a tapped usage alert) while already mounted must
// still expand — the route is the request.
watch(
  () => props.expandMeters,
  (shouldExpand) => {
    if (shouldExpand) {
      metersExpanded.value = true;
    }
  },
);

// `localNowMs` is NOT the clock the ages are measured against: usageStripModel
// advances the daemon's own `observedNow`/`ageMs` by the LOCAL ELAPSED time
// since the response landed. A browser clock that is wrong by an hour therefore
// still shows the true age, because only a difference of two readings of that
// clock is ever used. This is the whole point of the 4c fix.
const strip = computed(() => usageStripModel(store.usageSnapshot, localNowMs.value));
const meterRows = computed<MeterRow[]>(() => strip.value.rows);
// Order is the DAEMON's (binding first, then meterId) and is preserved as sent.
const bindingMeter = computed<MeterRow | null>(() => meterRows.value[0] ?? null);

// The refresh control's honest one-liner: throttled, failed and succeeded are
// three different messages and never impersonate each other.
const refreshMessage = computed(() => refreshNotice(store.lastUsageRefresh));

const REFRESH_TONE_CLASS: Readonly<Record<RefreshNoticeTone, string>> = {
  success: 'text-emerald-700 dark:text-emerald-300',
  throttled: 'text-slate-500 dark:text-slate-400',
  failed: 'text-rose-600 dark:text-rose-400',
};

function tapRefreshUsage(): void {
  void store.refreshUsage();
}

const METER_TONE_BAR_CLASS: Readonly<Record<MeterTone, string>> = {
  normal: 'bg-emerald-500',
  elevated: 'bg-amber-500',
  high: 'bg-rose-500',
  unknown: 'bg-slate-300 dark:bg-slate-600',
};

const METER_TONE_TEXT_CLASS: Readonly<Record<MeterTone, string>> = {
  normal: 'text-emerald-700 dark:text-emerald-300',
  elevated: 'text-amber-700 dark:text-amber-300',
  high: 'text-rose-700 dark:text-rose-300',
  unknown: 'text-slate-500 dark:text-slate-400',
};

// The ONLY place a meter's figure becomes text. A null displayPercent never
// yields a number — it yields the honest word for why we have none.
function meterValueLabel(row: MeterRow): string {
  if (row.displayPercent !== null) {
    return `${row.displayPercent}%`;
  }
  return row.freshness === 'stale' ? 'stale' : 'usage unknown';
}

// Bar fill width. Unknown/stale rows get no fill at all — an empty bar plus the
// word "stale" cannot be misread as 0% the way a zero-width *numeric* bar could.
function meterBarStyle(row: MeterRow): Record<string, string> {
  return { width: row.displayPercent === null ? '0%' : `${row.displayPercent}%` };
}

function toggleMetersExpanded(): void {
  metersExpanded.value = !metersExpanded.value;
}

onMounted(() => {
  void store.fetchCacheObservability();
  void store.fetchDerivedUsage();
  meterClockHandle = setInterval(() => {
    localNowMs.value = Date.now();
  }, METER_CLOCK_TICK_MS);
});

// A leaked interval on a long-lived phone PWA is a real leak, not a theoretical
// one: this view mounts and unmounts on every navigation home.
onUnmounted(() => {
  if (meterClockHandle !== null) {
    clearInterval(meterClockHandle);
    meterClockHandle = null;
  }
});
</script>

<template>
  <div class="mx-auto flex max-w-lg flex-col gap-4 p-4">
    <div class="flex items-center justify-between gap-2">
      <h1 class="text-lg font-semibold">Sessions</h1>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex min-h-[44px] items-center gap-1 rounded-md border px-3 text-sm font-medium disabled:opacity-50"
          :class="
            store.pushState === 'on'
              ? 'border-sky-400 text-sky-700 active:bg-sky-50 dark:border-sky-600 dark:text-sky-300 dark:active:bg-sky-950'
              : 'border-slate-300 active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900'
          "
          :disabled="!isBellActionable(store.pushState)"
          :title="pushStateLabel(store.pushState)"
          :aria-label="pushStateLabel(store.pushState)"
          @click="store.togglePush()"
        >
          <span aria-hidden="true">{{ bellIcon() }}</span>
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          aria-label="Files"
          @click="emit('openFiles')"
        >
          📁 Files
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          aria-label="Search"
          @click="emit('openSearch')"
        >
          🔍
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          aria-label="Terminal"
          @click="emit('openTerminal')"
        >
          ⌨️
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          aria-label="Git"
          @click="emit('openGit')"
        >
          ⑂ Git
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          aria-label="Cost ledger"
          @click="emit('openCost')"
        >
          💰 Cost
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          aria-label="Task board"
          @click="emit('openTasks')"
        >
          ▤ Tasks
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          @click="refreshDiscover"
        >
          ↻ Discover
        </button>
      </div>
    </div>

    <!-- Q1 (scratchpad/QUEUE.md, 2026-07-23) — collapsed "+ New session"
         affordance at the very TOP of the view, immediately below the header
         row and above the (possibly-expanded) usage meters strip. Placed here
         rather than below the meters so it stays reachable with ZERO
         scrolling on a phone regardless of the meters' own expanded state —
         the meters section is the one part of this view tall enough to
         threaten that on its own. Collapsed, this is a single row; a plain
         reorder of the four-row form would have pushed the session list below
         the fold instead, trading one scroll for another (decided, not a
         rewrite — see the work order). -->
    <div class="flex flex-col gap-2">
      <button
        type="button"
        class="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 text-sm font-semibold text-sky-700 active:bg-sky-100 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300 dark:active:bg-sky-900"
        :aria-expanded="spawnFormExpanded"
        aria-controls="new-session-form"
        @click="toggleSpawnForm()"
      >
        <span aria-hidden="true">{{ spawnFormExpanded ? '▴' : '+' }}</span>
        {{ spawnFormExpanded ? 'Close' : 'New session' }}
      </button>

      <!-- The existing form, moved verbatim: same fields, same v-model
           bindings, same @submit.prevent="spawn" — only the disclosure
           wrapper is new. spawn(), the store call, `channel`, and `cwd`
           handling are untouched (explicitly out of scope for Q1). The form
           is NOT auto-collapsed on submit — see the onRefused comment above
           for why staying open is part of the refusal-visibility guarantee. -->
      <form
        v-if="spawnFormExpanded"
        id="new-session-form"
        class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
        @submit.prevent="spawn"
      >
        <label class="text-sm font-medium" for="new-session-cwd">New session · cwd</label>
        <input
          id="new-session-cwd"
          v-model="cwd"
          type="text"
          placeholder="/home/wes/projects/games/dongfu"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <div class="flex items-center gap-4 text-sm">
          <label class="flex items-center gap-1">
            <input v-model="channel" type="radio" value="sdk" />
            SDK
          </label>
          <label class="flex items-center gap-1">
            <input v-model="channel" type="radio" value="pty" />
            PTY
          </label>
        </div>
        <button
          type="submit"
          class="min-h-[44px] rounded-md bg-sky-600 font-semibold text-white active:bg-sky-700 disabled:opacity-50"
          :disabled="spawning || cwd.trim().length === 0"
        >
          {{ spawning ? 'Spawning…' : 'Spawn session' }}
        </button>
      </form>
    </div>

    <p v-if="store.pushState === 'off'" class="-mt-2 text-xs text-slate-500 dark:text-slate-400">
      Tap the bell to enable push notifications for gates and completions.
    </p>
    <p v-else-if="store.pushState === 'denied'" class="-mt-2 text-xs text-rose-500">
      Notifications are blocked — re-enable them in your browser settings.
    </p>

    <!-- Usage meters strip (slice 5 step 3, extended in step 4c). Principle 11:
         this INFORMS, it must not dominate the session list — one compact line,
         tap to expand inline (no new route; `/#/meters` just arrives expanded).
         A stale/unknown meter shows words, never a figure, and EVERY reading
         shows its age so freshness is a gradient the user can see. -->
    <section class="rounded-lg border border-slate-200 dark:border-slate-800" aria-label="Usage meters">
      <div class="flex items-stretch gap-1">
        <button
          v-if="bindingMeter !== null"
          type="button"
          class="flex min-h-[44px] min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-left"
          :aria-expanded="metersExpanded"
          @click="toggleMetersExpanded()"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span class="truncate text-sm font-semibold">{{ bindingMeter.label }}</span>
              <span
                v-if="bindingMeter.isBinding"
                class="shrink-0 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-800 dark:bg-sky-900/50 dark:text-sky-200"
              >
                binding
              </span>
            </span>
            <span class="shrink-0 text-sm font-semibold" :class="METER_TONE_TEXT_CLASS[bindingMeter.tone]">
              {{ meterValueLabel(bindingMeter) }}
            </span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div class="h-full rounded-full" :class="METER_TONE_BAR_CLASS[bindingMeter.tone]" :style="meterBarStyle(bindingMeter)"></div>
          </div>
          <div class="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <!-- The age is never optional and never hidden behind the expander:
                 a meter that hides how old it is overstates its precision. -->
            <span class="truncate">{{ bindingMeter.ageLabel }}</span>
            <span class="shrink-0">{{ metersExpanded ? '▴' : `▾ ${meterRows.length} meters` }}</span>
          </div>
          <div class="w-full truncate text-xs text-slate-500 dark:text-slate-400">
            {{ bindingMeter.resetLabel ?? 'no reset pending' }}
          </div>
        </button>

        <!-- Fresh install, poller disabled, or the endpoint dead since boot: one
             honest line, never an empty gap and never zeros. -->
        <p v-else class="min-w-0 flex-1 px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
          Usage unknown — no meters observed yet.
        </p>

        <!-- Forced refresh. Disabled while in flight so an impatient thumb
             cannot stack requests against an unofficial endpoint. -->
        <button
          type="button"
          class="m-1 min-h-[44px] min-w-[44px] shrink-0 self-start rounded-md border border-slate-300 text-sm font-medium active:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:active:bg-slate-900"
          :disabled="store.usageRefreshInFlight"
          aria-label="Refresh usage meters"
          @click="tapRefreshUsage()"
        >
          <span aria-hidden="true">{{ store.usageRefreshInFlight ? '⋯' : '↻' }}</span>
        </button>
      </div>

      <p v-if="refreshMessage !== null" class="px-3 pb-2 text-xs" :class="REFRESH_TONE_CLASS[refreshMessage.tone]">
        {{ refreshMessage.message }}
      </p>

      <!-- No staleness band at all: the daemon says its poller is disabled, so
           every reading is 'unknown' by construction. Say WHY rather than let it
           read as a transient hiccup. -->
      <p v-if="strip.freshnessBandMissing && meterRows.length > 0" class="px-3 pb-2 text-xs text-slate-500 dark:text-slate-400">
        Usage polling is disabled — freshness cannot be judged.
      </p>

      <!-- Expanded: EVERY meter with its countdown, age, freshness, burn rate
           and exhaustion projection. This is also what `/#/meters` lands on. -->
      <ul v-if="metersExpanded && meterRows.length > 0" class="flex flex-col gap-3 border-t border-slate-200 px-3 py-2 dark:border-slate-800">
        <li v-for="meter in meterRows" :key="meter.meterId" class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2 text-xs">
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span class="truncate text-slate-600 dark:text-slate-300">{{ meter.label }}</span>
              <span
                v-if="meter.isBinding"
                class="shrink-0 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-800 dark:bg-sky-900/50 dark:text-sky-200"
              >
                binding
              </span>
            </span>
            <span class="shrink-0 font-semibold" :class="METER_TONE_TEXT_CLASS[meter.tone]">
              {{ meterValueLabel(meter) }}
            </span>
          </div>
          <div class="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div class="h-full rounded-full" :class="METER_TONE_BAR_CLASS[meter.tone]" :style="meterBarStyle(meter)"></div>
          </div>
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            <!-- A meter at 0% with no resetsAt is a NORMAL freshly-rolled window
                 (observed live 2026-07-21), so this reads calmly, not as a fault. -->
            <span>{{ meter.resetLabel ?? 'no reset pending' }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ meter.ageLabel }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ meter.freshness }}</span>
          </div>
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            <span>{{ meter.burnRateLabel }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ meter.exhaustionLabel }}</span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Q2 (docs/QUEUE.md) — the session list gets its OWN scrollable frame
         instead of growing the page: `max-h-[55vh]` + `overflow-y-auto` on this
         wrapper means the list scrolls WITHIN itself, and the header, the Q1
         "+ New session" affordance, and the meters strip above stay reachable
         with zero page scroll. 55vh leaves ~45% of a phone viewport for that
         chrome — on a typical portrait phone (iPhone SE, 667px tall) the
         header + collapsed spawn affordance + collapsed meters strip together
         run well under half the screen, so this frame is the one thing that
         scrolls. DISPLAY ONLY: nothing inside is removed, only bounded. -->
    <div class="max-h-[55vh] overflow-y-auto">
      <ul class="flex flex-col gap-2">
        <template v-for="item in sessionListItems" :key="item.kind === 'row' ? item.row.appSessionId : 'older-toggle'">
          <li
            v-if="item.kind === 'row'"
            class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
          >
            <button
              type="button"
              class="flex min-h-[44px] w-full flex-col gap-1 text-left"
              @click="emit('open', item.row.appSessionId)"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate font-medium">{{ item.row.label }}</span>
                <span class="flex shrink-0 items-center gap-1">
                  <span
                    v-if="item.row.mirrored"
                    class="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800 dark:bg-violet-900/50 dark:text-violet-200"
                  >
                    mirrored
                  </span>
                  <span class="rounded-full px-2 py-0.5 text-xs font-semibold" :class="item.row.livenessColorClass">
                    {{ item.row.livenessLabel }}
                  </span>
                </span>
              </div>
              <div class="flex items-center justify-between gap-2 text-sm text-slate-500 dark:text-slate-400">
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate">{{ item.row.channel }} · {{ item.row.cwdTail }}</span>
                  <span
                    v-if="cacheBadges[item.row.appSessionId]"
                    class="shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold"
                    :class="cacheBadges[item.row.appSessionId]?.toneClass"
                    :title="cacheBadges[item.row.appSessionId]?.title"
                  >
                    {{ cacheBadges[item.row.appSessionId]?.label }}
                  </span>
                </span>
                <span
                  v-if="item.row.attention.visible"
                  class="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800 dark:bg-orange-900/50 dark:text-orange-200"
                >
                  {{ item.row.attention.label }}
                </span>
              </div>
            </button>

            <div v-if="renamingId === item.row.appSessionId" class="flex items-center gap-2">
              <input
                v-model="renameDraft"
                type="text"
                maxlength="120"
                class="min-h-[36px] min-w-0 flex-1 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                @keyup.enter="commitRename(item.row.appSessionId)"
                @keyup.esc="cancelRename"
              />
              <button type="button" class="min-h-[36px] rounded-md bg-sky-600 px-3 text-sm font-semibold text-white active:bg-sky-700" @click="commitRename(item.row.appSessionId)">
                Save
              </button>
              <button type="button" class="min-h-[36px] rounded-md px-2 text-sm text-slate-500 active:bg-slate-100 dark:active:bg-slate-900" @click="cancelRename">
                Cancel
              </button>
            </div>

            <div v-else class="flex items-center gap-2 text-sm">
              <button
                v-if="item.row.canAdopt"
                type="button"
                class="min-h-[36px] rounded-md bg-violet-600 px-3 font-semibold text-white active:bg-violet-700"
                @click="adopt(item.row.appSessionId)"
              >
                Adopt
              </button>
              <button
                v-if="item.row.canKill"
                type="button"
                class="min-h-[36px] rounded-md px-3 font-semibold active:bg-rose-100 dark:active:bg-rose-900/40"
                :class="isConfirmingKill(killConfirm, item.row.appSessionId) ? 'bg-rose-600 text-white' : 'border border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300'"
                @click="tapKill(item.row.appSessionId)"
              >
                {{ killLabel(item.row.appSessionId) }}
              </button>
              <button
                v-if="item.row.canRename"
                type="button"
                class="min-h-[36px] rounded-md border border-slate-300 px-3 text-slate-600 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-900"
                @click="startRename(item.row.appSessionId, item.row.label)"
              >
                Rename
              </button>
            </div>
          </li>

          <!-- Q2's age-out disclosure toggle, interleaved between the visible
               and (conditionally shown) older rows. `older` is only ever
               non-empty rows the partition decided are NOT recent (or the
               floor would have kept them in `visible`) — tapping this
               reveals them, fully reversible, never a second fetch (they
               were already loaded). No `aria-controls`: with a single flat
               list there is no longer a single stable container id to point
               it at (the previous `id="older-sessions"` wrapper existed only
               to dodge a repeated id across two separate `<ul>`s, which no
               longer exist) — `aria-expanded` alone still tells assistive
               tech the toggle's own state. -->
          <li v-else class="flex flex-col gap-2">
            <button
              type="button"
              class="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-900"
              :aria-expanded="showOlderSessions"
              @click="toggleOlderSessions()"
            >
              <span aria-hidden="true">{{ showOlderSessions ? '▴' : '▾' }}</span>
              {{ showOlderSessions ? 'Hide older sessions' : `Show ${olderRows.length} older sessions` }}
            </button>
          </li>
        </template>

        <!-- The floor rule (lib/sessionListPartition.ts) means `visible` is
             only empty when `older` is too — this cannot fire while
             `minVisible >= 1` and any session exists. -->
        <li v-if="sessionListItems.length === 0" class="p-3 text-center text-sm text-slate-500 dark:text-slate-400">
          No sessions yet — spawn one above, or Discover terminal-started ones.
        </li>
      </ul>
    </div>
  </div>
</template>
