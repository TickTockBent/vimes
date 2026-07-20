<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { effectiveRoots } from '../lib/treeNode.js';
import { decideMountReady, decideStartRoot } from '../lib/terminalStart.js';
import type { TerminalHandle } from '../lib/xterm-setup.js';

// Raw PTY shell — the ESCAPE HATCH (docs/design-directions.md): functional on
// desktop, reachable on mobile. Deliberately NOT a polished mobile daily-driver —
// no elaborate keyboard toolbar. xterm.js is loaded via dynamic import() so it
// lands in its own lazy chunk (the build-manifest gate enforces this).

const emit = defineEmits<{ back: [] }>();
const store = useVimesStore();

// cwd candidates prefer the daemon's fetched allowlist (GET /api/files/roots),
// falling back to live-session cwds only until that first fetch lands. A shell
// can only be rooted inside the daemon's allowlist either way.
const roots = computed(() => effectiveRoots(store.roots, store.sessions));
const selectedRoot = ref<string>('');
const started = ref(false);
const lostNotice = ref(false);
const loadError = ref<string | null>(null);

const terminalElement = ref<HTMLDivElement | null>(null);
const handle = shallowRef<TerminalHandle | null>(null);
let resizeObserver: ResizeObserver | null = null;

const statusLabel = computed(() => {
  switch (store.terminalStatus) {
    case 'opening':
      return 'Opening shell…';
    case 'live':
      return 'Connected';
    case 'exited':
      return `Shell exited${store.terminalExitCode !== null ? ` (code ${store.terminalExitCode})` : ''}`;
    case 'error':
      return 'Terminal error';
    default:
      return '';
  }
});

async function start(): Promise<void> {
  // Phase 1: is there a root at all? Must fail visibly, never silently.
  const rootDecision = decideStartRoot(selectedRoot.value, roots.value[0]);
  if (!rootDecision.ok) {
    loadError.value = rootDecision.error;
    return;
  }
  loadError.value = null;
  lostNotice.value = false;
  // Flip started FIRST, then wait a tick — the mount target lives behind
  // v-else="!started" in the template, so it does not exist in the DOM until
  // this render happens. Reading terminalElement.value before this point (the
  // original bug) always saw null and returned with no error.
  started.value = true;
  await nextTick();
  const element = terminalElement.value;
  // Phase 2: did the mount target actually render? Must also fail visibly.
  const mountDecision = decideMountReady(element !== null);
  if (!mountDecision.ok || element === null) {
    loadError.value = mountDecision.ok
      ? 'Could not prepare the terminal — try again.'
      : mountDecision.error;
    started.value = false;
    return;
  }
  try {
    // The ONLY place xterm.js is loaded — a dynamic import keeps it in a lazy chunk.
    const { mountTerminal } = await import('../lib/xterm-setup.js');
    const terminal = mountTerminal(element);
    handle.value = terminal;

    store.setTerminalSinks({
      onOutput: (bytes) => terminal.write(bytes),
      onLost: () => {
        lostNotice.value = true;
        terminal.writeNotice('[vimes] output was dropped — reconnected past the buffer window]');
      },
      onExit: () => {
        // Leave the final screen visible; the status line shows the exit.
      },
    });

    // Input keystrokes → framed bytes to the daemon (verbatim relay).
    terminal.onInput((text) => store.sendTerminalInput(text));
    // Keep the pty's dimensions in sync with the rendered size.
    terminal.onResize(({ cols, rows }) => store.resizeTerminal(cols, rows));

    const dimensions = terminal.fit();
    store.openTerminal(rootDecision.root);
    store.resizeTerminal(dimensions.cols, dimensions.rows);
    terminal.focus();

    // Refit on container size changes (rotation / keyboard).
    resizeObserver = new ResizeObserver(() => {
      handle.value?.fit();
    });
    resizeObserver.observe(element);
  } catch {
    loadError.value = 'Could not load the terminal.';
    started.value = false;
  }
}

onMounted(() => {
  if (roots.value.length > 0) {
    selectedRoot.value = roots.value[0]!;
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  store.clearTerminalSinks();
  store.closeTerminal();
  handle.value?.dispose();
  handle.value = null;
});
</script>

<template>
  <div class="flex min-h-screen flex-col bg-slate-950">
    <header class="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-800 bg-slate-950 px-3 py-2">
      <button
        type="button"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-lg text-slate-200 active:bg-slate-900"
        aria-label="Back to sessions"
        @click="emit('back')"
      >
        ‹
      </button>
      <h1 class="flex-1 truncate font-semibold text-slate-100">Terminal</h1>
      <span class="shrink-0 text-xs text-slate-400">{{ statusLabel }}</span>
    </header>

    <p
      v-if="lostNotice"
      class="border-b border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
    >
      Output was dropped — you reconnected past the buffer window. The stream is live again from here.
    </p>

    <div v-if="!started" class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <template v-if="roots.length === 0">
        <p class="max-w-sm text-sm text-slate-400">
          No workspace roots yet. Start or discover a session first — its working
          directory becomes a place you can open a shell.
        </p>
      </template>
      <template v-else>
        <p class="text-sm text-slate-300">Open a shell rooted at:</p>
        <select
          v-model="selectedRoot"
          class="min-h-[44px] w-full max-w-sm rounded-md border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100"
        >
          <option v-for="root in roots" :key="root" :value="root">{{ root }}</option>
        </select>
        <button
          type="button"
          class="min-h-[44px] rounded-md bg-sky-600 px-6 text-sm font-semibold text-white active:bg-sky-700"
          @click="start"
        >
          Open terminal
        </button>
        <p class="max-w-sm text-xs text-slate-500">
          This is a real shell on the dev box — the same access a local terminal has.
        </p>
        <p v-if="loadError" class="text-xs text-rose-400">{{ loadError }}</p>
      </template>
    </div>

    <div v-else ref="terminalElement" class="min-h-0 flex-1 overflow-hidden p-1"></div>
  </div>
</template>
