#!/usr/bin/env node
// Build-manifest lazy-chunk gate (docs/slice-3.md §Editor; docs/vimes-tech-stack.md §5).
//
// Deterministic, no calibration: parse the Vite build manifest and FAIL if
//   (a) CodeMirror 6 is not emitted as its own separate chunk, OR
//   (b) the entry chunk statically imports that chunk (transitively).
//
// CM6 must be reached ONLY via dynamic import() (src/lib/codemirror-setup.ts is
// the sole CM6 importer). Vite records a dynamic import under `dynamicImports`
// and a static one under `imports`; this gate walks the STATIC import graph from
// every entry and asserts the CM6 chunk is never reached that way.
//
// Exit 0 = pass; exit 1 = fail (with a diagnostic). Wired into scripts/ci-gate.sh
// AFTER the ui build step.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repoRoot, 'packages/ui/dist/.vite/manifest.json');

// The manifest src key for the one module that statically imports CM6.
const CODEMIRROR_SETUP_SRC = 'src/lib/codemirror-setup.ts';

function fail(message) {
  console.error(`check-build-manifest: FAIL — ${message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(
    `could not read ${manifestPath} (${error.message}). ` +
      'Run the ui build first (build.manifest must be true in packages/ui/vite.config.ts).',
  );
}

// (b-prep) Find the CM6 chunk. If the module was NOT split out (e.g. it stopped
// being dynamically imported), Vite inlines it into the entry and there is no
// such manifest key → that is exactly failure (a): "not in a separate chunk".
const codemirrorChunk = manifest[CODEMIRROR_SETUP_SRC];
if (codemirrorChunk === undefined) {
  fail(
    `no separate chunk for ${CODEMIRROR_SETUP_SRC} — CodeMirror was inlined into another ` +
      'chunk. It must be reached only via dynamic import() so it lands in its own lazy chunk.',
  );
}
if (codemirrorChunk.isDynamicEntry !== true) {
  fail(
    `${CODEMIRROR_SETUP_SRC} is emitted as a chunk but not as a dynamic entry ` +
      '(isDynamicEntry !== true) — it is reached by a static import somewhere. It must be ' +
      'imported ONLY via dynamic import().',
  );
}

// (b) Walk the STATIC import graph from every entry chunk; the CM6 chunk key must
// never appear. `imports` holds static edges (manifest src keys); `dynamicImports`
// (deliberately ignored) holds the allowed lazy edges.
const entryKeys = Object.keys(manifest).filter((key) => manifest[key].isEntry === true);
if (entryKeys.length === 0) {
  fail('manifest has no entry chunk (isEntry: true) — unexpected build output.');
}

for (const entryKey of entryKeys) {
  const visited = new Set();
  const stack = [entryKey];
  while (stack.length > 0) {
    const current = stack.pop();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current === CODEMIRROR_SETUP_SRC) {
      fail(
        `entry chunk "${entryKey}" statically imports ${CODEMIRROR_SETUP_SRC} ` +
          '(CodeMirror would load in the entry bundle). CM6 must be dynamically imported only.',
      );
    }
    const node = manifest[current];
    for (const staticImport of node?.imports ?? []) {
      stack.push(staticImport);
    }
  }
}

console.log(
  `check-build-manifest: PASS — CodeMirror is a separate lazy chunk ` +
    `(${codemirrorChunk.file}); no entry statically imports it.`,
);
