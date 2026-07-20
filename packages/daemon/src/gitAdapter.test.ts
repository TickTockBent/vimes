import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseStatusV2,
  parseDiff,
  parseWorktrees,
  parseBranches,
  GitAdapter,
  defaultGitRunner,
  gitAvailable,
  type GitRunner,
} from './gitAdapter.js';

// ─── Git adapter: pure parsers over REAL Spike-G output + one hermetic run ─────
//
// The parser fixtures are the ACTUAL captured strings from git 2.43.0 on this box
// (docs/calibration.md "Spike G"). The status fixture is NUL-delimited: the NUL
// is built at runtime from a constant so NO raw NUL byte lives in this source
// file (rule: NULs are invisible in editors and have bitten this project).

// Built at runtime — the source file itself stays free of raw NUL bytes.
const NUL = String.fromCharCode(0);

describe('parseStatusV2 — real porcelain v2 -z --branch output', () => {
  // Captured from a repo with a staged rename, a staged add, an unstaged modify,
  // and two untracked files (Spike G).
  const statusFixture =
    [
      '# branch.oid 29c6f6731985353342e28fc176745ed0dc2f9ed2',
      '# branch.head main',
      '2 R. N... 100644 100644 100644 05410dc067ff7565b58ccad90344032237d457a5 05410dc067ff7565b58ccad90344032237d457a5 R100 renamed.txt',
      'keep.txt',
      '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 393d6dd7190959cece20cd7d77278332fa592633 staged.txt',
      '1 .M N... 100644 100644 100644 0c2aa38e0600e0d2df09c2f84664d8a14f899879 0c2aa38e0600e0d2df09c2f84664d8a14f899879 tracked.txt',
      '? .gitignore',
      '? untracked.txt',
    ].join(NUL) + NUL;

  it('reads the branch header (oid + head)', () => {
    const parsed = parseStatusV2(statusFixture);
    expect(parsed.branch.oid).toBe('29c6f6731985353342e28fc176745ed0dc2f9ed2');
    expect(parsed.branch.head).toBe('main');
    expect(parsed.branch.upstream).toBeNull();
    expect(parsed.branch.ahead).toBeNull();
    expect(parsed.branch.behind).toBeNull();
  });

  it('reads the staged rename with its original path and similarity score', () => {
    const parsed = parseStatusV2(statusFixture);
    const renamed = parsed.entries.find((entry) => entry.kind === 'renamed');
    expect(renamed).toEqual({
      kind: 'renamed',
      path: 'renamed.txt',
      origPath: 'keep.txt',
      staged: 'R',
      unstaged: '',
      xy: 'R.',
      score: 'R100',
    });
  });

  it('reads a staged add and an unstaged modify as ordinary entries', () => {
    const parsed = parseStatusV2(statusFixture);
    const staged = parsed.entries.find((entry) => entry.path === 'staged.txt');
    expect(staged).toMatchObject({ kind: 'ordinary', staged: 'A', unstaged: '', xy: 'A.' });
    const modified = parsed.entries.find((entry) => entry.path === 'tracked.txt');
    expect(modified).toMatchObject({ kind: 'ordinary', staged: '', unstaged: 'M', xy: '.M' });
  });

  it('reads untracked entries', () => {
    const parsed = parseStatusV2(statusFixture);
    const untracked = parsed.entries.filter((entry) => entry.kind === 'untracked').map((entry) => entry.path);
    expect(untracked).toEqual(['.gitignore', 'untracked.txt']);
  });

  it('handles an initial repo with no commits (# branch.oid (initial))', () => {
    const initialFixture =
      ['# branch.oid (initial)', '# branch.head main', '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 587be6b4c3f93f93c489c0111bba5596147a26cb f.txt'].join(NUL) +
      NUL;
    const parsed = parseStatusV2(initialFixture);
    expect(parsed.branch.oid).toBeNull();
    expect(parsed.branch.head).toBe('main');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ path: 'f.txt', staged: 'A' });
  });

  it('reads upstream + ahead/behind headers when present (synthetic)', () => {
    const trackedFixture =
      ['# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'].join(NUL) + NUL;
    const parsed = parseStatusV2(trackedFixture);
    expect(parsed.branch.upstream).toBe('origin/main');
    expect(parsed.branch.ahead).toBe(2);
    expect(parsed.branch.behind).toBe(1);
  });

  it('classifies unmerged and ignored records, tolerating a path with spaces', () => {
    const fixture =
      [
        '# branch.head main',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict me.txt',
        '! build output.log',
        'x some future record type',
      ].join(NUL) + NUL;
    const parsed = parseStatusV2(fixture);
    const unmerged = parsed.entries.find((entry) => entry.kind === 'unmerged');
    expect(unmerged).toMatchObject({ path: 'conflict me.txt', xy: 'UU' });
    const ignored = parsed.entries.find((entry) => entry.kind === 'ignored');
    expect(ignored).toMatchObject({ path: 'build output.log', xy: '!' });
    // The unknown 'x' record type is skipped, never thrown on (rule 0.6).
    expect(parsed.entries).toHaveLength(2);
  });

  it('never throws on empty or garbage input', () => {
    expect(() => parseStatusV2('')).not.toThrow();
    expect(parseStatusV2('').entries).toEqual([]);
    expect(() => parseStatusV2('total garbage no nuls')).not.toThrow();
  });
});

