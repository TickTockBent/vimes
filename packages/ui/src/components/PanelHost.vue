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
import SessionListView from '../views/SessionListView.vue';
import StreamView from '../views/StreamView.vue';
import FileTreeView from '../views/FileTreeView.vue';
import EditorView from '../views/EditorView.vue';
import SearchPanel from '../views/SearchPanel.vue';
import TerminalView from '../views/TerminalView.vue';
import GitPanel from '../views/GitPanel.vue';
import CostLedgerView from '../views/CostLedgerView.vue';
import TaskBoardView from '../views/TaskBoardView.vue';
import type { Route } from '../lib/route.js';

const props = defineProps<{ route: Route; index: number; focused: boolean }>();

// Every navigation intent a view can raise, each carrying THIS panel's index so
// the shell knows which panel to open from. Optional trailing args mirror the
// existing view emits (editor path/line/returnTo, files dir).
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
const sessionListRoute = computed(() =>
  props.route.view === 'sessionList' ? props.route : null,
);
</script>

<template>
  <!-- The focus ring (D39 #4): a visible, INSET border on the focused panel.
       ring-inset draws inside the box so adding/removing it never shifts the
       column's geometry. App.vue only passes focused=true when more than one
       panel is visible, so at N=1 (the phone) no ring renders — the single
       panel is byte-visually identical to today. -->
  <div class="h-full" :class="focused ? 'ring-2 ring-inset ring-blue-500' : ''">
    <EditorView
      v-if="editorRoute"
      :key="editorRoute.path"
      :path="editorRoute.path"
      :line="editorRoute.line"
      @back="emit('back', index)"
    />
    <FileTreeView
      v-else-if="fileTreeRoute"
      :initial-dir="fileTreeRoute.initialDir"
      @open="(path) => emit('openEditor', index, path)"
      @search="emit('openSearch', index)"
      @back="emit('back', index)"
    />
    <SearchPanel
      v-else-if="route.view === 'search'"
      @open="(payload) => emit('openEditor', index, payload.path, payload.line)"
      @back="emit('back', index)"
    />
    <TerminalView v-else-if="route.view === 'terminal'" @back="emit('back', index)" />
    <GitPanel
      v-else-if="route.view === 'git'"
      @open-editor="(path) => emit('openEditor', index, path, undefined, 'git')"
      @back="emit('back', index)"
    />
    <CostLedgerView v-else-if="route.view === 'cost'" @back="emit('back', index)" />
    <TaskBoardView v-else-if="route.view === 'tasks'" @back="emit('back', index)" />
    <StreamView
      v-else-if="streamRoute"
      :app-session-id="streamRoute.appSessionId"
      @back="emit('back', index)"
    />
    <SessionListView
      v-else-if="sessionListRoute"
      :expand-meters="sessionListRoute.expandMeters"
      @open="(appSessionId) => emit('open', index, appSessionId)"
      @open-files="emit('openFiles', index)"
      @open-search="emit('openSearch', index)"
      @open-terminal="emit('openTerminal', index)"
      @open-git="emit('openGit', index)"
      @open-cost="emit('openCost', index)"
      @open-tasks="emit('openTasks', index)"
    />
  </div>
</template>
