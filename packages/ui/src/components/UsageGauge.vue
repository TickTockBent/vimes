<script setup lang="ts">
// The ACTIVE USAGE GAUGE (slice 6b, unit 3b) — the first-class usage instrument
// in the persistent top bar. Collapsed: the BINDING constraint, always visible.
// Expanded: a click-to-open pulldown of every window with burn rate and honest
// projection. This is ACCOUNT usage (the windows), distinct from the StreamView
// vitals strip (this-session context/cache) — the two do not overlap.
//
// GLUE ONLY. All logic lives in the pure, tested lib/usageGauge.ts (which itself
// reuses lib/meterDisplay.ts). This file: reads the store's already-polled
// snapshot (NO new fetch), computes the SERVER-ANCHORED now the same way
// usageStripModel does, maps the model's semantic tones to token classes, and
// renders. The honest-unknown rule (pillar 4) is enforced upstream: when
// displayPercent is null the bar shows an unknown/stale track and the number
// becomes a word — never a fabricated 0.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { buildUsageGaugeModel, type GaugeMeterVM } from '../lib/usageGauge.js';
import {
  refreshNotice,
  usageStripModel,
  type MeterTone,
  type RefreshNoticeTone,
} from '../lib/meterDisplay.js';

const store = useVimesStore();

// A ticking local clock so ages/countdowns advance on screen between fetches.
// Only the LOCAL delta since the response landed is ever used (see below), so a
// wrong client clock cannot make a stale reading look fresh.
const localNowMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

const expanded = ref(false);
const rootEl = ref<HTMLElement | null>(null);

// The server-anchored now: observedNow advanced by LOCAL elapsed time since the
// response landed — identical to usageStripModel's derivation, never Date.now().
const model = computed(() => {
  const snapshot = store.usageSnapshot;
  if (snapshot === null) {
    return buildUsageGaugeModel(null, null);
  }
  const observedNowMs = Date.parse(snapshot.body.observedNow ?? '');
  const elapsedSinceResponseMs = Math.max(0, localNowMs.value - snapshot.receivedAtLocalMs);
  const anchoredNowMs = Number.isFinite(observedNowMs) ? observedNowMs + elapsedSinceResponseMs : null;
  return buildUsageGaugeModel(snapshot.body, anchoredNowMs);
});

const binding = computed<GaugeMeterVM | null>(() => model.value.binding);
const hasData = computed(() => binding.value !== null);

// ── the meters-strip residuals (S16·U4; slice-16 §3 decision 1) ─────────────
//
// The dying SessionListView strip carried three things this gauge did not: the
// MANUAL REFRESH button (the only UI for store.refreshUsage /
// usageRefreshInFlight / lastUsageRefresh anywhere in the app), the
// "polling disabled" notice, and the per-meter freshness word. The first two
// move into the PULLDOWN below — never the collapsed bar, which stays the one
// binding readout. The third is an ACCEPTED, SIGNED LOSS: every row here
// already shows its observation age, which is the same fact with more
// resolution than the word.
//
// ⚠ WHY A SECOND MODEL. `UsageGaugeModel` does not carry `freshnessBandMissing`
// — that fact lives on `usageStripModel`, and teaching the gauge model to
// re-expose it would be a LIB change this unit is not allowed to make (and a
// second authority for the same fact if it went wrong). So the notice reads the
// SAME exported derivation the dying strip read, called the SAME way it called
// it (the LOCAL clock, not the anchored now — usageStripModel does its own
// server anchoring internally). Nothing is re-derived here.
const strip = computed(() => usageStripModel(store.usageSnapshot, localNowMs.value));

// True only when the daemon says it has no freshness band at all — i.e. the
// poller is off and every reading is 'unknown' BY CONSTRUCTION. Gated on there
// being meters to explain: with nothing observed, the honest-empty note below
// already says everything there is to say.
const pollingDisabled = computed(() => strip.value.freshnessBandMissing && model.value.meterCount > 0);

// The refresh control's honest one-liner: throttled, failed and succeeded are
// three different messages and never impersonate each other (refreshNotice
// owns that distinction; this file only picks the colour).
const refreshMessage = computed(() => refreshNotice(store.lastUsageRefresh));

const REFRESH_TONE_CLASS: Readonly<Record<RefreshNoticeTone, string>> = {
  success: 'text-ok',
  throttled: 'text-ink-dim',
  failed: 'text-crit',
};

function tapRefreshUsage(): void {
  void store.refreshUsage();
}

