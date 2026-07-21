<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import SessionListView from './views/SessionListView.vue';
import StreamView from './views/StreamView.vue';
import FileTreeView from './views/FileTreeView.vue';
import EditorView from './views/EditorView.vue';
import SearchPanel from './views/SearchPanel.vue';
import TerminalView from './views/TerminalView.vue';
import GitPanel from './views/GitPanel.vue';
import { useVimesStore } from './stores/vimesStore.js';

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

const showFileTree = computed(() => route.value.routePath === '/files' && editorTarget.value === null);
const showSearch = computed(() => route.value.routePath === '/search');
const showTerminal = computed(() => route.value.routePath === '/terminal');
const showGit = computed(() => route.value.routePath === '/git');

function navigateToSession(appSessionId: string): void {
  window.location.hash = `#/session/${encodeURIComponent(appSessionId)}`;
}
function navigateHome(): void {
  window.location.hash = '';
}
function navigateToFiles(): void {
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
function navigateToEditor(path: string, line?: number): void {
  const params = new URLSearchParams({ path });
  if (line !== undefined) {
    params.set('line', String(line));
  }
  window.location.hash = `#/files?${params.toString()}`;
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
      @back="navigateToFiles"
    />
    <FileTreeView
      v-else-if="showFileTree"
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
    <GitPanel v-else-if="showGit" @back="navigateHome" />
    <StreamView v-else-if="activeSessionId" :app-session-id="activeSessionId" @back="navigateHome" />
    <SessionListView
      v-else
      @open="navigateToSession"
      @open-files="navigateToFiles"
      @open-search="navigateToSearch"
      @open-terminal="navigateToTerminal"
      @open-git="navigateToGit"
    />
  </div>
</template>
