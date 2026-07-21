<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { deriveSessionRow } from '../lib/sessionRow.js';
import {
  initialKillConfirmState,
  isConfirmingKill,
  reduceKillConfirm,
  type KillConfirmState,
} from '../lib/killConfirm.js';
import { isBellActionable, pushStateLabel } from '../lib/pushState.js';
import { deriveCacheBadge, ttlTierLabel, ttlTierTone, type CacheTtlTone } from '../lib/cacheBadge.js';
import {
  deriveMeterRows,
  METER_STALE_AFTER_MS_PREVIEW,
  type MeterRow,
  type MeterTone,
} from '../lib/meterDisplay.js';

const emit = defineEmits<{
  open: [appSessionId: string];
  openFiles: [];
  openSearch: [];
  openTerminal: [];
  openGit: [];
}>();
const store = useVimesStore();

const LAST_CWD_KEY = 'vimes:lastCwd';
const cwd = ref(localStorage.getItem(LAST_CWD_KEY) ?? '');
const channel = ref<'sdk' | 'pty'>('sdk');
const spawning = ref(false);

// Confirm-tap-again state for kill (no browser confirm(), D-scope).
const killConfirm = ref<KillConfirmState>(initialKillConfirmState);
// The row currently being renamed inline, and its draft text.
const renamingId = ref<string | null>(null);
const renameDraft = ref('');

