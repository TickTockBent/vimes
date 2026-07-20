<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { effectiveRoots } from '../lib/treeNode.js';
import { decideMountReady, decideStartCwd } from '../lib/terminalStart.js';
import { deriveTerminalRows } from '../lib/terminalList.js';
import type { TerminalHandle } from '../lib/xterm-setup.js';

// Raw PTY shell — the ESCAPE HATCH (docs/design-directions.md): functional on
// desktop, reachable on mobile. Deliberately NOT a polished mobile daily-driver —
// no elaborate keyboard toolbar. xterm.js is loaded via dynamic import() so it
// lands in its own lazy chunk (the build-manifest gate enforces this).
//
// Terminals are PERSISTENT (terminal-lifecycle backlog item): shells outlive this
// view. The landing is a list of the daemon's still-alive shells — tap to
// re-enter (re-subscribe, not resume), one-tap kill, a resilient toggle to exempt
// a keeper from the inactivity reaper — plus a New-shell flow. Navigate-away
// DETACHES (keeps the shell), it never sends term_close.

const emit = defineEmits<{ back: [] }>();
const store = useVimesStore();

// cwd candidates prefer the daemon's fetched allowlist (GET /api/files/roots),
// falling back to live-session cwds only until that first fetch lands. A shell
// can only be rooted inside the daemon's allowlist either way.
const roots = computed(() => effectiveRoots(store.roots, store.sessions));
const selectedRoot = ref<string>('');
// Editable working directory for the new shell. Prefilled from the selected
// root and re-synced whenever the root changes, but the user may edit it to a
// SUBPATH so a shell can open below a root (not only at one). The daemon's
// term_open routes this cwd through resolveWithinRoots and refuses anything
// outside the allowlist — that server wall is authoritative, so we do NO
// client-side path validation beyond non-empty (the refusal reason surfaces as
// loadError/status via the existing openTerminal flow).
const cwdField = ref<string>('');
const started = ref(false);
const lostNotice = ref(false);
const loadError = ref<string | null>(null);
const showNewShell = ref(false);

// Live terminals list, most-recently-active first. `nowMs` is refreshed whenever
// the list is (re)fetched so the relative labels are current at render.
const nowMs = ref(Date.now());
const terminalRows = computed(() => deriveTerminalRows(store.terminals, nowMs.value));

async function refreshTerminals(): Promise<void> {
  await store.fetchTerminals();
  nowMs.value = Date.now();
}

const terminalElement = ref<HTMLDivElement | null>(null);
const handle = shallowRef<TerminalHandle | null>(null);
let resizeObserver: ResizeObserver | null = null;

// Wait one animation frame — used after nextTick() to let the browser finish a
// real layout/paint pass before we measure the mount target. On mobile,
// nextTick() alone can land before the on-screen viewport (safe-area, address
// bar, initial keyboard state) has settled, so a fit() run immediately after
// can measure a stale/wrong size. This matters here specifically because the
// measured size is sent as the pty's INITIAL size (below) — before the shell,
// and Claude Code's TUI, ever render a byte.
function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

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

// Mount xterm and wire its sinks + input/resize relay. Shared by BOTH the new-
// shell flow and the re-enter flow. Returns the fitted terminal handle (with its
// measured dimensions) or null when the mount target never rendered. The caller
// decides what to do with the handle (term_open at the fitted size, or subscribe
// to an existing shell then resize it).
async function mountXtermIntoView(): Promise<{ terminal: TerminalHandle; cols: number; rows: number } | null> {
  loadError.value = null;
  lostNotice.value = false;
  // Flip started FIRST, then wait a tick — the mount target lives behind
  // v-if="started" in the template, so it does not exist in the DOM until this
  // render happens. Reading terminalElement.value before this point (the original
  // bug) always saw null and returned with no error.
  started.value = true;
  await nextTick();
  const element = terminalElement.value;
  const mountDecision = decideMountReady(element !== null);
  if (!mountDecision.ok || element === null) {
    loadError.value = mountDecision.ok
      ? 'Could not prepare the terminal — try again.'
      : mountDecision.error;
    started.value = false;
    return null;
  }
  // Let the real on-screen layout settle before we ever measure it (see
  // nextAnimationFrame above) — a double rAF is cheap and covers browsers that
  // need an extra frame past the DOM mutation.
  await nextAnimationFrame();
  await nextAnimationFrame();
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
  // Keep the pty's dimensions in sync with the rendered size for LATER changes
  // (rotation, on-screen-keyboard show/hide).
  terminal.onResize(({ cols, rows }) => store.resizeTerminal(cols, rows));

  const dimensions = terminal.fit();
  terminal.focus();
  // Refit on container size changes (rotation / keyboard).
  resizeObserver = new ResizeObserver(() => {
    handle.value?.fit();
  });
  resizeObserver.observe(element);
  return { terminal, cols: dimensions.cols, rows: dimensions.rows };
}

