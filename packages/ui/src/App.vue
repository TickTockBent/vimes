<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import PanelHost from './components/PanelHost.vue';
import { useVimesStore } from './stores/vimesStore.js';
import { type Route } from './lib/route.js';
import {
  buildPanelStackHash,
  closePanelAt,
  openPanelFrom,
  parsePanelStack,
  type PanelStack,
} from './lib/panelStack.js';
import { panelLinkClick } from './lib/panelLinkClick.js';
import { useLayoutMode } from './lib/useLayoutMode.js';
import ThemePicker from './components/ThemePicker.vue';
import UsageGauge from './components/UsageGauge.vue';
import ProjectPickerView from './views/ProjectPickerView.vue';
import {
  declarePrefill,
  initialHashFor,
  layoutStorageKey,
  parseProjectPath,
  projectDisplayName,
  resolveProject,
} from './lib/projectContext.js';
import {
  describeEnsureOutcome,
  sessionToOpenAfterEnsure,
  type EnsureOutcomeNotice,
} from './lib/orchestratorEntry.js';

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

// D41: on a desktop panel the button that closes it reads "close ✕"; on a phone
// (one panel, "back" = go up) it stays "back". Tablet keeps the current
// paradigm with the panel row, so it stays 'back' too — the sidebar is the
// desktop signal. The ACTION is closePanelAt either way (backFrom); only the
// affordance differs.
const backKind = computed<'back' | 'close'>(() => (showSidebar.value ? 'close' : 'back'));

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

// ── the project context (S8·2, D61) ─────────────────────────────────────────
//
// THE PATH CARRIES THE PROJECT; THE HASH CARRIES THE VIEW. Both are read ONCE, at
// boot, before anything in this file writes either: `bootHash` in particular has
// to be captured ahead of the first `applyStack`, or a remembered layout would
// overwrite the deep link the user actually followed.
//
// The pathname is NOT reactive here on purpose. Changing project is a REAL
// navigation (a full document load — see ProjectPickerView), so within one
// document's life the segment is a constant. Making it a ref would imply a
// project switch this build does not do and cannot do without swapping the whole
// panel stack, the WS subscriptions and the store's scope in one step.
const bootProjectSegment = parseProjectPath(window.location.pathname);
const bootHash = window.location.hash;

// Which surface this document shows. Three outcomes, exactly D61's:
//   • a segment that RESOLVES → the app, scoped (`store.currentProject`);
//   • bare `/` → the picker;
//   • a segment nothing claims → the picker, in declare-prefill mode.
// Plus one that is not a D61 outcome but a compatibility guarantee: a deep link
// with NO project segment (`/#/session/x`, which is what every push notification
// still sends, and every bookmark made before today) renders the app IMMEDIATELY,
// unscoped — never the picker, and never blocked on the registry fetch.
const bootHasDeepLink = bootHash !== '' && bootHash !== '#';
const surface = computed<'loading' | 'picker' | 'app'>(() => {
  if (bootProjectSegment === null && bootHasDeepLink) {
    return 'app';
  }
  if (!store.projectsLoaded && !store.projectsUnreachable) {
    // We have not looked at the registry yet, so we do not yet know whether this
    // path is a project. Rendering the picker here would flash a "no such
    // project" at someone whose project is about to resolve.
    //
    // ⚠ A FAILED read counts as HAVING LOOKED. Gating only on `projectsLoaded`
    // would leave the whole app parked on a spinner forever the one time the
    // registry fetch fails — the picker, which can say so and offer a retry, is
    // strictly better than a screen with nothing on it.
    return 'loading';
  }
  return store.currentProject === null ? 'picker' : 'app';
});

