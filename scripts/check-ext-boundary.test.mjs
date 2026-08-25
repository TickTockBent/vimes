// Tests for scripts/check-ext-boundary.mjs (docs/slice-18.md §3.3, §4-A5).
//
// Drives checkExtBoundary() AS A FUNCTION against THROWAWAY fixture trees
// built in a temp dir by this file — never against the real packages for the
// failure cases (S18·U1 work order, Part E). The s1-s8 matrix mirrors A5's
// sabotage matrix; the CLEAN and REAL-TREE cases prove the checker doesn't
// cry wolf on either a well-formed fixture or the shipped repo.
//
// `.mjs`, not `.ts`: this file lives outside packages/*/src (no tsconfig
// project reference covers it — see the `.vue`/`sw.ts` gotchas in the root
// CLAUDE.md for the shape of that hole-family), and the script under test is
// itself plain ESM with no build step. Running vitest directly against `.mjs`
// keeps the loop the same as the script's own execution — no compile step to
// diverge from what actually ships.

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkExtBoundary } from './check-ext-boundary.mjs';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-boundary-fixture-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(dir, relFile, content) {
  const full = path.join(dir, relFile);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function writeJson(dir, relFile, obj) {
  writeFile(dir, relFile, JSON.stringify(obj, null, 2) + '\n');
}

// ─── the clean, valid fixture tree every scenario starts from ──────────────

function buildCleanFixture(dir) {
  writeJson(dir, 'package.json', {
    name: 'fixture-root',
    private: true,
    devDependencies: { vitest: '^3' },
  });

  writeJson(dir, 'packages/ext-host/package.json', {
    name: '@vimes/ext-host',
    private: true,
    dependencies: { '@vimes/core': '*' },
  });
  writeJson(dir, 'packages/ext-host/surface.json', [
    { name: 'Foo', from: '@vimes/core', original: 'Foo', kind: 'type' },
    { name: 'doIt', from: '@vimes/core', original: 'doIt', kind: 'value' },
  ]);
  writeFile(
    dir,
    'packages/ext-host/src/index.ts',
    "export type { Foo } from '@vimes/core';\nexport { doIt } from '@vimes/core';\n",
  );

  writeJson(dir, 'packages/ext-tasks/package.json', {
    name: '@vimes/ext-tasks',
    private: true,
    dependencies: { '@vimes/ext-host': '*', zod: '^3' },
  });
  writeFile(
    dir,
    'packages/ext-tasks/src/index.ts',
    "export { doIt } from '@vimes/ext-host';\nimport { z } from 'zod';\nexport const schema = z.object({});\n",
  );
  writeFile(
    dir,
    'packages/ext-tasks/src/discovery.test.ts',
    "import { describe, expect, it } from 'vitest';\nimport './index.js';\n\ndescribe('discovery', () => {\n  it('is real', () => {\n    expect(true).toBe(true);\n  });\n});\n",
  );

  writeJson(dir, 'packages/core/package.json', {
    name: '@vimes/core',
    private: true,
    dependencies: {},
  });
  writeFile(
    dir,
    'packages/core/src/index.ts',
    "export const Foo = 1;\nexport function doIt() { return 1; }\n",
  );

  writeJson(dir, 'packages/daemon/package.json', {
    name: '@vimes/daemon',
    private: true,
    dependencies: { '@vimes/core': '*', '@vimes/ext-tasks': '*' },
  });
  writeFile(
    dir,
    'packages/daemon/src/index.ts',
    "import { schema } from '@vimes/ext-tasks';\nimport { Foo } from '@vimes/core';\nexport { schema, Foo };\n",
  );
}

function rulesFor(violations) {
  return new Set(violations.map((v) => v.rule));
}

// ─── clean + real tree ───────────────────────────────────────────────────

describe('checkExtBoundary — clean fixture', () => {
  it('passes with zero violations', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    const result = checkExtBoundary(dir);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('checkExtBoundary — real tree', () => {
  it('the shipped repo passes', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const result = checkExtBoundary(repoRoot);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ─── s1-s8 sabotage matrix (each: the named rule fires) ────────────────────

describe('checkExtBoundary — sabotage matrix', () => {
  it('s1: bare import of @vimes/core in ext-tasks → undeclared-dependency', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/ext-tasks/src/index.ts',
      "import '@vimes/core';\nexport { doIt } from '@vimes/ext-host';\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('undeclared-dependency');
  });

  it('s2: relative escape ../../core/src/... → relative-escape', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/ext-tasks/src/index.ts',
      "import { Foo } from '../../core/src/index.js';\nexport { doIt } from '@vimes/ext-host';\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('relative-escape');
  });

  it('s3: deep import @vimes/core/dist/... → deep-package-import', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeJson(dir, 'packages/ext-tasks/package.json', {
      name: '@vimes/ext-tasks',
      private: true,
      dependencies: { '@vimes/ext-host': '*', '@vimes/core': '*', zod: '^3' },
    });
    writeFile(
      dir,
      'packages/ext-tasks/src/index.ts',
      "import { Foo } from '@vimes/core/dist/index.js';\nexport { doIt } from '@vimes/ext-host';\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('deep-package-import');
  });

  it('s4: dynamic import literal + non-literal variant', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/ext-tasks/src/index.ts',
      "export { doIt } from '@vimes/ext-host';\n" +
        "export async function loadCore() { return import('@vimes/core'); }\n" +
        "export async function loadDynamic(name) { return import(name); }\n",
    );
    const { violations } = checkExtBoundary(dir);
    const rules = rulesFor(violations);
    // literal '@vimes/core' is checked like a static import: undeclared (not a declared dep)
    expect(rules).toContain('undeclared-dependency');
    // non-literal argument is refused outright
    expect(rules).toContain('dynamic-import-non-literal');
  });

  it('s5: un-allowlisted re-export in ext-host → surface-mismatch', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/ext-host/src/index.ts',
      "export type { Foo } from '@vimes/core';\n" +
        "export { doIt } from '@vimes/core';\n" +
        "export { notAllowlisted } from '@vimes/core';\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('surface-mismatch');
  });

  it('s6a: alias laundering export type { X as Y } → alias-export', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/ext-host/src/index.ts',
      "export type { EventStore as Foo } from '@vimes/core';\n" +
        "export { doIt } from '@vimes/core';\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('alias-export');
  });

  it('s6b: local declaration exported under an allowed name → local-declaration-export', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/ext-host/src/index.ts',
      "export type { Foo } from '@vimes/core';\n" +
        "export const doIt = () => 1;\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('local-declaration-export');
  });

  it('s7: core reaching ext-tasks by relative path → core-imports-tenant', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/core/src/index.ts',
      "export const Foo = 1;\n" +
        "export function doIt() { return 1; }\n" +
        "import { schema } from '../../ext-tasks/src/index.js';\n" +
        "export { schema };\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('core-imports-tenant');
  });

  it('s8: daemon deep-importing @vimes/ext-tasks/dist/... → daemon-deep-tenant-import', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/daemon/src/index.ts',
      "import { schema } from '@vimes/ext-tasks/dist/index.js';\n" +
        "import { Foo } from '@vimes/core';\n" +
        "export { schema, Foo };\n",
    );
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('daemon-deep-tenant-import');
  });
});

// ─── S18-F2 regression: rule 6 scoped to index.ts, not every ext-host file ──

describe('checkExtBoundary — ext-host non-index files (S18-F2 regression)', () => {
  it('r1: index.ts + a benign second file that exports nothing passes clean', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(
      dir,
      'packages/ext-host/src/helpers.test.ts',
      "import { describe, expect, it } from 'vitest';\n\n" +
        "describe('helpers', () => {\n" +
        "  it('is real', () => {\n" +
        '    expect(true).toBe(true);\n' +
        '  });\n' +
        '});\n',
    );
    const result = checkExtBoundary(dir);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('r2: a second file that re-exports from @vimes/core fails with non-index-reexport', () => {
    const dir = makeTempDir();
    buildCleanFixture(dir);
    writeFile(dir, 'packages/ext-host/src/helpers.ts', "export { doIt } from '@vimes/core';\n");
    const { violations } = checkExtBoundary(dir);
    expect(rulesFor(violations)).toContain('non-index-reexport');
  });
});
