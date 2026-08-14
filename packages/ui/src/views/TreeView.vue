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
// ─── S15·U3 — the WRITE surface, on the same rows ────────────────────────────
//
// Create a node, attach a session, close a node, spawn from a node — every one
// of them completing from a phone tap path (doctrine U3: mobile is for
// DECIDING). Each row grows ONE compact affordance (`⋯`, 36px) that opens an
// inline sheet under it; there is no hover-only anything, no second screen, and
// no drag.
//
// ⚠ **THE DAEMON OWNS EVERY REFUSAL.** The picker lists open nodes and the
// create affordance hides on `unfiled` because those are kindnesses, not
// adjudications: the request still goes to the engine, and a 409 renders
// verbatim through the closed 11-reason vocabulary
// (`nodeRefusalMessage` ← `nodeWriteFailureMessage`), inline, dismissed BY HAND
// (U5 — nothing here auto-clears).
//
// ⚠ **NO OPTIMISTIC TREE EDIT (U8).** A 2xx schedules the store's throttled
// refetch and this component changes nothing about `store.tree`. The only
// optimism is disabling the affordance that was tapped while its round trip is
// in flight (the gate-card precedent).
// ─── S15·U7 — the SCOPE gate (D90, closing S15-F8) ───────────────────────────
//
// One project per tab. This view renders the tab's own project in full and
// every other root — siblings and `unfiled` — as a single row that carries its
// rollup and nothing else: no sessions, no chevron, no `⋯`. A sibling row that
// is URL-addressable is a REAL `<a href="/<segment>/">`, so tapping it is a
// full navigation to that project's own tab, exactly as ProjectPickerView's
// rows are (and NOT a panel push — `panelLinkClick` only ever intercepts `#/`
// hrefs, so this needs no opt-out).
//
// ⚠ **THE SCOPE IS READ, NEVER RE-DERIVED.** App.vue resolves
// `location.pathname` → `store.currentProject` once per document
// (`parseProjectPath`/`resolveProject`, D61); this file asks the store. And the
// FETCH IS UNCHANGED: `GET /api/tree` stays parameterless and the whole forest
// still arrives — that is what lets a sibling's gate read loud from here.
import { computed, onMounted, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import {
  sessionTreeContainerIds,
  sessionTreeForeignRootHref,
  sessionTreeRows,
  sessionTreeScopedRootId,
} from '../lib/sessionTreeRows.js';
import {
  rollupWorstDisplay,
  sessionRowTreatment,
  type SeverityTone,
} from '../lib/sessionSeverityDisplay.js';
import { resolveSessionLabel } from '../lib/sessionLabel.js';
import {
  attachTargetsOf,
  canCreateNodeUnder,
  createNodeRequestFor,
  nodeWriteFailureMessage,
  sessionTreeActionTargets,
  spawnPrefillFor,
  type NodeActionTarget,
} from '../lib/sessionTreeActions.js';
// ⚠ `lib/killConfirm.ts` gets a SECOND CONSUMER here, deliberately. The S15
// deletion inventory marked it "dies with SessionListView"; it does not — closing
// a node is IRREVERSIBLE (E2 has no reopen event), which is exactly the class of
// act that idiom exists for, and reusing the tested reducer beats either a
// browser `confirm()` (which the house has ruled out) or a second confirm state
// machine invented here. It outlives SessionListView.
import {
  initialKillConfirmState,
  isConfirmingKill,
  reduceKillConfirm,
  type KillConfirmState,
} from '../lib/killConfirm.js';

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

// The root id this tab is scoped to (`project:<projectId>`), or null for an
// unscoped tab — a bare host, an unresolved segment, or a `/#/session/x` deep
// link, all of which keep the pre-U7 full tree (D90 left the landing surface
// unpriced, and this view must not invent a policy for it).
const scopedRootId = computed(() => sessionTreeScopedRootId(store.currentProject));

// Has the registry read SETTLED? `currentProject` is null both before the
// registry lands and when there genuinely is no scope, and those two must not
// be confused: seeding the expansion default from the "not yet" null would open
// every sibling estate. A FAILED read counts as settled (App.vue's own rule for
// the same fork) — an unreadable registry means no scope is knowable, and the
// honest fallback is the unscoped tree, not a permanently collapsed one.
const scopeSettled = computed(() => store.projectsLoaded || store.projectsUnreachable);

// ── expansion state (ephemeral, per tab) ────────────────────────────────────
//
// IN-MANDATE, RECORDED: default FULLY EXPANDED, and nothing is persisted this
// slice. A tree that opens collapsed hides exactly what the operator came to
// see; a tree that remembers a collapse across reloads can hide a gate that
// fired while the tab was closed. Both are decisions worth revisiting with real
// data, and neither is worth a storage key before then.
//
// S15·U7 narrows the DEFAULT, not the rule: under a scope it is the scoped
// root's whole subtree that opens (`sessionTreeContainerIds(payload, scope)`
// never names a foreign container), and a foreign row cannot be opened by hand
// either, because `sessionTreeRows` refuses to expand one.
const expandedIds = ref<ReadonlySet<string>>(new Set<string>());
// Whether the expansion default has been applied. It runs ONCE, on the first
// payload that arrives with the scope settled — a later refresh must not
// re-expand branches the operator collapsed, and TREE_AFFECTING_TYPES makes
// refreshes frequent enough that re-applying it would fight the operator's
// hands mid-scroll.
let expansionInitialized = false;

watch(
  [() => store.tree, scopeSettled],
  ([payload, settled]) => {
    if (payload === null || !settled || expansionInitialized) {
      return;
    }
    expansionInitialized = true;
    expandedIds.value = new Set(sessionTreeContainerIds(payload, scopedRootId.value));
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
  store.tree === null ? [] : sessionTreeRows(store.tree, expandedIds.value, scopedRootId.value),
);

// A foreign root's link to its own tab, or null when it is not URL-addressable
// (`unfiled`, an archived record, a project that IS a configured root or sits
// under none). The registry the store already holds is the only source; a
// missing segment renders as no navigation rather than a guessed URL.
function foreignHref(rootId: string): string | null {
  return sessionTreeForeignRootHref(rootId, store.projects);
}

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

// ── the write surface (S15·U3) ──────────────────────────────────────────────
//
// ONE sheet open at a time, keyed by the row id `sessionTreeRows` already
// assigns. A second open sheet on a 50-row phone list would push the row that
// matters off screen (U2), and there is no flow here that needs two.
type SheetMode = 'menu' | 'create' | 'spawn' | 'attach';

const openSheetRowId = ref<string | null>(null);
const sheetMode = ref<SheetMode>('menu');
const nodeNameDraft = ref('');
const spawnCwdDraft = ref('');
const spawnChannel = ref<'sdk' | 'pty'>('sdk');
// The optimistic half, and the ONLY one: the affordance that fired is disabled
// until its round trip resolves. Nothing about the tree itself moves until the
// refetch lands.
const writePending = ref(false);
// The refusal, rendered inline beside the affordance that earned it and cleared
// only by a hand (doctrine §5: no auto-clearing anything).
const writeError = ref<string | null>(null);
// Closing is IRREVERSIBLE (no reopen event exists), so it takes the tap-again
// confirm — see the import comment.
const closeConfirm = ref<KillConfirmState>(initialKillConfirmState);

// Every container row's write context, resolved from the payload's own nesting
// (lib/sessionTreeActions.ts). Recomputed with the tree, so a node that closed
// server-side stops offering to host children on the next refresh.
const actionTargets = computed(() =>
  store.tree === null ? new Map<string, NodeActionTarget>() : sessionTreeActionTargets(store.tree),
);

// The attach picker's contents: effectively-open nodes, grouped by root, served
// order. A client-side courtesy filter — the daemon still adjudicates, and a
// node that closes underneath the picker answers 409 `node-closed`, which the
// operator then reads in plain words.
const attachGroups = computed(() => (store.tree === null ? [] : attachTargetsOf(store.tree)));

function targetFor(rowId: string): NodeActionTarget | null {
  return actionTargets.value.get(rowId) ?? null;
}

// The open sheet's target, or null — which is ALSO how a session row's sheet is
// told apart from a container's: sessions have no action target (their write is
// attach, and it targets a node from the picker, not the row it started on).
const openTarget = computed<NodeActionTarget | null>(() =>
  openSheetRowId.value === null ? null : targetFor(openSheetRowId.value),
);

function closeSheet(): void {
  openSheetRowId.value = null;
  sheetMode.value = 'menu';
  nodeNameDraft.value = '';
  writeError.value = null;
  closeConfirm.value = initialKillConfirmState;
}

// Session rows open straight into the picker: attach is the only write a leaf
// has, and a menu of one is chrome (U1).
function toggleSheet(rowId: string, kind: 'root' | 'node' | 'session'): void {
  if (openSheetRowId.value === rowId) {
    closeSheet();
    return;
  }
  closeSheet();
  openSheetRowId.value = rowId;
  sheetMode.value = kind === 'session' ? 'attach' : 'menu';
}

function startCreate(): void {
  sheetMode.value = 'create';
  nodeNameDraft.value = '';
  writeError.value = null;
}

// The A8 prefill, applied each time the spawn form is opened: node directory →
// project root directory → nothing. A null prefill leaves the box empty on
// purpose — `unfiled` is not a place on disk, and an invented default would be
// a lie the spawn allow-list then refuses in confusing words.
function startSpawn(target: NodeActionTarget): void {
  sheetMode.value = 'spawn';
  spawnCwdDraft.value = spawnPrefillFor(target) ?? '';
  writeError.value = null;
}

// Every write lands here: the daemon's own answer becomes either "done" (sheet
// closes, the refetch the store scheduled repaints the tree) or a sentence.
function applyWriteAnswer(answer: { status: number; body: unknown }): void {
  const message = nodeWriteFailureMessage(answer.status, answer.body);
  if (message === null) {
    closeSheet();
    return;
  }
  writeError.value = message;
}

async function submitCreate(target: NodeActionTarget): Promise<void> {
  const request = createNodeRequestFor(target, nodeNameDraft.value);
  if (request === null) {
    // Unreachable through the UI (the affordance is not drawn where this is
    // null), and stated rather than assumed: a root that names no project can
    // never host a node.
    writeError.value = 'This root is not a project — nodes live under projects.';
    return;
  }
  writePending.value = true;
  try {
    applyWriteAnswer(await store.createNode(request));
  } finally {
    writePending.value = false;
  }
}

// Tap once to arm, tap again to close. The confirm state is reset by any sheet
// change, so an armed close cannot survive being scrolled away from.
async function tapClose(target: NodeActionTarget): Promise<void> {
  if (target.nodeId === null) {
    return; // roots are virtual; there is no event that could close one
  }
  const result = reduceKillConfirm(closeConfirm.value, { type: 'tap', appSessionId: target.nodeId });
  closeConfirm.value = result.state;
  if (!result.fire) {
    return;
  }
  writePending.value = true;
  try {
    applyWriteAnswer(await store.closeNode(target.nodeId));
  } finally {
    writePending.value = false;
  }
}

function closeLabel(target: NodeActionTarget): string {
  return target.nodeId !== null && isConfirmingKill(closeConfirm.value, target.nodeId)
    ? 'Tap again — closing cannot be undone'
    : 'Close node';
}

async function submitAttach(nodeId: string, appSessionId: string): Promise<void> {
  writePending.value = true;
  try {
    applyWriteAnswer(await store.attachSessionToNode(nodeId, appSessionId));
  } finally {
    writePending.value = false;
  }
}

// The MINIMAL spawn sheet (in-mandate decision, recorded in the work order):
// this calls the SAME `store.spawnSession` SessionListView's form calls rather
// than extracting that form — the form dies with SessionListView next slice, and
// extracting a component for one slice of shared life is churn.
//
// A refusal (cwd outside the allow-list, say) surfaces on App.vue's sticky
// refusal banner exactly as it does from the old list — the spawn wire has no
// per-caller refusal channel, and inventing a second refusal surface here would
// mean two places to look. The pending flag clears either way.
function submitSpawn(): void {
  const trimmedCwd = spawnCwdDraft.value.trim();
  if (trimmedCwd.length === 0 || writePending.value) {
    return;
  }
  writePending.value = true;
  store.spawnSession(spawnChannel.value, trimmedCwd, {
    onSpawned: (appSessionId) => {
      writePending.value = false;
      closeSheet();
      emit('open', appSessionId);
    },
    onRefused: () => {
      writePending.value = false;
    },
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
          <!-- ── FOREIGN ROOT (S15·U7 / D90) ────────────────────────────────
               A sibling project, or `unfiled`, in a tab that belongs to some
               OTHER project. ONE row: no sessions under it, no chevron, and no
               `⋯` — there is nothing here to write to, because writing happens
               in the project's own tab.

               ⚠ THE ROLLUP STAYS HONEST (U5). The glyph and count come off the
               same payload and the same mapping the scoped root uses, so a
               `gate_fired` under johnny reads exactly as loud on johnny's row
               as it would inside johnny's tree. Flattening hides SESSIONS, not
               severity — that is the whole cross-project attention channel D90
               left in place.

               The name is `ink-dim` because this row is context, not this
               tab's estate; the severity glyph keeps its own tone, so the
               dimming can never mute a gate (the two channels stay apart). -->
          <li
            v-if="row.kind === 'root' && row.foreign && row.root !== null"
            class="flex items-stretch"
          >
            <!-- A REAL `<a>` when the project is URL-addressable: tapping it is
                 a full navigation to that project's own tab (D42's one project
                 per tab), never a panel push — `panelLinkClick` intercepts only
                 `#/` hrefs, so this falls through to the browser by itself.
                 When there is no segment to link to (`unfiled`, an archived or
                 unaddressable record) the row renders as a plain `div`: inert,
                 still legible, still loud if its rollup says so. -->
            <component
              :is="foreignHref(row.id) === null ? 'div' : 'a'"
              :href="foreignHref(row.id) ?? undefined"
              class="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left"
              :class="foreignHref(row.id) === null ? '' : 'active:bg-panel-sunken'"
              :title="
                foreignHref(row.id) === null
                  ? undefined
                  : `Open ${row.root.name} in its own tab`
              "
            >
              <!-- Alignment only, deliberately EMPTY: a foreign row has no
                   chevron because it has nothing to expand. -->
              <span class="w-3 shrink-0" aria-hidden="true"></span>
              <span class="min-w-0 flex-1 truncate font-mono text-sm text-ink-dim">{{
                row.root.name
              }}</span>
              <!-- The second channel for "this one goes somewhere" (U7): a
                   word, not colour alone. Absent on rows that cannot navigate,
                   so the affordance never lies about what a tap will do. -->
              <span
                v-if="foreignHref(row.id) !== null"
                class="shrink-0 font-mono text-[10px] uppercase text-ink-dim"
              >open ›</span>
              <span class="flex shrink-0 items-baseline gap-1 font-mono text-xs tabular-nums">
                <span
                  :class="TONE_TEXT_CLASS[rollupWorstDisplay(row.root.rollup.worst).tone]"
                  :title="row.root.rollup.worst ?? 'no processes'"
                >{{ rollupWorstDisplay(row.root.rollup.worst).glyph }}</span>
                <span class="text-ink-dim" :title="`${row.root.rollup.processCount} processes`">{{
                  row.root.rollup.processCount
                }}</span>
              </span>
            </component>
          </li>

          <!-- ── ROOT ───────────────────────────────────────────────────────
               A project's virtual root, or the singleton `unfiled` — which the
               payload already puts LAST and which reads quiet, because it is a
               statement about what nothing has claimed rather than a place.
               In a scoped tab this is the tab's OWN project and nothing else
               (D90); in an unscoped one it is every root, as before. -->
          <li v-else-if="row.kind === 'root' && row.root !== null" class="flex items-stretch">
            <button
              type="button"
              class="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left active:bg-panel-sunken"
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
            <!-- S15·U3 — the write affordance. One compact, always-visible,
                 36px-tall target per row (never hover-only: the phone has no
                 hover, and U3 says the phone must be able to DECIDE). It opens
                 the sheet below; it never writes anything itself. -->
            <button
              type="button"
              class="min-h-[36px] w-9 shrink-0 font-mono text-xs text-ink-dim active:bg-panel-sunken"
              :aria-expanded="openSheetRowId === row.id"
              :aria-label="`Actions for ${row.root.name}`"
              title="Actions"
              @click="toggleSheet(row.id, 'root')"
            >⋯</button>
          </li>

          <!-- ── NODE ───────────────────────────────────────────────────────
               A closed node is DIMMED, never hidden: closing a node says
               nothing about the sessions still running under it, and the rollup
               counts PROCESSES for exactly that reason. -->
          <li v-else-if="row.kind === 'node' && row.node !== null" class="flex items-stretch">
            <button
              type="button"
              class="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left active:bg-panel-sunken"
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
            <button
              type="button"
              class="min-h-[36px] w-9 shrink-0 font-mono text-xs text-ink-dim active:bg-panel-sunken"
              :aria-expanded="openSheetRowId === row.id"
              :aria-label="`Actions for ${row.node.name}`"
              title="Actions"
              @click="toggleSheet(row.id, 'node')"
            >⋯</button>
          </li>

          <!-- ── SESSION ────────────────────────────────────────────────────
               A leaf. Tapping it opens its stream — the existing route, through
               the existing emit, so the panel shell's truncate-then-push policy
               applies here exactly as it does from the old list. -->
          <li v-else-if="row.kind === 'session' && row.session !== null" class="flex items-stretch">
            <button
              type="button"
              class="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left active:bg-panel-sunken"
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
            <!-- A leaf's one write is ATTACH, so its sheet opens straight into
                 the picker (a menu of one is chrome, U1). -->
            <button
              type="button"
              class="min-h-[36px] w-9 shrink-0 font-mono text-xs text-ink-dim active:bg-panel-sunken"
              :aria-expanded="openSheetRowId === row.id"
              :aria-label="`Attach ${row.session.shortId} to a node`"
              title="Attach to a node"
              @click="toggleSheet(row.id, 'session')"
            >⋯</button>
          </li>

          <!-- ── THE ACTION SHEET (S15·U3) ──────────────────────────────────
               Inline, directly under the row it belongs to, one at a time. It
               is a list item rather than a floating layer because a phone frame
               has no room for an overlay that hides the estate behind it, and
               because the flow it serves is "decide from this row" (U3). -->
          <li
            v-if="openSheetRowId === row.id"
            class="border-y border-line bg-panel-sunken px-3 py-2"
          >
            <!-- Container rows (project roots and nodes): create / spawn /
                 close, plus their inline forms. -->
            <div v-if="openTarget !== null" class="flex flex-col gap-2">
              <div class="flex flex-wrap items-stretch gap-2">
                <!-- ⚠ NOT DRAWN ON `unfiled` (and not on a closed node): the
                     derivation refuses it because no projectId exists to name —
                     see canCreateNodeUnder/createNodeRequestFor. -->
                <button
                  v-if="canCreateNodeUnder(openTarget)"
                  type="button"
                  class="min-h-[36px] rounded-md border border-line px-3 text-xs text-accent active:bg-panel"
                  :class="sheetMode === 'create' ? 'border-accent' : ''"
                  @click="startCreate()"
                >
                  New node
                </button>
                <!-- Spawn is offered everywhere a row can name a place to start
                     from — including `unfiled`, which simply arrives with an
                     empty cwd rather than an invented one (A8). -->
                <button
                  type="button"
                  class="min-h-[36px] rounded-md border border-line px-3 text-xs text-accent active:bg-panel"
                  :class="sheetMode === 'spawn' ? 'border-accent' : ''"
                  @click="startSpawn(openTarget)"
                >
                  Spawn session
                </button>
                <!-- Close: node rows only (a virtual root has no closure), and
                     only while open. Tap-again confirm, because there is NO
                     REOPEN EVENT in the engine — this is one-way. -->
                <button
                  v-if="openTarget.kind === 'node' && !openTarget.effectivelyClosed"
                  type="button"
                  class="min-h-[36px] rounded-md px-3 text-xs disabled:opacity-50"
                  :class="
                    openTarget.nodeId !== null && isConfirmingKill(closeConfirm, openTarget.nodeId)
                      ? 'bg-accent font-semibold text-accent-fg'
                      : 'border border-line text-ink-dim active:bg-panel'
                  "
                  :disabled="writePending"
                  @click="tapClose(openTarget)"
                >
                  {{ closeLabel(openTarget) }}
                </button>
              </div>

              <!-- Create: ONE field. `directory` is deferred (WO), and the
                   engine calls a label-only group an ordinary shape. -->
              <form
                v-if="sheetMode === 'create'"
                class="flex flex-col gap-2"
                @submit.prevent="submitCreate(openTarget)"
              >
                <label
                  class="font-mono text-[10px] uppercase text-ink-dim"
                  :for="`node-name-${row.id}`"
                >New node under {{ openTarget.label }}</label>
                <input
                  :id="`node-name-${row.id}`"
                  v-model="nodeNameDraft"
                  type="text"
                  placeholder="slice 15"
                  class="min-h-[36px] rounded-md border border-line bg-panel px-2 text-sm"
                />
                <button
                  type="submit"
                  class="min-h-[36px] rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg active:bg-accent/90 disabled:opacity-50"
                  :disabled="writePending || nodeNameDraft.trim().length === 0"
                >
                  {{ writePending ? 'Creating…' : 'Create node' }}
                </button>
              </form>

              <!-- Spawn: the MINIMAL sheet (see submitSpawn's comment) — the
                   same store action the old list's form calls, with the A8
                   prefill already in the box. -->
              <form
                v-else-if="sheetMode === 'spawn'"
                class="flex flex-col gap-2"
                @submit.prevent="submitSpawn()"
              >
                <label
                  class="font-mono text-[10px] uppercase text-ink-dim"
                  :for="`spawn-cwd-${row.id}`"
                >Spawn · cwd</label>
                <input
                  :id="`spawn-cwd-${row.id}`"
                  v-model="spawnCwdDraft"
                  type="text"
                  placeholder="/home/wes/projects/…"
                  class="min-h-[36px] rounded-md border border-line bg-panel px-2 text-sm"
                />
                <div class="flex items-center gap-4 text-xs">
                  <label class="flex items-center gap-1">
                    <input v-model="spawnChannel" type="radio" value="sdk" />
                    SDK
                  </label>
                  <label class="flex items-center gap-1">
                    <input v-model="spawnChannel" type="radio" value="pty" />
                    PTY
                  </label>
                </div>
                <button
                  type="submit"
                  class="min-h-[36px] rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg active:bg-accent/90 disabled:opacity-50"
                  :disabled="writePending || spawnCwdDraft.trim().length === 0"
                >
                  {{ writePending ? 'Spawning…' : 'Spawn session' }}
                </button>
              </form>
            </div>

            <!-- Session rows: the attach picker. Open nodes only, grouped by
                 root, SERVED order (attachTargetsOf) — a courtesy filter, never
                 an adjudication. -->
            <div
              v-else-if="row.kind === 'session' && row.session !== null"
              class="flex flex-col gap-2"
            >
              <p class="font-mono text-[10px] uppercase text-ink-dim">
                Attach {{ row.session.shortId }} to a node
              </p>
              <!-- A9-shaped honesty: an estate with no open node says so in a
                   sentence that names the next action, rather than rendering an
                   empty list. -->
              <p v-if="attachGroups.length === 0" class="text-xs text-ink-dim">
                No open nodes yet — create one from a project row first.
              </p>
              <div v-for="group in attachGroups" :key="group.rootId" class="flex flex-col">
                <p class="font-mono text-[10px] uppercase text-ink-dim">{{ group.rootName }}</p>
                <button
                  v-for="attachNode in group.nodes"
                  :key="attachNode.nodeId"
                  type="button"
                  class="min-h-[36px] truncate rounded-md px-2 text-left text-sm text-ink active:bg-panel disabled:opacity-50"
                  :style="indentStyle(attachNode.depth)"
                  :disabled="writePending"
                  @click="submitAttach(attachNode.nodeId, row.session.appSessionId)"
                >
                  {{ attachNode.name }}
                </button>
              </div>
            </div>

            <!-- The refusal, inline, in the engine's own vocabulary, cleared
                 only by a hand (U5 / doctrine §5 — never a toast, never a
                 timer). It sits under the affordance that earned it. -->
            <div v-if="writeError !== null" class="mt-2 flex items-start gap-2">
              <span class="shrink-0 font-mono text-[10px] uppercase text-warn">refused</span>
              <p class="min-w-0 flex-1 text-xs text-warn">{{ writeError }}</p>
              <button
                type="button"
                class="min-h-[36px] shrink-0 font-mono text-[10px] uppercase text-ink-dim active:text-ink"
                @click="writeError = null"
              >
                Dismiss
              </button>
            </div>
          </li>
        </template>
      </ul>
    </div>
  </div>
</template>
