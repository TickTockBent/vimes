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
import { useVimesStore } from './stores/vimesStore.js';
import { decideEditorReturn } from './lib/gitReview.js';
import { parentDir } from './lib/treeNode.js';

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

// Parse the hash into a path + query params. Format: `#/files?path=/a/b&line=3`.
interface ParsedRoute {
  routePath: string;
  params: URLSearchParams;
}
const route = computed<ParsedRoute>(() => {
  const raw = hash.value.startsWith('#') ? hash.value.slice(1) : hash.value;
  const questionIndex = raw.indexOf('?');
  const routePath = questionIndex >= 0 ? raw.slice(0, questionIndex) : raw;
  const params = new URLSearchParams(questionIndex >= 0 ? raw.slice(questionIndex + 1) : '');
  return { routePath, params };
});

const activeSessionId = computed<string | null>(() => {
  const match = /^\/session\/(.+)$/.exec(route.value.routePath);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
});

// `#/files` with a `path` param is the editor; without it, the tree.
const editorTarget = computed<{ path: string; line?: number } | null>(() => {
  if (route.value.routePath !== '/files') {
    return null;
  }
  const path = route.value.params.get('path');
  if (path === null) {
    return null;
  }
  const lineRaw = route.value.params.get('line');
  const line = lineRaw !== null ? Number(lineRaw) : undefined;
  return { path, line: line !== undefined && Number.isFinite(line) ? line : undefined };
});

// Where EditorView's `back` lands. A WHITELIST (only 'git' is understood today —
// see decideEditorReturn, unit-tested): anything absent or unrecognized falls
// back to the file tree, which is exactly the pre-existing behavior. This is
// deliberately not a general redirect mechanism.
const editorReturnTarget = computed(() => decideEditorReturn(route.value.params.get('returnTo')));

const showFileTree = computed(() => route.value.routePath === '/files' && editorTarget.value === null);
// The directory `#/files?dir=…` asked for (set when returning from the editor).
// Absent → the tree opens at its first root, exactly as before.
const fileTreeInitialDir = computed(() => route.value.params.get('dir'));
const showSearch = computed(() => route.value.routePath === '/search');
const showTerminal = computed(() => route.value.routePath === '/terminal');
const showGit = computed(() => route.value.routePath === '/git');
// `#/cost` — the cost-ledger view (slice 5b step 4b). Statically imported like
// the other views; it pulls in no heavy dep, so it adds no lazy chunk.
const showCost = computed(() => route.value.routePath === '/cost');
// `/#/meters` — the deep-link target of the deployed threshold-notification push
// (slice 5 step 4b). It used to fall through to SessionListView by ACCIDENT,
// which was correct only because the meters strip happens to live there. Claim
// it deliberately: same view, but the strip arrives EXPANDED, because a user who
// tapped a usage alert wants every meter with its countdown, age, freshness,
// burn rate and exhaustion projection — not a one-line summary they must then
// find and tap. Deliberately NOT a separate lazily-loaded view: SessionListView
// is already statically imported, so this adds no chunk and cannot disturb the
// build-manifest lazy-chunk gate.
const showMeters = computed(() => route.value.routePath === '/meters');

function navigateToSession(appSessionId: string): void {
  window.location.hash = `#/session/${encodeURIComponent(appSessionId)}`;
}
function navigateHome(): void {
  window.location.hash = '';
}
// `#/files` opens the tree. An optional `dir` param says WHICH directory to open;
// without it the tree falls back to the first root (the pre-existing behavior).
function navigateToFiles(dir?: string | null): void {
  if (dir !== undefined && dir !== null && dir.length > 0) {
    window.location.hash = `#/files?dir=${encodeURIComponent(dir)}`;
    return;
  }
  window.location.hash = '#/files';
}
function navigateToSearch(): void {
  window.location.hash = '#/search';
}
function navigateToTerminal(): void {
  window.location.hash = '#/terminal';
}
function navigateToGit(): void {
  window.location.hash = '#/git';
}
function navigateToCost(): void {
  window.location.hash = '#/cost';
}
function navigateToEditor(path: string, line?: number, returnTo?: 'git'): void {
  const params = new URLSearchParams({ path });
  if (line !== undefined) {
    params.set('line', String(line));
  }
  if (returnTo !== undefined) {
    params.set('returnTo', returnTo);
  }
  window.location.hash = `#/files?${params.toString()}`;
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
  const editedPath = editorTarget.value?.path ?? null;
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

    <EditorView
      v-if="editorTarget"
      :key="editorTarget.path"
      :path="editorTarget.path"
      :line="editorTarget.line"
      @back="leaveEditor"
    />
    <FileTreeView
      v-else-if="showFileTree"
      :initial-dir="fileTreeInitialDir"
      @open="(path) => navigateToEditor(path)"
      @search="navigateToSearch"
      @back="navigateHome"
    />
    <SearchPanel
      v-else-if="showSearch"
      @open="(payload) => navigateToEditor(payload.path, payload.line)"
      @back="navigateHome"
    />
    <TerminalView v-else-if="showTerminal" @back="navigateHome" />
    <GitPanel
      v-else-if="showGit"
      @open-editor="(path) => navigateToEditor(path, undefined, 'git')"
      @back="navigateHome"
    />
    <CostLedgerView v-else-if="showCost" @back="navigateHome" />
    <StreamView v-else-if="activeSessionId" :app-session-id="activeSessionId" @back="navigateHome" />
    <SessionListView
      v-else
      :expand-meters="showMeters"
      @open="navigateToSession"
      @open-files="navigateToFiles"
      @open-search="navigateToSearch"
      @open-terminal="navigateToTerminal"
      @open-git="navigateToGit"
      @open-cost="navigateToCost"
    />
  </div>
</template>
