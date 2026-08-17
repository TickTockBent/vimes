<script setup lang="ts">
// One panel of the desktop stack (desktop phase 3+4, §C). Takes a SINGLE route
// (+ its true stack index + whether it is the focused panel) and renders the
// matching view — this is App.vue's old v-if/v-else-if chain, lifted to operate
// on one route so the shell can render N of them side by side.
//
// WHY THE INDEX RIDES EVERY EMIT. The shell's navigation policy is "opening a
// view FROM panel i truncates the stack to [0..i], then pushes" (openPanelFrom).
// So a view's navigation intent is meaningless without knowing WHICH panel it
// came from — this component re-emits every intent tagged with its own `index`,
// and App.vue turns (index, intent) into a stack write. The views themselves are
// unchanged; PanelHost is the adapter between their existing events and the
// index-aware shell.
//
// LAZY-CHUNK NOTE. EditorView/TerminalView are STATIC imports here, and that is
// safe: each only TYPE-imports its heavy setup module (codemirror-setup /
// xterm-setup) and reaches CM6/xterm through a dynamic import() inside itself.
// So a static component import creates no static edge into those lazy chunks —
// the build-manifest gate stays green (verified).
import { computed } from 'vue';
import TreeView from '../views/TreeView.vue';
import StreamView from '../views/StreamView.vue';
import FileTreeView from '../views/FileTreeView.vue';
import EditorView from '../views/EditorView.vue';
import SearchPanel from '../views/SearchPanel.vue';
import TerminalView from '../views/TerminalView.vue';
import GitPanel from '../views/GitPanel.vue';
import CostLedgerView from '../views/CostLedgerView.vue';
import TaskBoardView from '../views/TaskBoardView.vue';
import type { Route } from '../lib/route.js';

// backKind (D41): required, always passed by App.vue — every PanelHost instance
// in both layout arms threads it through. 'close' on a desktop content panel,
// 'back' everywhere else (phone/tablet). Forwarded verbatim to each view that
// owns a back button; the home view (TreeView) has none, so it does not
// receive it.
const props = defineProps<{ route: Route; index: number; focused: boolean; backKind: 'back' | 'close' }>();

// Every navigation intent a view can raise, each carrying THIS panel's index so
// the shell knows which panel to open from. Optional trailing args mirror the
// existing view emits (editor path/line/returnTo, files dir).
//
// ⚠ **THE PANEL-NAV INTENTS OUTLIVE THEIR OLD PRODUCER, DELIBERATELY (S16·U5).**
// `openFiles` / `openTerminal` / `openGit` / `openCost` / `openTasks` were
// raised by the deleted SessionListView's nav strip and by nothing else inside
// a panel today; U4 moved those affordances to App.vue's persistent top bar,
// which calls the handlers DIRECTLY rather than through a panel emit. They stay
// declared here because App.vue binds all five on every PanelHost instance —
// this list is the component's contract with the shell, not a census of who
// currently fires it — and because the next view that needs to say "open the
// git panel from HERE" needs the index-tagged wire, not a new one. `openSearch`
// is the proof that the wire is live: FileTreeView's `@search` still rides it.
const emit = defineEmits<{
  open: [index: number, appSessionId: string];
  openFiles: [index: number, dir?: string | null];
  openSearch: [index: number];
  openTerminal: [index: number];
  openGit: [index: number];
  openCost: [index: number];
  openTasks: [index: number];
  openEditor: [index: number, path: string, line?: number, returnTo?: 'git'];
  back: [index: number];
}>();

// Narrowing projections of the ONE route — same pattern App.vue used, so
// vue-tsc can see the discriminated fields when binding props. Exactly one is
// non-null for any route.
const editorRoute = computed(() => (props.route.view === 'editor' ? props.route : null));
const fileTreeRoute = computed(() => (props.route.view === 'fileTree' ? props.route : null));
const streamRoute = computed(() => (props.route.view === 'stream' ? props.route : null));
</script>

<template>
  <!-- The focus ring (D39 #4): a visible, INSET border on the focused panel.
       ring-inset draws inside the box so adding/removing it never shifts the
       column's geometry. App.vue only passes focused=true when more than one
       panel is visible, so at N=1 (the phone) no ring renders — the single
       panel is byte-visually identical to today. -->
  <div class="h-full" :class="focused ? 'ring-2 ring-inset ring-accent' : ''">
    <EditorView
      v-if="editorRoute"
      :key="editorRoute.path"
      :path="editorRoute.path"
      :line="editorRoute.line"
      :back-kind="backKind"
      @back="emit('back', index)"
    />
    <FileTreeView
      v-else-if="fileTreeRoute"
      :initial-dir="fileTreeRoute.initialDir"
      :back-kind="backKind"
      @open="(path) => emit('openEditor', index, path)"
      @search="emit('openSearch', index)"
      @back="emit('back', index)"
    />
    <SearchPanel
      v-else-if="route.view === 'search'"
      :back-kind="backKind"
      @open="(payload) => emit('openEditor', index, payload.path, payload.line)"
      @back="emit('back', index)"
    />
    <TerminalView v-else-if="route.view === 'terminal'" :back-kind="backKind" @back="emit('back', index)" />
    <GitPanel
      v-else-if="route.view === 'git'"
      :back-kind="backKind"
      @open-editor="(path) => emit('openEditor', index, path, undefined, 'git')"
      @back="emit('back', index)"
    />
    <CostLedgerView v-else-if="route.view === 'cost'" :back-kind="backKind" @back="emit('back', index)" />
    <TaskBoardView v-else-if="route.view === 'tasks'" :back-kind="backKind" @back="emit('back', index)" />
    <!-- S15-F5: the `:key` is LOAD-BEARING, not hygiene. `openPanelFrom`
         replaces a slot's route in one update, so without it Vue reuses the
         mounted StreamView with a swapped appSessionId, `onMounted` (the only
         site of store.subscribe + markSeen) never re-runs, and B's stream is
         never subscribed — a permanently blank panel. Keying forces a remount,
         which also resets exactly the per-session state that SHOULD reset on a
         session switch: scroll follow, seen-on-view, the composer draft. Same
         idiom as EditorView's :key="editorRoute.path" above. -->
    <StreamView
      v-else-if="streamRoute"
      :key="streamRoute.appSessionId"
      :app-session-id="streamRoute.appSessionId"
      :back-kind="backKind"
      @back="emit('back', index)"
    />
    <!-- S15·U2 — the home cutover (F1) — COMPLETED IN S16·U5. TreeView took the
         slot SessionListView held: the phone's home frame AND the desktop
         sidebar's stack[0], the SAME component in both layouts, because the
         swap is a route→component mapping change and nothing more. The old
         list's branch (reached at `#/sessions` for exactly one slice) is now
         gone, along with the view, the route and the hash — so `tree` is the
         LAST branch here, and it is also the branch every unrecognized hash
         lands on, because `parseRoute`'s total fallback is the tree. The tree
         raises only `open`; the nav intents it does not raise are explained at
         the emit declaration above. -->
    <TreeView
      v-else-if="route.view === 'tree'"
      @open="(appSessionId) => emit('open', index, appSessionId)"
    />
  </div>
</template>
