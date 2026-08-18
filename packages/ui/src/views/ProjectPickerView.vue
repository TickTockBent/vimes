<script setup lang="ts">
// ─── S8·2 — the project picker (D42's landing, D61's doors) ──────────────────
//
// The app's ROOT surface: `vimes.example.com/` shows this, and every project is
// one real link away. Two things about it are deliberate and easy to undo by
// accident:
//
//   1. **THE ROWS ARE REAL `<a href>`s, and tapping one is a REAL NAVIGATION.**
//      Not a hash swap, not a `currentProject = x` assignment. D61 made the PATH
//      the project identity — one tab, one project, in the URL bar — so opening a
//      project has to move the browser to that path, or the URL would lie about
//      what the tab is showing. Real anchors also mean long-press/middle-click
//      "open in new tab" works for free, which is how a human ends up with johnny
//      in one tab and vimes in another.
//   2. **NOTHING HERE INFERS A PROJECT** (D37/D42). The list is exactly the
//      declared registry; the "New Project" form declares one explicitly, and the
//      daemon re-checks the fence (D60) whatever this form sends.
//
// OUT of this unit, on purpose: archived projects (and un-archive), metadata
// editing, descriptions. The registry serves the archived flag and this view
// filters on it; the doors come when they have a decision behind them.
import { computed, onMounted, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import {
  describeDeclareResponse,
  projectDisplayName,
  type ProjectView,
} from '../lib/projectContext.js';
import { resolveSessionLabel } from '../lib/sessionLabel.js';
import { severityDisplayOf, type SeverityTone } from '../lib/sessionSeverityDisplay.js';

const props = defineProps<{
  // The URL segment that brought us here and named NO declared project, or null
  // when this is the bare `/` landing. Non-null turns the picker into D61's
  // onboarding door: the declare form opens, pre-filled with `prefillRoot`.
  unknownSegment: string | null;
  // The absolute path that segment proposes (declarePrefill), or null.
  prefillRoot: string | null;
}>();

const store = useVimesStore();

// Archived projects are filtered HERE rather than at the route (the route serves
// every record on purpose — the flag is on the record and clients filter).
const livingProjects = computed<ProjectView[]>(() =>
  store.projects.filter((project) => !project.archived),
);

// A project is reachable by URL only when it HAS a segment. `''` (the project IS
// a configured root) and null (its root fell outside the fence) are both honest
// non-answers from the daemon, and the row says so rather than rendering a link
// to `//` that would land back on this picker.
function projectHref(project: ProjectView): string | null {
  return project.pathSegment === null || project.pathSegment === ''
    ? null
    : `/${project.pathSegment}/`;
}

// ── the declare form ────────────────────────────────────────────────────────

const declareOpen = ref(props.unknownSegment !== null);
const declareRoot = ref(props.prefillRoot ?? firstBaseWithSeparator());
const declareName = ref('');
const declareInFlight = ref(false);
const declareNotice = ref<string | null>(null);

// With no segment to propose, the box starts at the configured root plus a
// separator so the operator types only the rest — the same courtesy the task
// board's create sheet extends for projectRoot.
function firstBaseWithSeparator(): string {
  const firstBase = store.rootsBases[0];
  if (firstBase === undefined) {
    return '';
  }
  return firstBase.endsWith('/') ? firstBase : `${firstBase}/`;
}

function toggleDeclare(): void {
  declareOpen.value = !declareOpen.value;
  if (declareOpen.value && declareRoot.value === '') {
    declareRoot.value = firstBaseWithSeparator();
  }
}

async function submitDeclare(): Promise<void> {
  const trimmedRoot = declareRoot.value.trim();
  if (declareInFlight.value || trimmedRoot === '') {
    return;
  }
  declareInFlight.value = true;
  try {
    const trimmedName = declareName.value.trim();
    const answer = await store.declareProject({
      root: trimmedRoot,
      // Absent stays absent: a blank box must not become a project named ''.
      ...(trimmedName === '' ? {} : { name: trimmedName }),
    });
    const outcome = describeDeclareResponse(answer.status, answer.body);
    declareNotice.value = outcome.sentence;
    if (outcome.kind !== 'declared') {
      return;
    }
    // `declareProject` has already REFETCHED the registry, so the record we
    // navigate to is the one the projection folded — including the pathSegment
    // the daemon derived, which the POST response does not carry.
    const declared = store.projects.find((project) => project.root === trimmedRoot);
    const href = declared === undefined ? null : projectHref(declared);
    if (href !== null) {
      // A real navigation INTO the new project, closing D61's onboarding loop:
      // the URL that proposed the declaration now opens it.
      window.location.assign(href);
      return;
    }
    // Declared, but not addressable (the base root itself). The list below now
    // shows it; say so rather than navigating somewhere that is not it.
    declareName.value = '';
    declareOpen.value = false;
  } finally {
    declareInFlight.value = false;
  }
}

// ─── S16·U5 — UNFILED'S FLOOR (slice-16 decision 7, D90's accepted consequence)
//
// ⚠ **READ THIS BEFORE EXTENDING IT. THE SMALLNESS IS THE DESIGN.**
//
// D90 ruled that a project tab's tree gates on THAT tab's project, and signed
// off on the consequence: a session that belongs to no declared project — an
// `unfiled` one — is served by the daemon and visible in NO project tab. Left
// alone that is a session going dark, which is the exact failure the whole
// attention system exists to prevent. So D90's consequence carries a FLOOR, and
// this block is it: the data is already served, and there is now one reachable
// surface in the app where an unfiled session can be SEEN.
//
// A floor is not a feature. Three things this deliberately is NOT, each one an
// omission rather than an oversight:
//
//   • **No links.** An unfiled session has no project tab to open into — that is
//     the whole reason it is unfiled — and inventing a destination for it here
//     would be inventing a scope the estate does not have.
//   • **No actions.** No file, no attach, no rename, no kill. TRIAGE IS
//     EXTENSION-ERA (the deletion map's seventh decision, ⟨Wes⟩'s lean): the
//     right home for "do something about this session" is the tree's own write
//     surface under a real filing decision, not a second write path grown on the
//     picker where nobody would look for it.
//   • **No empty state.** An empty `unfiled` renders NOTHING — not "no unfiled
//     sessions", not a zero count. This whole section is an INTERIM, and
//     chrome that announces an interim's own emptiness is chrome that has to be
//     deleted twice.
//
// A read-only listing is the entire feature. If it ever needs to be more than
// that, that is a decision to take, not a gap to fill in passing.
//
// The `unfiled` root's id, mirrored from `packages/core/src/projections/tree.ts`
// (`UNFILED_ROOT_ID`) rather than imported — the same narrow-mirroring posture
// TreeView.vue takes toward the same constant, and required here besides: no
// `.vue` file may import from `@vimes/core` at all (D87 rider 2's tightening,
// enforced by lib/coreImportPolicy.test.ts). The authority is core; keep the two
// in step. Presentation only — never to reorder or filter, which the payload
// already decided (unfiled comes LAST, and it comes even when empty).
const UNFILED_ROOT_ID = 'unfiled';

// The tree is read VERBATIM off the store, exactly as TreeView reads it: this
// view holds no copy, sorts nothing, and derives no shape of its own. `find`
// rather than an index, because "unfiled comes last" is the payload's declared
// ordering and not this view's assumption to bake in.
const unfiledRoot = computed(
  () => store.tree?.roots.find((root) => root.rootId === UNFILED_ROOT_ID) ?? null,
);

// The sessions that landed on `unfiled` by derivation rather than attachment,
// in the payload's own order. Empty (or a tree we have not read yet) renders
// nothing at all — see the omission list above.
const unfiledSessions = computed(() => unfiledRoot.value?.sessions ?? []);

// The root's rollup covers its WHOLE estate, so this is the honest "how much is
// out here" number even though only the root's own leaves are listed below.
const unfiledProcessCount = computed(() => unfiledRoot.value?.rollup.processCount ?? 0);

// The identity ladder (lib/sessionLabel.ts — the ONE answer to "what is this
// session called?"), threaded exactly as TreeView threads it. `shortId` comes
// off the payload (estate-scoped, D79) and renders separately at the row's end;
// it is NOT the ladder's bottom rung.
function sessionLabelOf(session: {
  appSessionId: string;
  name: string | null;
  derivedTitle: string | null;
  createdAt: string;
}): string {
  return resolveSessionLabel(
    {
      sessionId: session.appSessionId,
      name: session.name,
      derivedTitle: session.derivedTitle,
      earliestActivityAt: session.createdAt,
    },
    // S15-F10: `getTimezoneOffset()` returns minutes the viewer is BEHIND UTC
    // (positive = west); the ladder wants minutes EAST of UTC, hence the
    // negation. This is the view boundary — the ambient clock is allowed here,
    // never inside lib/sessionLabel.ts.
    -new Date().getTimezoneOffset(),
  );
}

// The tone family → utility class half of the severity mapping (ui-doctrine §3).
// `lib/sessionSeverityDisplay.ts` owns the severity → (tone, glyph) translation
// and must never learn a colour; each view owns this half, which is why the same
// four-row map also appears in TreeView.vue. That is the doctrine's shape, not
// drift: the SEVERITY table has exactly one home, the palette has exactly one
// home (the tokens), and this is the join between them.
const TONE_TEXT_CLASS: Readonly<Record<SeverityTone, string>> = {
  crit: 'text-crit',
  warn: 'text-warn',
  accent: 'text-accent',
  dim: 'text-ink-dim',
};

onMounted(() => {
  // Through the store's THROTTLE, not `refreshTree` directly — the same door
  // TreeView's own mount uses, and for the same reason: mounting a surface must
  // not be a way to bypass the tree's cadence. The picker and the app are
  // mutually exclusive surfaces (App.vue renders one or the other), so this is
  // never a second mount racing TreeView's.
  store.scheduleTreeRefresh();
});
</script>

<template>
  <!-- min-h-0 + flex-1: this is a direct child of App.vue's 100dvh flex-col, so
       it takes the space BELOW the persistent top bar and scrolls on its own.
       `h-full` here would measure the whole shell and push past the header. -->
  <div class="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto p-4">
    <header class="flex items-center gap-3">
      <h1 class="text-lg font-semibold text-ink">Projects</h1>
      <span class="flex-1"></span>
      <button
        type="button"
        class="min-h-[44px] rounded-md border border-line px-3 text-sm font-medium text-ink transition-colors hover:bg-panel-sunken"
        :aria-expanded="declareOpen"
        @click="toggleDeclare()"
      >
        {{ declareOpen ? 'Cancel' : 'New project' }}
      </button>
    </header>

    <!-- D61's onboarding door: a URL inside the roots that names no project. -->
    <p
      v-if="unknownSegment !== null"
      class="rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink-dim"
    >
      No project is declared at
      <span class="font-mono text-ink">/{{ unknownSegment }}/</span>. Declare it below, or pick one
      of yours.
    </p>

    <form
      v-if="declareOpen"
      class="flex flex-col gap-2 rounded-md border border-line bg-panel p-3"
      @submit.prevent="submitDeclare()"
    >
      <label class="text-xs font-medium text-ink-dim" for="declare-root">
        Directory (inside the configured project roots)
      </label>
      <input
        id="declare-root"
        v-model="declareRoot"
        type="text"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        class="min-h-[44px] rounded-md border border-line bg-panel-sunken px-3 font-mono text-sm text-ink"
        placeholder="/home/you/projects/thing"
      />
      <label class="text-xs font-medium text-ink-dim" for="declare-name">Name (optional)</label>
      <input
        id="declare-name"
        v-model="declareName"
        type="text"
        class="min-h-[44px] rounded-md border border-line bg-panel-sunken px-3 text-sm text-ink"
        :placeholder="'defaults to the directory name'"
      />
      <button
        type="submit"
        class="min-h-[44px] rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg disabled:opacity-50"
        :disabled="declareInFlight || declareRoot.trim() === ''"
      >
        {{ declareInFlight ? 'Declaring…' : 'Declare project' }}
      </button>
      <!-- The daemon's answer, rendered verbatim-ish. A refusal is never dressed
           up as a success, and the fence's 403 says which fence it was. -->
      <p v-if="declareNotice" class="text-sm text-ink-dim">{{ declareNotice }}</p>
    </form>

    <!-- "We could not read the registry" is a different fact from "there is
         nothing in it", and only one of them earns D42's blank-picker line. -->
    <div
      v-if="!store.projectsLoaded && store.projectsUnreachable"
      class="flex flex-col items-start gap-2 rounded-md border border-line bg-panel px-3 py-2"
    >
      <p class="text-sm text-ink-dim">
        Could not read the project registry — this is not the same as having no projects.
      </p>
      <button
        type="button"
        class="min-h-[44px] rounded-md border border-line px-3 text-sm font-medium text-ink transition-colors hover:bg-panel-sunken"
        @click="store.fetchProjects()"
      >
        Try again
      </button>
    </div>
    <p v-else-if="!store.projectsLoaded" class="text-sm text-ink-dim">Loading projects…</p>
    <p v-else-if="livingProjects.length === 0" class="text-sm text-ink-dim">
      No projects yet. Declare the directory you work in, and every session, task and cost under it
      becomes this project's — no backfill, no migration.
    </p>

    <ul v-else class="flex flex-col gap-2">
      <li v-for="project in livingProjects" :key="project.projectId">
        <a
          v-if="projectHref(project)"
          :href="projectHref(project)!"
          class="flex min-h-[56px] flex-col justify-center rounded-md border border-line bg-panel px-3 py-2 transition-colors hover:bg-panel-sunken"
        >
          <span class="text-sm font-medium text-ink">{{ projectDisplayName(project) }}</span>
          <span class="truncate font-mono text-xs text-ink-dim">{{ project.pathSegment }}</span>
        </a>
        <!-- Declared, but with no URL of its own: a project AT a configured root
             has an empty segment, and one whose root left the fence has none at
             all. Shown (it is a real declared boundary) and honestly not a link. -->
        <div
          v-else
          class="flex min-h-[56px] flex-col justify-center rounded-md border border-dashed border-line px-3 py-2"
        >
          <span class="text-sm font-medium text-ink">{{ projectDisplayName(project) }}</span>
          <span class="truncate font-mono text-xs text-ink-dim">{{ project.root }}</span>
          <span class="text-xs text-ink-dim">no URL of its own — see docs/decisions D61</span>
        </div>
      </li>
    </ul>

    <!-- ── UNFILED'S FLOOR (S16·U5, decision 7 / D90) ─────────────────────────
         READ-ONLY, ON PURPOSE. No `<a>`, no `<button>`, no handler anywhere in
         this section — see the long comment in the script block for why each of
         those is an omission rather than an oversight. It renders only when
         there is something to render: an empty `unfiled` produces no heading,
         no count and no empty-state line, because this whole section is an
         interim and interim chrome that announces its own emptiness has to be
         deleted twice. -->
    <section v-if="unfiledSessions.length > 0" class="flex flex-col gap-2">
      <header class="flex items-baseline gap-2">
        <h2 class="text-sm font-semibold text-ink">Unfiled</h2>
        <!-- Both numbers, because they are different facts: how many sessions
             are listed below, and what the root's rollup says is running under
             it. A single number would have to pick one and would read as the
             other. -->
        <span class="font-mono text-xs text-ink-dim">
          {{ unfiledSessions.length }} · {{ unfiledProcessCount }} live
        </span>
      </header>
      <p class="text-sm text-ink-dim">
        Sessions under no declared project. They are not in any project's tree — declare the
        directory they work in and new sessions there land in it.
      </p>
      <ul class="flex flex-col gap-1">
        <li
          v-for="session in unfiledSessions"
          :key="session.appSessionId"
          class="flex min-h-[44px] items-center gap-2 rounded-md border border-dashed border-line px-3 py-2"
        >
          <!-- The severity glyph, through the ONE mapping (lib/
               sessionSeverityDisplay.ts). `title` carries the raw severity so
               the glyph is never the only channel. -->
          <span
            class="shrink-0 font-mono text-xs"
            :class="TONE_TEXT_CLASS[severityDisplayOf(session.severity).tone]"
            :title="session.severity"
            >{{ severityDisplayOf(session.severity).glyph }}</span
          >
          <span class="min-w-0 flex-1 truncate text-sm text-ink">{{ sessionLabelOf(session) }}</span>
          <!-- The D79 handle, estate-scoped, straight off the payload — the way
               a human names one of these out loud. -->
          <span class="shrink-0 font-mono text-[10px] text-ink-dim">{{ session.shortId }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
