<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import {
  absoluteRepoFilePath,
  decideDiffRestore,
  decideGitRoot,
  diffLineStyle,
  groupStatusRows,
  summarizeDiffStat,
  type GitStatusRow,
} from '../lib/gitReview.js';

// Git review panel — the PRIMARY HUMAN JOB (spec §3.4: reviewing agent diffs) and
// the slice-4 KILL CRITERION: the mobile hunk diff must be legible enough to
// actually review agent diffs on a phone. One-column flow (principle 11 — the diff
// owns the width, no file-rail chrome tax):
//   root picker → changed-files list → tap a file → its unified diff → back.
// Staging is FILE-LEVEL (the step-1 API is path-level). HUNK-LEVEL staging is
// DEFERRED to a future API extension — hunks are shown READ-ONLY for review; the
// review loop (see the diff clearly, then stage/commit or leave it) is fully
// covered. No push/pull/merge (the raw terminal is the escape hatch).

// `openEditor` carries the ABSOLUTE file path; App.vue routes it to the CM6
// editor with returnTo=git, closing the review → fix → re-review loop.
// D41: this panel's close affordance. The header button is CONDITIONAL —
// `activeFilePath ? backToList() : emit('back')` — and only the `emit('back')`
// branch (no active file) actually closes the panel, so only THAT branch
// respects `backKind`. The `backToList()` branch is in-view navigation (diff →
// changed-files list) and keeps its current label/aria regardless of
// `backKind`. The click handler is UNCHANGED — only the label/aria differ.
const props = defineProps<{ backKind?: 'back' | 'close' }>();
const emit = defineEmits<{ back: []; openEditor: [absolutePath: string] }>();
const store = useVimesStore();

// The repo picker (2026-07-21 gate finding). The panel used to offer the
// configured project ROOTS — but VIMES_PROJECT_ROOTS is a CONTAINER of repos
// (D21: ~/projects), so no entry was ever a repository and the diff surface was
// unreachable. It now picks from DISCOVERED repos (GET /api/git/repos), with the
// free-text path field beside it as the escape hatch (pillar 7) for a repo
// discovery didn't surface — exactly the shape that fixed the terminal's
// identical gap. The daemon re-resolves every root against the allowlist, so
// there is NO client-side path validation beyond non-empty (see decideGitRoot).
const repos = computed(() => store.gitRepos);
const selectedRepoPath = ref<string>('');
const rootPathField = ref<string>('');
// The root actually loaded — only ever set through decideGitRoot, so the status
// fetches never chase keystrokes in the free-text field.
const activeRoot = ref<string>('');
// A local (client-side) notice for "you picked nothing" — daemon refusals go to
// store.gitError, which stays the authoritative channel.
const rootNotice = ref<string | null>(null);

// The file whose diff is on screen (null = the changed-files list). Two-step back,
// like TerminalView: from a diff, return to the list; from the list, leave home.
const activeFilePath = ref<string | null>(null);
// The diff screen toggles between the worktree (unstaged) diff and the staged
// diff (staged=1) for the active file.
const diffShowsStaged = ref(false);

// Set when a remembered diff could not be reopened because the file is no longer
// in status (the edit made it clean) — the reviewer gets a reason instead of an
// empty diff screen.
const restoreNotice = ref<string | null>(null);

const commitMessage = ref('');
const committing = ref(false);
const commitNotice = ref<string | null>(null);

// The branch + changed-files buckets, derived from the fetched status. Grouped
// staged → unstaged → untracked, each path-sorted (stable, no jitter between
// fetches). See lib/gitReview.ts (pure + unit-tested).
const branchInfo = computed(() => store.gitStatus?.status.branch ?? null);
const branchLabel = computed(() => {
  const branch = branchInfo.value;
  if (branch === null) {
    return '';
  }
  if (branch.head !== null) {
    return branch.head;
  }
  return branch.oid === null ? '(no commits yet)' : '(detached)';
});
const aheadBehindLabel = computed(() => {
  const branch = branchInfo.value;
  if (branch === null) {
    return '';
  }
  const parts: string[] = [];
  if (branch.ahead !== null && branch.ahead > 0) {
    parts.push(`↑${branch.ahead}`);
  }
  if (branch.behind !== null && branch.behind > 0) {
    parts.push(`↓${branch.behind}`);
  }
  return parts.join(' ');
});