// The absolute path the picker's declare form pre-fills when the URL named a
// segment no project claims — D61's onboarding door.
const declarePrefillRoot = computed(() =>
  store.projectsLoaded && store.currentProject === null
    ? declarePrefill(bootProjectSegment, store.rootsBases)
    : null,
);
// The segment to SAY is undeclared. Only once we have a REGISTRY (not merely an
// attempt) and only when it really resolved to nothing — offering to declare a
// directory because the fetch failed would be an invitation to declare a
// duplicate.
const unclaimedSegment = computed(() =>
  store.projectsLoaded && store.currentProject === null ? bootProjectSegment : null,
);

// Resolve the URL against the registry, then root the stack. Runs whenever a
// registry lands and this document has not resolved yet — the resolution is
// against DECLARED records (D42), so it cannot happen before they do, and a
// retry after a failed first read has to get a second chance at it.
//
// ONE-WAY. Once a project has resolved, nothing re-runs this: changing project is
// a full navigation (D61), never a re-resolution under a live panel stack.
function applyProjectContext(): void {
  if (store.currentProject !== null) {
    return;
  }
  const resolvedProject = resolveProject(bootProjectSegment, store.projects);
  store.setCurrentProject(resolvedProject);
  if (resolvedProject === null) {
    return;
  }
  // D61's third leg: the remembered layout, unless the URL carried a deep link,
  // which always wins. `initialHashFor` owns that precedence.
  const openingHash = initialHashFor(bootHash, readStoredLayout(resolvedProject.projectId));
  panelStack.value = seedStackFromHash(openingHash);
  focusedIndex.value = panelStack.value.length - 1;
  if (openingHash !== window.location.hash) {
    lastWrittenHash = openingHash;
    window.location.hash = openingHash;
  }
}

// Per-project panel-stack memory. Best-effort on BOTH sides (localStorage throws
// in private mode / when disabled): a lost layout is a cosmetic loss, and it must
// never take the app down with it. The pure precedence lives in
// lib/projectContext.ts; these two are the glue that touches the browser.
function readStoredLayout(projectId: string): string | null {
  try {
    return window.localStorage.getItem(layoutStorageKey(projectId));
  } catch {
    return null;
  }
}

// Called from every place that writes the hash (applyStack, the resize
// re-mirror, and an external hashchange) so the memory tracks what the URL
// actually shows. A no-op without a project context — an unscoped tab has no
// project to remember a layout FOR.
function rememberLayout(hashValue: string): void {
  const project = store.currentProject;
  if (project === null) {
    return;
  }
  try {
    window.localStorage.setItem(layoutStorageKey(project.projectId), hashValue);
  } catch {
    // Persisting is best-effort; this session's in-memory stack is unaffected.
  }
}

// The scope chip in the top bar: the one always-visible statement of which
// project this tab is, and the way back to the picker. A REAL link to `/`, for
// the same reason the picker's rows are real links — switching project is a
// navigation, not a state change.
const scopeLabel = computed(() =>
  store.currentProject === null ? null : projectDisplayName(store.currentProject),
);

// ── the orchestrator door (S8·5, D56) ────────────────────────────────────────
//
// The standing per-project orchestrator's own top-level surface: a header
// button (beside the scope chip, only when a project is scoped) that ENSURES
// it exists and is live, then opens its stream panel — the SAME route shape
// (`{ view: 'stream', appSessionId }`) and the same `openSessionPanel` write
// every other session-opening path in this file uses. Busy-guarded so a
// double-tap while the ensure is in flight cannot fire a second request.
const orchestratorBusy = ref(false);
const orchestratorNotice = ref<EnsureOutcomeNotice | null>(null);

async function openOrchestrator(): Promise<void> {
  const project = store.currentProject;
  if (project === null || orchestratorBusy.value) {
    return;
  }
  orchestratorBusy.value = true;
  orchestratorNotice.value = null;
  try {
    const answer = await store.ensureOrchestrator(project.projectId);
    // Opening comes FIRST: a founded/resumed session that also has something
    // to say (a rotation, an undelivered briefing) still opens — the notice is
    // a separate, additive fact, never a gate on getting into the chat.
    const sessionId = sessionToOpenAfterEnsure(answer.status, answer.body);
    if (sessionId !== null) {
      openSessionPanel(panelStack.value.length - 1, sessionId);
    }
    orchestratorNotice.value = describeEnsureOutcome(answer.status, answer.body);
  } finally {
    orchestratorBusy.value = false;
  }
}

