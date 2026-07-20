import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWithinRoots, type RealpathProbe } from './filePaths.js';

// ─── The security spine (spec §3.11) ──────────────────────────────────────────
// resolveWithinRoots is the one gate every request-derived path passes through.
// Symlink-escape MUST be exercised against a real symlink on the real fs (the
// realpath probe is the mechanism that catches it); the rest mix real-fs and an
// injected fake probe to prove the module is pure but for that one probe.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-filepaths-'));
// A canonical root: a real directory with a nested tree and an escaping symlink.
const projectRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'root-')));
// A directory OUTSIDE the root — the target every escape attempt aims at.
const outsideDirectory = realpathSync(mkdtempSync(join(temporaryDirectory, 'outside-')));

mkdirSync(join(projectRoot, 'src'));
writeFileSync(join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(outsideDirectory, 'secret.txt'), 'TOP SECRET\n');
// A symlink INSIDE the root that points OUT of the root (the escape vector).
symlinkSync(outsideDirectory, join(projectRoot, 'escape'));
symlinkSync(join(outsideDirectory, 'secret.txt'), join(projectRoot, 'secretlink'));

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('resolveWithinRoots — traversal & absolute-outside refusals', () => {
  it('refuses a `../../etc/passwd` traversal that climbs out of the root', () => {
    const result = resolveWithinRoots('../../etc/passwd', [projectRoot]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('outside-roots');
    }
  });

  it('refuses an absolute path outside every root', () => {
    const result = resolveWithinRoots('/etc/passwd', [projectRoot]);
    expect(result.ok).toBe(false);
  });

  it('refuses a nested traversal even when it starts inside the root string', () => {
    // src/../../<outside>/secret.txt — collapses to outside the root.
    const climbing = join('src', '..', '..', 'outside-does-not-matter', 'secret.txt');
    const result = resolveWithinRoots(climbing, [projectRoot]);
    expect(result.ok).toBe(false);
  });
});

describe('resolveWithinRoots — symlink escape (real fs)', () => {
  it('refuses a path THROUGH a symlink that points outside the root', () => {
    // <root>/escape -> <outside>; <root>/escape/secret.txt realpaths OUT of root.
    const result = resolveWithinRoots(join(projectRoot, 'escape', 'secret.txt'), [projectRoot]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('outside-roots');
    }
  });

  it('refuses a symlinked FILE whose target is outside the root', () => {
    const result = resolveWithinRoots(join(projectRoot, 'secretlink'), [projectRoot]);
    expect(result.ok).toBe(false);
  });

  it('refuses a NEW file whose parent chain escapes via a symlink (write path)', () => {
    // <root>/escape/newfile.txt does not exist yet, but its parent realpaths out.
    const result = resolveWithinRoots(join(projectRoot, 'escape', 'newfile.txt'), [projectRoot]);
    expect(result.ok).toBe(false);
  });
});

describe('resolveWithinRoots — null byte', () => {
  it('refuses a path containing a NUL byte, before touching the fs', () => {
    const neverCalled: RealpathProbe = () => {
      throw new Error('realpath must not run when a null byte is present');
    };
    const result = resolveWithinRoots('src/a.ts\0.png', [projectRoot], neverCalled);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('null-byte');
    }
  });
});

describe('resolveWithinRoots — root-boundary exactness', () => {
  it('a sibling dir sharing the root as a string prefix (`/root-evil`) does NOT match `/root`', () => {
    // `${projectRoot}-evil` startsWith `${projectRoot}` as a STRING but is not
    // within it — the `root + sep` guard must reject it.
    const evilSibling = realpathSync(mkdtempSync(join(temporaryDirectory, 'evilsibling-')));
    const targetInsideSibling = join(evilSibling, 'file.txt');
    writeFileSync(targetInsideSibling, 'x');
    // Use a root that is a strict string-prefix of the sibling by constructing
    // both from the same stem.
    const stem = join(temporaryDirectory, 'boundary');
    const exactRoot = stem; // e.g. .../boundary
    const evilName = `${stem}-evil`; // .../boundary-evil  (startsWith stem)
    mkdirSync(exactRoot);
    mkdirSync(evilName);
    writeFileSync(join(exactRoot, 'ok.txt'), 'ok');
    writeFileSync(join(evilName, 'leak.txt'), 'leak');

    const inside = resolveWithinRoots(join(exactRoot, 'ok.txt'), [exactRoot]);
    expect(inside.ok).toBe(true);

    const boundaryEscape = resolveWithinRoots(join(evilName, 'leak.txt'), [exactRoot]);
    expect(boundaryEscape.ok).toBe(false);
    if (!boundaryEscape.ok) {
      expect(boundaryEscape.reason).toBe('outside-roots');
    }
  });

  it('accepts the root directory itself (=== root)', () => {
    const result = resolveWithinRoots(projectRoot, [projectRoot]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolute).toBe(projectRoot);
    }
  });
});

describe('resolveWithinRoots — happy paths, nested roots, root-relative', () => {
  it('accepts an absolute path inside the root and returns the canonical absolute', () => {
    const result = resolveWithinRoots(join(projectRoot, 'src', 'a.ts'), [projectRoot]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolute).toBe(join(projectRoot, 'src', 'a.ts'));
    }
  });

  it('resolves a ROOT-RELATIVE path against the containing root', () => {
    const result = resolveWithinRoots('src/a.ts', [projectRoot]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolute).toBe(join(projectRoot, 'src', 'a.ts'));
    }
  });

  it('resolves a relative path against the FIRST allowed root (documented first-root-wins)', () => {
    // A bare relative name is within EVERY root as a would-be path; the first
    // root wins deterministically. The API handlers pass absolute paths (or an
    // explicit root+path joined to absolute), so this branch is the safety net.
    const secondRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'root2-')));
    const result = resolveWithinRoots('only-here.txt', [projectRoot, secondRoot]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolute).toBe(join(projectRoot, 'only-here.txt'));
    }
  });

  it('accepts a file inside a nested root when both parent and child roots are allowed', () => {
    const childRoot = join(projectRoot, 'src');
    const result = resolveWithinRoots(join(childRoot, 'a.ts'), [projectRoot, childRoot]);
    expect(result.ok).toBe(true);
  });
});

describe('resolveWithinRoots — empty allowlist refuses all', () => {
  it('refuses every path when the allowlist is empty (path-traversal discipline)', () => {
    const result = resolveWithinRoots(join(projectRoot, 'src', 'a.ts'), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-roots');
    }
  });
});

describe('resolveWithinRoots — purity (injected fake probe)', () => {
  it('uses ONLY the injected realpath probe for the fs touch (identity probe → lexical result)', () => {
    // An identity probe models "every path exists, no symlinks". The module is
    // otherwise pure: same input → same classified output.
    const identityProbe: RealpathProbe = (path) => path;
    const root = '/allowed/root';
    const inside = resolveWithinRoots('/allowed/root/deep/file.ts', [root], identityProbe);
    expect(inside).toEqual({ ok: true, absolute: '/allowed/root/deep/file.ts' });

    const outside = resolveWithinRoots('/allowed/root-evil/file.ts', [root], identityProbe);
    expect(outside.ok).toBe(false);
  });
});
