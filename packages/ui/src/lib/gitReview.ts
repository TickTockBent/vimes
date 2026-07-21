// Pure derivations for the git review panel (GitPanel.vue) — the primary-human-
// job surface (spec §3.4: reviewing agent diffs). No Vue, no DOM, no I/O: every
// branch is unit-tested without a browser (gitReview.test.ts), mirroring the
// lib/terminalList.ts pattern. The Vue component stays declarative; the decisions
// that matter (status grouping, diff-line styling, the diffstat) live here where
// they can be asserted.
//
// The types below MIRROR the daemon's exported shapes (packages/daemon/src/
// gitAdapter.ts / gitApi.ts) — the UI re-declares the wire shape locally rather
// than importing across the package boundary (same as TerminalListItem in
// terminalList.ts). The daemon owns the parse; this file only reshapes the parsed
// model for display.

// ── wire shapes (mirror packages/daemon/src/gitAdapter.ts) ──

export type GitStatusEntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

export interface GitStatusEntry {
  kind: GitStatusEntryKind;
  path: string;
  origPath: string | null;
  // The index (staged) status letter, '' when unmodified.
  staged: string;
  // The worktree (unstaged) status letter, '' when unmodified.
  unstaged: string;
  xy: string;
  score: string | null;
}

export interface GitBranchInfo {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface GitStatus {
  branch: GitBranchInfo;
  entries: GitStatusEntry[];
}

export type GitDiffLineKind = 'add' | 'del' | 'context';

export interface GitDiffLine {
  kind: GitDiffLineKind;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: GitDiffLine[];
}

export type GitFileChangeKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface GitFileDiff {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  changeKind: GitFileChangeKind;
  binary: boolean;
  hunks: GitDiffHunk[];
}

// ── repo picking (the escape hatch beside the abstraction, pillar 7) ──
//
// GATE FINDING (2026-07-21): the panel used to offer the configured project
// ROOTS. But VIMES_PROJECT_ROOTS is a CONTAINER of repos (D21: ~/projects), so
// the picker could never name an actual repository and the diff surface was
// unreachable. The picker now lists DISCOVERED repos (GET /api/git/repos), with
// a free-text path field beside it — the same shape that fixed the identical gap
// for the terminal (lib/terminalStart.ts's decideStartCwd).

// One discovered repository (mirrors the daemon's GitRepoEntry).
export interface GitRepoEntry {
  path: string;
  name: string;
}

export interface GitRootChoice {
  ok: true;
  root: string;
}
export interface GitRootProblem {
  ok: false;
  error: string;
}
export type GitRootDecision = GitRootChoice | GitRootProblem;

// Compose the repo root the panel operates on from the editable free-text field,
// with the selected discovered repo as the fallback. A non-empty (trimmed) field
// WINS — that is how the user reaches a repo discovery did not surface (too deep,
// behind an unreadable parent, a fresh clone). An empty field falls back to the
// dropdown selection; neither present is a visible message, never a silent no-op.
//
// NO client-side path validation beyond non-empty: the daemon's resolveWithinRoots
// + repoRootFor are the authoritative wall, and their refusal already surfaces
// through the store's gitError. Duplicating a weaker check here would only invent
// a second, wronger boundary.
export function decideGitRoot(pathFieldValue: string, selectedRepoPath: string): GitRootDecision {
  const trimmedFieldValue = pathFieldValue.trim();
  if (trimmedFieldValue.length > 0) {
    return { ok: true, root: trimmedFieldValue };
  }
  const trimmedSelection = selectedRepoPath.trim();
  if (trimmedSelection.length > 0) {
    return { ok: true, root: trimmedSelection };
  }
  return { ok: false, error: 'Pick a repository, or type a path inside your project roots.' };
}

// ── changed-files list (the tap-a-file-to-see-its-diff rail) ──

// The three review buckets, in most-meaningful order: what is ready to commit
// (staged), what is not yet staged (unstaged), then brand-new files (untracked).
export type GitStatusGroup = 'staged' | 'unstaged' | 'untracked';

export interface GitStatusRow {
  // The path exactly as git reports it — the operand handed back to the stage/
  // unstage/diff API (the daemon re-resolves it against the allowlist).
  path: string;
  // The last path segment — the compact label for a tight mobile row (the full
  // path is shown too, but the tail is what fits).
  pathTail: string;
  // The rename/copy source path, for a "was: <origPath>" hint; null otherwise.
  origPath: string | null;
  // A human status word derived from the staged/unstaged letters + kind.
  statusLabel: string;
  group: GitStatusGroup;
  // A file can be BOTH staged and unstaged (partially staged) — these drive which
  // of the file-level Stage / Unstage actions the row offers.
  hasStaged: boolean;
  hasUnstaged: boolean;
}

export interface GroupedStatusRows {
  staged: GitStatusRow[];
  unstaged: GitStatusRow[];
  untracked: GitStatusRow[];
}

// Last path segment — the human-legible file label. A trailing slash or an empty
// path falls back to the whole string.
function pathTail(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

// A single porcelain-v2 status letter → a human word. '' (unmodified on this
// axis) yields '' so the caller can fall back to the other axis.
function letterToWord(letter: string): string {
  switch (letter) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    case 'T':
      return 'Type changed';
    case 'U':
      return 'Unmerged';
    default:
      return '';
  }
}

// The human status word for an entry. Kind wins for the special buckets;
// otherwise the staged letter is preferred (what will commit), falling back to
// the worktree letter, then a generic 'Changed'.
function statusLabelFor(entry: GitStatusEntry): string {
  if (entry.kind === 'untracked') {
    return 'Untracked';
  }
  if (entry.kind === 'ignored') {
    return 'Ignored';
  }
  if (entry.kind === 'unmerged') {
    return 'Unmerged';
  }
  if (entry.kind === 'renamed') {
    return 'Renamed';
  }
  return letterToWord(entry.staged) || letterToWord(entry.unstaged) || 'Changed';
}

// Which review bucket a file belongs to. A file with ANY staged content sits in
// 'staged' (even when it also has unstaged edits — the hasUnstaged flag marks
// that "partially staged" case); a conflict is surfaced under 'unstaged' since it
// needs resolution before it can cleanly commit.
function groupFor(entry: GitStatusEntry): GitStatusGroup {
  if (entry.kind === 'untracked') {
    return 'untracked';
  }
  if (entry.kind === 'unmerged') {
    return 'unstaged';
  }
  if (entry.staged !== '') {
    return 'staged';
  }
  return 'unstaged';
}

export function deriveGitStatusRow(entry: GitStatusEntry): GitStatusRow {
  const hasStaged = entry.kind !== 'untracked' && entry.kind !== 'unmerged' && entry.staged !== '';
  const hasUnstaged = entry.kind === 'untracked' || entry.kind === 'unmerged' || entry.unstaged !== '';
  return {
    path: entry.path,
    pathTail: pathTail(entry.path),
    origPath: entry.origPath,
    statusLabel: statusLabelFor(entry),
    group: groupFor(entry),
    hasStaged,
    hasUnstaged,
  };
}

// All rows, path-sorted within each group for a stable, jitter-free order between
// fetches (git's own status order is stable but not alphabetical; a deterministic
// sort here keeps the list from reordering under the reviewer's thumb).
export function deriveGitStatusRows(entries: readonly GitStatusEntry[]): GitStatusRow[] {
  return entries.map(deriveGitStatusRow);
}

// Group the rows into the three review buckets, each path-sorted. The template
// renders the buckets in staged → unstaged → untracked order (most-meaningful
// first — what is ready to commit leads).
export function groupStatusRows(entries: readonly GitStatusEntry[]): GroupedStatusRows {
  const byPath = (first: GitStatusRow, second: GitStatusRow): number =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0;
  const rows = deriveGitStatusRows(entries);
  return {
    staged: rows.filter((row) => row.group === 'staged').sort(byPath),
    unstaged: rows.filter((row) => row.group === 'unstaged').sort(byPath),
    untracked: rows.filter((row) => row.group === 'untracked').sort(byPath),
  };
}

// ── diff-line styling (the mobile hunk view) ──

// The semantic style for one diff line: the left-gutter sign and a stable class
// token. The component binds the token to the actual tint (see GitPanel's scoped
// styles, which set legible add/del/context colors in BOTH light and dark). The
// mapping is decided here so it is tested, not buried in template ternaries.
export type DiffLineClass = 'diff-line-add' | 'diff-line-del' | 'diff-line-context';

export interface DiffLineStyle {
  // The gutter marker: '+' for an addition, '-' for a deletion, ' ' for context.
  sign: '+' | '-' | ' ';
  className: DiffLineClass;
}

export function diffLineStyle(kind: GitDiffLineKind): DiffLineStyle {
  switch (kind) {
    case 'add':
      return { sign: '+', className: 'diff-line-add' };
    case 'del':
      return { sign: '-', className: 'diff-line-del' };
    default:
      return { sign: ' ', className: 'diff-line-context' };
  }
}

// ── diffstat (the compact header: N files, +A −D) ──

export interface DiffStat {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export function summarizeDiffStat(files: readonly GitFileDiff[]): DiffStat {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') {
          additions += 1;
        } else if (line.kind === 'del') {
          deletions += 1;
        }
      }
    }
  }
  return { filesChanged: files.length, additions, deletions };
}

