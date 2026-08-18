import { execFile } from 'node:child_process';

// ─── Git adapter (daemon, fragile-adapter boundary — rule 0.6) ────────────────
//
// A single module owns EVERY `git` invocation + parse; nothing outside it depends
// on git's output shape (spec §3.4, slice-4 step 1). Injection safety is the
// headline risk — a git service is arbitrary-command-adjacent:
//
//   • The subprocess is `node:child_process` execFile with ARRAY args ONLY —
//     never a shell string, so nothing a caller supplies is ever interpolated
//     into a shell. This is the injection-safety boundary.
//   • Every command that takes a request-derived operand (a path, a commit
//     message) puts it AFTER a `--` guard so git can never read it as an option.
//   • The methods here take an ALREADY-RESOLVED, allowlist-checked `repoRoot`
//     (the caller — gitApi — does the resolveWithinRoots security check on the
//     requested root, the discovered toplevel, and any path). This module never
//     reaches into the allowlist; it only runs git in the cwd it is handed.
//
// The parsers are PURE and TOLERATE drift (rule 0.6): an unrecognized line is
// skipped or bucketed, never thrown on. They are unit-tested over REAL captured
// output (docs/calibration.md "Spike G", git 2.43.0).

// ── the injectable runner seam (mirrors search.ts's RipgrepSpawner) ──
export interface GitRunResult {
  stdout: string;
  stderr: string;
  // The process exit code, or null when the spawn itself failed (e.g. ENOENT —
  // git absent). Distinguishing the two is what the preflight keys off.
  exitCode: number | null;
}

// Runs git with array args in a cwd and resolves the captured streams. Tests
// inject a fake returning canned output; production uses defaultGitRunner.
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

// Generous ceiling: a large repo's `git diff` can be many megabytes; the default
// 1 MB execFile buffer would truncate it. Determinism-exempt (process boundary).
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// The default (real) git seam — determinism-exempt (process boundary). ARRAY
// args, no shell: execFile never spawns a shell, so no argument is interpolated.
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        let exitCode: number | null;
        if (error !== null && typeof (error as NodeJS.ErrnoException).code === 'number') {
          // A non-zero git exit: execFile surfaces the numeric code on error.code.
          exitCode = (error as NodeJS.ErrnoException).code as unknown as number;
        } else if (error !== null && error !== undefined) {
          // A spawn failure (ENOENT etc.) — error.code is a string; git ran nothing.
          exitCode = null;
        } else {
          exitCode = 0;
        }
        resolveResult({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
      },
    );
  });

// One-time preflight (mirrors ripgrep's): `git --version` succeeds and looks like
// git. When git is absent the runner's spawn fails → exitCode null → false, and
// ops return a structured 'git-unavailable' rather than throwing.
export async function gitAvailable(runner: GitRunner): Promise<boolean> {
  try {
    const versionResult = await runner(['--version'], process.cwd());
    return versionResult.exitCode === 0 && versionResult.stdout.includes('git version');
  } catch {
    return false;
  }
}

// ── the parsed data model (the API contract these parsers feed) ──

export interface GitBranchInfo {
  // From `# branch.oid` — null on `(initial)` (a repo with no commits yet).
  oid: string | null;
  // From `# branch.head` — null on `(detached)` (detached HEAD).
  head: string | null;
  // From `# branch.upstream` — absent when no upstream is configured.
  upstream: string | null;
  // From `# branch.ab +A -B` — absent when there is no upstream to compare to.
  ahead: number | null;
  behind: number | null;
}

export type GitStatusEntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

export interface GitStatusEntry {
  kind: GitStatusEntryKind;
  path: string;
  // The rename/copy source path (type-2 records only); null otherwise.
  origPath: string | null;
  // The index (staged) status letter, '' when unmodified (a '.' in porcelain v2).
  staged: string;
  // The worktree (unstaged) status letter, '' when unmodified.
  unstaged: string;
  // The raw two-char XY field for ordinary/renamed/unmerged, or '?'/'!' for
  // untracked/ignored — preserved verbatim so the UI can render exactly.
  xy: string;
  // The rename/copy similarity token (e.g. 'R100'); null on non-rename entries.
  score: string | null;
}

export interface GitStatus {
  branch: GitBranchInfo;
  entries: GitStatusEntry[];
}

export type GitDiffLineKind = 'add' | 'del' | 'context';

