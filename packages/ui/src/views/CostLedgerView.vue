<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import {
  attributionRows,
  defaultExpandedKeys,
  directorySelectOptions,
  formatMoney,
  hasUnknownTokens,
  ledgerState,
  ledgerTreeRows,
  seriesForSelection,
  sessionLabelFor,
  spendAxisMax,
  spendBars,
  unknownTokenBadges,
  unvalidatedNote,
  type RollupView,
  type SessionView,
} from '../lib/costDisplay.js';

// This view is statically imported by App.vue (like SessionListView), and it
// pulls in no heavy dependency — so it adds no lazy chunk and cannot disturb the
// build-manifest lazy-chunk gate (CodeMirror/xterm stay separate).

// D41: this panel's close affordance. 'close' (a desktop panel) renders ✕;
// 'back' (a phone) keeps the original back affordance. The click handler is
// UNCHANGED — only the label/aria differ.
const props = defineProps<{ backKind?: 'back' | 'close' }>();
const emit = defineEmits<{ back: [] }>();
const store = useVimesStore();

// Fetch on open + a manual refresh button (mirrors the usage strip's refresh):
// the cost tree is expensive to rebuild server-side and nobody stares at it
// continuously, so it does NOT ride the sessions polling cadence.
onMounted(() => {
  void store.fetchCostLedger();
});

function refresh(): void {
  void store.fetchCostLedger();
}

const body = computed(() => store.costLedger);
const state = computed(() => ledgerState(body.value));
const ledger = computed(() => body.value?.ledger ?? null);

// ── Tree expand/collapse (D37: a DIRECTORY rollup) ──────────────────────────
// One reactive set of expanded node keys, namespaced by kind in costDisplay so a
// session id can never collide with a directory path. The tree opens to a useful
// depth (root → category → repo) and is collapsed below it: this view is driven
// from a phone, where a fully expanded deep tree is unusable.
//
// `userHasTouchedTree` keeps a manual collapse from being undone by the next
// refresh: once the operator has expressed an opinion, the default stops applying.
const expandedKeys = ref<Set<string>>(new Set());
const userHasTouchedTree = ref(false);
watch(
  () => ledger.value?.directories,
  (directories) => {
    if (!userHasTouchedTree.value) {
      expandedKeys.value = new Set(defaultExpandedKeys(directories));
    }
  },
  { immediate: true },
);

function toggle(nodeKey: string): void {
  userHasTouchedTree.value = true;
  const next = new Set(expandedKeys.value);
  if (next.has(nodeKey)) {
    next.delete(nodeKey);
  } else {
    next.add(nodeKey);
  }
  expandedKeys.value = next;
}

// The flat row list the template renders — directories, their own sessions, and
// (for an expanded session) its agents, each carrying its indent depth. All the
// nesting logic lives in costDisplay.ts, where it is unit-tested.
const treeRows = computed(() => ledgerTreeRows(ledger.value?.directories, expandedKeys.value));

// True when no agent anywhere has a resolved parent — i.e. the agent tree is
// still flat. Drives the honesty note; it disappears on its own once nesting is real.
const treeIsFlat = computed(() => {
  for (const row of treeRows.value) {
    if (row.kind === 'agent' && (row.agent.parentResolved || row.depth > 0)) {
      return false;
    }
  }
  return true;
});

// ── Spend history ───────────────────────────────────────────────────────────
// null selection = the grand (everything) series. Any directory node can be
// selected to swap the series to that node's subtree (seriesForSelection guards
// a non-matching key and never falls back to grand).
const selectedDirectoryPath = ref<string | null>(null);
const directoryOptions = computed(() => directorySelectOptions(ledger.value?.directories));
const bars = computed(() => spendBars(seriesForSelection(ledger.value?.spendHistory, selectedDirectoryPath.value)));
// The y-axis top tick: same series, same `nanoDollars` field `heightPercent`
// was derived from — so the axis label and the bar heights cannot disagree.
// null for an empty/all-zero series (spendAxisMax refuses to fabricate one).
const axisMax = computed(() => spendAxisMax(bars.value));
const tallestBarUsd = computed(() => {
  let tallest = bars.value[0] ?? null;
  for (const bar of bars.value) {
    if (bar.nanoDollars > (tallest?.nanoDollars ?? -1)) {
      tallest = bar;
    }
  }
  return tallest?.usd ?? null;
});

// ── Attribution ─────────────────────────────────────────────────────────────
const skillRows = computed(() => attributionRows(ledger.value?.byAttributionSkill));
const agentRows = computed(() => attributionRows(ledger.value?.byAttributionAgent));

