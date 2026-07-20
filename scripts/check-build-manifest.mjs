#!/usr/bin/env node
// Build-manifest lazy-chunk gate (docs/slice-3.md §Editor + §Raw terminal;
// docs/vimes-design-spec.md §8).
//
// Deterministic, no calibration: parse the Vite build manifest and FAIL if, for
// EITHER heavy dependency (CodeMirror 6 and xterm.js):
//   (a) it is not emitted as its own separate lazy chunk, OR
//   (b) the entry chunk statically imports that chunk (transitively).
//
// Each dependency is reached ONLY via dynamic import() from a single setup module
// (src/lib/codemirror-setup.ts, src/lib/xterm-setup.ts). Vite records a dynamic
// import under `dynamicImports` and a static one under `imports`; this gate walks
// the STATIC import graph from every entry and asserts neither setup module is
// reachable that way.
//
// Exit 0 = pass; exit 1 = fail (with a diagnostic). Wired into scripts/ci-gate.sh
// AFTER the ui build step.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repoRoot, 'packages/ui/dist/.vite/manifest.json');

// The manifest src keys for the modules that statically import each heavy dep.
// Each MUST land in its own dynamic (lazy) chunk and never be reached statically.
const LAZY_SETUP_MODULES = [
  { label: 'CodeMirror', src: 'src/lib/codemirror-setup.ts' },
  { label: 'xterm.js', src: 'src/lib/xterm-setup.ts' },
];

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

const entryKeys = Object.keys(manifest).filter((key) => manifest[key].isEntry === true);
if (entryKeys.length === 0) {
  fail('manifest has no entry chunk (isEntry: true) — unexpected build output.');
}

const passedFiles = [];
for (const { label, src } of LAZY_SETUP_MODULES) {
  // (a) The setup module must be split into its own chunk. If it was NOT split out
  // (e.g. it stopped being dynamically imported), Vite inlines it into the entry
  // and there is no such manifest key → that is exactly failure (a).
  const chunk = manifest[src];
  if (chunk === undefined) {
    fail(
      `no separate chunk for ${src} — ${label} was inlined into another chunk. ` +
        'It must be reached only via dynamic import() so it lands in its own lazy chunk.',
    );
  }
  if (chunk.isDynamicEntry !== true) {
    fail(
      `${src} is emitted as a chunk but not as a dynamic entry (isDynamicEntry !== true) ` +
        `— ${label} is reached by a static import somewhere. It must be imported ONLY via dynamic import().`,
    );
  }

  // (b) Walk the STATIC import graph from every entry chunk; the setup module key
  // must never appear. `imports` holds static edges; `dynamicImports` (ignored) holds
  // the allowed lazy edges.
  for (const entryKey of entryKeys) {
    const visited = new Set();
    const stack = [entryKey];
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      if (current === src) {
        fail(
          `entry chunk "${entryKey}" statically imports ${src} (${label} would load in the ` +
            'entry bundle). It must be dynamically imported only.',
        );
      }
      for (const staticImport of manifest[current]?.imports ?? []) {
        stack.push(staticImport);
      }
    }
  }
  passedFiles.push(`${label} → ${chunk.file}`);
}

console.log(
  `check-build-manifest: PASS — each heavy dep is a separate lazy chunk, no entry ` +
    `statically imports any: ${passedFiles.join('; ')}.`,
);
