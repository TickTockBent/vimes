<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import SessionListView from './views/SessionListView.vue';
import StreamView from './views/StreamView.vue';
import FileTreeView from './views/FileTreeView.vue';
import EditorView from './views/EditorView.vue';
import SearchPanel from './views/SearchPanel.vue';
import TerminalView from './views/TerminalView.vue';
import GitPanel from './views/GitPanel.vue';
import CostLedgerView from './views/CostLedgerView.vue';
import TaskBoardView from './views/TaskBoardView.vue';
import { useVimesStore } from './stores/vimesStore.js';
import { decideEditorReturn } from './lib/gitReview.js';
import { parentDir } from './lib/treeNode.js';
import { buildHash, type Route } from './lib/route.js';
import { parsePanelStack, type PanelStack } from './lib/panelStack.js';

const store = useVimesStore();
const hash = ref(window.location.hash);

function onHashChange(): void {
  hash.value = window.location.hash;
}

onMounted(() => {
  store.init();
  window.addEventListener('hashchange', onHashChange);
});
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
});

// ⚠ THE ROUTE MODEL LIVES IN lib/route.ts, INCLUDING ITS PRECEDENCE. This file
// owns the I/O — reading `window.location.hash`, listening for `hashchange`,
// writing the hash back — and nothing else about routing. What used to be a
// hand-rolled parse plus eight independent `show*` booleans plus a v-if chain
// whose ORDER was the only record of precedence is now one resolved route, and
// route.ts has the tests App.vue never could (route.test.ts).
//
// So: do not add a `routePath === '/x'` check here. A new route is a rule in
// route.ts's ROUTE_RULES, in its right precedence position, with a table row.
//
// PHASE 2 (D39): navigation state is now a STACK of panels, each a route. The
// hash is parsed to that stack (lib/panelStack.ts), and this file renders the
// TRAILING panel — the focused/visible one. With no multi-panel producer yet
// (no push path; every navigate* still writes a single-panel hash), the stack is
// ALWAYS length 1, so `activeRoute` is byte-identical to the old
// `parseRoute(hash)`: the last element of `[parseRoute(hash)]` is exactly
// `parseRoute(hash)`. Phase 3+4 renders more than the trailing panel; phase 2
// renders exactly today's single view.
const panelStack = computed<PanelStack>(() => parsePanelStack(hash.value));
const activeRoute = computed<Route>(() => panelStack.value[panelStack.value.length - 1]!);

// Narrowing projections of the ONE route — only one can ever be non-null,
// because `parseRoute` returns a single discriminated value. The template's
// chain is driven by these rather than by independent booleans, so the branches
// cannot disagree about which view is showing.
const editorRoute = computed(() => (activeRoute.value.view === 'editor' ? activeRoute.value : null));
const fileTreeRoute = computed(() =>
  activeRoute.value.view === 'fileTree' ? activeRoute.value : null,
);
const streamRoute = computed(() => (activeRoute.value.view === 'stream' ? activeRoute.value : null));
// `/#/meters` — the deep-link target of the deployed threshold-notification push
// (slice 5 step 4b). Same view as home, but the meters strip arrives EXPANDED,
// because a user who tapped a usage alert wants every meter with its countdown,
// age, freshness, burn rate and exhaustion projection — not a one-line summary
// they must then find and tap. This is why a Route names props and not just a
// view: two hashes, one component, different prop.
const metersExpanded = computed(
  () => activeRoute.value.view === 'sessionList' && activeRoute.value.expandMeters,
);

// Where EditorView's `back` lands. A WHITELIST (only 'git' is understood today —
// see decideEditorReturn, unit-tested): anything absent or unrecognized falls
// back to the file tree, which is exactly the pre-existing behavior. This is
// deliberately not a general redirect mechanism, and it deliberately does NOT
// live in route.ts — route.ts carries the raw `returnTo` param and has no opinion
// about it.
const editorReturnTarget = computed(() =>
  decideEditorReturn(editorRoute.value === null ? null : editorRoute.value.returnToParam),
);

