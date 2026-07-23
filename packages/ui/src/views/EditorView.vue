<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { languageForPath } from '../lib/languageByExtension.js';
import {
  initialSaveConflictState,
  isDirty as isDirtyState,
  reduceSaveConflict,
  type SaveConflictState,
} from '../lib/saveConflict.js';
// TYPE-ONLY import — fully erased at build time, so it creates NO static runtime
// edge into the entry chunk. CM6 is reached ONLY via the dynamic import() below,
// which is what makes codemirror-setup its own lazy chunk (build-manifest gate).
import type { EditorAction, EditorHandle } from '../lib/codemirror-setup.js';

// D41: this panel's close affordance. 'close' (a desktop panel) renders ✕;
// 'back' (a phone) keeps the original back affordance. The click handler is
// UNCHANGED — only the label/aria differ.
const props = defineProps<{ path: string; line?: number; backKind?: 'back' | 'close' }>();
const emit = defineEmits<{ back: [] }>();

type LoadState = 'loading' | 'ready' | 'binary' | 'error';
const loadState = ref<LoadState>('loading');
const errorMessage = ref('');

const editorHost = ref<HTMLElement | null>(null);
const handle = shallowRef<EditorHandle | null>(null);
const saveState = ref<SaveConflictState>(initialSaveConflictState('', null));
// Sticky-Ctrl for the toolbar: when armed, an arrow does the word/doc variant.
const ctrlArmed = ref(false);

const downloadHref = () => `/api/files/download?path=${encodeURIComponent(props.path)}`;

function contentUrl(): string {
  return `/api/files/content?path=${encodeURIComponent(props.path)}`;
}

async function fetchContent(): Promise<{ text: string; mtime: number; binary: boolean } | null> {
  const response = await fetch(contentUrl(), { credentials: 'same-origin' });
  if (!response.ok) {
    errorMessage.value =
      response.status === 403
        ? 'This path is outside the workspace.'
        : response.status === 413
          ? 'File is too large to open in the editor.'
          : `Could not open file (HTTP ${response.status}).`;
    return null;
  }
  const mtime = Number(response.headers.get('x-vimes-mtime') ?? '0');
  const binary = response.headers.get('x-vimes-binary') === '1';
  const text = await response.text();
  return { text, mtime, binary };
}

onMounted(async () => {
  const loaded = await fetchContent();
  if (loaded === null) {
    loadState.value = 'error';
    return;
  }
  if (loaded.binary) {
    loadState.value = 'binary';
    return;
  }
  saveState.value = initialSaveConflictState(loaded.text, loaded.mtime);
  // The single dynamic import that pulls the CM6 lazy chunk on first file open.
  const { mountEditor } = await import('../lib/codemirror-setup.js');
  if (editorHost.value === null) {
    return; // unmounted while the chunk was loading
  }
  handle.value = mountEditor({
    parent: editorHost.value,
    doc: loaded.text,
    language: languageForPath(props.path),
    onChange: (content) => {
      saveState.value = reduceSaveConflict(saveState.value, { type: 'edit', content });
    },
    onSave: () => requestSave(),
  });
  loadState.value = 'ready';
  if (props.line !== undefined) {
    handle.value.goToLine(props.line);
  }
});

onBeforeUnmount(() => {
  handle.value?.destroy();
  handle.value = null;
});

async function putCurrent(): Promise<void> {
  const snapshot = saveState.value;
  try {
    const response = await fetch('/api/files/content', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: props.path, content: snapshot.currentContent, expectedMtime: snapshot.mtime }),
    });
    if (response.status === 409) {
      const freshMtime = Number(response.headers.get('x-vimes-mtime') ?? '0');
      saveState.value = reduceSaveConflict(saveState.value, { type: 'save_conflict', mtime: freshMtime });
      return;
    }
    if (!response.ok) {
      saveState.value = reduceSaveConflict(saveState.value, { type: 'save_error' });
      return;
    }
    const body = (await response.json()) as { mtime: number };
    saveState.value = reduceSaveConflict(saveState.value, { type: 'save_ok', mtime: body.mtime });
  } catch {
    saveState.value = reduceSaveConflict(saveState.value, { type: 'save_error' });
  }
}

function requestSave(): void {
  const next = reduceSaveConflict(saveState.value, { type: 'save' });
  if (next.status !== 'saving') {
    return; // nothing dirty to save
  }
  saveState.value = next;
  void putCurrent();
}

function overwrite(): void {
  const next = reduceSaveConflict(saveState.value, { type: 'overwrite' });
  if (next.status !== 'saving') {
    return;
  }
  saveState.value = next;
  void putCurrent();
}

async function reloadFromDisk(): Promise<void> {
  const loaded = await fetchContent();
  if (loaded === null || loaded.binary) {
    return;
  }
  handle.value?.setContent(loaded.text);
  saveState.value = reduceSaveConflict(saveState.value, {
    type: 'reloaded',
    content: loaded.text,
    mtime: loaded.mtime,
  });
}