// ── edit-from-diff: the review → fix → re-review round trip ──────────────────
//
// From the diff screen an Edit button opens the CM6 editor on that file and
// comes back to a REFRESHED diff. Three decisions live here (pure, tested) so
// GitPanel.vue and App.vue stay declarative:
//
//   1. absoluteRepoFilePath — git status paths are REPO-RELATIVE; the editor
//      route wants an ABSOLUTE path. Conflating the two is exactly the semantics
//      bug D25 records, so the join is a named, tested function rather than an
//      inline concat at the call site.
//   2. decideEditorReturn — a WHITELIST of return targets (only 'git' today).
//      Anything absent or unrecognized falls back to the file tree, the
//      pre-existing behavior, so the normal editor back path cannot regress.
//      Deliberately NOT a general redirect mechanism.
//   3. decideDiffRestore — on GitPanel remount, whether the remembered diff
//      context still names a changed file (restore it) or not (fall back to the
//      list with a visible reason, never an empty diff screen).

// Join a repo root and a repo-relative path into the absolute path the editor
// route needs. An input that is ALREADY absolute is returned as-is (the caller
// may hold either shape); trailing root slashes never produce a double slash;
// empty inputs degrade to the one non-empty side rather than to '/'-noise.
export function absoluteRepoFilePath(repoRoot: string, repoRelativePath: string): string {
  const trimmedRelativePath = repoRelativePath.trim();
  const trimmedRepoRoot = repoRoot.trim();
  // Already absolute → the join would be wrong; hand it back untouched.
  if (trimmedRelativePath.startsWith('/')) {
    return trimmedRelativePath;
  }
  if (trimmedRepoRoot === '') {
    return trimmedRelativePath;
  }
  const rootWithoutTrailingSlash = trimmedRepoRoot.replace(/\/+$/, '');
  if (trimmedRelativePath === '') {
    return rootWithoutTrailingSlash === '' ? '/' : rootWithoutTrailingSlash;
  }
  // git never emits './x', but a hand-built context might; strip it so the join
  // cannot produce '/repo/./x'.
  const relativeWithoutDotPrefix = trimmedRelativePath.replace(/^(?:\.\/+)+/, '');
  return `${rootWithoutTrailingSlash}/${relativeWithoutDotPrefix}`;
}

