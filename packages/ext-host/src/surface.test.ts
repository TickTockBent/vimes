// The ext-host surface pin (docs/slice-18.md §3.2, §4-A8).
//
// `surface.json` is the interface artifact — its diff IS the changelog
// (index.ts's own header). This test pins the OTHER half of the belt-and-
// suspenders story the header describes: `scripts/check-ext-boundary.mjs`
// enforces the exact-origin re-export law mechanically at gate time; this
// test enforces the SAME law from the artifact's side, independently, so a
// bug in the checker and a bug in this test would have to agree by accident
// to both miss the same drift. It also hard-codes the five Wes-signed
// entries verified at kill-criterion baseline (§6) — a sixth entry shows up
// in THIS test's diff, not just in surface.json's.
//
// Text-level parsing only (no AST deps, per the WO's own preference) — the
// file is small and hand-written to a strict two-statement-shape law, so a
// regex walk is sufficient and keeps this package's import list at node
// builtins + vitest only, same discipline the boundary checker enforces on
// every ext-* package.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC_DIR = path.dirname(THIS_FILE);
const PACKAGE_ROOT = path.resolve(SRC_DIR, '..');

interface SurfaceRow {
  name: string;
  from: string;
  original: string;
  kind: 'type' | 'value';
}

interface ExportEntry {
  name: string;
  kind: 'type' | 'value';
  from: string;
}

function readSurfaceJson(): SurfaceRow[] {
  const raw = fs.readFileSync(path.join(PACKAGE_ROOT, 'surface.json'), 'utf8');
  return JSON.parse(raw);
}

function readIndexTs(): string {
  return fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf8');
}

// Strip `//` line comments and `/* */` block comments (this file has no
// string literals in play besides the specifier quotes, which never contain
// comment-like sequences — a full string-aware stripper is unneeded here).
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const STATEMENT_RE =
  /export\s+(?<typePrefix>type\s+)?\{(?<braceBody>[^}]*)\}\s*from\s*(?<quote>['"])(?<specifier>[^'"]+)\k<quote>\s*;/g;

function parseExportStatements(cleaned: string): {
  entries: ExportEntry[];
  leftover: string;
} {
  const entries: ExportEntry[] = [];
  let consumed = cleaned;
  let match: RegExpExecArray | null;
  STATEMENT_RE.lastIndex = 0;
  const matchedSpans: Array<{ start: number; end: number }> = [];
  while ((match = STATEMENT_RE.exec(cleaned))) {
    const full = match[0];
    const groups = match.groups as {
      typePrefix?: string;
      braceBody: string;
      specifier: string;
    };
    const { typePrefix, braceBody, specifier } = groups;
    matchedSpans.push({ start: match.index, end: match.index + full.length });
    const statementIsType = !!typePrefix;
    for (const rawPart of braceBody.split(',')) {
      const part = rawPart.trim();
      if (!part) continue;
      const aliasMatch = part.match(
        /^(?<typePrefix>type\s+)?(?<localName>[$\w]+)(\s+as\s+(?<alias>[$\w]+))?$/,
      );
      if (!aliasMatch || !aliasMatch.groups) {
        // Unparseable entry — surface it as a distinct "name" so the
        // equality assertion against the signed list fails loudly rather
        // than silently dropping it.
        entries.push({ name: `<UNPARSEABLE: ${part}>`, kind: 'value', from: specifier });
        continue;
      }
      const { typePrefix: entryTypePrefix, localName, alias } = aliasMatch.groups as {
        typePrefix?: string;
        localName: string;
        alias?: string;
      };
      const hasTypePrefix = !!entryTypePrefix;
      entries.push({
        // An alias means the public name (alias) diverges from the
        // original (localName) — record BOTH via a name that can never
        // collide with a legitimate signed entry, so aliasing always fails
        // the equality check against SIGNED_SURFACE rather than silently
        // matching on the alias alone.
        name: alias ? `<ALIASED: ${localName} as ${alias}>` : localName,
        kind: statementIsType || hasTypePrefix ? 'type' : 'value',
        from: specifier,
      });
    }
  }
  // Blank out matched spans to find leftover (non-comment, non-export-
  // statement) content — proves "no other statements besides comments".
  const chars = Array.from(consumed);
  for (const span of matchedSpans) {
    for (let i = span.start; i < span.end; i++) chars[i] = ' ';
  }
  consumed = chars.join('');
  return { entries, leftover: consumed.trim() };
}

describe('S18 §3.2/A8 — ext-host export surface ≡ surface.json', () => {
  const surfaceRows = readSurfaceJson();
  const indexRaw = readIndexTs();
  const cleaned = stripComments(indexRaw);
  const { entries: exportEntries, leftover } = parseExportStatements(cleaned);

  it('index.ts contains ONLY export statements and comments (no local decls, no export *, no aliasing)', () => {
    expect(leftover).toBe('');
  });

  it('every export entry has a matching allowlist row (same name, kind, origin)', () => {
    const bySurfaceName = new Map(surfaceRows.map((r) => [r.name, r]));
    for (const entry of exportEntries) {
      const row = bySurfaceName.get(entry.name);
      expect(row, `export "${entry.name}" has no surface.json row`).toBeDefined();
      expect(row!.kind, `kind mismatch for "${entry.name}"`).toBe(entry.kind);
      expect(row!.from, `origin mismatch for "${entry.name}"`).toBe(entry.from);
      expect(row!.original, `public name != original for "${entry.name}"`).toBe(entry.name);
    }
  });

  it('every surface.json row has a matching export entry', () => {
    const byExportName = new Map(exportEntries.map((e) => [e.name, e]));
    for (const row of surfaceRows) {
      expect(
        byExportName.has(row.name),
        `surface.json row "${row.name}" has no corresponding export in index.ts`,
      ).toBe(true);
    }
  });

  it('the export count equals the surface.json row count (no untracked duplicates either side)', () => {
    expect(exportEntries.length).toBe(surfaceRows.length);
  });

  it('the five Wes-signed entries are exactly present — a sixth entry fails HERE, not just in surface.json', () => {
    const SIGNED_SURFACE: SurfaceRow[] = [
      { name: 'TaskRecord', from: '@vimes/core', original: 'TaskRecord', kind: 'type' },
      {
        name: 'ReportCompletionPayload',
        from: '@vimes/core',
        original: 'ReportCompletionPayload',
        kind: 'type',
      },
      {
        name: 'ReportReviewPayload',
        from: '@vimes/core',
        original: 'ReportReviewPayload',
        kind: 'type',
      },
      { name: 'StageRunnerPlan', from: '@vimes/core', original: 'StageRunnerPlan', kind: 'type' },
      { name: 'canonicalJson', from: '@vimes/core', original: 'canonicalJson', kind: 'value' },
    ];
    const sortByName = (a: SurfaceRow, b: SurfaceRow) => a.name.localeCompare(b.name);
    expect([...surfaceRows].sort(sortByName)).toEqual([...SIGNED_SURFACE].sort(sortByName));
  });
});