const rows = computed(() =>
  Object.values(store.sessions)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((session) => ({
      ...deriveSessionRow(session),
      cacheBadge: cacheBadgeFor(session.appSessionId),
    })),
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
    // and its dismiss banner (App.vue), same as any other refused op.
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

// ── Cache-observability badge (slice 4 step 4) — a compact TTL-tier + hit-rate
// chip joining the step-2 projection to this row by appSessionId. Small on
// purpose (principle 11): it informs, it doesn't dominate the row. Only the
// tone KEY comes from cacheBadge.ts — the color mapping lives here.
const TONE_CLASS: Readonly<Record<CacheTtlTone, string>> = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

function cacheBadgeFor(appSessionId: string) {
  const badge = deriveCacheBadge(store.cacheObservability[appSessionId]);
  if (badge === null) {
    return null;
  }
  return {
    label: `${ttlTierLabel(badge.ttlTier)} · ${badge.hitRatePercent}%`,
    toneClass: TONE_CLASS[ttlTierTone(badge.ttlTier)],
  };
}

// ── Usage meters strip (slice 5 step 3) — "can I afford to start this?" on the
// home screen. Every derivation is in lib/meterDisplay.ts; this block only maps
// semantic tone keys to colour classes and owns the ticking clock.
//
// THE INTEGRITY RULE, enforced in the template below: a percentage figure is
// rendered ONLY where `displayPercent !== null`, and that is null for anything
// not freshly observed. Stale/unknown rows say so in words and show no number,
// no bar fill, and no absolute (D26: the source has no absolutes to show).

// The countdown needs a moving "now"; the derivations take it injected, so the
// clock lives here at the edge (rule 0.3). A minute is well under the shortest
// countdown unit displayed, so nothing visibly lags.
const METER_CLOCK_TICK_MS = 60_000;
const nowMs = ref(Date.now());
let meterClockHandle: ReturnType<typeof setInterval> | null = null;

const metersExpanded = ref(false);

const meterRows = computed<MeterRow[]>(() =>
  // Binding meter first — it is the one that answers the question.
  deriveMeterRows({ meters: store.meters }, nowMs.value, METER_STALE_AFTER_MS_PREVIEW),
);
const bindingMeter = computed<MeterRow | null>(() => meterRows.value[0] ?? null);
const secondaryMeters = computed<MeterRow[]>(() => meterRows.value.slice(1));

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
  void store.fetchMeters();
  meterClockHandle = setInterval(() => {
    nowMs.value = Date.now();
  }, METER_CLOCK_TICK_MS);
});

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
          @click="refreshDiscover"
        >
          ↻ Discover
        </button>
      </div>
    </div>
    <p v-if="store.pushState === 'off'" class="-mt-2 text-xs text-slate-500 dark:text-slate-400">
      Tap the bell to enable push notifications for gates and completions.
    </p>
    <p v-else-if="store.pushState === 'denied'" class="-mt-2 text-xs text-rose-500">
      Notifications are blocked — re-enable them in your browser settings.
    </p>

    <!-- Usage meters strip (slice 5 step 3). Principle 11: this INFORMS, it must
         not dominate the session list — one compact line, tap to expand inline
         (no new route). A stale/unknown meter shows words, never a figure. -->
    <section class="rounded-lg border border-slate-200 dark:border-slate-800" aria-label="Usage meters">
      <button
        v-if="bindingMeter !== null"
        type="button"
        class="flex min-h-[44px] w-full flex-col gap-1 px-3 py-2 text-left"
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
          <span class="truncate">{{ bindingMeter.resetLabel ?? 'reset time unknown' }}</span>
          <span class="shrink-0">{{ metersExpanded ? '▴' : `▾ ${meterRows.length} meters` }}</span>
        </div>
      </button>

      <!-- Fresh install, poller disabled, or the endpoint dead since boot: one
           honest line, never an empty gap and never zeros. -->
      <p v-else class="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">Usage unknown — no meters observed yet.</p>

      <ul v-if="metersExpanded && secondaryMeters.length > 0" class="flex flex-col gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-800">
        <li v-for="meter in secondaryMeters" :key="meter.meterId" class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2 text-xs">
            <span class="truncate text-slate-600 dark:text-slate-300">{{ meter.label }}</span>
            <span class="shrink-0 font-semibold" :class="METER_TONE_TEXT_CLASS[meter.tone]">
              {{ meterValueLabel(meter) }}
            </span>
          </div>
          <div class="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div class="h-full rounded-full" :class="METER_TONE_BAR_CLASS[meter.tone]" :style="meterBarStyle(meter)"></div>
          </div>
          <span class="text-[11px] text-slate-500 dark:text-slate-400">{{ meter.resetLabel ?? 'reset time unknown' }}</span>
        </li>
      </ul>
    </section>

    <ul class="flex flex-col gap-2">
      <li
        v-for="row in rows"
        :key="row.appSessionId"
        class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
      >
        <button
          type="button"
          class="flex min-h-[44px] w-full flex-col gap-1 text-left"
          @click="emit('open', row.appSessionId)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="truncate font-medium">{{ row.label }}</span>
            <span class="flex shrink-0 items-center gap-1">
              <span
                v-if="row.mirrored"
                class="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800 dark:bg-violet-900/50 dark:text-violet-200"
              >
                mirrored
              </span>
              <span class="rounded-full px-2 py-0.5 text-xs font-semibold" :class="row.livenessColorClass">
                {{ row.livenessLabel }}
              </span>
            </span>
          </div>
          <div class="flex items-center justify-between gap-2 text-sm text-slate-500 dark:text-slate-400">
            <span class="flex min-w-0 items-center gap-1.5">
              <span class="truncate">{{ row.channel }} · {{ row.cwdTail }}</span>
              <span
                v-if="row.cacheBadge !== null"
                class="shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold"
                :class="row.cacheBadge.toneClass"
                :title="`cache: ${row.cacheBadge.label}`"
              >
                {{ row.cacheBadge.label }}
              </span>
            </span>
            <span
              v-if="row.attention.visible"
              class="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800 dark:bg-orange-900/50 dark:text-orange-200"
            >
              {{ row.attention.label }}
            </span>
          </div>
        </button>

        <div v-if="renamingId === row.appSessionId" class="flex items-center gap-2">
          <input
            v-model="renameDraft"
            type="text"
            maxlength="120"
            class="min-h-[36px] min-w-0 flex-1 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            @keyup.enter="commitRename(row.appSessionId)"
            @keyup.esc="cancelRename"
          />
          <button type="button" class="min-h-[36px] rounded-md bg-sky-600 px-3 text-sm font-semibold text-white active:bg-sky-700" @click="commitRename(row.appSessionId)">
            Save
          </button>
          <button type="button" class="min-h-[36px] rounded-md px-2 text-sm text-slate-500 active:bg-slate-100 dark:active:bg-slate-900" @click="cancelRename">
            Cancel
          </button>
        </div>

        <div v-else class="flex items-center gap-2 text-sm">
          <button
            v-if="row.canAdopt"
            type="button"
            class="min-h-[36px] rounded-md bg-violet-600 px-3 font-semibold text-white active:bg-violet-700"
            @click="adopt(row.appSessionId)"
          >
            Adopt
          </button>
          <button
            v-if="row.canKill"
            type="button"
            class="min-h-[36px] rounded-md px-3 font-semibold active:bg-rose-100 dark:active:bg-rose-900/40"
            :class="isConfirmingKill(killConfirm, row.appSessionId) ? 'bg-rose-600 text-white' : 'border border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300'"
            @click="tapKill(row.appSessionId)"
          >
            {{ killLabel(row.appSessionId) }}
          </button>
          <button
            v-if="row.canRename"
            type="button"
            class="min-h-[36px] rounded-md border border-slate-300 px-3 text-slate-600 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-900"
            @click="startRename(row.appSessionId, row.label)"
          >
            Rename
          </button>
        </div>
      </li>
      <li v-if="rows.length === 0" class="p-3 text-center text-sm text-slate-500 dark:text-slate-400">
        No sessions yet — spawn one below, or Discover terminal-started ones.
      </li>
    </ul>

    <form class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800" @submit.prevent="spawn">
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
</template>
