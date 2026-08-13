<script setup lang="ts">
// ─── S15·U2 — THE HOME SURFACE: the session tree ─────────────────────────────
//
// The forest `GET /api/tree` serves, rendered. This view occupies the slot
// SessionListView held until the cutover (F1): the phone's home frame AND the
// desktop sidebar, same component, two layouts — so its frame shape is
// SessionListView's, not a new one.
//
// ⚠ **THIS COMPONENT DERIVES NOTHING THE DAEMON SERVES (ui-doctrine U8).** Root
// order, sibling order, severities, rollups and short ids all arrive decided.
// The rows come from `sessionTreeRows` verbatim; there is no `.sort()`, no
// `.filter()` over the payload, and no second opinion about what a session is
// called or which four characters name it. The ONLY thing this file owns is
// which containers are expanded, which is view state and never leaves the view.
//
// ⚠ **SEEN NEVER MUTES SEVERITY (U5/D83).** `sessionRowTreatment` already keeps
// the two channels apart; the template must not put them back together. There is
// deliberately NO `v-if="seen"` anywhere near a tone or a glyph binding — the
// unseen marker is its own element, and removing it changes nothing about how
// loud the row reads.
import { computed, onMounted, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { sessionTreeContainerIds, sessionTreeRows } from '../lib/sessionTreeRows.js';
import {
  rollupWorstDisplay,
  sessionRowTreatment,
  type SeverityTone,
} from '../lib/sessionSeverityDisplay.js';
import { resolveSessionLabel } from '../lib/sessionLabel.js';

const emit = defineEmits<{
  open: [appSessionId: string];
}>();

const store = useVimesStore();

// The `unfiled` root's id, mirrored from `packages/core/src/projections/tree.ts`
// (`UNFILED_ROOT_ID`) rather than imported, in the same narrow-mirroring posture
// `lib/sessionLabel.ts` takes toward `sessionIdentity.ts`. The authority is core;
// keep the two in step. It is used for PRESENTATION ONLY — `unfiled` is a fact
// about the estate, not a project, and it reads quietly — never to reorder or
// filter, which the payload already decided (it comes last, and it comes even
// when empty).
const UNFILED_ROOT_ID = 'unfiled';

// ── expansion state (ephemeral, per tab) ────────────────────────────────────
//
// IN-MANDATE, RECORDED: default FULLY EXPANDED, and nothing is persisted this
// slice. A tree that opens collapsed hides exactly what the operator came to
// see; a tree that remembers a collapse across reloads can hide a gate that
// fired while the tab was closed. Both are decisions worth revisiting with real
// data, and neither is worth a storage key before then.
const expandedIds = ref<ReadonlySet<string>>(new Set<string>());
// Whether the expand-all default has been applied. It runs ONCE, on the first
// payload — a later refresh must not re-expand branches the operator collapsed,
// and TREE_AFFECTING_TYPES makes refreshes frequent enough that re-applying it
// would fight the operator's hands mid-scroll.
let expansionInitialized = false;

watch(
  () => store.tree,
  (payload) => {
    if (payload === null || expansionInitialized) {
      return;
    }
    expansionInitialized = true;
    expandedIds.value = new Set(sessionTreeContainerIds(payload));
  },
  { immediate: true },
);

// Replaced rather than mutated: a fresh Set is the simplest thing that is
// unambiguously reactive, and expansion sets are tens of ids, not thousands.
function toggleExpansion(containerId: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(containerId)) {
    next.delete(containerId);
  } else {
    next.add(containerId);
  }
  expandedIds.value = next;
}

const rows = computed(() =>
  store.tree === null ? [] : sessionTreeRows(store.tree, expandedIds.value),
);

// ── presentation maps (tokens only — ui-doctrine §3) ────────────────────────
//
// The tone KEY comes from lib/sessionSeverityDisplay.ts, which owns the
// severity→(tone, glyph) translation and must never learn a colour. This map is
// the view's half: tone family → the utility class minted from the token. No
// raw hexes, no second accent, both themes for free (the tokens swap, the class
// names do not).
const TONE_TEXT_CLASS: Readonly<Record<SeverityTone, string>> = {
  crit: 'text-crit',
  warn: 'text-warn',
  accent: 'text-accent',
  dim: 'text-ink-dim',
};

// One `text-xs` step of indent per depth level (U2 — this surface holds ~50 rows
// on a phone, and a wide indent spends the width the names need). Inline because
// the depth is data; Tailwind cannot mint a class from a runtime number.
const INDENT_PER_DEPTH_PX = 12;

function indentStyle(depth: number): Record<string, string> {
  return { paddingLeft: `${depth * INDENT_PER_DEPTH_PX}px` };
}