const grouped = computed(() => groupStatusRows(store.gitStatus?.status.entries ?? []));
const changedFileCount = computed(
  () => grouped.value.staged.length + grouped.value.unstaged.length + grouped.value.untracked.length,
);

// The compact diffstat for the file currently on screen (summarizeDiffStat over
// the fetched hunks — pure + unit-tested). Empty until a file's diff is loaded.
const activeDiffStat = computed(() => summarizeDiffStat(store.gitDiffFiles));

// The ABSOLUTE path of the file on the diff screen. Status rows are REPO-
// RELATIVE; the editor route needs absolute. The join is the tested helper
// absoluteRepoFilePath, never an inline concat — D25 is the bug that taught us.
// The daemon's canonical repoRoot leads; activeRoot (what the user typed) is the
// fallback before the first status lands.
const activeFileAbsolutePath = computed(() => {
  if (activeFilePath.value === null) {
    return '';
  }
  const canonicalRepoRoot = store.gitStatus?.repoRoot ?? activeRoot.value;
  return absoluteRepoFilePath(canonicalRepoRoot, activeFilePath.value);
});

async function refreshStatus(): Promise<void> {
  if (activeRoot.value === '') {
    return;
  }
  await store.fetchGitStatus(activeRoot.value);
}

// Apply the current picker + field state as the repo root under review. The
// free-text field wins when non-empty; otherwise the dropdown selection. An
// unusable pair surfaces a visible notice, never a silent no-op.
async function applyRoot(): Promise<void> {
  const decision = decideGitRoot(rootPathField.value, selectedRepoPath.value);
  if (!decision.ok) {
    rootNotice.value = decision.error;
    return;
  }
  rootNotice.value = null;
  activeRoot.value = decision.root;
  store.lastGitRoot = decision.root;
  activeFilePath.value = null;
  store.clearGitDiff();
  commitNotice.value = null;
  await refreshStatus();
  await restoreRememberedDiff();
}

// After a status load, reopen the diff the reviewer left behind for the editor
// (if any). The context is CONSUMED unconditionally — a stale one must not
// resurrect on a later, unrelated visit. decideDiffRestore (pure, tested) owns
// the branch; this function only performs it.
async function restoreRememberedDiff(): Promise<void> {
  const rememberedContext = store.pendingGitDiffContext;
  const changedFilePaths = (store.gitStatus?.status.entries ?? []).map((entry) => entry.path);
  const decision = decideDiffRestore(rememberedContext, activeRoot.value, changedFilePaths);
  if (decision.action === 'none') {
    store.pendingGitDiffContext = null;
    return;
  }
  store.pendingGitDiffContext = null;
  if (decision.action === 'fallback') {
    activeFilePath.value = null;
    store.clearGitDiff();
    restoreNotice.value = `${decision.repoRelativePath} has no changes left — showing the file list.`;
    return;
  }
  restoreNotice.value = null;
  activeFilePath.value = decision.repoRelativePath;
  diffShowsStaged.value = decision.showsStaged;
  // The re-fetch is the point: an edit made in the editor shows up immediately.
  await loadActiveDiff();
}

// Load (or reload) the active file's diff for the current worktree/staged toggle.
async function loadActiveDiff(): Promise<void> {
  if (activeRoot.value === '' || activeFilePath.value === null) {
    return;
  }
  await store.fetchGitDiff(activeRoot.value, activeFilePath.value, diffShowsStaged.value);
}

