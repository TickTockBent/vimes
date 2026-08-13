// D87 (private-docs/decisions.md) sanctions @vimes/core under
// packages/ui/src as a TYPE-ONLY dependency: rider 1 requires every import
// whose module specifier is @vimes/core to be a bare `import type`
// STATEMENT — never an inline `{ type X }` specifier — because the
// statement form is what a plain grep can verify, and greppability is the
// point (D87 rider 1, verbatim). This test IS that grep, made assertable
// and CI-enforced: the same idiom principle #16 uses for engine-vocabulary
// rules (an assertable form a scan can check directly), applied here to a
// dependency rule instead of a vocabulary rule.
//
// Scope: every .ts and .vue file under packages/ui/src, recursively —
// including .test.ts files (the walker still visits them; the exemption
// below is scoped to rider 1's assertion only, not to the walk).
//
// D87 ADDENDUM (2026-08-13, private-docs/decisions.md, S15-F2): `.test.ts`
// files are EXEMPT from rider 1's type-only-statement rule. They run in
// node and never enter the browser bundle, so bundle discipline (D87's
// intent 1) is untouched; value-importing core constants to cross-check UI
// literals against wire names (e.g. `EVENT_TYPES.nodeCreated`) is genuine
// drift protection the strict reading would have destroyed. This is the
// DECIDED shape (the addendum's own words), not a loophole coded around
// the guard. The `.vue` total ban below is NOT part of this exemption —
// it stands for test and non-test `.vue` files alike, per the addendum's
// own text ("The `.vue` total ban stands for test and non-test alike").
//
// DELIBERATE TIGHTENING (D87 permits this, does not itself require it):
// D87 rider 2 keeps payload-contract types to lib derivations rather than
// SFCs, but does not on its own forbid a type-only import inside a .vue
// file. This guard tightens that gap into an outright ban — no .vue file
// may import from @vimes/core at all, type-only or not — because a
// type-only import sitting in a component today is exactly the seam a
// later edit grows a runtime usage from unnoticed. If this ever fires
// against a real .vue file, the fix is D87 rider 2's own prescription: move
// the type consumption into a lib/ derivation and have the component read
// that derivation's return type instead.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// lib/ -> src/ (never process.cwd() — resolved relative to this file, per
// the idiom correctionStatus.test.ts already uses for on-disk source reads).
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.vue')) {
      out.push(full);
    }
  }
  return out;
}

// Matches a module specifier of @vimes/core, single- or double-quoted.
// Deliberately built from parts (no literal quote-wrapped specifier string
// appears anywhere in this file, including in comments) so this guard can
// never accidentally flag its own source when it scans itself.
const CORE_SPECIFIER = String.fromCharCode(64) + 'vimes/core'; // '@vimes/core'
const CORE_IMPORT_LINE = new RegExp(`from\\s+['"]${CORE_SPECIFIER.replace('/', '\\/')}['"]`);
const IMPORT_TYPE_STATEMENT = /^import\s+type\s/;

interface CoreImportSite {
  relativeFile: string;
  lineNumber: number;
  line: string;
}

function findCoreImportSites(): CoreImportSite[] {
  const sites: CoreImportSite[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (CORE_IMPORT_LINE.test(line)) {
        sites.push({
          relativeFile: path.relative(SRC_ROOT, file),
          lineNumber: i + 1,
          line: line.trim(),
        });
      }
    });
  }
  return sites;
}

function formatSites(sites: CoreImportSite[]): string {
  return sites.map((s) => `  ${s.relativeFile}:${s.lineNumber}  ${s.line}`).join('\n');
}

describe('D87 rider 1/2 — the @vimes/core dependency-policy guard', () => {
  it('is not vacuous: the scan finds at least one real import site to check', () => {
    // If this goes to zero, the walker or the specifier match broke silently
    // — a guard that never finds anything to check is not a guard.
    expect(findCoreImportSites().length).toBeGreaterThan(0);
  });

  it('every NON-TEST import site is the bare `import type` STATEMENT form (D87 rider 1; .test.ts exempt per the D87 addendum, S15-F2)', () => {
    // .test.ts files are exempt here — see the D87 addendum note in this
    // file's header. The exemption is scoped to THIS assertion only: the
    // .vue ban below still walks and checks test and non-test .vue files
    // alike, and the walker itself still visits .test.ts files (so a
    // .test.ts file is not invisible to the guard — it is just not held to
    // the type-only-statement rule).
    const offenders = findCoreImportSites().filter(
      (s) => !s.relativeFile.endsWith('.test.ts') && !IMPORT_TYPE_STATEMENT.test(s.line),
    );
    if (offenders.length > 0) {
      throw new Error(
        `D87 rider 1 violation — import(s) of the ${CORE_SPECIFIER} module specifier that are ` +
          `not a bare \`import type\` statement (value imports and inline \`{ type X }\` ` +
          `specifiers both fail this; .test.ts files are exempt per the D87 addendum, S15-F2):\n` +
          `${formatSites(offenders)}`,
      );
    }
  });

  it('no .vue file imports from the core package at all (deliberate tightening beyond D87 rider 2)', () => {
    const offenders = findCoreImportSites().filter((s) => s.relativeFile.endsWith('.vue'));
    if (offenders.length > 0) {
      throw new Error(
        `D87 rider 2 violation — a .vue file imports the ${CORE_SPECIFIER} module specifier. ` +
          `Payload-contract types belong in a lib/ derivation, not an SFC (D87 rider 2): move ` +
          `the import into a lib/ module and have the component consume that derivation's ` +
          `return type instead:\n${formatSites(offenders)}`,
      );
    }
  });
});