function dismissOrchestratorNotice(): void {
  orchestratorNotice.value = null;
}

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
  rememberLayout(windowedHash);
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
  rememberLayout(reMirroredHash);
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
  // Browser back/forward and hand-edited URLs move the layout too, so the memory
  // follows them — otherwise "where I left off" would only track in-app taps.
  rememberLayout(currentHash);
}

onMounted(() => {
  store.init();
  window.addEventListener('hashchange', onHashChange);
  // The registry, then the resolution. D42's boundaries are DECLARED records, so
  // there is nothing to resolve a URL against until this lands.
  void store.fetchProjects();
});

// Every registry read re-attempts the resolution (applyProjectContext is a no-op
// once resolved). That is what makes the picker's retry — and a declaration made
// against this very URL — open the project instead of leaving the tab parked.
watch(
  () => store.projects,
  () => {
    applyProjectContext();
  },
);
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
// Back on panel `index` closes panel `index` AND everything opened after it
// (truncate forward, mirroring openPanelFrom): the editor opened FROM a file
// closes with the file, so there's no orphaned child left dangling. On the
// TAIL this is exactly popPanel (closePanelAt(stack, stack.length-1) ===
// popPanel(stack), pinned in panelStack.test.ts), so the phone path — where
// only the tail panel is ever visible — is unchanged: back from the one view
// still goes home, one panel at a time. A length-1 stack floors to itself, as
// always. Applies in BOTH layout arms — the sidebar's @back="backFrom" (index
// 0) and every content panel's, wired identically.
function backFrom(index: number): void {
  applyStack(closePanelAt(panelStack.value, index));
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

// ── sidebar collapse (unit 6b·3a) ────────────────────────────────────────────
// Desktop-only presentation state (rule 0.3 boundary — layout, never a projection
// input): whether the ambient session-list sidebar is hidden so the content frames
// fill the full width. Persisted to localStorage so the choice survives a reload;
// the parse is a trivial boolean so it stays inline (glue, not unit-tested per the
// house rule). On tablet/mobile showSidebar is false, so this ref is inert and its
// toggle is hidden — collapsing only means anything in the sidebar layout paradigm.
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'vimes.sidebarCollapsed';

function readStoredSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    // localStorage can throw (private mode, disabled) — default to expanded.
    return false;
  }
}

const sidebarCollapsed = ref<boolean>(readStoredSidebarCollapsed());

function toggleSidebarCollapsed(): void {
  const nextCollapsed = !sidebarCollapsed.value;
  sidebarCollapsed.value = nextCollapsed;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(nextCollapsed));
  } catch {
    // Persisting is best-effort; the in-memory ref still drives this session.
  }
}
</script>