// Where EditorView's `back` should land. 'git' is the ONLY recognized non-default
// target; every other value (absent, empty, unknown, spoofed in the hash) yields
// 'files' — today's behavior.
export type EditorReturnTarget = 'git' | 'files';

export function decideEditorReturn(returnToParam: string | null): EditorReturnTarget {
  return returnToParam === 'git' ? 'git' : 'files';
}

// The diff the reviewer left behind when tapping Edit. Lives in the STORE (like
// lastGitRoot), because GitPanel unmounts for the editor visit.
export interface GitDiffContext {
  // The repo root the panel had LOADED (the lastGitRoot-shaped identity), so a
  // remount against a different repo does not resurrect a foreign file's diff.
  repoRoot: string;
  // Repo-relative, exactly as `git status` reported it — the operand the diff /
  // stage APIs take.
  repoRelativePath: string;
  // Which side of the diff toggle was on screen (worktree vs staged).
  showsStaged: boolean;
}

export type GitDiffRestoreDecision =
  // Nothing to restore (no context, or it belongs to another repo). The panel
  // opens on the changed-files list, unchanged from before this feature.
  | { action: 'none' }
  // The remembered file is still changed — reopen its diff on the remembered
  // side and re-fetch.
  | { action: 'restore'; repoRelativePath: string; showsStaged: boolean }
  // The remembered file is no longer in status (the edit made it clean, or it
  // was committed elsewhere) — show the list plus a reason, never an empty diff.
  | { action: 'fallback'; repoRelativePath: string };

export function decideDiffRestore(
  rememberedContext: GitDiffContext | null,
  loadedRepoRoot: string,
  changedFilePaths: readonly string[],
): GitDiffRestoreDecision {
  if (rememberedContext === null) {
    return { action: 'none' };
  }
  if (rememberedContext.repoRelativePath === '') {
    return { action: 'none' };
  }
  if (rememberedContext.repoRoot !== loadedRepoRoot) {
    return { action: 'none' };
  }
  if (!changedFilePaths.includes(rememberedContext.repoRelativePath)) {
    return { action: 'fallback', repoRelativePath: rememberedContext.repoRelativePath };
  }
  return {
    action: 'restore',
    repoRelativePath: rememberedContext.repoRelativePath,
    showsStaged: rememberedContext.showsStaged,
  };
}
