<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { deriveTreeRows, effectiveRoots, parentDir, type RawTreeEntry, type TreeRow } from '../lib/treeNode.js';

const emit = defineEmits<{ open: [path: string]; back: []; search: [] }>();
const store = useVimesStore();

// Roots prefer the daemon's fetched allowlist (GET /api/files/roots), falling
// back to live-session cwds only until that first fetch lands (see treeNode.ts).
const roots = computed(() => effectiveRoots(store.roots, store.sessions));

type LoadState = 'empty' | 'loading' | 'ready' | 'error';
const loadState = ref<LoadState>('empty');
const errorMessage = ref('');
const boundaryHit = ref(false);
const currentDir = ref<string | null>(null);
const rows = ref<TreeRow[]>([]);

function treeUrl(dir: string): string {
  return `/api/files/tree?root=${encodeURIComponent(dir)}&path=`;
}

function downloadHref(row: TreeRow): string {
  const zip = row.type === 'dir' ? '&zip=1' : '';
  return `/api/files/download?path=${encodeURIComponent(row.absolute)}${zip}`;
}

// List a directory. On 403 (allowlist boundary) we keep the current view and
// flag it, rather than dropping the user into a dead end.
async function navigate(dir: string): Promise<void> {
  loadState.value = 'loading';
  boundaryHit.value = false;
  errorMessage.value = '';
  try {
    const response = await fetch(treeUrl(dir), { credentials: 'same-origin' });
    if (response.status === 403) {
      boundaryHit.value = true;
      loadState.value = currentDir.value === null ? 'error' : 'ready';
      if (currentDir.value === null) {
        errorMessage.value = 'That directory is outside the workspace.';
      }
      return;
    }
    if (!response.ok) {
      loadState.value = 'error';
      errorMessage.value = `Could not list directory (HTTP ${response.status}).`;
      return;
    }
    const data = (await response.json()) as { entries: RawTreeEntry[] };
    rows.value = deriveTreeRows(dir, data.entries);
    currentDir.value = dir;
    loadState.value = 'ready';
  } catch {
    loadState.value = 'error';
    errorMessage.value = 'Network error listing directory.';
  }
}

function openDir(row: TreeRow): void {
  if (row.type === 'dir') {
    void navigate(row.absolute);
  } else if (row.type === 'file') {
    emit('open', row.absolute);
  }
  // symlinks: not followed by the API listing; tapping does nothing here.
}

function goUp(): void {
  if (currentDir.value === null) {
    return;
  }
  const parent = parentDir(currentDir.value);
  if (parent === null) {
    boundaryHit.value = true;
    return;
  }
  void navigate(parent);
}

function selectRoot(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value.length > 0) {
    void navigate(value);
  }
}

// Initialize to the first root once the sessions projection has one.
watch(
  roots,
  (next) => {
    if (currentDir.value === null && next.length > 0) {
      void navigate(next[0]!);
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (currentDir.value === null && roots.value.length > 0) {
    void navigate(roots.value[0]!);
  }
});

const hasRoots = computed(() => roots.value.length > 0);

function icon(type: TreeRow['type']): string {
  return type === 'dir' ? '📁' : type === 'symlink' ? '🔗' : '📄';
}
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
      <button
        type="button"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-lg active:bg-slate-100 dark:active:bg-slate-900"
        aria-label="Back to sessions"
        @click="emit('back')"
      >
        ‹
      </button>
      <h1 class="flex-1 truncate font-semibold">Files</h1>
      <button
        type="button"
        class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm font-medium active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
        @click="emit('search')"
      >
        🔍 Search
      </button>
    </header>

    <div v-if="!hasRoots" class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p class="text-sm text-slate-500 dark:text-slate-400">
        No workspace roots yet. Start or discover a session first — its working
        directory becomes a browsable root.
      </p>
    </div>

    <template v-else>
      <div class="flex flex-col gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
        <label class="text-xs font-medium text-slate-500 dark:text-slate-400" for="root-select">Root</label>
        <select
          id="root-select"
          class="min-h-[44px] rounded-md border border-slate-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          :value="roots.includes(currentDir ?? '') ? currentDir : ''"
          @change="selectRoot"
        >
          <option value="" disabled>Select a root…</option>
          <option v-for="root in roots" :key="root" :value="root">{{ root }}</option>
        </select>
        <div class="truncate text-xs text-slate-500 dark:text-slate-400">{{ currentDir }}</div>
      </div>

      <p v-if="boundaryHit" class="border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        That's the edge of the workspace — you can't go higher from here.
      </p>

      <ul class="flex-1 divide-y divide-slate-100 dark:divide-slate-900">
        <li>
          <button
            type="button"
            class="flex min-h-[44px] w-full items-center gap-3 px-3 text-left text-sm active:bg-slate-100 dark:active:bg-slate-900"
            @click="goUp"
          >
            <span aria-hidden="true">↩</span>
            <span class="text-slate-500 dark:text-slate-400">.. (up)</span>
          </button>
        </li>
        <li v-for="row in rows" :key="row.absolute" class="flex items-center">
          <button
            type="button"
            class="flex min-h-[44px] w-full min-w-0 items-center gap-3 px-3 text-left text-sm active:bg-slate-100 dark:active:bg-slate-900"
            @click="openDir(row)"
          >
            <span aria-hidden="true">{{ icon(row.type) }}</span>
            <span class="min-w-0 flex-1 truncate" :class="row.hidden ? 'text-slate-400 dark:text-slate-500' : ''">
              {{ row.name }}
            </span>
            <span v-if="row.sizeLabel" class="shrink-0 text-xs text-slate-400">{{ row.sizeLabel }}</span>
          </button>
          <a
            v-if="row.type !== 'symlink'"
            :href="downloadHref(row)"
            class="flex min-h-[44px] min-w-[44px] items-center justify-center text-slate-400 active:bg-slate-100 dark:active:bg-slate-900"
            :aria-label="`Download ${row.name}`"
            @click.stop
          >
            ⬇
          </a>
        </li>
        <li v-if="loadState === 'ready' && rows.length === 0" class="px-3 py-4 text-center text-sm text-slate-500 dark:text-slate-400">
          Empty directory.
        </li>
      </ul>

      <p v-if="loadState === 'error'" class="px-3 py-4 text-center text-sm text-rose-600">{{ errorMessage }}</p>
      <p v-else-if="loadState === 'loading'" class="px-3 py-4 text-center text-sm text-slate-400">Loading…</p>
    </template>
  </div>
</template>