<template>
  <div class="flex h-[100dvh] flex-col overflow-hidden">
    <!-- PERSISTENT TOP BAR (unit 6b·3a). A flex-none child of the 100dvh flex-col
         shell, ABOVE the frame-row split and rendered in ALL layouts (not gated by
         showSidebar), so the brand and — the point of this unit — the theme picker
         are reachable on desktop, tablet AND mobile. It carries: a desktop-only
         sidebar-collapse toggle, the VIMES wordmark, a spacer, a slot for the
         usage gauge (unit 3b), and the picker (moved here from the sidebar foot).
         flex-none keeps it out of the frame row's bounded height, so the 100dvh
         model and the frames' own scrolling are untouched. -->
    <header class="flex flex-none items-center gap-2 border-b border-line bg-panel px-3 py-2">
      <!-- Sidebar-collapse toggle: desktop only (showSidebar). On tablet/mobile
           there is no ambient sidebar, so the control is hidden and the ref inert. -->
      <button
        v-if="showSidebar"
        type="button"
        class="flex h-8 w-8 flex-none items-center justify-center rounded-md text-lg text-ink-dim transition-colors hover:bg-panel-sunken hover:text-ink"
        :aria-pressed="sidebarCollapsed"
        aria-label="Toggle sidebar"
        title="Hide/show sidebar"
        @click="toggleSidebarCollapsed()"
      >
        <span aria-hidden="true">☰</span>
      </button>
      <span class="font-mono text-sm font-bold tracking-[0.14em] text-ink">VIMES</span>
      <!-- The scope chip (S8·2): which project this tab IS, and the door back to
           the picker. A real `<a href="/">` — switching project is a navigation
           (D61), so this must not be a click handler that swaps state. -->
      <a
        v-if="scopeLabel"
        href="/"
        class="min-w-0 truncate rounded-md border border-line px-2 py-1 text-xs text-ink-dim transition-colors hover:bg-panel-sunken hover:text-ink"
        title="Switch project"
      >
        {{ scopeLabel }}
      </a>
      <!-- The orchestrator door (S8·5, D56): the standing per-project
           orchestrator's own top-level surface — matches the scope chip's
           markup/tokens, project-gated the same way. -->
      <button
        v-if="store.currentProject !== null"
        type="button"
        class="min-w-0 shrink-0 truncate rounded-md border border-line px-2 py-1 text-xs text-ink-dim transition-colors hover:bg-panel-sunken hover:text-ink disabled:opacity-50"
        :disabled="orchestratorBusy"
        title="Talk to this project's standing orchestrator"
        @click="openOrchestrator()"
      >
        {{ orchestratorBusy ? 'Opening…' : 'Orchestrator' }}
      </button>
      <span class="flex-1"></span>
      <!-- usage gauge (unit 3b): the account-usage instrument — binding constraint
           always visible, click to expand every window. Right region so it shows in
           every layout, ahead of the theme picker. -->
      <UsageGauge />
      <ThemePicker />
    </header>

    <!-- Persistent chrome above the panel row — unchanged from today. -->
    <div v-if="bannerText" class="sticky top-0 z-30 bg-warn px-4 py-2 text-center text-sm font-medium text-accent-fg">
      {{ bannerText }}
    </div>
    <div
      v-if="store.lastRefusal"
      class="sticky top-0 z-30 flex items-center justify-between gap-3 bg-crit px-4 py-2 text-sm text-accent-fg"
    >
      <span class="truncate">{{ store.lastRefusal.reason }}</span>
      <button
        type="button"
        class="min-h-[44px] min-w-[44px] shrink-0 rounded px-3 font-semibold active:bg-crit/80"
        @click="store.dismissRefusal()"
      >
        Dismiss
      </button>
    </div>
    <!-- The orchestrator ensure notice (S8·5): mirrors the refusal strip's
         dismissible idiom, tone-mapped onto the design system's info/warn
         tokens — 'warn' matches the solid bg-warn banners above, 'info' uses
         the lighter accent-tinted surface GitPanel's own info notice uses
         (border-accent/30 bg-accent/10 text-accent), since a founding is
         worth noting but is not a problem. -->
    <div
      v-if="orchestratorNotice"
      class="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 py-2 text-sm"
      :class="
        orchestratorNotice.tone === 'warn'
          ? 'bg-warn text-accent-fg'
          : 'border-b border-accent/30 bg-accent/10 text-accent'
      "
    >
      <span class="truncate">{{ orchestratorNotice.text }}</span>
      <button
        type="button"
        class="min-h-[44px] min-w-[44px] shrink-0 rounded px-3 font-semibold"
        :class="orchestratorNotice.tone === 'warn' ? 'active:bg-warn/80' : 'active:bg-accent/20'"
        @click="dismissOrchestratorNotice()"
      >
        Dismiss
      </button>
    </div>

    <!-- THE PICKER IS THE ROOT SURFACE (D42's landing, D61's resolution rules):
         bare `/`, or a path that names no declared project. It REPLACES the panel
         shell rather than sitting inside it — this document is not in a project,
         so there is no stack to render. -->
    <ProjectPickerView
      v-if="surface === 'picker'"
      :unknown-segment="unclaimedSegment"
      :prefill-root="declarePrefillRoot"
    />
    <!-- Between the registry fetch and its answer we do not yet know whether this
         path is a project. Saying so beats flashing a picker at someone whose
         project is one round trip from resolving. -->
    <div
      v-else-if="surface === 'loading'"
      class="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-ink-dim"
    >
      Loading projects…
    </div>

    <!-- DESKTOP (D39 #3): the session list becomes ambient LEFT-HAND CHROME. This
         is not a new list — it is stack[0] (already the stack root, D40) rendered
         as a fixed-width sidebar via the SAME PanelHost/SessionListView instead of
         as a windowed panel column. To its right, the CONTENT window (stack.slice(1)
         trailing panelCount-1). Meters / new-session / nav ride along inside
         SessionListView for free, so there is nothing to drift. -->
    <div v-else-if="showSidebar" class="flex min-h-0 flex-1">
      <!-- The sidebar column: fixed width, its own scroll, a right divider. It is
           CHROME, so it takes NO focus ring (:focused=false) and no @mousedown. It
           carries the SAME nav/@open handlers a content panel does (a click in the
           list opens FROM index 0 → openPanelFrom truncates to [list] then pushes),
           plus onPanelClick so an in-app hash link inside it pushes a panel rather
           than hard-navigating the browser. -->
      <div
        v-if="!sidebarCollapsed"
        class="flex w-80 shrink-0 flex-col overflow-hidden border-r border-line"
        @click="onPanelClick($event, 0)"
      >
        <!-- The session list scrolls on its OWN (SessionListView is h-full +
             overflow-y-auto); this wrapper gives it the bounded height. The unit
             6b·1 frame structure is intact: an overflow-hidden column with the
             PanelHost in a min-h-0 flex-1 region. The theme-picker foot (added in
             6b·2) has MOVED to the persistent top bar (unit 6b·3a) so it is
             reachable in every layout, not just desktop; nothing scrolls the doc. -->
        <div class="min-h-0 flex-1">
          <PanelHost
            :route="sidebarRoute"
            :index="0"
            :focused="false"
            :back-kind="backKind"
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

      <!-- The content area: the trailing content panels beside the sidebar, each
           tagged with its TRUE stack index (openPanelFrom targets it). The ring
           rule is UNCHANGED — a content panel rings only when MORE THAN ONE content
           panel is visible. Empty (only the list is open) → a centred placeholder. -->
      <div class="flex min-h-0 flex-1">
        <div
          v-for="(panel, localIndex) in contentPanels"
          :key="panel.trueIndex"
          class="min-w-0 flex-1 overflow-y-auto"
          :class="localIndex > 0 ? 'border-l border-line' : ''"
          @mousedown="focusedIndex = panel.trueIndex"
          @click="onPanelClick($event, panel.trueIndex)"
        >
          <PanelHost
            :route="panel.route"
            :index="panel.trueIndex"
            :focused="panel.trueIndex === focusedIndex && contentPanels.length > 1"
            :back-kind="backKind"
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
          class="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-ink-dim"
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
        :class="localIndex > 0 ? 'border-l border-line' : ''"
        @mousedown="focusedIndex = panel.trueIndex"
        @click="onPanelClick($event, panel.trueIndex)"
      >
        <PanelHost
          :route="panel.route"
          :index="panel.trueIndex"
          :focused="panel.trueIndex === focusedIndex && visiblePanels.length > 1"
          :back-kind="backKind"
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