// Tap a file → open its diff. Default to whichever side has content: if the file
// is staged-only, show the staged diff; otherwise show the worktree diff.
async function openFileDiff(row: GitStatusRow): Promise<void> {
  restoreNotice.value = null;
  activeFilePath.value = row.path;
  diffShowsStaged.value = row.hasStaged && !row.hasUnstaged;
  await loadActiveDiff();
}

function backToList(): void {
  activeFilePath.value = null;
  store.clearGitDiff();
  // Leaving the diff normally forgets it, so a later visit lands on the file
  // list exactly as it did before edit-from-diff existed.
  store.pendingGitDiffContext = null;
  restoreNotice.value = null;
}

// Edit this file: remember where to come back to (in the STORE — this component
// unmounts during the editor visit), then hand App.vue the ABSOLUTE path.
function editActiveFile(): void {
  const absolutePath = activeFileAbsolutePath.value;
  if (activeFilePath.value === null || absolutePath === '') {
    return;
  }
  store.pendingGitDiffContext = {
    repoRoot: activeRoot.value,
    repoRelativePath: activeFilePath.value,
    showsStaged: diffShowsStaged.value,
  };
  emit('openEditor', absolutePath);
}

async function stageRow(row: GitStatusRow): Promise<void> {
  if (activeRoot.value === '') {
    return;
  }
  commitNotice.value = null;
  await store.stageGitPath(activeRoot.value, row.path);
}

async function unstageRow(row: GitStatusRow): Promise<void> {
  if (activeRoot.value === '') {
    return;
  }
  commitNotice.value = null;
  await store.unstageGitPath(activeRoot.value, row.path);
}

async function commit(): Promise<void> {
  const message = commitMessage.value.trim();
  if (message === '' || committing.value || activeRoot.value === '') {
    return;
  }
  committing.value = true;
  commitNotice.value = null;
  const result = await store.commitGit(activeRoot.value, message);
  committing.value = false;
  if (result.ok) {
    commitMessage.value = '';
    commitNotice.value = 'Committed.';
  }
}

// Picking a repo from the dropdown prefills the free-text field with it (so the
// field always shows what will be used, and stays editable for a subpath) and
// loads that repo immediately — a tap is the whole interaction on mobile.
watch(selectedRepoPath, (repoPath) => {
  if (repoPath === '') {
    return;
  }
  rootPathField.value = repoPath;
  void applyRoot();
});

// Flipping the worktree/staged toggle reloads the active file's diff.
watch(diffShowsStaged, () => {
  void loadActiveDiff();
});