function navigateToSession(appSessionId: string): void {
  window.location.hash = buildHash({ view: 'stream', appSessionId });
}
function navigateHome(): void {
  window.location.hash = buildHash({ view: 'sessionList', expandMeters: false });
}
// `#/files` opens the tree. An optional `dir` param says WHICH directory to open;
// without it the tree falls back to the first root (the pre-existing behavior).
function navigateToFiles(dir?: string | null): void {
  window.location.hash = buildHash({ view: 'fileTree', initialDir: dir ?? null });
}
function navigateToSearch(): void {
  window.location.hash = buildHash({ view: 'search' });
}
function navigateToTerminal(): void {
  window.location.hash = buildHash({ view: 'terminal' });
}
function navigateToGit(): void {
  window.location.hash = buildHash({ view: 'git' });
}
function navigateToCost(): void {
  window.location.hash = buildHash({ view: 'cost' });
}
function navigateToTasks(): void {
  window.location.hash = buildHash({ view: 'tasks' });
}
function navigateToEditor(path: string, line?: number, returnTo?: 'git'): void {
  window.location.hash = buildHash({
    view: 'editor',
    path,
    line,
    returnToParam: returnTo ?? null,
  });
}
// The editor's back button: the git panel only when the route said so (and the
// panel then restores + refreshes the diff), otherwise the file tree — reopened
// at the file's OWN directory, so leaving an editor returns you where you were
// instead of dropping you at the top-level root.
function leaveEditor(): void {
  if (editorReturnTarget.value === 'git') {
    navigateToGit();
    return;
  }
  const editedPath = editorRoute.value?.path ?? null;
  navigateToFiles(editedPath === null ? null : parentDir(editedPath));
}

const bannerText = computed(() => {
  if (store.connectionStatus === 'connecting') return 'Connecting…';
  if (store.connectionStatus === 'reconnecting') return 'Reconnecting…';
  if (store.catchingUp) return 'Catching up…';
  return null;
});
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <div v-if="bannerText" class="sticky top-0 z-30 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-white">
      {{ bannerText }}
    </div>
    <div
      v-if="store.lastRefusal"
      class="sticky top-0 z-30 flex items-center justify-between gap-3 bg-rose-600 px-4 py-2 text-sm text-white"
    >
      <span class="truncate">{{ store.lastRefusal.reason }}</span>
      <button
        type="button"
        class="min-h-[44px] min-w-[44px] shrink-0 rounded px-3 font-semibold active:bg-rose-700"
        @click="store.dismissRefusal()"
      >
        Dismiss
      </button>
    </div>

    <!-- ⚠ This chain no longer DECIDES anything: `parseRoute` already picked the
         view, and exactly one branch below can match. Precedence lives in
         route.ts's ROUTE_RULES, where route.test.ts pins it — reordering these
         elements can no longer change which view a hash renders. -->
    <EditorView
      v-if="editorRoute"
      :key="editorRoute.path"
      :path="editorRoute.path"
      :line="editorRoute.line"
      @back="leaveEditor"
    />
    <FileTreeView
      v-else-if="fileTreeRoute"
      :initial-dir="fileTreeRoute.initialDir"
      @open="(path) => navigateToEditor(path)"
      @search="navigateToSearch"
      @back="navigateHome"
    />
    <SearchPanel
      v-else-if="activeRoute.view === 'search'"
      @open="(payload) => navigateToEditor(payload.path, payload.line)"
      @back="navigateHome"
    />
    <TerminalView v-else-if="activeRoute.view === 'terminal'" @back="navigateHome" />
    <GitPanel
      v-else-if="activeRoute.view === 'git'"
      @open-editor="(path) => navigateToEditor(path, undefined, 'git')"
      @back="navigateHome"
    />
    <CostLedgerView v-else-if="activeRoute.view === 'cost'" @back="navigateHome" />
    <TaskBoardView v-else-if="activeRoute.view === 'tasks'" @back="navigateHome" />
    <StreamView v-else-if="streamRoute" :app-session-id="streamRoute.appSessionId" @back="navigateHome" />
    <SessionListView
      v-else
      :expand-meters="metersExpanded"
      @open="navigateToSession"
      @open-files="navigateToFiles"
      @open-search="navigateToSearch"
      @open-terminal="navigateToTerminal"
      @open-git="navigateToGit"
      @open-cost="navigateToCost"
      @open-tasks="navigateToTasks"
    />
  </div>
</template>