// Selecting a different root refills the editable path with that root; the user
// can then extend it to a subpath before opening. Order-independent (a watch, so
// it never races the select's v-model update).
watch(selectedRoot, (root) => {
  cwdField.value = root;
});

// New-shell flow: resolve the cwd (free-text field, or selected root when
// empty), mount xterm, term_open at the fitted size (so the shell never spawns
// at the wrong width — the mobile terminal-corruption fix).
async function start(): Promise<void> {
  // Phase 1: resolve a cwd. The field wins (a subpath); an empty field falls
  // back to the selected root. Must fail visibly when there is no root at all,
  // never silently. The daemon still validates the cwd against the allowlist.
  const cwdDecision = decideStartCwd(cwdField.value, selectedRoot.value, roots.value[0]);
  if (!cwdDecision.ok) {
    loadError.value = cwdDecision.error;
    return;
  }
  try {
    const mounted = await mountXtermIntoView();
    if (mounted === null) {
      return;
    }
    store.openTerminal(cwdDecision.cwd, { cols: mounted.cols, rows: mounted.rows });
  } catch {
    loadError.value = 'Could not load the terminal.';
    started.value = false;
  }
}

// Re-enter flow: mount xterm and re-SUBSCRIBE to a still-alive shell (the ring
// replays what it holds). The shell already exists, so we do not term_open; we
// resize it to our viewport once attached.
async function enter(terminalId: string, cwd: string): Promise<void> {
  try {
    const mounted = await mountXtermIntoView();
    if (mounted === null) {
      return;
    }
    store.enterTerminal(terminalId, cwd);
    store.resizeTerminal(mounted.cols, mounted.rows);
  } catch {
    loadError.value = 'Could not load the terminal.';
    started.value = false;
  }
}

function toggleResilient(terminalId: string, resilient: boolean): void {
  store.setTerminalResilient(terminalId, resilient);
}

function kill(terminalId: string): void {
  store.killTerminal(terminalId);
}

// Tear down the xterm view WITHOUT killing the shell (detach = persist). Reused
// by unmount and by the in-view "back to list" action.
function teardownView(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  store.clearTerminalSinks();
  store.detachTerminal();
  handle.value?.dispose();
  handle.value = null;
  started.value = false;
}

// Header back: from an open shell, return to the LIST (detach, keep the shell);
// from the list, leave the terminal view entirely (home).
async function onBack(): Promise<void> {
  if (started.value) {
    teardownView();
    await refreshTerminals();
    return;
  }
  emit('back');
}

onMounted(() => {
  if (roots.value.length > 0) {
    selectedRoot.value = roots.value[0]!;
  }
  void refreshTerminals();
});

onBeforeUnmount(() => {
  // Navigate-away DETACHES: the shell survives (persistence) — never term_close.
  teardownView();
});
</script>

