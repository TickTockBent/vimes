<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import {
  attributionRows,
  formatMoney,
  hasUnknownTokens,
  ledgerState,
  seriesForSelection,
  spendAxisMax,
  spendBars,
  unknownTokenBadges,
  unvalidatedNote,
  type AgentView,
  type ProjectView,
  type RollupView,
  type SessionView,
} from '../lib/costDisplay.js';

// This view is statically imported by App.vue (like SessionListView), and it
// pulls in no heavy dependency — so it adds no lazy chunk and cannot disturb the
// build-manifest lazy-chunk gate (CodeMirror/xterm stay separate).

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

// ── Tree expand/collapse ────────────────────────────────────────────────────
// One reactive set of expanded node keys; every node starts collapsed. Keys are
// namespaced by level so a session id can never collide with a project key.
const expandedKeys = ref<Set<string>>(new Set());
function projectKeyOf(project: ProjectView): string {
  return `project:${project.projectKey}`;
}
function sessionKeyOf(project: ProjectView, session: SessionView): string {
  return `session:${project.projectKey}::${session.sessionId}`;
}
function isExpanded(nodeKey: string): boolean {
  return expandedKeys.value.has(nodeKey);
}
function toggle(nodeKey: string): void {
  const next = new Set(expandedKeys.value);
  if (next.has(nodeKey)) {
    next.delete(nodeKey);
  } else {
    next.add(nodeKey);
  }
  expandedKeys.value = next;
}

// Flatten an agent subtree into rows carrying their depth, in pre-order. This
// renders WHATEVER tree arrives: today every agent sits at the session root
// (depth 0, the flat reality), and it will indent automatically once the parent
// edge is persisted — no view change needed.
interface FlatAgentRow {
  agent: AgentView;
  depth: number;
}
function flattenAgents(agents: readonly AgentView[], depth = 0): FlatAgentRow[] {
  const rows: FlatAgentRow[] = [];
  for (const agent of agents) {
    rows.push({ agent, depth });
    if (agent.children.length > 0) {
      rows.push(...flattenAgents(agent.children, depth + 1));
    }
  }
  return rows;
}

// True when any agent anywhere has a resolved parent — i.e. the tree is NOT flat
// anymore. Drives whether we show the "currently flat" honesty note.
const treeIsFlat = computed(() => {
  const projects = ledger.value?.projects ?? [];
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const row of flattenAgents(session.agents)) {
        if (row.agent.parentResolved || row.depth > 0) {
          return false;
        }
      }
    }
  }
  return true;
});

// ── Spend history ───────────────────────────────────────────────────────────
// null selection = the grand (all-projects) series. A project can be selected to
// swap the series to its own (seriesForSelection guards a non-matching key).
const selectedProjectKey = ref<string | null>(null);
const projectKeysForSelect = computed(() => (ledger.value?.projects ?? []).map((project) => project.projectKey));
const bars = computed(() => spendBars(seriesForSelection(ledger.value?.spendHistory, selectedProjectKey.value)));
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
</script>

