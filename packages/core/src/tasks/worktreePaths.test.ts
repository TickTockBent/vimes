import { describe, expect, it } from 'vitest';
import { validateRefName } from '../git/refValidation.js';
import {
  NODE_CHECKOUT_BRANCH_PREFIX,
  NODE_CHECKOUT_DIR_PREFIX,
  TASK_WORKTREE_BRANCH_PREFIX,
  TASK_WORKTREE_DIR_PREFIX,
  nodeCheckoutBranch,
  nodeCheckoutDirName,
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

// ─── slice 17, unit 1 — node-derived checkout names (§3.6, §3.11) ────────────
//
// Same pipeline, same idiom, new tenant: everything above pins the LEGACY
// task-derived pair (unmodified, per §3.11 — U3 deletes it later); everything
// below pins the pair that replaces it. The hostile menagerie and the
// `expectSafeName` shape-check are REUSED verbatim from above rather than
// duplicated, because the escaper and fingerprint pipeline is reused verbatim
// in the implementation too.

// Node ids as the engine actually mints them today (uuid-shaped) and as a
// human-legible placeholder — deliberately containing NEITHER 'task' NOR any
// prefix collision with the legacy family, so the tenant-word assertion below
// tests the DERIVATION's own vocabulary rather than an id that happened to
// carry the word already.
const REALISTIC_NODE_ID = 'node-aaaa-0001';
const UUID_NODE_ID = '00000000-0000-4000-8000-00000000node';

describe('worktreePaths — node-derived names, assertion: deterministic (§3.7)', () => {
  it('maps the same nodeId to the same branch and dir, every time', () => {
    for (const nodeId of [REALISTIC_NODE_ID, UUID_NODE_ID, ...HOSTILE_TASK_IDS.map((c) => c.taskId)]) {
      const firstBranch = nodeCheckoutBranch(nodeId);
      const firstDirName = nodeCheckoutDirName(nodeId);
      for (let repeat = 0; repeat < 5; repeat += 1) {
        expect(nodeCheckoutBranch(nodeId)).toBe(firstBranch);
        expect(nodeCheckoutDirName(nodeId)).toBe(firstDirName);
      }
    }
  });

  it('derives from the nodeId ALONE — the readable happy path is pinned verbatim', () => {
    expect(nodeCheckoutBranch(REALISTIC_NODE_ID)).toBe('vimes/node-node-aaaa-0001');
    expect(nodeCheckoutDirName(REALISTIC_NODE_ID)).toBe('node-node-aaaa-0001');
  });
});

describe('worktreePaths — node-derived names, assertion: hostile nodeIds are safe, and nothing throws', () => {
  for (const { name, taskId: hostileNodeId } of HOSTILE_TASK_IDS) {
    it(`${name}: no traversal, no separator, no leading dash, no throw`, () => {
      let branch = '';
      let dirName = '';
      expect(() => {
        branch = nodeCheckoutBranch(hostileNodeId);
        dirName = nodeCheckoutDirName(hostileNodeId);
      }, `${name} must not throw — these functions are TOTAL`).not.toThrow();

      expectSafeName(dirName, `${name} dirName`);
      expect(dirName.startsWith(NODE_CHECKOUT_DIR_PREFIX), `${name}: keeps its prefix`).toBe(true);

      expect(branch.startsWith(NODE_CHECKOUT_BRANCH_PREFIX), `${name}: keeps its prefix`).toBe(true);
      const branchTail = branch.slice(NODE_CHECKOUT_BRANCH_PREFIX.length);
      expectSafeName(`${NODE_CHECKOUT_DIR_PREFIX}${branchTail}`, `${name} branch tail`);
      expect(branch.split('/'), `${name}: exactly one slash, ours`).toHaveLength(2);
    });
  }
});

describe('worktreePaths — node-derived names, assertion: distinct ids never collide', () => {
  it('gives every distinct nodeId a distinct branch AND a distinct dir, even over a shared 64-char prefix', () => {
    // The fingerprint's ENTIRE job (worktreePaths.ts's `nodeCheckoutSlug`,
    // reusing `fingerprint` verbatim): without it, two ids that agree on their
    // first MAX_SLUG_LENGTH characters would truncate onto the SAME directory —
    // two different checkouts quietly sharing one worktree. These two ids are
    // chosen to collapse under exactly that failure mode.
    const distinctNodeIds = [
      REALISTIC_NODE_ID,
      UUID_NODE_ID,
      `${'z'.repeat(64)}A`,
      `${'z'.repeat(64)}B`,
      `${'z'.repeat(200)}A`,
      `${'z'.repeat(200)}B`,
    ];
    const branches = new Set(distinctNodeIds.map(nodeCheckoutBranch));
    const dirNames = new Set(distinctNodeIds.map(nodeCheckoutDirName));
    expect(branches.size, 'every distinct nodeId must own a distinct branch').toBe(
      distinctNodeIds.length,
    );
    expect(dirNames.size, 'every distinct nodeId must own a distinct directory').toBe(
      distinctNodeIds.length,
    );
  });
});

describe('worktreePaths — node-derived names, prefix correctness', () => {
  it('uses the node-specific prefixes, distinct from the legacy task pair', () => {
    expect(NODE_CHECKOUT_BRANCH_PREFIX).toBe('vimes/node-');
    expect(NODE_CHECKOUT_DIR_PREFIX).toBe('node-');
    expect(NODE_CHECKOUT_BRANCH_PREFIX).not.toBe(TASK_WORKTREE_BRANCH_PREFIX);
    expect(NODE_CHECKOUT_DIR_PREFIX).not.toBe(TASK_WORKTREE_DIR_PREFIX);
    expect(nodeCheckoutBranch(REALISTIC_NODE_ID).startsWith(NODE_CHECKOUT_BRANCH_PREFIX)).toBe(true);
    expect(nodeCheckoutDirName(REALISTIC_NODE_ID).startsWith(NODE_CHECKOUT_DIR_PREFIX)).toBe(true);
  });
});

describe('worktreePaths — node-derived names, assertion A5 #16: no tenant word "task"', () => {
  it('never spells "task" in a node-derived branch or directory name', () => {
    // The derivation's own vocabulary (prefixes + escaper + fingerprint) must
    // never spell the retired tenant word — checked over ids that do not
    // themselves already contain it, so this tests the CODE, not the input.
    const taskFreeNodeIds = [
      REALISTIC_NODE_ID,
      UUID_NODE_ID,
      'node-bbbb-0002',
      '../../etc',
      '-rf',
      '',
      'x'.repeat(5_000),
    ];
    for (const nodeId of taskFreeNodeIds) {
      expect(nodeCheckoutBranch(nodeId)).not.toMatch(/task/i);
      expect(nodeCheckoutDirName(nodeId)).not.toMatch(/task/i);
    }
    // Also true of the bare prefixes themselves.
    expect(NODE_CHECKOUT_BRANCH_PREFIX).not.toMatch(/task/i);
    expect(NODE_CHECKOUT_DIR_PREFIX).not.toMatch(/task/i);
  });
});

describe('worktreePaths — node-derived names, branch passes the §3.9 ref grammar', () => {
  it('every node-derived branch — happy-path and hostile — validates under validateRefName', () => {
    for (const nodeId of [REALISTIC_NODE_ID, UUID_NODE_ID, ...HOSTILE_TASK_IDS.map((c) => c.taskId)]) {
      const branch = nodeCheckoutBranch(nodeId);
      expect(
        validateRefName(branch),
        `branch derived from ${JSON.stringify(nodeId)} must pass validateRefName: got ${branch}`,
      ).toEqual({ ok: true });
    }
  });
});
