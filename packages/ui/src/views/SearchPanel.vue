<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { deriveRoots } from '../lib/treeNode.js';
import { basenameOf, groupResultsByFile } from '../lib/searchGroup.js';

// D41: this panel's close affordance. 'close' (a desktop panel) renders ✕;
// 'back' (a phone) keeps the original back affordance. The click handler is
// UNCHANGED — only the label/aria differ.
const props = defineProps<{ backKind?: 'back' | 'close' }>();
const emit = defineEmits<{ open: [payload: { path: string; line: number }]; back: [] }>();
const store = useVimesStore();

const roots = computed(() => deriveRoots(store.sessions));
const selectedRoot = ref('');
const query = ref('');
const caseInsensitive = ref(false);

watch(
  roots,
  (next) => {
    if (selectedRoot.value === '' && next.length > 0) {
      selectedRoot.value = next[0]!;
    }
  },
  { immediate: true },
);

const groups = computed(() => groupResultsByFile(store.searchResults));

// Human message for a search_error reason (ripgrep-unavailable is the notable
// one — a clear message beats a spinner that never resolves).
const errorText = computed(() => {
  switch (store.searchErrorReason) {
    case 'ripgrep-unavailable':
      return 'Search is unavailable — ripgrep is not installed on the host.';
    case 'root-outside-allowlist':
      return 'That root is outside the workspace.';
    case 'ripgrep-failed':
      return 'Search failed unexpectedly. Try again.';
    default:
      return store.searchErrorReason ? `Search error: ${store.searchErrorReason}` : '';
  }
});

function submit(): void {
  const trimmed = query.value.trim();
  if (trimmed.length === 0 || selectedRoot.value.length === 0) {
    return;
  }
  store.startSearch(selectedRoot.value, trimmed, { caseInsensitive: caseInsensitive.value });
}

function openResult(path: string, line: number): void {
  emit('open', { path, line });
}

onBeforeUnmount(() => {
  store.clearSearch();
});

// Highlight the matched substring within a line preview built from submatches.
function preview(submatches: Array<{ text: string }>): string {
  return submatches.map((s) => s.text).join(' … ');
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
      <button
        type="button"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-lg active:bg-panel-sunken"
        :aria-label="props.backKind === 'close' ? 'Close panel' : 'Back'"
        @click="emit('back')"
      >
        {{ props.backKind === 'close' ? '✕' : '‹' }}
      </button>
      <h1 class="flex-1 truncate font-semibold">Search</h1>
    </header>

    <form class="flex flex-col gap-2 border-b border-line p-3" @submit.prevent="submit">
      <select
        v-if="roots.length > 0"
        v-model="selectedRoot"
        class="min-h-[44px] rounded-md border border-line bg-panel px-2 text-sm"
      >
        <option v-for="root in roots" :key="root" :value="root">{{ root }}</option>
      </select>
      <p v-else class="text-sm text-ink-dim">
        No workspace roots yet — start or discover a session to search its files.
      </p>
      <div class="flex gap-2">
        <input
          v-model="query"
          type="search"
          placeholder="Search text…"
          class="min-h-[44px] min-w-0 flex-1 rounded-md border border-line bg-panel px-3 text-sm"
        />
        <button
          type="submit"
          class="min-h-[44px] rounded-md bg-accent px-4 text-sm font-semibold text-accent-fg active:bg-accent/80 disabled:opacity-50"
          :disabled="roots.length === 0 || query.trim().length === 0"
        >
          Go
        </button>
      </div>
      <label class="flex items-center gap-2 text-sm text-ink-dim">
        <input v-model="caseInsensitive" type="checkbox" />
        Case-insensitive
      </label>
    </form>

    <div class="min-h-0 flex-1 overflow-auto overscroll-contain">
      <p v-if="store.searchStatus === 'running'" class="px-3 py-3 text-sm text-ink-dim">
        Searching…
        <button type="button" class="ml-2 underline" @click="store.cancelSearch()">cancel</button>
      </p>
      <p v-else-if="store.searchStatus === 'error'" class="px-3 py-3 text-sm text-crit">
        {{ errorText }}
      </p>
      <p
        v-else-if="store.searchStatus === 'done' && groups.length === 0"
        class="px-3 py-3 text-sm text-ink-dim"
      >
        No matches.
      </p>
      <p
        v-else-if="store.searchStatus === 'done' && store.searchStats"
        class="px-3 py-2 font-mono text-xs tabular-nums text-ink-dim"
      >
        {{ store.searchStats.matched }} match(es) in {{ store.searchStats.files }} file(s) ·
        {{ store.searchStats.elapsedMs }} ms
      </p>

      <ul class="divide-y divide-line">
        <li v-for="group in groups" :key="group.file">
          <div class="bg-panel-sunken px-3 py-1">
            <div class="truncate text-sm font-medium">{{ basenameOf(group.file) }}</div>
            <div class="truncate text-xs text-ink-dim">{{ group.file }}</div>
          </div>
          <button
            v-for="(match, index) in group.matches"
            :key="`${group.file}:${match.line}:${index}`"
            type="button"
            class="flex min-h-[44px] w-full items-baseline gap-3 px-3 text-left text-sm active:bg-panel-sunken"
            @click="openResult(group.file, match.line)"
          >
            <span class="shrink-0 font-mono tabular-nums text-ink-dim">{{ match.line }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ preview(match.submatches) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