onMounted(async () => {
  await store.fetchGitRepos();
  // Prefer the repo the reviewer was last on (remembered in the store across
  // mounts); otherwise the first discovered repo. Neither → the free-text field
  // is the way in, and the template says so.
  const rememberedRoot = store.lastGitRoot;
  const remembered = repos.value.find((repo) => repo.path === rememberedRoot);
  if (remembered !== undefined) {
    selectedRepoPath.value = remembered.path;
    return;
  }
  if (rememberedRoot !== '') {
    rootPathField.value = rememberedRoot;
    await applyRoot();
    return;
  }
  if (repos.value.length > 0) {
    selectedRepoPath.value = repos.value[0]!.path;
  }
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-panel text-ink">
    <header
      class="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-panel px-3 py-2"
    >
      <button
        type="button"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-lg text-ink-dim active:bg-panel-sunken"
        :aria-label="
          activeFilePath
            ? 'Back to changed files'
            : props.backKind === 'close'
              ? 'Close panel'
              : 'Back to sessions'
        "
        @click="activeFilePath ? backToList() : emit('back')"
      >
        {{ !activeFilePath && props.backKind === 'close' ? '✕' : '‹' }}
      </button>
      <h1 class="flex-1 truncate font-semibold uppercase tracking-[0.08em] text-ink">
        {{ activeFilePath ? 'Diff' : 'Git' }}
      </h1>
      <span v-if="branchLabel" class="shrink-0 truncate text-xs font-mono tabular-nums text-ink-dim">
        {{ branchLabel }}<span v-if="aheadBehindLabel"> · {{ aheadBehindLabel }}</span>
      </span>
    </header>

    <p
      v-if="store.gitError"
      class="border-b border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit"
    >
      {{ store.gitError }}
    </p>

    <!-- ── Changed-files list (home) ───────────────────────────────────────── -->
    <div v-if="!activeFilePath" class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      <div class="mx-auto flex max-w-2xl flex-col gap-4">
        <section class="flex flex-col gap-2">
          <label for="git-repo-picker" class="text-xs font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim">
            Repository
          </label>
          <select
            v-if="repos.length > 0"
            id="git-repo-picker"
            v-model="selectedRepoPath"
            class="min-h-[44px] w-full rounded-md border border-line bg-panel px-2 text-sm text-ink"
          >
            <option v-for="repo in repos" :key="repo.path" :value="repo.path">{{ repo.name }}</option>
          </select>
          <p v-else class="text-sm text-ink-dim">
            No git repos found under your project roots — type a path below.
          </p>
          <!-- The escape hatch beside the abstraction: any path the daemon's
               allowlist accepts, including a repo discovery didn't reach. -->
          <label class="flex flex-col gap-1 text-xs text-ink-dim">
            Repository path (edit to reach a repo not listed above)
            <input
              v-model="rootPathField"
              type="text"
              inputmode="url"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="/home/you/projects/some/repo"
              class="min-h-[44px] w-full rounded-md border border-line bg-panel px-2 font-mono text-sm text-ink"
              @keyup.enter="applyRoot"
            />
          </label>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="min-h-[44px] rounded-md border border-line px-4 text-sm font-semibold text-ink-dim active:bg-panel-sunken"
              @click="applyRoot"
            >
              Load repo
            </button>
            <span v-if="activeRoot" class="truncate font-mono text-xs text-ink-dim">{{ activeRoot }}</span>
          </div>
          <p v-if="rootNotice" class="text-sm text-warn">{{ rootNotice }}</p>
          <p v-if="activeRoot" class="text-xs text-ink-dim">
            <span class="font-medium text-ink">{{ branchLabel || '—' }}</span>
            · {{ changedFileCount }} changed {{ changedFileCount === 1 ? 'file' : 'files' }}
          </p>
        </section>

        <p
          v-if="restoreNotice"
          class="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent"
        >
          {{ restoreNotice }}
        </p>

        <p v-if="changedFileCount === 0 && store.gitStatus" class="rounded-lg border border-line p-4 text-center text-sm text-ink-dim">
          Working tree clean — nothing to review.
        </p>

        <!-- Grouped buckets: staged → unstaged → untracked (most-meaningful first). -->
        <template v-for="bucket in ([
          { key: 'staged', label: 'Staged', rows: grouped.staged },
          { key: 'unstaged', label: 'Unstaged', rows: grouped.unstaged },
          { key: 'untracked', label: 'Untracked', rows: grouped.untracked },
        ] as const)" :key="bucket.key">
          <section v-if="bucket.rows.length > 0" class="flex flex-col gap-2">
            <h2 class="px-1 text-xs font-semibold font-mono uppercase tracking-[0.08em] text-ink-dim">
              {{ bucket.label }} ({{ bucket.rows.length }})
            </h2>
            <ul class="flex flex-col gap-2">
              <li
                v-for="row in bucket.rows"
                :key="row.path"
                class="flex items-center gap-2 rounded-lg border border-line bg-panel p-2"
              >
                <button
                  type="button"
                  class="flex min-h-[44px] flex-1 flex-col items-start justify-center gap-0.5 rounded-md px-2 text-left active:bg-panel-sunken"
                  @click="openFileDiff(row)"
                >
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="font-medium text-ink">{{ row.pathTail }}</span>
                    <span
                      class="rounded px-1.5 py-0.5 text-[10px] font-semibold font-mono uppercase tracking-[0.08em]"
                      :class="row.group === 'staged'
                        ? 'bg-ok/10 text-ok'
                        : row.group === 'untracked'
                          ? 'bg-panel-sunken text-ink-dim'
                          : 'bg-warn/10 text-warn'"
                    >{{ row.statusLabel }}</span>
                    <span
                      v-if="row.hasStaged && row.hasUnstaged"
                      class="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold font-mono uppercase tracking-[0.08em] text-accent"
                    >partly staged</span>
                  </span>
                  <span class="truncate text-xs text-ink-dim">{{ row.path }}</span>
                  <span v-if="row.origPath" class="truncate text-[11px] text-ink-dim">was {{ row.origPath }}</span>
                </button>
                <button
                  v-if="row.hasUnstaged"
                  type="button"
                  class="min-h-[44px] shrink-0 rounded-md border border-ok/40 px-3 text-xs font-semibold text-ok active:bg-ok/10"
                  @click="stageRow(row)"
                >
                  Stage
                </button>
                <button
                  v-if="row.hasStaged"
                  type="button"
                  class="min-h-[44px] shrink-0 rounded-md border border-line px-3 text-xs font-semibold text-ink-dim active:bg-panel-sunken"
                  @click="unstageRow(row)"
                >
                  Unstage
                </button>
              </li>
            </ul>
          </section>
        </template>

        <!-- Commit composer -->
        <section v-if="activeRoot" class="flex flex-col gap-2 rounded-lg border border-line p-3">
          <label for="git-commit-message" class="text-sm font-medium text-ink">Commit staged changes</label>
          <textarea
            id="git-commit-message"
            v-model="commitMessage"
            rows="3"
            placeholder="Commit message"
            class="min-h-[72px] w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
          ></textarea>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="min-h-[44px] rounded-md bg-accent px-6 text-sm font-semibold text-accent-fg active:bg-accent/90 disabled:opacity-50"
              :disabled="committing || commitMessage.trim().length === 0"
              @click="commit"
            >
              {{ committing ? 'Committing…' : 'Commit' }}
            </button>
            <span v-if="commitNotice" class="text-sm font-medium text-ok">{{ commitNotice }}</span>
          </div>
          <p class="text-xs text-ink-dim">
            Commits the staged index with the box's configured git identity. Push/pull/merge live at the raw terminal.
          </p>
        </section>
      </div>
    </div>

    <!-- ── Diff screen ─────────────────────────────────────────────────────── -->
    <div v-else class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div class="mx-auto flex max-w-3xl flex-col gap-3 p-3">
        <div class="flex flex-col gap-2">
          <p class="break-all font-mono text-sm font-medium text-ink">{{ activeFilePath }}</p>
          <p class="text-xs font-mono tabular-nums text-ink-dim">
            {{ activeDiffStat.filesChanged }} file · <span class="text-ok">+{{ activeDiffStat.additions }}</span>
            <span class="text-crit">−{{ activeDiffStat.deletions }}</span>
          </p>
          <!-- Worktree vs staged toggle for this file, and Edit beside it: the
               review → fix → re-review loop without leaving the surface. Coming
               back re-fetches both this diff and the repo status. -->
          <div class="flex flex-wrap items-center gap-2">
            <div class="inline-flex overflow-hidden rounded-md border border-line text-xs">
              <button
                type="button"
                class="min-h-[36px] px-3 font-semibold"
                :class="!diffShowsStaged ? 'bg-accent text-accent-fg' : 'text-ink-dim active:bg-panel-sunken'"
                @click="diffShowsStaged = false"
              >
                Working tree
              </button>
              <button
                type="button"
                class="min-h-[36px] border-l border-line px-3 font-semibold"
                :class="diffShowsStaged ? 'bg-accent text-accent-fg' : 'text-ink-dim active:bg-panel-sunken'"
                @click="diffShowsStaged = true"
              >
                Staged
              </button>
            </div>
            <button
              type="button"
              class="min-h-[36px] rounded-md border border-accent px-4 text-xs font-semibold text-accent active:bg-accent/10"
              :aria-label="`Edit ${activeFilePath}`"
              @click="editActiveFile"
            >
              Edit
            </button>
          </div>
        </div>

        <p v-if="store.gitDiffFiles.length === 0" class="rounded-lg border border-line p-4 text-center text-sm text-ink-dim">
          No {{ diffShowsStaged ? 'staged' : 'unstaged' }} changes for this file.
        </p>

        <template v-for="file in store.gitDiffFiles" :key="file.path">
          <p v-if="file.binary" class="rounded-lg border border-line p-3 text-sm text-ink-dim">
            Binary file — no textual diff.
          </p>
          <!-- Each hunk owns an overflow-x-auto container: a long line scrolls
               WITHIN the hunk and never scrolls the page body horizontally. -->
          <div
            v-for="(hunk, hunkIndex) in file.hunks"
            :key="hunkIndex"
            class="overflow-hidden rounded-lg border border-line"
          >
            <div class="diff-hunk-header">{{ hunk.header }}</div>
            <div class="overflow-x-auto">
              <table class="diff-table">
                <tbody>
                  <tr
                    v-for="(line, lineIndex) in hunk.lines"
                    :key="lineIndex"
                    :class="diffLineStyle(line.kind).className"
                  >
                    <td class="diff-gutter">{{ line.oldLineNumber ?? '' }}</td>
                    <td class="diff-gutter">{{ line.newLineNumber ?? '' }}</td>
                    <td class="diff-sign">{{ diffLineStyle(line.kind).sign }}</td>
                    <td class="diff-content">{{ line.content }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>

        <p class="px-1 text-[11px] text-ink-dim">
          Hunks are read-only for review. Staging is file-level (Stage / Unstage on the list); per-hunk staging is not yet available.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The mobile hunk diff. Colors come from the token custom properties
   (packages/ui/src/style.css) via var(--token) — those tokens already self-
   theme (light/dark/auto, runtime-swappable), so a single declaration block
   replaces the old light-CSS + `@media (prefers-color-scheme: dark)` pair. The
   tint + the left-gutter sign carry the semantics; the code text stays high-
   contrast on top of the tint. The class names come from lib/gitReview.ts
   (diffLineStyle) — the mapping is unit-tested there. */

.diff-hunk-header {
  padding: 0.25rem 0.75rem;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 0.72rem;
  color: var(--ink-dim);
  background: var(--panel-sunken);
  border-bottom: 1px solid var(--line);
  white-space: pre;
  overflow-x: auto;
}

.diff-table {
  /* Width follows content (table-layout auto): a long code line grows the table
     past the container, so the enclosing overflow-x-auto scrolls — and every row
     spans the full table width, so the row tint covers the whole scrolled line. */
  border-collapse: collapse;
  width: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 0.78rem;
  line-height: 1.45;
}

.diff-gutter {
  padding: 0 0.4rem;
  text-align: right;
  color: var(--ink-dim);
  user-select: none;
  white-space: nowrap;
  vertical-align: top;
  font-variant-numeric: tabular-nums;
}

.diff-sign {
  padding: 0 0.35rem;
  text-align: center;
  user-select: none;
  white-space: nowrap;
  vertical-align: top;
  font-weight: 600;
}

.diff-content {
  padding: 0 0.6rem 0 0.25rem;
  white-space: pre; /* never wrap — long lines scroll the hunk container */
  color: var(--ink);
  width: 100%;
}

/* Add / del / context tints — tone tokens, self-theming. */
.diff-line-add {
  background: color-mix(in srgb, var(--ok) 16%, transparent);
}
.diff-line-add .diff-sign {
  color: var(--ok);
}
.diff-line-del {
  background: color-mix(in srgb, var(--crit) 16%, transparent);
}
.diff-line-del .diff-sign {
  color: var(--crit);
}
.diff-line-context .diff-content {
  color: var(--ink-dim);
}
</style>