// Semantic tone → token utility classes (the lib never touches CSS). unknown is
// deliberately its own neutral tone — never green, so an unknown meter can never
// read as "fine".
function toneTextClass(tone: MeterTone): string {
  switch (tone) {
    case 'normal':
      return 'text-ok';
    case 'elevated':
      return 'text-warn';
    case 'high':
      return 'text-crit';
    default:
      return 'text-ink-dim';
  }
}
function toneBarClass(tone: MeterTone): string {
  switch (tone) {
    case 'normal':
      return 'bg-ok';
    case 'elevated':
      return 'bg-warn';
    case 'high':
      return 'bg-crit';
    default:
      return 'bg-ink-dim';
  }
}

function toggle(): void {
  if (!hasData.value) {
    // Nothing to expand into, but still allow opening for the honest empty note.
  }
  expanded.value = !expanded.value;
}

function onDocumentClick(event: MouseEvent): void {
  if (!expanded.value) {
    return;
  }
  if (rootEl.value !== null && event.target instanceof Node && !rootEl.value.contains(event.target)) {
    expanded.value = false;
  }
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && expanded.value) {
    expanded.value = false;
  }
}

onMounted(() => {
  clockTimer = setInterval(() => {
    localNowMs.value = Date.now();
  }, 1000);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  if (clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="rootEl" class="relative">
    <!-- COLLAPSED: the binding constraint, always visible in the bar. -->
    <button
      type="button"
      class="flex items-center gap-2 rounded-md border border-line bg-panel-sunken px-2 py-1 text-left transition-colors hover:border-ink-dim sm:gap-3 sm:px-3"
      :aria-expanded="expanded"
      aria-haspopup="true"
      aria-controls="usage-gauge-panel"
      :aria-label="hasData ? `Account usage — binding: ${binding!.label} at ${binding!.valueLabel}` : 'Account usage — unknown'"
      @click.stop="toggle()"
    >
      <!-- Tone status dot. Pulses only when motion is welcome. -->
      <span
        class="h-2 w-2 flex-none rounded-full"
        :class="[hasData ? toneBarClass(binding!.tone) : 'bg-ink-dim', 'motion-safe:animate-pulse']"
        aria-hidden="true"
      ></span>

      <!-- Title block: kicker + binding window name. Kicker hides on narrow. -->
      <span class="flex-none">
        <span class="hidden text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-dim sm:block">
          Binding
        </span>
        <span class="block font-mono text-xs font-semibold text-ink sm:text-sm">
          {{ hasData ? binding!.label : 'usage' }}
        </span>
      </span>

      <!-- Compact meter bar — desktop/tablet only; the number carries mobile. -->
      <span class="hidden h-1.5 w-16 flex-none overflow-hidden rounded-full md:block lg:w-24" :class="hasData && binding!.displayPercent !== null ? 'bg-track' : 'border border-dashed border-line'">
        <span
          v-if="hasData && binding!.displayPercent !== null"
          class="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
          :class="toneBarClass(binding!.tone)"
          :style="{ width: `${binding!.displayPercent}%` }"
        ></span>
      </span>

      <!-- Readout: bold tabular percent (or honest word) + reset · burn subline. -->
      <span class="flex flex-none flex-col items-end leading-tight">
        <span
          class="font-mono text-sm font-bold tabular-nums sm:text-base"
          :class="hasData ? toneTextClass(binding!.tone) : 'text-ink-dim'"
        >
          {{ hasData ? binding!.valueLabel : '—' }}
        </span>
        <span v-if="hasData" class="hidden font-mono text-[10px] tabular-nums text-ink-dim sm:block">
          {{ binding!.resetLabel ?? 'no reset pending' }} · {{ binding!.burnRateLabel }}
        </span>
      </span>

      <!-- Chevron. -->
      <span
        class="flex-none text-ink-dim motion-safe:transition-transform motion-safe:duration-200"
        :class="{ 'rotate-180 text-accent': expanded }"
        aria-hidden="true"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>

    <!-- EXPANDED PULLDOWN: every constraint, daemon binding-first order. -->
    <div
      v-if="expanded"
      id="usage-gauge-panel"
      role="region"
      aria-label="All account usage constraints"
      class="absolute right-0 top-full z-40 mt-1 w-[min(92vw,34rem)] rounded-lg border border-line bg-panel p-3 shadow-lg"
    >
      <template v-if="hasData">
        <!-- Flat rows in a LIST (Wes, 2026-07-25): each window spans full width —
             label+binding on the left, the meter bar taking the middle, the % on
             the right, with reset · burn · projected under the bar. More scannable
             than a grid of square cards, and reads like an instrument readout. -->
        <ul class="flex flex-col gap-1.5">
          <li
            v-for="constraint in model.constraints"
            :key="constraint.meterId"
            class="flex items-center gap-3 rounded-md border bg-panel-sunken px-3 py-2"
            :class="constraint.isBinding ? 'border-ink-dim' : 'border-line'"
          >
            <!-- label + binding chip -->
            <div class="flex w-28 flex-none flex-col gap-0.5">
              <span class="truncate font-mono text-xs font-semibold text-ink">{{ constraint.label }}</span>
              <span
                v-if="constraint.isBinding"
                class="w-fit rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
                :class="toneTextClass(constraint.tone)"
              >
                Binding
              </span>
            </div>

            <!-- meter bar + the reset/burn/projected readout under it -->
            <div class="min-w-0 flex-1">
              <!-- Bar: fills only with a confident fresh percent; otherwise a dashed
                   unknown track that never implies 0. -->
              <span
                class="block h-2 w-full overflow-hidden rounded-full"
                :class="constraint.displayPercent !== null ? 'bg-track' : 'border border-dashed border-line'"
              >
                <span
                  v-if="constraint.displayPercent !== null"
                  class="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
                  :class="toneBarClass(constraint.tone)"
                  :style="{ width: `${constraint.displayPercent}%` }"
                ></span>
              </span>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-ink-dim">
                <span>reset <span class="text-ink">{{ constraint.resetLabel ?? '—' }}</span></span>
                <span>burn <span class="text-ink">{{ constraint.burnRateLabel }}</span></span>
                <span>proj <span class="text-ink">{{ constraint.exhaustionLabel }}</span></span>
              </div>
            </div>

            <!-- the % (and observation age under it) -->
            <div class="flex-none text-right">
              <div
                class="font-mono text-lg font-bold tabular-nums"
                :class="constraint.displayPercent !== null ? toneTextClass(constraint.tone) : 'text-ink-dim'"
              >
                {{ constraint.valueLabel }}
              </div>
              <div class="font-mono text-[10px] tabular-nums text-ink-dim">{{ constraint.ageLabel }}</div>
            </div>
          </li>
        </ul>
      </template>

      <!-- Honest empty state — never a fake gauge (pillar 4 / kill criterion). -->
      <p v-else class="px-1 py-2 font-mono text-xs text-ink-dim">
        No usage windows observed yet.
      </p>

      <!-- THE RESIDUAL FOOT (S16·U4, decision 1). Rendered in BOTH the
           has-data and empty arms on purpose: a forced poll is most useful
           precisely when nothing has been observed yet, which is exactly what
           the dying strip did (its refresh button sat beside the honest-empty
           line, not inside the meter list). Inside the pulldown, so the click
           never reaches the document listener that would close it. -->
      <div class="mt-2 flex items-center gap-2 border-t border-line pt-2">
        <!-- Forced refresh. Disabled while in flight so an impatient thumb
             cannot stack requests against an unofficial endpoint. -->
        <button
          type="button"
          class="flex-none rounded-md border border-line px-2 py-1 font-mono text-[11px] text-ink-dim transition-colors hover:bg-panel-sunken hover:text-ink disabled:opacity-50"
          :disabled="store.usageRefreshInFlight"
          aria-label="Refresh usage meters"
          @click="tapRefreshUsage()"
        >
          <span aria-hidden="true">{{ store.usageRefreshInFlight ? '⋯' : '↻' }}</span>
          {{ store.usageRefreshInFlight ? 'Refreshing…' : 'Refresh' }}
        </button>
        <!-- The outcome of the LAST forced refresh, in its own tone. Absent
             until one has been asked for — this never speaks for the poller. -->
        <p v-if="refreshMessage !== null" class="min-w-0 text-[11px]" :class="REFRESH_TONE_CLASS[refreshMessage.tone]">
          {{ refreshMessage.message }}
        </p>
      </div>

      <!-- No staleness band at all: the daemon says its poller is disabled, so
           every reading is 'unknown' by construction. Say WHY rather than let it
           read as a transient hiccup. -->
      <p v-if="pollingDisabled" class="mt-1 text-[11px] text-ink-dim">
        Usage polling is disabled — freshness cannot be judged.
      </p>
    </div>
  </div>
</template>