// Re-exported for the template (Vue templates can't call bare imports typed as
// value-returning without exposing them; expose the ones the template uses).
function badgesFor(rollup: RollupView) {
  return unknownTokenBadges(rollup);
}
function unvalidatedFor(rollup: RollupView) {
  return unvalidatedNote(rollup);
}
function hasUnknownFor(rollup: RollupView) {
  return hasUnknownTokens(rollup);
}
// Q3: the one shared ladder (lib/sessionLabel.ts), re-exposed for the template.
function sessionLabel(session: SessionView) {
  // S15-F10: `getTimezoneOffset()` returns minutes the viewer is BEHIND UTC
  // (positive = west); the ladder wants minutes EAST of UTC, hence the
  // negation. This is the view boundary — the ambient clock is allowed here,
  // never inside lib/sessionLabel.ts.
  return sessionLabelFor(session, -new Date().getTimezoneOffset());
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
        <h1 class="text-lg font-semibold uppercase tracking-[0.08em] text-ink">Cost ledger</h1>
      </div>
      <button
        type="button"
        class="min-h-[44px] min-w-[44px] rounded-md border border-line px-3 text-sm font-medium active:bg-panel-sunken disabled:opacity-50"
        :disabled="store.costLedgerLoading"
        aria-label="Refresh cost ledger"
        @click="refresh"
      >
        <span aria-hidden="true">{{ store.costLedgerLoading ? '⋯' : '↻' }}</span>
      </button>
    </div>

    <!-- Nothing observed yet: honest states, never a fabricated $0 tree. -->
    <p
      v-if="body === null && store.costLedgerLoading"
      class="rounded-lg border border-line p-4 text-sm text-ink-dim"
    >
      Loading the cost ledger…
    </p>
    <p
      v-else-if="state === 'disabled'"
      class="rounded-lg border border-line p-4 text-sm text-ink-dim"
    >
      Cost ledger is not enabled on this host — nothing is being ingested, so there is nothing to price. This is
      the feature being off, not a spend of $0.
    </p>
    <p
      v-else-if="state === 'empty'"
      class="rounded-lg border border-line p-4 text-sm text-ink-dim"
    >
      Cost ingestion is on, but nothing has been ingested yet — no VIMES-hosted work has been recorded to price.
    </p>

    <template v-else-if="ledger !== null">
      <!-- Scope + grand total. The scope label is verbatim and prominent; this is
           VIMES-hosted work, never "your spend". -->
      <section class="flex flex-col gap-2 rounded-lg border border-line p-4">
        <p class="text-sm font-medium text-ink-dim">{{ ledger.scopeLabel }}</p>
        <div class="flex items-baseline gap-2">
          <span class="text-3xl font-bold font-mono tabular-nums text-ink">{{ formatMoney(ledger.grandTotal.priced.nanoDollars) }}</span>
          <span class="text-xs text-ink-dim">priced at {{ ledger.priceTableDate }}</span>
        </div>
        <p v-if="unvalidatedFor(ledger.grandTotal) !== null" class="text-xs text-warn">
          {{ unvalidatedFor(ledger.grandTotal) }} — some models are priced by analogy.
        </p>
        <!-- Un-knowns beside the grand total: token counts, never a $0 row. -->
        <div v-if="hasUnknownFor(ledger.grandTotal)" class="flex flex-wrap items-center gap-1.5">
          <span class="text-xs text-ink-dim">not in the total:</span>
          <span
            v-for="badge in badgesFor(ledger.grandTotal)"
            :key="badge.status"
            class="rounded-full bg-panel-sunken px-2 py-0.5 text-xs font-semibold font-mono tabular-nums text-ink-dim"
          >
            {{ badge.tokensLabel }} tokens {{ badge.label }}
          </span>
        </div>
      </section>

      <!-- Spend over time — CSS bars, no charting dependency. -->
      <section class="flex flex-col gap-3 rounded-lg border border-line p-4">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold font-mono uppercase tracking-[0.08em] text-ink">Spend over time</h2>
          <!-- The SAME nodes the tree shows, so any rollup level can be charted. -->
          <select
            v-model="selectedDirectoryPath"
            class="min-h-[36px] max-w-[55%] truncate rounded-md border border-line bg-panel px-2 text-xs text-ink"
            aria-label="Spend history directory"
          >
            <option :value="null">Everything</option>
            <option v-for="option in directoryOptions" :key="option.directoryPath" :value="option.directoryPath">
              {{ option.label }}
            </option>
          </select>
        </div>
        <p v-if="bars.length === 0" class="text-xs text-ink-dim">
          No priced spend recorded for this selection yet.
        </p>
        <template v-else>
          <!-- Cost axis (D38): two ticks — series max at the top, zero at the
               bottom — sharing the exact h-28 box the bars grow in, so a tick's
               position and a bar's `heightPercent` are reading the same 0–100%
               space and can never disagree. Omitted (axisMax null) rather than
               fabricated when every bar in the series is flat at 0. -->
          <div class="flex items-stretch gap-2">
            <div
              v-if="axisMax !== null"
              class="flex h-28 shrink-0 flex-col justify-between text-right text-[10px] font-mono tabular-nums leading-none text-ink-dim"
              aria-hidden="true"
            >
              <span>{{ axisMax.usd }}</span>
              <span>$0.00</span>
            </div>
            <div class="flex h-28 flex-1 items-end gap-0.5">
              <div
                v-for="bar in bars"
                :key="bar.day"
                class="flex-1 rounded-t bg-accent/70"
                :style="{ height: `${bar.heightPercent}%` }"
                :title="`${bar.day}: ${bar.usd}`"
              ></div>
            </div>
          </div>
          <div class="flex justify-between text-[11px] font-mono tabular-nums text-ink-dim">
            <span>{{ bars[0]?.day }}</span>
            <span v-if="tallestBarUsd !== null">peak day {{ tallestBarUsd }}</span>
            <span>{{ bars[bars.length - 1]?.day }}</span>
          </div>
        </template>
      </section>

      <!-- D37: directory rollup → session → agent tree. Every row is a real
           directory a session ran in (or an ancestor of one) — no project
           boundary is inferred anywhere. -->
      <section class="flex flex-col gap-2 rounded-lg border border-line p-4">
        <h2 class="text-sm font-semibold font-mono uppercase tracking-[0.08em] text-ink">Where it went</h2>
        <!-- The honest flat-tree note: agents currently all sit at the session
             root because the parent edge is not persisted yet. It disappears on
             its own once agents start resolving parents. -->
        <p v-if="treeIsFlat" class="text-[11px] text-ink-dim">
          Agents are shown flat at the session root — the parent-of relationship is not persisted yet, so nesting
          will fill in automatically once that lands.
        </p>

        <!-- One flat list, indented by row depth. The nesting decisions live in
             costDisplay.ts (ledgerTreeRows), where they are unit-tested. -->
        <ul class="flex flex-col">
          <li v-if="treeRows.length === 0" class="px-2 py-1 text-xs text-ink-dim">No directories recorded.</li>
          <li v-for="row in treeRows" :key="row.key" class="border-b border-line last:border-b-0">
            <!-- A directory node: its subtree total, and the un-knowns beneath it. -->
            <template v-if="row.kind === 'directory'">
              <button
                type="button"
                class="flex min-h-[44px] w-full items-center justify-between gap-2 py-2 pr-2 text-left"
                :style="{ paddingLeft: `${0.25 + row.depth * 0.85}rem` }"
                :aria-expanded="row.expanded"
                :disabled="!row.expandable"
                @click="toggle(row.key)"
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="w-3 shrink-0 text-ink-dim" aria-hidden="true">
                    {{ row.expandable ? (row.expanded ? '▾' : '▸') : '' }}
                  </span>
                  <span class="truncate text-sm font-medium text-ink">{{ row.directory.label }}</span>
                  <span
                    v-if="!row.directory.insideProjectRoots"
                    class="shrink-0 rounded-full bg-panel-sunken px-1.5 py-0.5 text-[10px] font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim"
                  >
                    outside roots
                  </span>
                </span>
                <span class="shrink-0 text-sm font-semibold font-mono tabular-nums text-ink">
                  {{ formatMoney(row.directory.subtree.priced.nanoDollars) }}
                </span>
              </button>
              <div
                v-if="hasUnknownFor(row.directory.subtree)"
                class="flex flex-wrap gap-1 pb-1.5"
                :style="{ paddingLeft: `${1.25 + row.depth * 0.85}rem` }"
              >
                <span
                  v-for="badge in badgesFor(row.directory.subtree)"
                  :key="badge.status"
                  class="rounded-full bg-panel-sunken px-1.5 py-0.5 text-[10px] font-semibold font-mono tabular-nums text-ink-dim"
                >
                  +{{ badge.tokensLabel }} {{ badge.label }}
                </span>
              </div>
            </template>

            <!-- A session launched in that exact directory. The label comes from
                 `sessionLabelFor` — the SAME ladder the session list uses
                 (`title` → `Jul 19 23:25 · a1b2c3d4`), so one session can never
                 be called two things in two views. There is no cwd-basename
                 rung: this row's parent directory already shows that name. -->
            <template v-else-if="row.kind === 'session'">
              <button
                type="button"
                class="flex min-h-[40px] w-full items-center justify-between gap-2 py-1.5 pr-2 text-left"
                :style="{ paddingLeft: `${0.25 + row.depth * 0.85}rem` }"
                :aria-expanded="row.expanded"
                :disabled="!row.expandable"
                @click="toggle(row.key)"
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="w-3 shrink-0 text-ink-dim" aria-hidden="true">
                    {{ row.expandable ? (row.expanded ? '▾' : '▸') : '' }}
                  </span>
                  <span class="truncate text-xs text-ink-dim">{{ sessionLabel(row.session) }}</span>
                  <span
                    v-if="row.session.title === null"
                    class="shrink-0 font-mono text-[10px] text-ink-dim"
                    :title="row.session.sessionId"
                  >
                    session
                  </span>
                </span>
                <span class="shrink-0 text-xs font-semibold font-mono tabular-nums text-ink">
                  {{ formatMoney(row.session.subtree.priced.nanoDollars) }}
                </span>
              </button>
              <div
                v-if="hasUnknownFor(row.session.subtree)"
                class="flex flex-wrap gap-1 pb-1"
                :style="{ paddingLeft: `${1.25 + row.depth * 0.85}rem` }"
              >
                <span
                  v-for="badge in badgesFor(row.session.subtree)"
                  :key="badge.status"
                  class="rounded-full bg-panel-sunken px-1.5 py-0.5 text-[10px] font-semibold font-mono tabular-nums text-ink-dim"
                >
                  +{{ badge.tokensLabel }} {{ badge.label }}
                </span>
              </div>
            </template>

            <!-- An agent under an expanded session. -->
            <div
              v-else
              class="flex items-center justify-between gap-2 py-1 pr-2 text-xs"
              :style="{ paddingLeft: `${1 + row.depth * 0.85}rem` }"
            >
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate font-mono tabular-nums text-ink-dim">{{ row.agent.agentId }}</span>
                <span
                  class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold font-mono uppercase tracking-[0.08em]"
                  :class="
                    row.agent.parentResolved
                      ? 'bg-ok/10 text-ok'
                      : 'bg-panel-sunken text-ink-dim'
                  "
                >
                  {{ row.agent.parentResolved ? 'attributed' : 'session-root' }}
                </span>
              </span>
              <span class="shrink-0 font-mono tabular-nums text-ink">{{ formatMoney(row.agent.subtree.priced.nanoDollars) }}</span>
            </div>
          </li>
        </ul>
      </section>

      <!-- Attribution groupings. -->
      <section class="flex flex-col gap-3 rounded-lg border border-line p-4">
        <div>
          <h2 class="mb-1 text-sm font-semibold font-mono uppercase tracking-[0.08em] text-ink">By skill</h2>
          <p v-if="skillRows.length === 0" class="text-xs text-ink-dim">No skill attribution recorded.</p>
          <ul v-else class="flex flex-col gap-0.5">
            <li v-for="row in skillRows" :key="`skill:${row.key}`" class="flex items-center justify-between gap-2 text-xs">
              <span class="truncate text-ink-dim">{{ row.label }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <span
                  v-for="badge in row.unknownBadges"
                  :key="badge.status"
                  class="rounded-full bg-panel-sunken px-1.5 py-0.5 text-[10px] font-semibold font-mono tabular-nums text-ink-dim"
                >
                  +{{ badge.tokensLabel }} {{ badge.label }}
                </span>
                <span class="font-semibold font-mono tabular-nums text-ink">{{ row.usd }}</span>
              </span>
            </li>
          </ul>
        </div>
        <div>
          <h2 class="mb-1 text-sm font-semibold font-mono uppercase tracking-[0.08em] text-ink">By agent</h2>
          <p v-if="agentRows.length === 0" class="text-xs text-ink-dim">No agent attribution recorded.</p>
          <ul v-else class="flex flex-col gap-0.5">
            <li v-for="row in agentRows" :key="`agent:${row.key}`" class="flex items-center justify-between gap-2 text-xs">
              <span class="truncate text-ink-dim">{{ row.label }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <span
                  v-for="badge in row.unknownBadges"
                  :key="badge.status"
                  class="rounded-full bg-panel-sunken px-1.5 py-0.5 text-[10px] font-semibold font-mono tabular-nums text-ink-dim"
                >
                  +{{ badge.tokensLabel }} {{ badge.label }}
                </span>
                <span class="font-semibold font-mono tabular-nums text-ink">{{ row.usd }}</span>
              </span>
            </li>
          </ul>
        </div>
      </section>
    </template>
  </div>
</template>
