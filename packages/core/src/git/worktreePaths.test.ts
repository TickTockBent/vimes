import { describe, expect, it } from 'vitest';
import { validateRefName } from './refValidation.js';
import {
  NODE_CHECKOUT_BRANCH_PREFIX,
  NODE_CHECKOUT_DIR_PREFIX,
  nodeCheckoutBranch,
  nodeCheckoutDirName,
} from './worktreePaths.js';

// ─── the pure checkout-name derivation ───────────────────────────────
//
// ⚠ NOTHING HERE TOUCHES GIT OR THE FILESYSTEM. These are two pure string
// functions; the whole module has no I/O to fake.
//
// The hostile-id cases are the reason this file exists. Every nodeId in production
// today is a uuid minted by the engine, so none of them can currently arrive —
// but the OUTPUT of these functions becomes a filesystem path and a git ref, and
// the propose routes are a caller with an outside surface. The guarantees are
// asserted now, while asserting them is free.
//
// ⚠ **S17·U3 DELETED THE THREE LEGACY BLOCKS THAT STOOD BELOW THIS HEADER**
// (`taskWorktreeBranch` / `taskWorktreeDirName` determinism, hostile-id safety
// and collision-freedom), together with the pair they tested (slice-17.md
// §3.11). Nothing was weakened by that: the hostile menagerie and
// `expectSafeName` below are the SAME fixtures those blocks used, and the node
// blocks run every one of them against the surviving derivation.

// The hostile menagerie. Each entry is a thing that, unescaped, would be a real
// exploit against a path or a git ref.
const HOSTILE_IDS: ReadonlyArray<{ name: string; rawId: string }> = [
  { name: 'parent traversal', rawId: '../../etc' },
  { name: 'bare dot-dot', rawId: '..' },
  { name: 'single dot', rawId: '.' },
  { name: 'absolute path', rawId: '/etc/passwd' },
  { name: 'leading dash (git would read it as an OPTION)', rawId: '-rf' },
  { name: 'long option', rawId: '--force' },
  { name: 'path separator', rawId: 'a/b' },
  { name: 'windows separator', rawId: 'a\\b' },
  { name: 'empty', rawId: '' },
  { name: 'whitespace only', rawId: '   ' },
  { name: 'newline', rawId: 'a\nb' },
  // Written as an ESCAPE, never as a literal byte: a real NUL in a source file is
  // invisible in a diff and would make this test lie about what it is testing.
  { name: 'NUL byte', rawId: 'a\u0000b' },
  { name: 'shell metacharacters', rawId: '$(rm -rf ~); `id`; a|b&c' },
  { name: 'git ref refusals', rawId: 'a~1^2:3?4*5[6' },
  { name: 'git lock suffix', rawId: 'branch.lock' },
  { name: 'unicode + astral', rawId: 't\u00e2che-\u65e5\u672c\u8a9e-\u{1f642}' },
  { name: 'combining mark', rawId: 'e\u0301' },
  { name: 'very long', rawId: 'x'.repeat(5_000) },
  { name: 'very long hostile', rawId: '../'.repeat(2_000) },
  { name: 'underscore (the escape character itself)', rawId: '_0041' },
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

// ─── slice 17, unit 1 — node-derived checkout names (§3.6, §3.11) ────────────
//
// The only tenant left. The hostile menagerie and the `expectSafeName`
// shape-check above are the fixtures the retired task-derived blocks used, kept
// because the escaper and fingerprint pipeline they exercise is the same one.

// Node ids as the engine actually mints them today (uuid-shaped) and as a
// human-legible placeholder — deliberately containing NEITHER 'task' NOR any
// prefix collision with the retired family, so the tenant-word assertion below
// tests the DERIVATION's own vocabulary rather than an id that happened to
// carry the word already.
const REALISTIC_NODE_ID = 'node-aaaa-0001';
const UUID_NODE_ID = '00000000-0000-4000-8000-00000000node';

describe('worktreePaths — node-derived names, assertion: deterministic (§3.7)', () => {
  it('maps the same nodeId to the same branch and dir, every time', () => {
    for (const nodeId of [REALISTIC_NODE_ID, UUID_NODE_ID, ...HOSTILE_IDS.map((c) => c.rawId)]) {
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
  for (const { name, rawId: hostileNodeId } of HOSTILE_IDS) {
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
  it('uses the node-specific prefixes, distinct from the RETIRED task pair', () => {
    expect(NODE_CHECKOUT_BRANCH_PREFIX).toBe('vimes/node-');
    expect(NODE_CHECKOUT_DIR_PREFIX).toBe('node-');
    // ⚠ The two `not.toBe(TASK_WORKTREE_*)` lines that stood here compared against
    // the legacy CONSTANTS, which S17·U3 deleted. The claim they made survives as
    // a comparison with the retired SPELLINGS, written as literals: the node pair
    // must not have inherited the tenant word by accident (§3.6), and asserting
    // that against a literal is strictly stronger than asserting it against a
    // constant that could have been edited in the same commit.
    expect(NODE_CHECKOUT_BRANCH_PREFIX).not.toBe('vimes/task-');
    expect(NODE_CHECKOUT_DIR_PREFIX).not.toBe('task-');
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
    for (const nodeId of [REALISTIC_NODE_ID, UUID_NODE_ID, ...HOSTILE_IDS.map((c) => c.rawId)]) {
      const branch = nodeCheckoutBranch(nodeId);
      expect(
        validateRefName(branch),
        `branch derived from ${JSON.stringify(nodeId)} must pass validateRefName: got ${branch}`,
      ).toEqual({ ok: true });
    }
  });
});
