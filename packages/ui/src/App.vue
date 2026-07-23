<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
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
// showSidebar (D39 #3): at desktop width the session list — which is ALREADY the
// root of every stack (stack[0], D40) — renders as fixed left-hand chrome (a
// sidebar) instead of as a panel column. This is NOT a second list: it is the
// SAME stack[0], rendered by the SAME PanelHost/SessionListView, just laid out as
// a sidebar rather than windowed into the flex row. So nav, meters, new-session
// and D40 all come for free with nothing to drift (the whole point of D39 #3).
// Below desktop width showSidebar is false and the phone/tablet path is untouched.
const { panelCount, showSidebar } = useLayoutMode();

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

// ── the desktop sidebar split (D39 #3) ───────────────────────────────────────
//
// When showSidebar is true the sidebar renders stack[0] (the session list) and
// the CONTENT area renders the panels AFTER the root — stack.slice(1) — windowed
// to the trailing (panelCount - 1), because the sidebar consumes one of the N
// layout slots (desktop panelCount 3 → sidebar + up to 2 content columns). Each
// content panel keeps its TRUE stack index so openPanelFrom still targets the
// right panel through the window. Same shape as visiblePanels above, only the
// windowed range differs; the +1 restores the index the leading slice(1) drops.
// (This computed is only READ in the showSidebar template arm; the v-else arm
// still uses visiblePanels verbatim, so the phone path is untouched.)
// The sidebar always renders the stack ROOT — stack[0], the session list. The
// stack is never empty (seedStackFromHash prepends the list root, popPanel floors
// at length 1), so the root is always present; the assertion just gives the
// template a plain Route rather than Route | undefined.
const sidebarRoute = computed<Route>(() => panelStack.value[0]!);

const contentPanels = computed(() => {
  const stack = panelStack.value;
  const contentPanelSlots = Math.max(1, panelCount.value - 1);
  const contentStack = stack.slice(1); // everything past the list root (stack[0])
  const visibleCount = Math.min(contentPanelSlots, contentStack.length);
  const windowStart = contentStack.length - visibleCount;
  return contentStack.slice(windowStart).map((route, localIndex) => ({
    route,
    trueIndex: 1 + windowStart + localIndex,
  }));
});

// THE ONE hash-vs-layout policy (D40, made layout-aware). Every hash write —
// applyStack on navigation AND the resize re-mirror below — funnels through here,
// so there is a single place that decides what the URL shows.
//   • Not sidebar → EXACTLY today's write: the trailing-panelCount window. This
//     expression is deliberately left byte-identical to 70ec17d because the phone
//     byte-identity guarantee (D40) rests on it — do not reshape it.
//   • Sidebar → mirror only the CONTENT window (the same routes contentPanels
//     shows): stack.slice(1) trailing (panelCount - 1). seedStackFromHash re-adds
//     the list root on reseed, so this round-trips; and one desktop stream mirrors
//     to `#/session/x` — the SAME hash a phone produces for that state, so URLs
//     stay portable across devices. Empty content → buildPanelStackHash([]) → ''
//     → home.
function mirroredHashFor(stack: PanelStack): string {
  if (showSidebar.value) {
    const contentPanelSlots = Math.max(1, panelCount.value - 1);
    const contentWindow = stack.slice(1).slice(-contentPanelSlots);
    return buildPanelStackHash(contentWindow);
  }
  return buildPanelStackHash(stack.slice(-panelCount.value));
}

// Write the new full stack to the ref and mirror its VISIBLE WINDOW to the hash.
// Focus follows to the new tail (what you just opened, or the panel revealed by
// a pop). Every navigation funnels through here so there is exactly one place
// the hash is written and exactly one hash-vs-stack policy.
function applyStack(newStack: PanelStack): void {
  panelStack.value = newStack;
  focusedIndex.value = newStack.length - 1;
  const windowedHash = mirroredHashFor(newStack);
  lastWrittenHash = windowedHash;
  window.location.hash = windowedHash;
}

// Re-mirror the hash when a resize crosses a layout boundary. applyStack only
// runs on NAVIGATION, so a pure resize — crossing SIDEBAR_MIN_WIDTH_PX (sidebar
// ⇄ row) or a panelCount breakpoint (the window widens/narrows) — would otherwise
// leave the URL windowed for the OLD layout. This re-writes the mirror for the
// CURRENT stack (the ref is the source of truth; we do NOT re-seed it — the
// window changed, the history did not). Guarded by lastWrittenHash so it is a
// no-op when the mirror is unchanged and never loops against our own write /
// onHashChange's echo check.
watch([showSidebar, panelCount], () => {
  const reMirroredHash = mirroredHashFor(panelStack.value);
  if (reMirroredHash === lastWrittenHash) {
    return;
  }
  lastWrittenHash = reMirroredHash;
  window.location.hash = reMirroredHash;
});

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

    <!-- DESKTOP (D39 #3): the session list becomes ambient LEFT-HAND CHROME. This
         is not a new list — it is stack[0] (already the stack root, D40) rendered
         as a fixed-width sidebar via the SAME PanelHost/SessionListView instead of
         as a windowed panel column. To its right, the CONTENT window (stack.slice(1)
         trailing panelCount-1). Meters / new-session / nav ride along inside
         SessionListView for free, so there is nothing to drift. -->
    <div v-if="showSidebar" class="flex min-h-0 flex-1">
      <!-- The sidebar column: fixed width, its own scroll, a right divider. It is
           CHROME, so it takes NO focus ring (:focused=false) and no @mousedown. It
           carries the SAME nav/@open handlers a content panel does (a click in the
           list opens FROM index 0 → openPanelFrom truncates to [list] then pushes),
           plus onPanelClick so an in-app hash link inside it pushes a panel rather
           than hard-navigating the browser. -->
      <div
        class="w-80 shrink-0 overflow-y-auto border-r border-slate-200 dark:border-slate-800"
        @click="onPanelClick($event, 0)"
      >
        <PanelHost
          :route="sidebarRoute"
          :index="0"
          :focused="false"
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

      <!-- The content area: the trailing content panels beside the sidebar, each
           tagged with its TRUE stack index (openPanelFrom targets it). The ring
           rule is UNCHANGED — a content panel rings only when MORE THAN ONE content
           panel is visible. Empty (only the list is open) → a centred placeholder. -->
      <div class="flex min-h-0 flex-1">
        <div
          v-for="(panel, localIndex) in contentPanels"
          :key="panel.trueIndex"
          class="min-w-0 flex-1 overflow-y-auto"
          :class="localIndex > 0 ? 'border-l border-slate-200 dark:border-slate-800' : ''"
          @mousedown="focusedIndex = panel.trueIndex"
          @click="onPanelClick($event, panel.trueIndex)"
        >
          <PanelHost
            :route="panel.route"
            :index="panel.trueIndex"
            :focused="panel.trueIndex === focusedIndex && contentPanels.length > 1"
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
        <div
          v-if="contentPanels.length === 0"
          class="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-slate-500 dark:text-slate-400"
        >
          Select a session, or start one from the sidebar.
        </div>
      </div>
    </div>

    <!-- PHONE / TABLET: UNCHANGED from 70ec17d. The panel row: the trailing N
         panels as equal columns, each its own vertical scroll, a left divider
         between columns. At N=1 this is one full-width column — no divider, no
         ring — rendering exactly today's single view. -->
    <div v-else class="flex min-h-0 flex-1">
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
