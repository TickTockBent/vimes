<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import PanelHost from './components/PanelHost.vue';
import { useVimesStore } from './stores/vimesStore.js';
import { type Route } from './lib/route.js';
import {
  buildPanelStackHash,
  openPanelFrom,
  parsePanelStack,
  popPanel,
  type PanelStack,
} from './lib/panelStack.js';
import { panelLinkClick } from './lib/panelLinkClick.js';
import { useLayoutMode } from './lib/useLayoutMode.js';

const store = useVimesStore();

// ── the panel shell (desktop phase 3+4, D39) ────────────────────────────────
//
// THE MODEL. Navigation state is a STACK of panels (each a Route). The viewport
// renders the TRAILING N panels side by side, N from useLayoutMode (width +
// device override). Opening a view FROM panel i truncates the stack to [0..i]
// then pushes (openPanelFrom); back pops the tail.
//
// WHY THE STACK IS A REF, NOT `computed(parsePanelStack(hash))`. Phase 2 kept
// the stack length 1 and derived it straight from the hash. The shell needs
// something phase 2 did not: the stack must retain HISTORY BELOW THE VISIBLE
// WINDOW so `back` works. On a phone (N=1) opening a session gives the full
// stack [list, stream] but only `stream` is visible — and the hash must stay
// BYTE-IDENTICAL to today (`#/session/x`, a single-panel hash), not the
// multi-panel `#/stack/...` that the full stack would encode. So the two are
// split deliberately:
//   • `panelStack` (this ref) is the SOURCE OF TRUTH — the full history, in
//     memory, as deep as navigation made it.
//   • the HASH mirrors only the VISIBLE window (trailing N). At N=1 that is
//     always one panel, so buildPanelStackHash emits exactly today's hash for
//     every transition (phase-2 byte-identity), which is the phone guarantee.
// This is the one place this file departs from the work order's literal
// "stack = computed(parsePanelStack(hash))" / "write buildPanelStackHash(newStack)"
// wording — because writing the FULL stack would make a phone's URL multi-panel,
// breaking the hard byte-identical requirement. The window is what a user sees
// and would bookmark/share, so mirroring it is also the honest URL.
const { panelCount } = useLayoutMode();

// The session list is home — the bottom of every navigation stack. A deep-link
// or reload lands on just the visible window (e.g. `#/session/x` → [stream]); we
// synthesize the list root beneath it so "back" always eventually reaches home,
// matching today's `navigateHome` from any view. A window that already starts at
// the session list (home, or `#/meters`, or a `#/stack/` beginning with it) is
// left untouched. Only ever PREPENDS — never reshapes the visible window, so the
// mirrored hash and the N=1 byte-identity are unaffected.
function seedStackFromHash(hashValue: string): PanelStack {
  const parsedWindow = parsePanelStack(hashValue);
  if (parsedWindow[0]!.view === 'sessionList') {
    return parsedWindow;
  }
  return [{ view: 'sessionList', expandMeters: false }, ...parsedWindow];
}

const panelStack = ref<PanelStack>(seedStackFromHash(window.location.hash));

// The last hash THIS component wrote. onHashChange compares against it so our
// own writes (which mirror the visible window and would otherwise re-seed the
// ref shallowly, destroying the in-memory history) are ignored, while genuinely
// external changes (deep link, browser back/forward, a hand-edited URL) DO
// re-seed. Deep browser-history depth is explicitly OUT of this POC, so a
// re-seed producing a shallow stack (back then floors) is the accepted
// behaviour for those external entries.
let lastWrittenHash = window.location.hash;

// Focus (D39 #4): the last-interacted panel takes the focus ring. Default is the
// tail (the freshest panel). A mousedown anywhere in a column sets it; a pop
// clamps it back into range. The ring only renders when MORE THAN ONE panel is
// visible (see the `:focused` binding) so a phone (N=1) shows no ring and stays
// byte-visually identical to today.
const focusedIndex = ref<number>(panelStack.value.length - 1);

// The trailing N panels, each tagged with its TRUE stack index so navigation
// truncation (openPanelFrom) targets the right panel even though only a window
// of the stack is on screen.
const visiblePanels = computed(() => {
  const stack = panelStack.value;
  const visibleCount = Math.min(panelCount.value, stack.length);
  const windowStart = stack.length - visibleCount;
  return stack.slice(windowStart).map((route, localIndex) => ({
    route,
    trueIndex: windowStart + localIndex,
  }));
});

// Write the new full stack to the ref and mirror its VISIBLE WINDOW to the hash.
// Focus follows to the new tail (what you just opened, or the panel revealed by
// a pop). Every navigation funnels through here so there is exactly one place
// the hash is written and exactly one hash-vs-stack policy.
function applyStack(newStack: PanelStack): void {
  panelStack.value = newStack;
  focusedIndex.value = newStack.length - 1;
  const windowedHash = buildPanelStackHash(newStack.slice(-panelCount.value));
  lastWrittenHash = windowedHash;
  window.location.hash = windowedHash;
}

function onHashChange(): void {
  const currentHash = window.location.hash;
  if (currentHash === lastWrittenHash) {
    // Our own write echoing back — the ref is already the deep truth; leave it.
    return;
  }
  // External navigation (deep link, browser back/forward, manual edit): re-seed
  // from the hash. Loses any in-memory depth below the window, which is the
  // accepted POC limit (deep browser-history integration is OUT).
  panelStack.value = seedStackFromHash(currentHash);
  focusedIndex.value = panelStack.value.length - 1;
  lastWrittenHash = currentHash;
}

