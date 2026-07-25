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
import type { MeterTone } from '../lib/meterDisplay.js';

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
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div
            v-for="constraint in model.constraints"
            :key="constraint.meterId"
            class="rounded-md border bg-panel-sunken p-3"
            :class="constraint.isBinding ? 'border-ink-dim' : 'border-line'"
          >
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate font-mono text-xs font-semibold text-ink">{{ constraint.label }}</span>
              <span
                v-if="constraint.isBinding"
                class="flex-none rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
                :class="toneTextClass(constraint.tone)"
              >
                Binding
              </span>
            </div>

            <div class="mt-2 flex items-baseline justify-between gap-2">
              <span
                class="font-mono text-lg font-bold tabular-nums"
                :class="constraint.displayPercent !== null ? toneTextClass(constraint.tone) : 'text-ink-dim'"
              >
                {{ constraint.valueLabel }}
              </span>
              <span class="font-mono text-[10px] tabular-nums text-ink-dim">{{ constraint.ageLabel }}</span>
            </div>

            <!-- Bar: fills only with a confident fresh percent; otherwise a dashed
                 unknown track that never implies 0. -->
            <span
              class="mt-2 block h-2 w-full overflow-hidden rounded-full"
              :class="constraint.displayPercent !== null ? 'bg-track' : 'border border-dashed border-line'"
            >
              <span
                v-if="constraint.displayPercent !== null"
                class="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
                :class="toneBarClass(constraint.tone)"
                :style="{ width: `${constraint.displayPercent}%` }"
              ></span>
            </span>

            <dl class="mt-2 grid grid-cols-1 gap-0.5 font-mono text-[11px] tabular-nums text-ink-dim">
              <div class="flex justify-between gap-2">
                <dt>reset</dt>
                <dd class="text-ink">{{ constraint.resetLabel ?? 'no reset pending' }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>burn</dt>
                <dd class="text-ink">{{ constraint.burnRateLabel }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>projected</dt>
                <dd class="text-right text-ink">{{ constraint.exhaustionLabel }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </template>

      <!-- Honest empty state — never a fake gauge (pillar 4 / kill criterion). -->
      <p v-else class="px-1 py-2 font-mono text-xs text-ink-dim">
        No usage windows observed yet.
      </p>
    </div>
  </div>
</template>