<template>
  <div class="mx-auto flex max-w-lg flex-col gap-4 p-4">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          aria-label="Back"
          @click="emit('back')"
        >
          ‹ Back
        </button>
        <h1 class="text-lg font-semibold">Cost ledger</h1>
      </div>
      <button
        type="button"
        class="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:active:bg-slate-900"
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
      class="rounded-lg border border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
    >
      Loading the cost ledger…
    </p>
    <p
      v-else-if="state === 'disabled'"
      class="rounded-lg border border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
    >
      Cost ledger is not enabled on this host — nothing is being ingested, so there is nothing to price. This is
      the feature being off, not a spend of $0.
    </p>
    <p
      v-else-if="state === 'empty'"
      class="rounded-lg border border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
    >
      Cost ingestion is on, but nothing has been ingested yet — no VIMES-hosted work has been recorded to price.
    </p>

    <template v-else-if="ledger !== null">
      <!-- Scope + grand total. The scope label is verbatim and prominent; this is
           VIMES-hosted work, never "your spend". -->
      <section class="flex flex-col gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <p class="text-sm font-medium text-slate-600 dark:text-slate-300">{{ ledger.scopeLabel }}</p>
        <div class="flex items-baseline gap-2">
          <span class="text-3xl font-bold tabular-nums">{{ formatMoney(ledger.grandTotal.priced.nanoDollars) }}</span>
          <span class="text-xs text-slate-500 dark:text-slate-400">priced at {{ ledger.priceTableDate }}</span>
        </div>
        <p v-if="unvalidatedFor(ledger.grandTotal) !== null" class="text-xs text-amber-700 dark:text-amber-300">
          {{ unvalidatedFor(ledger.grandTotal) }} — some models are priced by analogy.
        </p>
        <!-- Un-knowns beside the grand total: token counts, never a $0 row. -->
        <div v-if="hasUnknownFor(ledger.grandTotal)" class="flex flex-wrap items-center gap-1.5">
          <span class="text-xs text-slate-500 dark:text-slate-400">not in the total:</span>
          <span
            v-for="badge in badgesFor(ledger.grandTotal)"
            :key="badge.status"
            class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            {{ badge.tokensLabel }} tokens {{ badge.label }}
          </span>
        </div>
      </section>

      <!-- Spend over time — CSS bars, no charting dependency. -->
      <section class="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">Spend over time</h2>
          <select
            v-model="selectedProjectKey"
            class="min-h-[36px] max-w-[55%] truncate rounded-md border border-slate-300 px-2 text-xs dark:border-slate-700 dark:bg-slate-900"
            aria-label="Spend history project"
          >
            <option :value="null">All projects</option>
            <option v-for="projectKey in projectKeysForSelect" :key="projectKey" :value="projectKey">
              {{ projectKey }}
            </option>
          </select>
        </div>
        <p v-if="bars.length === 0" class="text-xs text-slate-500 dark:text-slate-400">
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
              class="flex h-28 shrink-0 flex-col justify-between text-right text-[10px] leading-none text-slate-500 dark:text-slate-400"
              aria-hidden="true"
            >
              <span>{{ axisMax.usd }}</span>
              <span>$0.00</span>
            </div>
            <div class="flex h-28 flex-1 items-end gap-0.5">
              <div
                v-for="bar in bars"
                :key="bar.day"
                class="flex-1 rounded-t bg-sky-500/80 dark:bg-sky-500/70"
                :style="{ height: `${bar.heightPercent}%` }"
                :title="`${bar.day}: ${bar.usd}`"
              ></div>
            </div>
          </div>
          <div class="flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
            <span>{{ bars[0]?.day }}</span>
            <span v-if="tallestBarUsd !== null">peak day {{ tallestBarUsd }}</span>
            <span>{{ bars[bars.length - 1]?.day }}</span>
          </div>
        </template>
      </section>

      <!-- Project → session → agent tree. -->
      <section class="flex flex-col gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <h2 class="text-sm font-semibold">Projects</h2>
        <!-- The honest flat-tree note: agents currently all sit at the session
             root because the parent edge is not persisted yet. It disappears on
             its own once agents start resolving parents. -->
        <p v-if="treeIsFlat" class="text-[11px] text-slate-500 dark:text-slate-400">
          Agents are shown flat at the session root — the parent-of relationship is not persisted yet, so nesting
          will fill in automatically once that lands.
        </p>

        <ul class="flex flex-col gap-1">
          <li v-for="project in ledger.projects" :key="projectKeyOf(project)" class="rounded-md border border-slate-100 dark:border-slate-800/70">
            <button
              type="button"
              class="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left"
              :aria-expanded="isExpanded(projectKeyOf(project))"
              @click="toggle(projectKeyOf(project))"
            >
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="shrink-0 text-slate-400" aria-hidden="true">{{ isExpanded(projectKeyOf(project)) ? '▾' : '▸' }}</span>
                <span class="truncate text-sm font-medium">{{ project.projectKey }}</span>
                <span
                  v-if="!project.insideProjectRoots"
                  class="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  outside roots
                </span>
              </span>
              <span class="shrink-0 text-sm font-semibold tabular-nums">{{ formatMoney(project.subtree.priced.nanoDollars) }}</span>
            </button>
            <div v-if="hasUnknownFor(project.subtree)" class="flex flex-wrap gap-1 px-3 pb-1.5">
              <span
                v-for="badge in badgesFor(project.subtree)"
                :key="badge.status"
                class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                +{{ badge.tokensLabel }} {{ badge.label }}
              </span>
            </div>

            <!-- Sessions -->
            <ul v-if="isExpanded(projectKeyOf(project))" class="flex flex-col gap-0.5 border-t border-slate-100 px-2 py-1 dark:border-slate-800/70">
              <li v-if="project.sessions.length === 0" class="px-2 py-1 text-xs text-slate-400">No sessions.</li>
              <li v-for="session in project.sessions" :key="sessionKeyOf(project, session)">
                <button
                  type="button"
                  class="flex min-h-[40px] w-full items-center justify-between gap-2 px-2 py-1.5 text-left"
                  :aria-expanded="isExpanded(sessionKeyOf(project, session))"
                  @click="toggle(sessionKeyOf(project, session))"
                >
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span class="shrink-0 text-slate-400" aria-hidden="true">{{ isExpanded(sessionKeyOf(project, session)) ? '▾' : '▸' }}</span>
                    <span class="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{{ session.sessionId }}</span>
                  </span>
                  <span class="shrink-0 text-xs font-semibold tabular-nums">{{ formatMoney(session.subtree.priced.nanoDollars) }}</span>
                </button>
                <div v-if="hasUnknownFor(session.subtree)" class="flex flex-wrap gap-1 px-2 pb-1 pl-6">
                  <span
                    v-for="badge in badgesFor(session.subtree)"
                    :key="badge.status"
                    class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    +{{ badge.tokensLabel }} {{ badge.label }}
                  </span>
                </div>

                <!-- Agents (flattened; indents by depth once nesting is real) -->
                <ul v-if="isExpanded(sessionKeyOf(project, session))" class="flex flex-col">
                  <li v-if="session.agents.length === 0" class="px-2 py-1 pl-6 text-xs text-slate-400">No agents.</li>
                  <li
                    v-for="row in flattenAgents(session.agents)"
                    :key="`${row.agent.sessionId}::${row.agent.agentId}`"
                    class="flex items-center justify-between gap-2 py-1 text-xs"
                    :style="{ paddingLeft: `${1.5 + row.depth * 0.75}rem`, paddingRight: '0.5rem' }"
                  >
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span class="truncate font-mono text-slate-500 dark:text-slate-400">{{ row.agent.agentId }}</span>
                      <span
                        class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        :class="
                          row.agent.parentResolved
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                        "
                      >
                        {{ row.agent.parentResolved ? 'attributed' : 'session-root' }}
                      </span>
                    </span>
                    <span class="shrink-0 tabular-nums">{{ formatMoney(row.agent.subtree.priced.nanoDollars) }}</span>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <!-- Attribution groupings. -->
      <section class="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <div>
          <h2 class="mb-1 text-sm font-semibold">By skill</h2>
          <p v-if="skillRows.length === 0" class="text-xs text-slate-400">No skill attribution recorded.</p>
          <ul v-else class="flex flex-col gap-0.5">
            <li v-for="row in skillRows" :key="`skill:${row.key}`" class="flex items-center justify-between gap-2 text-xs">
              <span class="truncate text-slate-600 dark:text-slate-300">{{ row.label }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <span
                  v-for="badge in row.unknownBadges"
                  :key="badge.status"
                  class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                >
                  +{{ badge.tokensLabel }} {{ badge.label }}
                </span>
                <span class="font-semibold tabular-nums">{{ row.usd }}</span>
              </span>
            </li>
          </ul>
        </div>
        <div>
          <h2 class="mb-1 text-sm font-semibold">By agent</h2>
          <p v-if="agentRows.length === 0" class="text-xs text-slate-400">No agent attribution recorded.</p>
          <ul v-else class="flex flex-col gap-0.5">
            <li v-for="row in agentRows" :key="`agent:${row.key}`" class="flex items-center justify-between gap-2 text-xs">
              <span class="truncate text-slate-600 dark:text-slate-300">{{ row.label }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <span
                  v-for="badge in row.unknownBadges"
                  :key="badge.status"
                  class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                >
                  +{{ badge.tokensLabel }} {{ badge.label }}
                </span>
                <span class="font-semibold tabular-nums">{{ row.usd }}</span>
              </span>
            </li>
          </ul>
        </div>
      </section>
    </template>
  </div>
</template>