onMounted(() => {
  store.init();
  window.addEventListener('hashchange', onHashChange);
});
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
});

// ── navigation handlers (PanelHost emit → stack write) ──────────────────────
// Each opens its route FROM the emitting panel's index, so what was "forward" of
// that panel is discarded (openPanelFrom). The old navigate* single-route hash
// writes are GONE — nothing here sets the hash to a bare route, which would
// silently drop the stack.

function openSessionPanel(index: number, appSessionId: string): void {
  applyStack(openPanelFrom(panelStack.value, index, { view: 'stream', appSessionId }));
}
// The editor push — reached both from a view's `open` (file tree / search / git)
// and from the marquee path-click below. returnToParam is carried for URL
// fidelity but no longer honoured for "back": under the stack, popping the
// editor reveals whatever panel it was pushed from, which is the context the old
// decideEditorReturn/leaveEditor logic hand-rebuilt. (The git→editor→back
// diff-refresh edge is a known follow-up, OUT of this POC.)
function openEditorPanel(index: number, path: string, line?: number, returnTo?: 'git'): void {
  applyStack(
    openPanelFrom(panelStack.value, index, {
      view: 'editor',
      path,
      line,
      returnToParam: returnTo ?? null,
    }),
  );
}
function openFilesPanel(index: number, dir?: string | null): void {
  applyStack(openPanelFrom(panelStack.value, index, { view: 'fileTree', initialDir: dir ?? null }));
}
function openSearchPanel(index: number): void {
  applyStack(openPanelFrom(panelStack.value, index, { view: 'search' }));
}
function openTerminalPanel(index: number): void {
  applyStack(openPanelFrom(panelStack.value, index, { view: 'terminal' }));
}
function openGitPanel(index: number): void {
  applyStack(openPanelFrom(panelStack.value, index, { view: 'git' }));
}
function openCostPanel(index: number): void {
  applyStack(openPanelFrom(panelStack.value, index, { view: 'cost' }));
}
function openTasksPanel(index: number): void {
  applyStack(openPanelFrom(panelStack.value, index, { view: 'tasks' }));
}
// Back pops the TAIL (popPanel), not panel `index` — for the POC "back" always
// means "drop the last panel". A length-1 stack pops to itself (the floor); on a
// phone that reproduces today's "back from the one view goes home" because the
// panel below the tail (e.g. the session list) is what the pop reveals.
function backFrom(_index: number): void {
  applyStack(popPanel(panelStack.value));
}

// ── §E: a plain left-click on an in-app hash link PUSHES a panel ─────────────
// Delegated on each column so it knows WHICH panel the link was in. The decision
// (intercept vs let the browser handle it) is the pure, tested panelLinkClick;
// this only extracts the DOM facts (the anchor's raw href, the modifier flags,
// the button) and, on a hit, prevents the default new-tab and opens the route as
// a panel FROM the clicked panel's index. Modifier/middle/right clicks return
// null and fall through to the browser via the surviving href.
function onPanelClick(clickEvent: MouseEvent, panelIndex: number): void {
  const clickTarget = clickEvent.target as HTMLElement | null;
  const anchor = clickTarget?.closest?.('a[href^="#/"]') as HTMLAnchorElement | null;
  if (anchor === null || anchor === undefined) {
    return;
  }
  // getAttribute keeps the raw `#/...` hash; `.href` would be the absolute URL.
  const rawHref = anchor.getAttribute('href') ?? '';
  const routeToPush: Route | null = panelLinkClick({
    href: rawHref,
    hasModifier:
      clickEvent.ctrlKey || clickEvent.metaKey || clickEvent.shiftKey || clickEvent.altKey,
    button: clickEvent.button,
  });
  if (routeToPush === null) {
    return;
  }
  clickEvent.preventDefault();
  applyStack(openPanelFrom(panelStack.value, panelIndex, routeToPush));
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
    <!-- Persistent chrome above the panel row — unchanged from today. -->
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

    <!-- The panel row: the trailing N panels as equal columns, each its own
         vertical scroll, a left divider between columns. At N=1 this is one
         full-width column — no divider, no ring — rendering exactly today's
         single view. -->
    <div class="flex min-h-0 flex-1">
      <div
        v-for="(panel, localIndex) in visiblePanels"
        :key="panel.trueIndex"
        class="min-w-0 flex-1 overflow-y-auto"
        :class="localIndex > 0 ? 'border-l border-slate-200 dark:border-slate-800' : ''"
        @mousedown="focusedIndex = panel.trueIndex"
        @click="onPanelClick($event, panel.trueIndex)"
      >
        <PanelHost
          :route="panel.route"
          :index="panel.trueIndex"
          :focused="panel.trueIndex === focusedIndex && visiblePanels.length > 1"
          @open="openSessionPanel"
          @open-files="openFilesPanel"
          @open-search="openSearchPanel"
          @open-terminal="openTerminalPanel"
          @open-git="openGitPanel"
          @open-cost="openCostPanel"
          @open-tasks="openTasksPanel"
          @open-editor="openEditorPanel"
          @back="backFrom"
        />
      </div>
    </div>
  </div>
</template>