// Toolbar → editor. Sticky Ctrl promotes arrows to word/doc motion, then disarms.
function toolbar(action: EditorAction): void {
  const target = handle.value;
  if (target === null) {
    return;
  }
  if (action === 'escape') {
    target.run('escape');
    return;
  }
  let effective: EditorAction = action;
  if (ctrlArmed.value) {
    if (action === 'left') effective = 'wordLeft';
    else if (action === 'right') effective = 'wordRight';
    else if (action === 'up') effective = 'docStart';
    else if (action === 'down') effective = 'docEnd';
    ctrlArmed.value = false;
  }
  target.run(effective);
}

function toggleCtrl(): void {
  ctrlArmed.value = !ctrlArmed.value;
}

const dirty = () => isDirtyState(saveState.value);
const fileName = () => props.path.slice(props.path.lastIndexOf('/') + 1);
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
      <button
        type="button"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-lg active:bg-slate-100 dark:active:bg-slate-900"
        :aria-label="props.backKind === 'close' ? 'Close panel' : 'Back'"
        @click="emit('back')"
      >
        {{ props.backKind === 'close' ? '✕' : '‹' }}
      </button>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1 truncate font-medium">
          <span class="truncate">{{ fileName() }}</span>
          <span v-if="dirty()" class="text-amber-500" title="Unsaved changes" aria-label="Unsaved changes">●</span>
        </div>
        <div class="truncate text-xs text-slate-500 dark:text-slate-400">{{ props.path }}</div>
      </div>
      <button
        v-if="loadState === 'ready'"
        type="button"
        class="min-h-[44px] rounded-md bg-sky-600 px-4 text-sm font-semibold text-white active:bg-sky-700 disabled:opacity-50"
        :disabled="saveState.status === 'saving' || !dirty()"
        @click="requestSave"
      >
        {{ saveState.status === 'saving' ? 'Saving…' : 'Save' }}
      </button>
    </header>

    <div
      v-if="saveState.status === 'conflict'"
      class="flex flex-col gap-2 border-b border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40"
    >
      <span class="font-medium text-amber-800 dark:text-amber-200">
        This file changed on disk since you opened it.
      </span>
      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-[44px] rounded-md bg-rose-600 px-4 text-sm font-semibold text-white active:bg-rose-700"
          @click="overwrite"
        >
          Overwrite
        </button>
        <button
          type="button"
          class="min-h-[44px] rounded-md border border-slate-300 px-4 text-sm font-semibold active:bg-slate-100 dark:border-slate-700 dark:active:bg-slate-900"
          @click="reloadFromDisk"
        >
          Reload from disk
        </button>
      </div>
    </div>

    <div v-if="loadState === 'loading'" class="flex flex-1 items-center justify-center p-8 text-sm text-slate-500">
      Opening…
    </div>

    <div v-else-if="loadState === 'error'" class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p class="text-sm text-rose-600">{{ errorMessage }}</p>
    </div>

    <div v-else-if="loadState === 'binary'" class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p class="text-sm text-slate-600 dark:text-slate-300">
        This looks like a binary file and can't be edited as text.
      </p>
      <a
        :href="downloadHref()"
        class="min-h-[44px] rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white active:bg-sky-700"
      >
        Download instead
      </a>
    </div>

    <!-- The CM6 mount target; kept present (v-show) so the mounted view is never
         re-parented. The editor fills the space between header and toolbar. -->
    <div v-show="loadState === 'ready'" ref="editorHost" class="min-h-0 flex-1 overflow-auto text-sm"></div>

    <!-- Mobile keyboard toolbar (44px+ targets). Sits above the on-screen
         keyboard; the buttons dispatch CM6 commands. -->
    <nav
      v-if="loadState === 'ready'"
      class="sticky bottom-0 z-20 flex gap-1 overflow-x-auto border-t border-slate-200 bg-white px-2 py-1 dark:border-slate-800 dark:bg-slate-950"
    >
      <button type="button" class="tb" @click="toolbar('tab')">Tab</button>
      <button type="button" class="tb" @click="toolbar('escape')">Esc</button>
      <button
        type="button"
        class="tb"
        :class="ctrlArmed ? 'bg-sky-600 text-white' : ''"
        :aria-pressed="ctrlArmed"
        @click="toggleCtrl"
      >
        Ctrl
      </button>
      <button type="button" class="tb" aria-label="Left" @click="toolbar('left')">←</button>
      <button type="button" class="tb" aria-label="Down" @click="toolbar('down')">↓</button>
      <button type="button" class="tb" aria-label="Up" @click="toolbar('up')">↑</button>
      <button type="button" class="tb" aria-label="Right" @click="toolbar('right')">→</button>
      <button type="button" class="tb tb-save" @click="requestSave">Save</button>
    </nav>
  </div>
</template>

<style scoped>
.tb {
  min-height: 44px;
  min-width: 44px;
  flex: 0 0 auto;
  border-radius: 0.375rem;
  border: 1px solid rgb(203 213 225);
  padding: 0 0.75rem;
  font-size: 0.875rem;
  font-weight: 600;
}
.tb:active {
  background: rgb(241 245 249);
}
.tb-save {
  margin-left: auto;
  background: rgb(2 132 199);
  color: white;
  border-color: rgb(2 132 199);
}
:global(.dark) .tb {
  border-color: rgb(51 65 85);
}
</style>
