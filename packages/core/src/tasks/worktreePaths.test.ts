import { describe, expect, it } from 'vitest';
import {
  TASK_WORKTREE_BRANCH_PREFIX,
  TASK_WORKTREE_DIR_PREFIX,
  taskWorktreeBranch,
  taskWorktreeDirName,
} from './worktreePaths.js';

// ─── slice 6 step 8, assertions 1–3 — the pure worktree name derivation ──────
//
// ⚠ NOTHING HERE TOUCHES GIT OR THE FILESYSTEM. These are two pure string
// functions; the whole module has no I/O to fake.
//
// The hostile-id cases are the reason this file exists. Every taskId in production
// today is a uuid minted by `TaskWriter`, so none of them can currently arrive —
// but the OUTPUT of these functions becomes a filesystem path and a git ref, and
// slice 7's MCP surface is a caller nobody has written yet. The guarantees are
// asserted now, while asserting them is free.

// A realistic id (the shape `TaskWriter` mints) and the shape the fixtures use.
const REALISTIC_TASK_ID = 'task-dispatch-0001';
const UUID_TASK_ID = '00000000-0000-4000-8000-000000000001';

// The hostile menagerie. Each entry is a thing that, unescaped, would be a real
// exploit against a path or a git ref.
const HOSTILE_TASK_IDS: ReadonlyArray<{ name: string; taskId: string }> = [
  { name: 'parent traversal', taskId: '../../etc' },
  { name: 'bare dot-dot', taskId: '..' },
  { name: 'single dot', taskId: '.' },
  { name: 'absolute path', taskId: '/etc/passwd' },
  { name: 'leading dash (git would read it as an OPTION)', taskId: '-rf' },
  { name: 'long option', taskId: '--force' },
  { name: 'path separator', taskId: 'a/b' },
  { name: 'windows separator', taskId: 'a\\b' },
  { name: 'empty', taskId: '' },
  { name: 'whitespace only', taskId: '   ' },
  { name: 'newline', taskId: 'a\nb' },
  // Written as an ESCAPE, never as a literal byte: a real NUL in a source file is
  // invisible in a diff and would make this test lie about what it is testing.
  { name: 'NUL byte', taskId: 'a\u0000b' },
  { name: 'shell metacharacters', taskId: '$(rm -rf ~); `id`; a|b&c' },
  { name: 'git ref refusals', taskId: 'a~1^2:3?4*5[6' },
  { name: 'git lock suffix', taskId: 'branch.lock' },
  { name: 'unicode + astral', taskId: 't\u00e2che-\u65e5\u672c\u8a9e-\u{1f642}' },
  { name: 'combining mark', taskId: 'e\u0301' },
  { name: 'very long', taskId: 'x'.repeat(5_000) },
  { name: 'very long hostile', taskId: '../'.repeat(2_000) },
  { name: 'underscore (the escape character itself)', taskId: '_0041' },
];

// Everything a derived name must never be, asserted in one place so a new case
// only has to name its input.
function expectSafeName(derivedName: string, label: string): void {
  expect(derivedName, `${label}: must not be empty`).not.toBe('');
  expect(derivedName, `${label}: no path separator`).not.toMatch(/[/\\]/);
  expect(derivedName, `${label}: no dot at all, so '..' and '.lock' are unreachable`).not.toContain(
    '.',
  );
  expect(derivedName, `${label}: never starts with a dash`).not.toMatch(/^-/);
  // The full legal charset: letters, digits, dash, and the `_` escape marker.
  expect(derivedName, `${label}: conservative charset only`).toMatch(/^[A-Za-z0-9_-]+$/);
  // Bounded: the prefix plus a 64-character slug plus a 9-character fingerprint.
  expect(derivedName.length, `${label}: bounded length`).toBeLessThanOrEqual(128);
}

describe('worktreePaths — assertion 1: deterministic', () => {
  it('maps the same taskId to the same branch and dir, every time', () => {
    // The property the whole retry story rests on: a re-dispatched task must find
    // the worktree it already has instead of minting a second one.
    for (const taskId of [REALISTIC_TASK_ID, UUID_TASK_ID, ...HOSTILE_TASK_IDS.map((c) => c.taskId)]) {
      const firstBranch = taskWorktreeBranch(taskId);
      const firstDirName = taskWorktreeDirName(taskId);
      for (let repeat = 0; repeat < 5; repeat += 1) {
        expect(taskWorktreeBranch(taskId)).toBe(firstBranch);
        expect(taskWorktreeDirName(taskId)).toBe(firstDirName);
      }
    }
  });

  it('derives from the taskId ALONE — the readable happy path is pinned verbatim', () => {
    // Pinned so a future refactor of the escaper cannot silently re-point every
    // existing task's worktree at a new directory.
    expect(taskWorktreeBranch(REALISTIC_TASK_ID)).toBe('vimes/task-task-dispatch-0001');
    expect(taskWorktreeDirName(REALISTIC_TASK_ID)).toBe('task-task-dispatch-0001');
    expect(taskWorktreeBranch(UUID_TASK_ID)).toBe(
      `${TASK_WORKTREE_BRANCH_PREFIX}00000000-0000-4000-8000-000000000001`,
    );
    expect(taskWorktreeDirName(UUID_TASK_ID)).toBe(
      `${TASK_WORKTREE_DIR_PREFIX}00000000-0000-4000-8000-000000000001`,
    );
  });
});

