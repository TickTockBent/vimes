<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { decideGitRoot, diffLineStyle, groupStatusRows, summarizeDiffStat, type GitStatusRow } from '../lib/gitReview.js';

// Git review panel — the PRIMARY HUMAN JOB (spec §3.4: reviewing agent diffs) and
// the slice-4 KILL CRITERION: the mobile hunk diff must be legible enough to
// actually review agent diffs on a phone. One-column flow (principle 11 — the diff
// owns the width, no file-rail chrome tax):
//   root picker → changed-files list → tap a file → its unified diff → back.
// Staging is FILE-LEVEL (the step-1 API is path-level). HUNK-LEVEL staging is
// DEFERRED to a future API extension — hunks are shown READ-ONLY for review; the
// review loop (see the diff clearly, then stage/commit or leave it) is fully
// covered. No push/pull/merge (the raw terminal is the escape hatch).

const emit = defineEmits<{ back: [] }>();
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
  activeFilePath.value = row.path;
  diffShowsStaged.value = row.hasStaged && !row.hasUnstaged;
  await loadActiveDiff();
}

function backToList(): void {
  activeFilePath.value = null;
  store.clearGitDiff();
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
  <div class="flex min-h-screen flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <header
      class="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950"
    >
      <button
        type="button"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-lg text-slate-600 active:bg-slate-100 dark:text-slate-200 dark:active:bg-slate-900"
        :aria-label="activeFilePath ? 'Back to changed files' : 'Back to sessions'"
        @click="activeFilePath ? backToList() : emit('back')"
      >
        ‹
      </button>
      <h1 class="flex-1 truncate font-semibold">
        {{ activeFilePath ? 'Diff' : 'Git' }}
      </h1>
      <span v-if="branchLabel" class="shrink-0 truncate text-xs text-slate-500 dark:text-slate-400">
        {{ branchLabel }}<span v-if="aheadBehindLabel"> · {{ aheadBehindLabel }}</span>
      </span>
    </header>

    <p
      v-if="store.gitError"
      class="border-b border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
    >
      {{ store.gitError }}
    </p>

    <!-- ── Changed-files list (home) ───────────────────────────────────────── -->
    <div v-if="!activeFilePath" class="min-h-0 flex-1 overflow-y-auto p-4">
      <div class="mx-auto flex max-w-2xl flex-col gap-4">
        <section class="flex flex-col gap-2">
          <label for="git-repo-picker" class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Repository
          </label>
          <select
            v-if="repos.length > 0"
            id="git-repo-picker"
            v-model="selectedRepoPath"
            class="min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option v-for="repo in repos" :key="repo.path" :value="repo.path">{{ repo.name }}</option>
          </select>
          <p v-else class="text-sm text-slate-500 dark:text-slate-400">
            No git repos found under your project roots — type a path below.
          </p>
          <!-- The escape hatch beside the abstraction: any path the daemon's
               allowlist accepts, including a repo discovery didn't reach. -->
          <label class="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
            Repository path (edit to reach a repo not listed above)
            <input
              v-model="rootPathField"
              type="text"
              inputmode="url"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="/home/you/projects/some/repo"
              class="min-h-[44px] w-full rounded-md border border-slate-300 px-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              @keyup.enter="applyRoot"
            />
          </label>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="min-h-[44px] rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 active:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:active:bg-slate-800"
              @click="applyRoot"
            >
              Load repo
            </button>
            <span v-if="activeRoot" class="truncate font-mono text-xs text-slate-500 dark:text-slate-400">{{ activeRoot }}</span>
          </div>
          <p v-if="rootNotice" class="text-sm text-amber-700 dark:text-amber-300">{{ rootNotice }}</p>
          <p v-if="activeRoot" class="text-xs text-slate-500 dark:text-slate-400">
            <span class="font-medium text-slate-700 dark:text-slate-300">{{ branchLabel || '—' }}</span>
            · {{ changedFileCount }} changed {{ changedFileCount === 1 ? 'file' : 'files' }}
          </p>
        </section>

        <p v-if="changedFileCount === 0 && store.gitStatus" class="rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Working tree clean — nothing to review.
        </p>

        <!-- Grouped buckets: staged → unstaged → untracked (most-meaningful first). -->
        <template v-for="bucket in ([
          { key: 'staged', label: 'Staged', rows: grouped.staged },
          { key: 'unstaged', label: 'Unstaged', rows: grouped.unstaged },
          { key: 'untracked', label: 'Untracked', rows: grouped.untracked },
        ] as const)" :key="bucket.key">
          <section v-if="bucket.rows.length > 0" class="flex flex-col gap-2">
            <h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ bucket.label }} ({{ bucket.rows.length }})
            </h2>
            <ul class="flex flex-col gap-2">
              <li
                v-for="row in bucket.rows"
                :key="row.path"
                class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900"
              >
                <button
                  type="button"
                  class="flex min-h-[44px] flex-1 flex-col items-start justify-center gap-0.5 rounded-md px-2 text-left active:bg-slate-100 dark:active:bg-slate-800"
                  @click="openFileDiff(row)"
                >
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ row.pathTail }}</span>
                    <span
                      class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                      :class="row.group === 'staged'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
                        : row.group === 'untracked'
                          ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200'"
                    >{{ row.statusLabel }}</span>
                    <span
                      v-if="row.hasStaged && row.hasUnstaged"
                      class="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 dark:bg-sky-900/50 dark:text-sky-200"
                    >partly staged</span>
                  </span>
                  <span class="truncate text-xs text-slate-500 dark:text-slate-500">{{ row.path }}</span>
                  <span v-if="row.origPath" class="truncate text-[11px] text-slate-400 dark:text-slate-500">was {{ row.origPath }}</span>
                </button>
                <button
                  v-if="row.hasUnstaged"
                  type="button"
                  class="min-h-[44px] shrink-0 rounded-md border border-emerald-300 px-3 text-xs font-semibold text-emerald-700 active:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:active:bg-emerald-950/40"
                  @click="stageRow(row)"
                >
                  Stage
                </button>
                <button
                  v-if="row.hasStaged"
                  type="button"
                  class="min-h-[44px] shrink-0 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-600 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-800"
                  @click="unstageRow(row)"
                >
                  Unstage
                </button>
              </li>
            </ul>
          </section>
        </template>

        <!-- Commit composer -->
        <section v-if="activeRoot" class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <label for="git-commit-message" class="text-sm font-medium">Commit staged changes</label>
          <textarea
            id="git-commit-message"
            v-model="commitMessage"
            rows="3"
            placeholder="Commit message"
            class="min-h-[72px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          ></textarea>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="min-h-[44px] rounded-md bg-sky-600 px-6 text-sm font-semibold text-white active:bg-sky-700 disabled:opacity-50"
              :disabled="committing || commitMessage.trim().length === 0"
              @click="commit"
            >
              {{ committing ? 'Committing…' : 'Commit' }}
            </button>
            <span v-if="commitNotice" class="text-sm font-medium text-emerald-600 dark:text-emerald-400">{{ commitNotice }}</span>
          </div>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Commits the staged index with the box's configured git identity. Push/pull/merge live at the raw terminal.
          </p>
        </section>
      </div>
    </div>

    <!-- ── Diff screen ─────────────────────────────────────────────────────── -->
    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-3xl flex-col gap-3 p-3">
        <div class="flex flex-col gap-2">
          <p class="break-all font-mono text-sm font-medium">{{ activeFilePath }}</p>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            {{ activeDiffStat.filesChanged }} file · <span class="text-emerald-600 dark:text-emerald-400">+{{ activeDiffStat.additions }}</span>
            <span class="text-rose-600 dark:text-rose-400">−{{ activeDiffStat.deletions }}</span>
          </p>
          <!-- Worktree vs staged toggle for this file. -->
          <div class="inline-flex self-start overflow-hidden rounded-md border border-slate-300 text-xs dark:border-slate-700">
            <button
              type="button"
              class="min-h-[36px] px-3 font-semibold"
              :class="!diffShowsStaged ? 'bg-sky-600 text-white' : 'text-slate-600 active:bg-slate-100 dark:text-slate-300 dark:active:bg-slate-800'"
              @click="diffShowsStaged = false"
            >
              Working tree
            </button>
            <button
              type="button"
              class="min-h-[36px] border-l border-slate-300 px-3 font-semibold dark:border-slate-700"
              :class="diffShowsStaged ? 'bg-sky-600 text-white' : 'text-slate-600 active:bg-slate-100 dark:text-slate-300 dark:active:bg-slate-800'"
              @click="diffShowsStaged = true"
            >
              Staged
            </button>
          </div>
        </div>

        <p v-if="store.gitDiffFiles.length === 0" class="rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          No {{ diffShowsStaged ? 'staged' : 'unstaged' }} changes for this file.
        </p>

        <template v-for="file in store.gitDiffFiles" :key="file.path">
          <p v-if="file.binary" class="rounded-lg border border-slate-200 p-3 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Binary file — no textual diff.
          </p>
          <!-- Each hunk owns an overflow-x-auto container: a long line scrolls
               WITHIN the hunk and never scrolls the page body horizontally. -->
          <div
            v-for="(hunk, hunkIndex) in file.hunks"
            :key="hunkIndex"
            class="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800"
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

        <p class="px-1 text-[11px] text-slate-400 dark:text-slate-500">
          Hunks are read-only for review. Staging is file-level (Stage / Unstage on the list); per-hunk staging is not yet available.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The mobile hunk diff. Colors are set for BOTH light and dark (prefers-color-
   scheme, the app's dark strategy) so add/del/context stay legible in either.
   The tint + the left-gutter sign carry the semantics; the code text stays high-
   contrast on top of the tint. The class names come from lib/gitReview.ts
   (diffLineStyle) — the mapping is unit-tested there. */

.diff-hunk-header {
  padding: 0.25rem 0.75rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.72rem;
  color: #475569; /* slate-600 */
  background: #f1f5f9; /* slate-100 */
  border-bottom: 1px solid #e2e8f0; /* slate-200 */
  white-space: pre;
  overflow-x: auto;
}

.diff-table {
  /* Width follows content (table-layout auto): a long code line grows the table
     past the container, so the enclosing overflow-x-auto scrolls — and every row
     spans the full table width, so the row tint covers the whole scrolled line. */
  border-collapse: collapse;
  width: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.45;
}

.diff-gutter {
  padding: 0 0.4rem;
  text-align: right;
  color: #94a3b8; /* slate-400 */
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
  color: #0f172a; /* slate-900 */
  width: 100%;
}

/* Add / del / context tints (light). */
.diff-line-add {
  background: #dcfce7; /* green-100 */
}
.diff-line-add .diff-sign {
  color: #15803d; /* green-700 */
}
.diff-line-del {
  background: #fee2e2; /* red-100 */
}
.diff-line-del .diff-sign {
  color: #b91c1c; /* red-700 */
}
.diff-line-context .diff-content {
  color: #334155; /* slate-700 */
}

@media (prefers-color-scheme: dark) {
  .diff-hunk-header {
    color: #94a3b8; /* slate-400 */
    background: #1e293b; /* slate-800 */
    border-bottom-color: #334155; /* slate-700 */
  }
  .diff-gutter {
    color: #64748b; /* slate-500 */
  }
  .diff-content {
    color: #e2e8f0; /* slate-200 */
  }
  .diff-line-add {
    background: rgba(34, 197, 94, 0.16); /* green tint over dark */
  }
  .diff-line-add .diff-sign {
    color: #4ade80; /* green-400 */
  }
  .diff-line-del {
    background: rgba(248, 113, 113, 0.16); /* red tint over dark */
  }
  .diff-line-del .diff-sign {
    color: #f87171; /* red-400 */
  }
  .diff-line-context .diff-content {
    color: #cbd5e1; /* slate-300 */
  }
}
</style>