<template>
  <div class="flex min-h-screen flex-col bg-slate-950">
    <header class="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-800 bg-slate-950 px-3 py-2">
      <button
        type="button"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-lg text-slate-200 active:bg-slate-900"
        :aria-label="started ? 'Back to terminals' : 'Back to sessions'"
        @click="onBack"
      >
        ‹
      </button>
      <h1 class="flex-1 truncate font-semibold text-slate-100">{{ started ? 'Terminal' : 'Terminals' }}</h1>
      <span class="shrink-0 text-xs text-slate-400">{{ statusLabel }}</span>
    </header>

    <p
      v-if="lostNotice"
      class="border-b border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
    >
      Output was dropped — you reconnected past the buffer window. The stream is live again from here.
    </p>

    <!-- Landing: the live terminals list + a New-shell flow. Persistent shells
         appear here so they can be re-entered, kept (resilient), or killed. -->
    <div v-if="!started" class="min-h-0 flex-1 overflow-y-auto p-4">
      <section v-if="terminalRows.length > 0" class="mx-auto flex max-w-2xl flex-col gap-2">
        <h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Running shells</h2>
        <ul class="flex flex-col gap-2">
          <li
            v-for="row in terminalRows"
            :key="row.terminalId"
            class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 p-2"
          >
            <button
              type="button"
              class="flex min-h-[44px] flex-1 flex-col items-start justify-center gap-0.5 rounded-md px-2 text-left active:bg-slate-800"
              @click="enter(row.terminalId, row.cwd)"
            >
              <span class="flex items-center gap-2">
                <span class="font-medium text-slate-100">{{ row.cwdTail }}</span>
                <span
                  v-if="row.resilient"
                  class="rounded bg-emerald-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300"
                >kept</span>
                <span v-if="row.watched" class="text-[10px] text-sky-400">watching</span>
              </span>
              <span class="truncate text-xs text-slate-500">{{ row.cwd }}</span>
              <span class="text-[11px] text-slate-500">active {{ row.lastActiveLabel }}</span>
            </button>
            <label
              class="flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-slate-300 active:bg-slate-800"
              :title="'Resilient — exempt this shell from the idle reaper'"
            >
              <input
                type="checkbox"
                class="h-4 w-4 accent-emerald-500"
                :checked="row.resilient"
                @change="toggleResilient(row.terminalId, ($event.target as HTMLInputElement).checked)"
              />
              keep
            </label>
            <button
              type="button"
              class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-sm font-semibold text-rose-400 active:bg-rose-950"
              :aria-label="`Kill shell ${row.cwdTail}`"
              @click="kill(row.terminalId)"
            >
              Kill
            </button>
          </li>
        </ul>
        <p class="px-1 text-[11px] text-slate-600">
          Shells persist across reconnects. Idle shells are auto-reaped unless kept; killing one ends its process tree.
        </p>
      </section>

      <section class="mx-auto mt-6 flex max-w-2xl flex-col gap-3">
        <div v-if="roots.length === 0 && terminalRows.length === 0" class="text-center text-sm text-slate-400">
          No workspace roots yet. Start or discover a session first — its working
          directory becomes a place you can open a shell.
        </div>
        <template v-else>
          <button
            v-if="!showNewShell"
            type="button"
            class="min-h-[44px] self-start rounded-md border border-slate-700 bg-slate-900 px-4 text-sm font-semibold text-slate-100 active:bg-slate-800"
            @click="showNewShell = true"
          >
            + New shell
          </button>
          <div v-else class="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900 p-3">
            <p class="text-sm text-slate-300">Open a new shell rooted at:</p>
            <select
              v-model="selectedRoot"
              class="min-h-[44px] w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
            >
              <option v-for="root in roots" :key="root" :value="root">{{ root }}</option>
            </select>
            <label class="flex flex-col gap-1 text-xs text-slate-400">
              Working directory (edit to open at a subpath)
              <input
                v-model="cwdField"
                type="text"
                inputmode="url"
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                placeholder="Pick a root above, or type a path inside one"
                class="min-h-[44px] w-full rounded-md border border-slate-700 bg-slate-950 px-2 font-mono text-sm text-slate-100"
              />
            </label>
            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-[44px] rounded-md bg-sky-600 px-6 text-sm font-semibold text-white active:bg-sky-700"
                @click="start"
              >
                Open terminal
              </button>
              <button
                type="button"
                class="min-h-[44px] rounded-md px-4 text-sm text-slate-400 active:bg-slate-800"
                @click="showNewShell = false"
              >
                Cancel
              </button>
            </div>
            <p class="text-xs text-slate-500">
              This is a real shell on the dev box — the same access a local terminal has.
            </p>
          </div>
        </template>
        <p v-if="loadError" class="text-xs text-rose-400">{{ loadError }}</p>
      </section>
    </div>

    <div v-else ref="terminalElement" class="min-h-0 flex-1 overflow-hidden p-1"></div>
  </div>
</template>