export interface GitDiffLine {
  kind: GitDiffLineKind;
  // The line content WITHOUT the leading +/-/space marker.
  content: string;
  // 1-based line numbers within the old/new file; null on the side the line does
  // not exist in (a null oldLineNumber on an add, null newLineNumber on a del).
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface GitDiffHunk {
  // The full `@@ -a,b +c,d @@ section` header line, verbatim.
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  // The function/section context after the closing `@@` (may be '').
  section: string;
  lines: GitDiffLine[];
}

export type GitFileChangeKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface GitFileDiff {
  // The path as git reports it (the `b/` side for adds/modifies, `a/` for deletes).
  path: string;
  // The old path (null for a pure add) and new path (null for a pure delete).
  oldPath: string | null;
  newPath: string | null;
  changeKind: GitFileChangeKind;
  // True for a binary file ("Binary files a/x and b/x differ") — no hunks then.
  binary: boolean;
  hunks: GitDiffHunk[];
}

export interface GitWorktree {
  path: string;
  head: string | null;
  // The full ref (e.g. 'refs/heads/main'); null when detached or bare.
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

export interface GitBranch {
  // %(refname:short) — e.g. 'main'.
  name: string;
  // %(objectname:short) — the short commit id.
  oid: string;
  // %(upstream:short) — null when the branch tracks nothing.
  upstream: string | null;
}

// ── pure parsers (exported, unit-tested over real Spike-G output) ──

// Split a fixed-count space-delimited prefix off a porcelain v2 entry line,
// returning [field0, …, field(fixedCount-1), remainder]. The remainder is the
// path, which may itself contain spaces — so only the leading fields are split.
function splitFixedFields(line: string, fixedCount: number): string[] {
  const fields: string[] = [];
  let remaining = line;
  for (let fieldIndex = 0; fieldIndex < fixedCount; fieldIndex += 1) {
    const spaceIndex = remaining.indexOf(' ');
    if (spaceIndex < 0) {
      fields.push(remaining);
      remaining = '';
    } else {
      fields.push(remaining.slice(0, spaceIndex));
      remaining = remaining.slice(spaceIndex + 1);
    }
  }
  fields.push(remaining);
  return fields;
}

// A porcelain-v2 status axis letter: '.' means unmodified → normalized to ''.
function normalizeStatusLetter(letter: string | undefined): string {
  return letter === undefined || letter === '.' ? '' : letter;
}

function parseBranchHeaderLine(headerLine: string, branch: GitBranchInfo): void {
  // Header lines look like `# branch.oid <value>` (value may contain spaces for
  // some keys, so keep everything after the key).
  const withoutHash = headerLine.slice(2); // drop the leading '# '
  const spaceIndex = withoutHash.indexOf(' ');
  const key = spaceIndex < 0 ? withoutHash : withoutHash.slice(0, spaceIndex);
  const value = spaceIndex < 0 ? '' : withoutHash.slice(spaceIndex + 1);
  if (key === 'branch.oid') {
    branch.oid = value === '(initial)' ? null : value;
  } else if (key === 'branch.head') {
    branch.head = value === '(detached)' ? null : value;
  } else if (key === 'branch.upstream') {
    branch.upstream = value === '' ? null : value;
  } else if (key === 'branch.ab') {
    // `+A -B` — tolerate either token being missing.
    const aheadMatch = value.match(/\+(-?\d+)/);
    const behindMatch = value.match(/-(\d+)/);
    branch.ahead = aheadMatch ? Number.parseInt(aheadMatch[1]!, 10) : null;
    branch.behind = behindMatch ? Number.parseInt(behindMatch[1]!, 10) : null;
  }
  // Any other `# ...` header (a future key) is tolerated and ignored (rule 0.6).
}

// Parse `git status --porcelain=v2 -z --branch`. NUL-delimited: records are split
// on \0, and a type-2 (rename/copy) record consumes the FOLLOWING token as its
// original path. Unrecognized record types are skipped (rule 0.6).
export function parseStatusV2(stdout: string): GitStatus {
  const branch: GitBranchInfo = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  const entries: GitStatusEntry[] = [];
  const tokens = stdout.split('\0');
  let tokenIndex = 0;
  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    tokenIndex += 1;
    if (token === undefined || token.length === 0) {
      continue; // trailing empty after the final NUL, or a blank token
    }
    if (token.startsWith('# ')) {
      parseBranchHeaderLine(token, branch);
      continue;
    }
    const recordType = token[0];
    if (recordType === '1') {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — 8 leading fields.
      const fields = splitFixedFields(token, 8);
      const xy = fields[1] ?? '..';
      entries.push({
        kind: 'ordinary',
        path: fields[8] ?? '',
        origPath: null,
        staged: normalizeStatusLetter(xy[0]),
        unstaged: normalizeStatusLetter(xy[1]),
        xy,
        score: null,
      });
    } else if (recordType === '2') {
      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>`, then \0<origPath>.
      const fields = splitFixedFields(token, 9);
      const xy = fields[1] ?? '..';
      const score = fields[8] ?? '';
      const origPath = tokens[tokenIndex] ?? '';
      tokenIndex += 1; // the rename source lives in the next NUL-delimited token
      entries.push({
        kind: 'renamed',
        path: fields[9] ?? '',
        origPath,
        staged: normalizeStatusLetter(xy[0]),
        unstaged: normalizeStatusLetter(xy[1]),
        xy,
        score: score === '' ? null : score,
      });
    } else if (recordType === 'u') {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — 10 leading fields.
      const fields = splitFixedFields(token, 10);
      const xy = fields[1] ?? '..';
      entries.push({
        kind: 'unmerged',
        path: fields[10] ?? '',
        origPath: null,
        staged: normalizeStatusLetter(xy[0]),
        unstaged: normalizeStatusLetter(xy[1]),
        xy,
        score: null,
      });
    } else if (recordType === '?') {
      // `? <path>`
      entries.push({
        kind: 'untracked',
        path: token.slice(2),
        origPath: null,
        staged: '',
        unstaged: '',
        xy: '?',
        score: null,
      });
    } else if (recordType === '!') {
      // `! <path>`
      entries.push({
        kind: 'ignored',
        path: token.slice(2),
        origPath: null,
        staged: '',
        unstaged: '',
        xy: '!',
        score: null,
      });
    }
    // Any other record type is unrecognized drift — skipped (rule 0.6).
  }
  return { branch, entries };
}

// Parse a `@@ -oldStart,oldLines +newStart,newLines @@ section` header. The line
// counts are optional (`@@ -1 +0,0 @@` means one line); a default of 1 applies.
function parseHunkHeader(headerLine: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
} | null {
  const match = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (match === null) {
    return null;
  }
  return {
    oldStart: Number.parseInt(match[1]!, 10),
    oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3]!, 10),
    newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
    // The section follows the closing `@@` — a single leading space is cosmetic.
    section: (match[5] ?? '').replace(/^ /, ''),
  };
}

// Strip git's `a/` or `b/` diff prefix (default prefixes); leave '/dev/null' and
// prefix-less paths untouched.
function stripDiffPrefix(rawPath: string): string {
  if (rawPath === '/dev/null') {
    return rawPath;
  }
  if (rawPath.startsWith('a/') || rawPath.startsWith('b/')) {
    return rawPath.slice(2);
  }
  return rawPath;
}

// Parse `git diff --no-color` into files → hunks → tagged lines. The mobile-diff
// data model (slice-4 §3.4) — line numbers are tracked so the UI can render a
// gutter. Tolerant of new/deleted/binary files and the no-newline marker.
export function parseDiff(stdout: string): GitFileDiff[] {
  const files: GitFileDiff[] = [];
  const lines = stdout.split('\n');
  let currentFile: GitFileDiff | null = null;
  let currentHunk: GitDiffHunk | null = null;
  let oldLineCursor = 0;
  let newLineCursor = 0;

  const finishFile = (): void => {
    if (currentFile !== null) {
      files.push(currentFile);
    }
    currentFile = null;
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finishFile();
      // `diff --git a/<old> b/<new>` — a best-effort path from the header; the
      // authoritative paths come from the ---/+++ lines below. Default to
      // modified; new-file/deleted-file lines refine changeKind.
      const headerMatch = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      const headerNew = headerMatch ? headerMatch[2]! : '';
      currentFile = {
        path: headerNew,
        oldPath: null,
        newPath: null,
        changeKind: 'modified',
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (currentFile === null) {
      continue; // preamble before the first file header (rule 0.6 — tolerate)
    }
    if (line.startsWith('new file mode ')) {
      currentFile.changeKind = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.changeKind = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      currentFile.changeKind = 'renamed';
      currentFile.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentFile.changeKind = 'renamed';
      currentFile.newPath = line.slice('rename to '.length);
      currentFile.path = currentFile.newPath;
      continue;
    }
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      currentFile.changeKind = 'copied';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      currentFile.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const oldRaw = stripDiffPrefix(line.slice(4));
      currentFile.oldPath = oldRaw === '/dev/null' ? null : oldRaw;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newRaw = stripDiffPrefix(line.slice(4));
      currentFile.newPath = newRaw === '/dev/null' ? null : newRaw;
      if (currentFile.newPath !== null) {
        currentFile.path = currentFile.newPath;
      } else if (currentFile.oldPath !== null) {
        currentFile.path = currentFile.oldPath;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const parsed = parseHunkHeader(line);
      if (parsed !== null) {
        currentHunk = {
          header: line,
          oldStart: parsed.oldStart,
          oldLines: parsed.oldLines,
          newStart: parsed.newStart,
          newLines: parsed.newLines,
          section: parsed.section,
          lines: [],
        };
        currentFile.hunks.push(currentHunk);
        oldLineCursor = parsed.oldStart;
        newLineCursor = parsed.newStart;
      }
      continue;
    }
    if (currentHunk === null) {
      // 'index <a>..<b> <mode>', 'old mode', 'similarity index', etc. — metadata
      // between the file header and the first hunk. Ignored (rule 0.6).
      continue;
    }
    if (line.startsWith('\\')) {
      // '\ No newline at end of file' — annotates the preceding line; not a line.
      continue;
    }
    const marker = line[0];
    if (marker === '+') {
      currentHunk.lines.push({
        kind: 'add',
        content: line.slice(1),
        oldLineNumber: null,
        newLineNumber: newLineCursor,
      });
      newLineCursor += 1;
    } else if (marker === '-') {
      currentHunk.lines.push({
        kind: 'del',
        content: line.slice(1),
        oldLineNumber: oldLineCursor,
        newLineNumber: null,
      });
      oldLineCursor += 1;
    } else if (marker === ' ') {
      currentHunk.lines.push({
        kind: 'context',
        content: line.slice(1),
        oldLineNumber: oldLineCursor,
        newLineNumber: newLineCursor,
      });
      oldLineCursor += 1;
      newLineCursor += 1;
    }
    // An empty line inside a hunk (git emits a bare '' for a blank context line
    // as ' ' + ''; a truly empty string is the split artifact of a trailing
    // newline) is ignored here — real blank context lines carry the ' ' marker.
  }
  finishFile();
  return files;
}

// Parse `git worktree list --porcelain` — blank-line-separated records of
// `worktree <path>` / `HEAD <sha>` / `branch <ref>` / `bare` / `detached` /
// `locked [reason]`. Unknown keys are tolerated (rule 0.6).
export function parseWorktrees(stdout: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  const finish = (): void => {
    if (current !== null) {
      worktrees.push(current);
    }
    current = null;
  };
  for (const line of stdout.split('\n')) {
    if (line === '') {
      finish();
      continue;
    }
    const spaceIndex = line.indexOf(' ');
    const key = spaceIndex < 0 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex < 0 ? '' : line.slice(spaceIndex + 1);
    if (key === 'worktree') {
      finish();
      current = { path: value, head: null, branch: null, detached: false, bare: false, locked: false };
    } else if (current === null) {
      continue; // a stray key before the first `worktree` — tolerate
    } else if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value;
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'locked') {
      current.locked = true;
    }
    // Other keys (e.g. 'prunable') are tolerated and ignored.
  }
  finish();
  return worktrees;
}

// Parse the Spike-G for-each-ref format
// `%(refname:short) %(objectname:short) %(upstream:short)` — one branch per line.
// The upstream field is empty (a trailing space) when the branch tracks nothing.
export function parseBranches(stdout: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      continue;
    }
    // Split into at most three fields; the name never contains a space, and
    // upstream is a single ref token, so a plain space split is safe here.
    const fields = line.split(' ');
    const name = fields[0] ?? '';
    if (name === '') {
      continue;
    }
    const oid = fields[1] ?? '';
    const upstream = fields[2] !== undefined && fields[2] !== '' ? fields[2] : null;
    branches.push({ name, oid, upstream });
  }
  return branches;
}

// ── the adapter: subprocess + parse behind a typed, root-scoped surface ──

export type GitOpError = 'git-unavailable' | 'not-a-repo' | 'git-failed';

export type GitOpResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: GitOpError; detail?: string };

export interface GitAdapterDeps {
  runner?: GitRunner;
}

export class GitAdapter {
  private readonly runner: GitRunner;
  private availabilityPromise: Promise<boolean> | undefined;

  constructor(deps: GitAdapterDeps = {}) {
    this.runner = deps.runner ?? defaultGitRunner;
  }

  // Cache the one-time preflight (like ripgrep's). Never throws.
  private ensureAvailable(): Promise<boolean> {
    if (this.availabilityPromise === undefined) {
      this.availabilityPromise = gitAvailable(this.runner);
    }
    return this.availabilityPromise;
  }

  // Run git in an already-resolved, allowlist-checked repoRoot. Maps a spawn
  // failure to 'git-unavailable' and a non-zero exit to 'git-failed' with the
  // stderr as detail. The caller owns all path safety.
  private async run(repoRoot: string, args: string[]): Promise<GitOpResult<string>> {
    if (!(await this.ensureAvailable())) {
      return { ok: false, error: 'git-unavailable' };
    }
    const result = await this.runner(args, repoRoot);
    if (result.exitCode === null) {
      return { ok: false, error: 'git-unavailable' };
    }
    if (result.exitCode !== 0) {
      return { ok: false, error: 'git-failed', detail: result.stderr.trim() };
    }
    return { ok: true, value: result.stdout };
  }

  // Discover the repo toplevel for a cwd: `git rev-parse --show-toplevel`. The
  // CALLER must resolveWithinRoots(cwd) BEFORE calling AND resolveWithinRoots the
  // returned toplevel AFTER — a repo must sit inside the allowlist. A cwd that is
  // not inside a repo exits non-zero → 'not-a-repo'.
  async repoRootFor(cwd: string): Promise<GitOpResult<string>> {
    if (!(await this.ensureAvailable())) {
      return { ok: false, error: 'git-unavailable' };
    }
    const result = await this.runner(['rev-parse', '--show-toplevel'], cwd);
    if (result.exitCode === null) {
      return { ok: false, error: 'git-unavailable' };
    }
    if (result.exitCode !== 0) {
      return { ok: false, error: 'not-a-repo', detail: result.stderr.trim() };
    }
    const toplevel = result.stdout.trim();
    if (toplevel === '') {
      return { ok: false, error: 'not-a-repo' };
    }
    return { ok: true, value: toplevel };
  }

  async status(repoRoot: string): Promise<GitOpResult<GitStatus>> {
    const result = await this.run(repoRoot, ['status', '--porcelain=v2', '-z', '--branch']);
    return result.ok ? { ok: true, value: parseStatusV2(result.value) } : result;
  }

  // `git diff --no-color [--staged] -- [<path>]`. The optional path is an
  // already-resolved absolute path (allowlist-checked by the caller); the `--`
  // guard means it is never read as an option.
  async diff(repoRoot: string, path?: string, staged?: boolean): Promise<GitOpResult<GitFileDiff[]>> {
    const args = ['diff', '--no-color'];
    if (staged === true) {
      args.push('--staged');
    }
    args.push('--');
    if (path !== undefined) {
      args.push(path);
    }
    const result = await this.run(repoRoot, args);
    return result.ok ? { ok: true, value: parseDiff(result.value) } : result;
  }

  async branches(repoRoot: string): Promise<GitOpResult<GitBranch[]>> {
    const result = await this.run(repoRoot, [
      'for-each-ref',
      '--format=%(refname:short) %(objectname:short) %(upstream:short)',
      'refs/heads/',
    ]);
    return result.ok ? { ok: true, value: parseBranches(result.value) } : result;
  }

  async worktrees(repoRoot: string): Promise<GitOpResult<GitWorktree[]>> {
    const result = await this.run(repoRoot, ['worktree', 'list', '--porcelain']);
    return result.ok ? { ok: true, value: parseWorktrees(result.value) } : result;
  }

  // `git add -- <path>` (path already resolved + allowlist-checked). The `--`
  // guard keeps a path that starts with '-' from being read as an option.
  async stage(repoRoot: string, path: string): Promise<GitOpResult<null>> {
    const result = await this.run(repoRoot, ['add', '--', path]);
    return result.ok ? { ok: true, value: null } : result;
  }

  // `git restore --staged -- <path>` — unstage without touching the worktree.
  async unstage(repoRoot: string, path: string): Promise<GitOpResult<null>> {
    const result = await this.run(repoRoot, ['restore', '--staged', '--', path]);
    return result.ok ? { ok: true, value: null } : result;
  }

  // `git commit -m <message> --`. The message is a bound value of `-m` (never
  // parsed as an option), and the trailing `--` guards the (empty) pathspec so no
  // operand is ever misread. Fails cleanly ('git-failed') when nothing is staged.
  async commit(repoRoot: string, message: string): Promise<GitOpResult<null>> {
    const result = await this.run(repoRoot, ['commit', '-m', message, '--']);
    return result.ok ? { ok: true, value: null } : result;
  }
}
