<script setup lang="ts">
// ─── S8·2 — the project picker (D42's landing, D61's doors) ──────────────────
//
// The app's ROOT surface: `vimes.wshoffner.dev/` shows this, and every project is
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
import { computed, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import {
  describeDeclareResponse,
  projectDisplayName,
  type ProjectView,
} from '../lib/projectContext.js';

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
  </div>
</template>