// The identity ladder (lib/sessionLabel.ts — the ONE answer to "what is this
// session called?"). `TreeSession` now carries `createdAt` (S15-F3), so the
// ladder's bottom rung renders its timestamp beside the 8-char distinguisher
// for nameless sessions instead of two hex strings with nothing to tell them
// apart; that rung is the S14-F1 exemption and is NOT the short id, which
// comes off the payload (`shortId`, estate-scoped, D79) and renders at the
// row's end.
function sessionLabelOf(session: {
  appSessionId: string;
  name: string | null;
  derivedTitle: string | null;
  createdAt: string;
}): string {
  return resolveSessionLabel({
    sessionId: session.appSessionId,
    name: session.name,
    derivedTitle: session.derivedTitle,
    earliestActivityAt: session.createdAt,
  });
}

onMounted(() => {
  // Through the store's throttle, like every other tree trigger (a subscribed
  // stream's TREE_AFFECTING_TYPES event, a WS reconnect) — mounting the home
  // surface must not be a way to bypass the cadence, and on the desktop this
  // component mounts in the sidebar for the life of the document anyway.
  store.scheduleTreeRefresh();
});
</script>

<template>
  <!-- The panel-frame shape SessionListView uses (slice 6b): an h-full column
       that scrolls INTERNALLY, never the page. No back button — this is home,
       the bottom of every navigation stack. -->
  <div class="flex h-full flex-col overflow-hidden">
    <div class="flex flex-none items-center justify-between gap-2 border-b border-line px-3 py-2">
      <h1 class="font-mono text-[11px] font-semibold uppercase text-ink-dim">Tree</h1>
      <!-- U10: the escape hatch stays VISIBLE. The pre-tree session list is
           still where the meters strip, the spawn form and the panel nav live
           this slice (F1), so the cutover must not leave them reachable only by
           a hand-typed URL. A real `#/` link, so App.vue's panelLinkClick opens
           it as a panel from THIS panel's index like any other in-app link. -->
      <a
        href="#/sessions"
        class="font-mono text-[11px] uppercase text-ink-dim transition-colors hover:text-ink"
        title="The pre-tree session list — meters, spawn, panel nav"
      >
        Sessions ›
      </a>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <!-- A9: we have not successfully read the estate yet. One quiet line, no
           spinner — a spinner over nothing says "wait" where a sentence can say
           what is actually happening. -->
      <p v-if="!store.treeLoaded && !store.treeError" class="px-3 py-2 text-xs text-ink-dim">
        Reading the estate…
      </p>
      <p v-else-if="!store.treeLoaded" class="px-3 py-2 text-xs text-warn">
        Cannot read the estate — retrying.
      </p>

      <!-- A9 / doctrine §5: a FAILING refresh with data in hand renders the data
           plus a staleness line. `tree` is never cleared on failure, so what is
           below this notice is the last estate we actually saw, not a guess. -->
      <p v-else-if="store.treeError" class="px-3 py-1 text-xs text-warn">
        Refresh failing — showing the last known estate.
      </p>

      <ul>
        <template v-for="row in rows" :key="row.id">
          <!-- ── ROOT ───────────────────────────────────────────────────────
               A project's virtual root, or the singleton `unfiled` — which the
               payload already puts LAST and which reads quiet, because it is a
               statement about what nothing has claimed rather than a place. -->
          <li v-if="row.kind === 'root' && row.root !== null">
            <button
              type="button"
              class="flex min-h-[36px] w-full items-center gap-2 px-3 py-1 text-left active:bg-panel-sunken"
              :aria-expanded="row.expandable ? row.expanded : undefined"
              @click="row.expandable ? toggleExpansion(row.id) : undefined"
            >
              <span
                class="w-3 shrink-0 font-mono text-xs text-ink-dim"
                aria-hidden="true"
              >{{ row.expandable ? (row.expanded ? '▾' : '▸') : '' }}</span>
              <span
                class="min-w-0 flex-1 truncate font-mono text-sm"
                :class="row.id === UNFILED_ROOT_ID ? 'text-ink-dim' : 'text-ink'"
              >{{ row.root.name }}</span>
              <span
                v-if="row.id !== UNFILED_ROOT_ID"
                class="shrink-0 font-mono text-[10px] uppercase text-ink-dim"
              >project</span>
              <!-- The rollup, ALWAYS — expanded or collapsed (U5). A collapsed
                   branch hiding a `gate_fired` is the failure mode this design
                   exists to prevent, so loudness may not depend on expansion
                   state. Glyph + count, never colour alone (U7). -->
              <span class="flex shrink-0 items-baseline gap-1 font-mono text-xs tabular-nums">
                <span
                  :class="TONE_TEXT_CLASS[rollupWorstDisplay(row.root.rollup.worst).tone]"
                  :title="row.root.rollup.worst ?? 'no processes'"
                >{{ rollupWorstDisplay(row.root.rollup.worst).glyph }}</span>
                <span class="text-ink-dim" :title="`${row.root.rollup.processCount} processes`">{{
                  row.root.rollup.processCount
                }}</span>
              </span>
            </button>
          </li>

          <!-- ── NODE ───────────────────────────────────────────────────────
               A closed node is DIMMED, never hidden: closing a node says
               nothing about the sessions still running under it, and the rollup
               counts PROCESSES for exactly that reason. -->
          <li v-else-if="row.kind === 'node' && row.node !== null">
            <button
              type="button"
              class="flex min-h-[36px] w-full items-center gap-2 px-3 py-1 text-left active:bg-panel-sunken"
              :style="indentStyle(row.depth)"
              :aria-expanded="row.expandable ? row.expanded : undefined"
              @click="row.expandable ? toggleExpansion(row.id) : undefined"
            >
              <span
                class="w-3 shrink-0 font-mono text-xs text-ink-dim"
                aria-hidden="true"
              >{{ row.expandable ? (row.expanded ? '▾' : '▸') : '' }}</span>
              <span
                class="min-w-0 flex-1 truncate text-sm"
                :class="row.node.effectivelyClosed ? 'text-ink-dim' : 'text-ink'"
              >{{ row.node.name }}</span>
              <!-- The second channel for `closed` is a WORD, not a glyph: every
                   glyph in this view already means a severity, and a sixth one
                   here would read as a state the engine does not have. The title
                   keeps `closed` and `effectivelyClosed` distinct — a node
                   somebody shut, versus one sitting under one. -->
              <span
                v-if="row.node.effectivelyClosed"
                class="shrink-0 font-mono text-[10px] uppercase text-ink-dim"
                :title="row.node.closed ? 'closed' : 'under a closed node'"
              >closed</span>
              <span class="flex shrink-0 items-baseline gap-1 font-mono text-xs tabular-nums">
                <span
                  :class="TONE_TEXT_CLASS[rollupWorstDisplay(row.node.rollup.worst).tone]"
                  :title="row.node.rollup.worst ?? 'no processes'"
                >{{ rollupWorstDisplay(row.node.rollup.worst).glyph }}</span>
                <span class="text-ink-dim" :title="`${row.node.rollup.processCount} processes`">{{
                  row.node.rollup.processCount
                }}</span>
              </span>
            </button>
          </li>

          <!-- ── SESSION ────────────────────────────────────────────────────
               A leaf. Tapping it opens its stream — the existing route, through
               the existing emit, so the panel shell's truncate-then-push policy
               applies here exactly as it does from the old list. -->
          <li v-else-if="row.kind === 'session' && row.session !== null">
            <button
              type="button"
              class="flex min-h-[36px] w-full items-center gap-2 px-3 py-1 text-left active:bg-panel-sunken"
              :style="indentStyle(row.depth)"
              @click="emit('open', row.session.appSessionId)"
            >
              <!-- Severity: glyph AND tone, both from the one mapping, so a leaf
                   and its collapsed ancestor can never disagree. -->
              <span
                class="w-3 shrink-0 font-mono text-xs"
                :class="TONE_TEXT_CLASS[sessionRowTreatment(row.session).tone]"
                :title="row.session.severity"
              >{{ sessionRowTreatment(row.session).glyph }}</span>
              <!-- The seen channel, SEPARATE (U5). It is `ink`, not a semantic
                   tone and not the accent: "nobody has looked at this yet" is
                   not a severity and not an interaction. Its presence or absence
                   changes nothing above. -->
              <span
                v-if="!sessionRowTreatment(row.session).seen"
                class="shrink-0 font-mono text-xs text-ink"
                aria-label="unseen"
                title="unseen"
              >•</span>
              <span class="min-w-0 flex-1 truncate text-sm text-ink">{{
                sessionLabelOf(row.session)
              }}</span>
              <!-- F3, signed: the estate handle, on the row, dimmed. Straight
                   off the payload — `shortId` is rendered against the WHOLE
                   estate, so these four characters name the same session
                   everywhere, which an ad-hoc slice could never promise. -->
              <span class="shrink-0 font-mono text-[10px] text-ink-dim">{{ row.session.shortId }}</span>
            </button>
          </li>
        </template>
      </ul>
    </div>
  </div>
</template>