describe('parseDiff — real git diff --no-color output', () => {
  // Captured: a two-hunk modify plus a deleted file (Spike G edge-case capture).
  const twoHunkAndDelete = `diff --git a/big.txt b/big.txt
index c9e9e05..d96039a 100644
--- a/big.txt
+++ b/big.txt
@@ -1,4 +1,4 @@
-one
+ONE
 two
 three
 four
@@ -7,4 +7,4 @@ six
 seven
 eight
 nine
-ten
+TEN
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4202011..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-to be deleted
`;

  it('splits into files and hunks with correct line tagging + numbers', () => {
    const files = parseDiff(twoHunkAndDelete);
    expect(files).toHaveLength(2);
    const bigFile = files[0]!;
    expect(bigFile.path).toBe('big.txt');
    expect(bigFile.changeKind).toBe('modified');
    expect(bigFile.oldPath).toBe('big.txt');
    expect(bigFile.newPath).toBe('big.txt');
    expect(bigFile.hunks).toHaveLength(2);

    const firstHunk = bigFile.hunks[0]!;
    expect(firstHunk).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, section: '' });
    expect(firstHunk.lines[0]).toEqual({ kind: 'del', content: 'one', oldLineNumber: 1, newLineNumber: null });
    expect(firstHunk.lines[1]).toEqual({ kind: 'add', content: 'ONE', oldLineNumber: null, newLineNumber: 1 });
    expect(firstHunk.lines[2]).toEqual({ kind: 'context', content: 'two', oldLineNumber: 2, newLineNumber: 2 });

    const secondHunk = bigFile.hunks[1]!;
    expect(secondHunk).toMatchObject({ oldStart: 7, newStart: 7, section: 'six' });
    // Context line numbering resumes at the hunk's start offsets.
    expect(secondHunk.lines[0]).toEqual({ kind: 'context', content: 'seven', oldLineNumber: 7, newLineNumber: 7 });
  });

  it('marks a deleted file (newPath null, count-omitted hunk header)', () => {
    const files = parseDiff(twoHunkAndDelete);
    const goneFile = files[1]!;
    expect(goneFile.changeKind).toBe('deleted');
    expect(goneFile.path).toBe('gone.txt');
    expect(goneFile.oldPath).toBe('gone.txt');
    expect(goneFile.newPath).toBeNull();
    // `@@ -1 +0,0 @@` — the omitted old count defaults to 1.
    expect(goneFile.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
  });

  it('marks an added file and tolerates the no-newline marker', () => {
    const addedFixture = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..ee41339
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+brand new no newline
\\ No newline at end of file
`;
    const files = parseDiff(addedFixture);
    expect(files).toHaveLength(1);
    const addedFile = files[0]!;
    expect(addedFile.changeKind).toBe('added');
    expect(addedFile.oldPath).toBeNull();
    expect(addedFile.newPath).toBe('added.txt');
    expect(addedFile.hunks[0]!.lines).toEqual([
      { kind: 'add', content: 'brand new no newline', oldLineNumber: null, newLineNumber: 1 },
    ]);
  });

  it('marks a binary file with no hunks', () => {
    const binaryFixture = `diff --git a/logo.png b/logo.png
index 1234567..89abcde 100644
Binary files a/logo.png and b/logo.png differ
`;
    const files = parseDiff(binaryFixture);
    expect(files[0]).toMatchObject({ path: 'logo.png', binary: true });
    expect(files[0]!.hunks).toEqual([]);
  });

  it('never throws on empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('parseWorktrees — real worktree list --porcelain output', () => {
  const worktreeFixture = `worktree /tmp/repo
HEAD 3b9a17ada075323398e81107edb571333f74a725
branch refs/heads/main

worktree /tmp/repo-feature
HEAD 1111111111111111111111111111111111111111
detached
`;

  it('parses records split on blank lines', () => {
    const worktrees = parseWorktrees(worktreeFixture);
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toEqual({
      path: '/tmp/repo',
      head: '3b9a17ada075323398e81107edb571333f74a725',
      branch: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
    });
    expect(worktrees[1]).toMatchObject({ path: '/tmp/repo-feature', detached: true, branch: null });
  });

  it('never throws on empty input', () => {
    expect(parseWorktrees('')).toEqual([]);
  });
});

describe('parseBranches — real for-each-ref output', () => {
  // Captured: two branches, neither with an upstream (trailing space).
  const branchFixture = 'feature-x 3b9a17a \nmain 3b9a17a \n';

  it('parses name + short oid, null upstream when absent', () => {
    const branches = parseBranches(branchFixture);
    expect(branches).toEqual([
      { name: 'feature-x', oid: '3b9a17a', upstream: null },
      { name: 'main', oid: '3b9a17a', upstream: null },
    ]);
  });

  it('reads an upstream when present', () => {
    const branches = parseBranches('main 3b9a17a origin/main\n');
    expect(branches[0]).toEqual({ name: 'main', oid: '3b9a17a', upstream: 'origin/main' });
  });

  it('never throws on empty input', () => {
    expect(parseBranches('')).toEqual([]);
  });
});

describe('GitAdapter with an injected fake runner', () => {
  // A canned runner keyed on the first arg — deterministic, no real git.
  function fakeRunner(cannedByCommand: Record<string, { stdout?: string; stderr?: string; exitCode?: number | null }>): GitRunner {
    return async (args) => {
      const command = args[0] ?? '';
      const canned = cannedByCommand[command] ?? { stdout: '', exitCode: 0 };
      return { stdout: canned.stdout ?? '', stderr: canned.stderr ?? '', exitCode: canned.exitCode ?? 0 };
    };
  }

  it('reports git-unavailable when the version preflight fails', async () => {
    const adapter = new GitAdapter({ runner: fakeRunner({ '--version': { exitCode: null } }) });
    const result = await adapter.status('/repo');
    expect(result).toEqual({ ok: false, error: 'git-unavailable' });
  });

  it('reports git-failed with stderr detail on a non-zero exit', async () => {
    const adapter = new GitAdapter({
      runner: fakeRunner({
        '--version': { stdout: 'git version 2.43.0', exitCode: 0 },
        commit: { stderr: 'nothing to commit, working tree clean', exitCode: 1 },
      }),
    });
    const result = await adapter.commit('/repo', 'msg');
    expect(result).toEqual({ ok: false, error: 'git-failed', detail: 'nothing to commit, working tree clean' });
  });

  it('reports not-a-repo when rev-parse fails', async () => {
    const adapter = new GitAdapter({
      runner: fakeRunner({
        '--version': { stdout: 'git version 2.43.0', exitCode: 0 },
        'rev-parse': { stderr: 'fatal: not a git repository', exitCode: 128 },
      }),
    });
    const result = await adapter.repoRootFor('/not/a/repo');
    expect(result).toEqual({ ok: false, error: 'not-a-repo', detail: 'fatal: not a git repository' });
  });
});

// ── gitAvailable over the real runner (verify-row; git IS present at 2.43.0) ──
describe('gitAvailable — real git preflight', () => {
  it('returns true when git is on PATH', async () => {
    expect(await gitAvailable(defaultGitRunner)).toBe(true);
  });
});

// ── hermetic integration: real git over a scratch repo, isolated from the box ──
//
// Uses the REAL defaultGitRunner. The scratch repo lives in a temp dir; the
// commit identity + config isolation come from env (GIT_CONFIG_GLOBAL=/dev/null,
// GIT_CONFIG_SYSTEM=/dev/null, HOME=temp, and explicit GIT_AUTHOR_*/COMMITTER_*)
// set ONLY for this test's window and restored after — so git never reads Wes's
// gitconfig and never touches the network. Default vitest pool ('forks') isolates
// this file in its own process, so the env mutation cannot race another file.
describe('GitAdapter — hermetic real-git round-trip', () => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), 'vimes-git-int-'));
  const isolatedHome = join(scratchDirectory, 'home');
  const repoDirectory = join(scratchDirectory, 'repo');

  afterAll(() => {
    rmSync(scratchDirectory, { recursive: true, force: true });
  });

  it('status + diff + stage + commit round-trip against real git', async () => {
    const savedEnv: Record<string, string | undefined> = {
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };
    try {
      // Isolation: no global/system gitconfig, an empty HOME, a fixed identity.
      process.env.HOME = isolatedHome;
      process.env.GIT_CONFIG_GLOBAL = '/dev/null';
      process.env.GIT_CONFIG_SYSTEM = '/dev/null';
      process.env.GIT_AUTHOR_NAME = 'Vimes Test';
      process.env.GIT_AUTHOR_EMAIL = 'vimes-test@example.invalid';
      process.env.GIT_COMMITTER_NAME = 'Vimes Test';
      process.env.GIT_COMMITTER_EMAIL = 'vimes-test@example.invalid';

      const gitEnv = { ...process.env };
      const runGitSetup = (args: string[]): void => {
        execFileSync('git', args, { cwd: repoDirectory, env: gitEnv });
      };
      // Build a known initial commit, then make a change to review.
      execFileSync('git', ['init', '-q', '-b', 'main', repoDirectory], { env: gitEnv });
      writeFileSync(join(repoDirectory, 'tracked.txt'), 'line one\nline two\nline three\n');
      runGitSetup(['add', '-A']);
      runGitSetup(['commit', '-q', '-m', 'initial']);
      // An unstaged modify + a brand-new untracked file.
      writeFileSync(join(repoDirectory, 'tracked.txt'), 'line one\nline two CHANGED\nline three\n');
      writeFileSync(join(repoDirectory, 'fresh.txt'), 'a fresh line\n');

      const adapter = new GitAdapter();

      // repoRootFor discovers the toplevel.
      const toplevel = await adapter.repoRootFor(repoDirectory);
      expect(toplevel.ok).toBe(true);
      const repoRoot = toplevel.ok ? toplevel.value : '';

      // status sees the modify (unstaged) and the untracked file.
      const statusResult = await adapter.status(repoRoot);
      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(statusResult.value.branch.head).toBe('main');
        const tracked = statusResult.value.entries.find((entry) => entry.path === 'tracked.txt');
        expect(tracked).toMatchObject({ kind: 'ordinary', unstaged: 'M' });
        const fresh = statusResult.value.entries.find((entry) => entry.path === 'fresh.txt');
        expect(fresh).toMatchObject({ kind: 'untracked' });
      }

      // diff (unstaged) shows the changed line.
      const diffResult = await adapter.diff(repoRoot);
      expect(diffResult.ok).toBe(true);
      if (diffResult.ok) {
        const trackedDiff = diffResult.value.find((file) => file.path === 'tracked.txt');
        expect(trackedDiff).toBeDefined();
        const addedLine = trackedDiff!.hunks.flatMap((hunk) => hunk.lines).find((line) => line.kind === 'add');
        expect(addedLine?.content).toBe('line two CHANGED');
      }

      // stage the modify, then commit it — the round-trip write path.
      const stageResult = await adapter.stage(repoRoot, join(repoRoot, 'tracked.txt'));
      expect(stageResult.ok).toBe(true);
      const stagedDiff = await adapter.diff(repoRoot, join(repoRoot, 'tracked.txt'), true);
      expect(stagedDiff.ok).toBe(true);
      if (stagedDiff.ok) {
        expect(stagedDiff.value).toHaveLength(1);
      }
      const commitResult = await adapter.commit(repoRoot, 'review: apply the change');
      expect(commitResult.ok).toBe(true);

      // After commit, tracked.txt is no longer dirty (only fresh.txt remains).
      const afterStatus = await adapter.status(repoRoot);
      expect(afterStatus.ok).toBe(true);
      if (afterStatus.ok) {
        const tracked = afterStatus.value.entries.find((entry) => entry.path === 'tracked.txt');
        expect(tracked).toBeUndefined();
      }

      // The commit really landed with the isolated identity (no Wes gitconfig).
      const log = execFileSync('git', ['log', '--format=%an <%ae> %s', '-1'], { cwd: repoRoot, env: gitEnv }).toString();
      expect(log.trim()).toBe('Vimes Test <vimes-test@example.invalid> review: apply the change');
      // Guard: the scratch repo carries no stray NUL-bearing artifacts.
      expect(existsSync(join(repoRoot, '.git'))).toBe(true);
      expect(readFileSync(join(repoRoot, 'tracked.txt')).includes(0)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