describe('worktreePaths — assertion 2: hostile taskIds are safe, and nothing throws', () => {
  for (const { name, taskId } of HOSTILE_TASK_IDS) {
    it(`${name}: no traversal, no separator, no leading dash, no throw`, () => {
      let branch = '';
      let dirName = '';
      expect(() => {
        branch = taskWorktreeBranch(taskId);
        dirName = taskWorktreeDirName(taskId);
      }, `${name} must not throw — these functions are TOTAL`).not.toThrow();

      // The DIRECTORY NAME is the one that becomes a path component.
      expectSafeName(dirName, `${name} dirName`);
      expect(dirName.startsWith(TASK_WORKTREE_DIR_PREFIX), `${name}: keeps its prefix`).toBe(true);

      // The BRANCH is the one that becomes a git ref. It carries exactly one
      // slash — the `vimes/` namespace — and nothing the id contributed.
      expect(branch.startsWith(TASK_WORKTREE_BRANCH_PREFIX), `${name}: keeps its prefix`).toBe(true);
      const branchTail = branch.slice(TASK_WORKTREE_BRANCH_PREFIX.length);
      expectSafeName(`${TASK_WORKTREE_DIR_PREFIX}${branchTail}`, `${name} branch tail`);
      expect(branch.split('/'), `${name}: exactly one slash, ours`).toHaveLength(2);
    });
  }

  it('a traversal id cannot escape its root when joined naively', () => {
    // The concrete consequence, stated as the attack rather than as a charset:
    // joining the derived name onto a root must stay under the root even with the
    // dumbest possible join.
    const worktreeRoot = '/var/lib/vimes-worktrees';
    const joinedPath = `${worktreeRoot}/${taskWorktreeDirName('../../etc')}`;
    expect(joinedPath.startsWith(`${worktreeRoot}/`)).toBe(true);
    expect(joinedPath).not.toContain('..');
    expect(joinedPath.split('/')).toHaveLength(5); // '', var, lib, vimes-worktrees, <name>
  });

  it('an over-long id is BOUNDED rather than passed through', () => {
    // Unbounded would mean ENAMETOOLONG at `git worktree add` time, which would
    // surface as an unexplained worktree-failed rather than as "your id is absurd".
    const dirName = taskWorktreeDirName('y'.repeat(10_000));
    expect(dirName.length).toBeLessThanOrEqual(128);
  });
});

describe('worktreePaths — assertion 3: distinct ids never collide', () => {
  it('gives every distinct taskId a distinct branch AND a distinct dir', () => {
    // ⚠ THE SANITISER'S OWN FAILURE MODE. A sanitiser that STRIPPED unsafe
    // characters would map 'a/b' and 'ab' onto one worktree — two tasks quietly
    // sharing a directory, which is the exact hazard this step exists to remove.
    // These pairs are chosen to collapse under any strip-based implementation.
    const distinctTaskIds = [
      'a/b',
      'ab',
      'a-b',
      'a_b',
      'a\\b',
      'a.b',
      'a b',
      '..',
      '.',
      '',
      '-rf',
      'rf',
      '--force',
      'force',
      REALISTIC_TASK_ID,
      UUID_TASK_ID,
      't\u00e2che',
      'tache',
      // Combining vs precomposed: two DIFFERENT ids that look identical. Written
      // as escapes so the distinction is visible in a diff.
      'e\u0301',
      '\u00e9',
      `${'z'.repeat(64)}A`,
      `${'z'.repeat(64)}B`,
      `${'z'.repeat(200)}A`,
      `${'z'.repeat(200)}B`,
    ];
    const branches = new Set(distinctTaskIds.map(taskWorktreeBranch));
    const dirNames = new Set(distinctTaskIds.map(taskWorktreeDirName));
    expect(branches.size, 'every distinct id must own a distinct branch').toBe(
      distinctTaskIds.length,
    );
    expect(dirNames.size, 'every distinct id must own a distinct directory').toBe(
      distinctTaskIds.length,
    );
  });

  it('the escape is injective even for ids that differ only in escaped characters', () => {
    // `_` is itself escaped, so the encoding can never be read two ways: the
    // literal id '_0041' must not land where the escape of 'A' would.
    expect(taskWorktreeDirName('_0041')).not.toBe(taskWorktreeDirName('A'));
    expect(taskWorktreeDirName('/')).not.toBe(taskWorktreeDirName('\\'));
  });
});
