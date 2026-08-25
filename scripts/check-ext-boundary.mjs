#!/usr/bin/env node
// Extension-boundary checker (docs/slice-18.md §3.3, the FULL spec; primary
// mechanical enforcement of §3.2's exact-origin re-export law).
//
// Walks three zones and fails on any crossing:
//   packages/ext-*/src   — the tenant packages (ext-host, ext-tasks, …)
//   packages/core/src    — the engine (must never reach a tenant, by any route)
//   packages/daemon/src  — the host (may only reach a tenant through its root
//                          barrel — a bare `@vimes/ext-*` import — never deep)
//
// Deliberately dependency-free: a small hand-rolled specifier scanner (regex +
// a balanced-paren walk for dynamic import() arguments), `node:` builtins only.
// No AST parser — this is a mechanical gate, not a linter; §3.3's deviation
// flag (a purpose-built script instead of an eslint rule) stands.
//
// Rule table (file: rule: specifier — every violation, never just the first):
//
//   dynamic-import-non-literal   ext-*/src: import(x) where x is not a string
//                                 literal (rule 2)
//   undeclared-dependency        ext-*/src: bare specifier's package name is
//                                 not in the importing package's declared
//                                 dependencies (devDependencies count too, but
//                                 ONLY for *.test.ts files — see NOTE below)
//                                 (rule 3)
//   deep-package-import          ext-*/src: a `@vimes/*` specifier with
//                                 anything after the package name — only the
//                                 root barrel is importable (rule 4)
//   relative-escape              ext-*/src: a relative specifier that,
//                                 resolved from its file, lands outside that
//                                 package's own root directory (rule 5)
//   export-star                  ext-host/src only: `export * from …` (rule 6)
//   alias-export                 ext-host/src only: any exported name that
//                                 differs from its upstream original — the
//                                 `as` laundering closed by §3.2 (rule 6)
//   local-declaration-export     ext-host/src only: an exported name that is
//                                 NOT a direct re-export from an allowlisted
//                                 upstream (a local const/function/class/type/
//                                 interface/default, or a brace re-export of a
//                                 local name) (rule 6)
//   surface-mismatch              ext-host/src only: the set of clean direct
//                                 re-exports does not equal surface.json's
//                                 rows (name+kind+origin), either direction
//                                 (rule 6)
//   core-imports-tenant          packages/core/src: any specifier — bare,
//                                 deep, or relative-resolved — reaching
//                                 `@vimes/ext-*` or a `packages/ext-*` path
//                                 (rule 7)
//   daemon-deep-tenant-import    packages/daemon/src: a DEEP `@vimes/ext-*`
//                                 subpath, or a relative-resolved reach into
//                                 `packages/ext-*` — the bare root-barrel
//                                 import (`@vimes/ext-tasks`) is legal (rule 8)
//
// NOTE on `undeclared-dependency` and devDependencies: no sibling package
// (core, daemon) declares `vitest` in its own package.json at all — it is a
// ROOT devDependency, hoisted to every workspace package by npm workspaces,
// and every `*.test.ts` file bare-imports it on that strength alone. To
// mirror that observed reality rather than invent a stricter rule the repo
// doesn't actually follow, a `*.test.ts`/`*.test.mts`/`*.test.cts` file may
// also satisfy `undeclared-dependency` from the ROOT package.json's
// devDependencies, in addition to its own package's dependencies/
// devDependencies.
//
// Exit 0 (near-silent) on a clean tree; exit 1 listing every violation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── comment stripping (string/template-literal aware) ─────────────────────

function stripComments(text) {
  let result = '';
  let inString = null; // one of ' " ` or null
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      result += c;
      if (c === '\\') {
        if (i + 1 < text.length) {
          result += text[i + 1];
          i++;
        }
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      result += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        result += ' ';
        i++;
      }
      i--; // let the loop's i++ land on the newline
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      result += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        result += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      result += '  ';
      i++; // i currently at '*'; loop's i++ lands past '/'
      continue;
    }
    result += c;
  }
  return result;
}

// ─── dynamic import() extraction (balanced-paren, string-aware) ────────────

function extractDynamicImports(text) {
  const results = [];
  let searchFrom = 0;
  while (true) {
    const kwIndex = text.indexOf('import', searchFrom);
    if (kwIndex === -1) break;
    const before = kwIndex === 0 ? '' : text[kwIndex - 1];
    if (/[A-Za-z0-9_$]/.test(before)) {
      searchFrom = kwIndex + 6;
      continue;
    }
    let cursor = kwIndex + 6;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    if (text[cursor] !== '(') {
      searchFrom = kwIndex + 6;
      continue;
    }
    const argStart = cursor + 1;
    let depth = 1;
    let i = argStart;
    let inStr = null;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === inStr) inStr = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        inStr = c;
        i++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const argEnd = i - 1;
    const argText = text.slice(argStart, Math.max(argStart, argEnd));
    results.push({ start: kwIndex, end: i, argText });
    searchFrom = i;
  }
  return results;
}

function parseLiteralArg(argText) {
  const trimmed = argText.trim();
  const m = trimmed.match(/^(['"])((?:(?!\1)[^\\]|\\.)*)\1(?:\s*,[\s\S]*)?$/);
  return m ? m[2] : null;
}

function blank(text, spans) {
  const chars = Array.from(text);
  for (const { start, end } of spans) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

// ─── static `import/export … from '…'` extraction ──────────────────────────

const FROM_STATEMENT_RE =
  /\b(import|export)\b((?:(?!;)[\s\S])*?)\bfrom\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3/g;

function parseBraceEntries(raw, statementIsTypeOnly) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const em = part.match(/^(type\s+)?([$\w]+)(\s+as\s+([$\w]+))?$/);
      if (!em) {
        return { localName: part, exportedName: part, hasAlias: false, kind: 'value' };
      }
      const hasTypePrefix = !!em[1];
      const localName = em[2];
      const alias = em[4];
      return {
        localName,
        exportedName: alias || localName,
        hasAlias: !!alias,
        kind: statementIsTypeOnly || hasTypePrefix ? 'type' : 'value',
      };
    });
}

function extractFromStatements(text) {
  const results = [];
  let m;
  FROM_STATEMENT_RE.lastIndex = 0;
  while ((m = FROM_STATEMENT_RE.exec(text))) {
    const [full, keyword, middle, , specifier] = m;
    const trimmedMiddle = middle.trim();
    let isStar = false;
    let entries = [];
    if (keyword === 'export') {
      if (/^\*/.test(trimmedMiddle)) {
        isStar = true;
      } else {
        const braceMatch = middle.match(/\{([\s\S]*)\}/);
        const isTypeStatement = /^type\b/.test(trimmedMiddle);
        if (braceMatch) {
          entries = parseBraceEntries(braceMatch[1], isTypeStatement);
        }
      }
    }
    results.push({
      index: m.index,
      end: m.index + full.length,
      keyword,
      specifier,
      isStar,
      entries,
    });
  }
  return results;
}

function extractSideEffectImports(text) {
  const results = [];
  const re = /\bimport\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;
  let m;
  while ((m = re.exec(text))) {
    results.push(m[2]);
  }
  return results;
}

// ─── local export declarations (ext-host laundering detection, rule 6) ─────

function parseBraceNames(raw, isType) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const em = part.match(/^(type\s+)?([$\w]+)(\s+as\s+([$\w]+))?$/);
      if (!em) return { name: part, kind: isType ? 'type' : 'value' };
      const hasTypePrefix = !!em[1];
      const name = em[4] || em[2];
      return { name, kind: isType || hasTypePrefix ? 'type' : 'value' };
    });
}

const LOCAL_DECL_PATTERNS = [
  { re: /^export\s+default\b/, get: () => [{ name: 'default', kind: 'value' }] },
  {
    re: /^export\s+(async\s+function\*?|function\*?)\s+([$\w]+)/,
    get: (mm) => [{ name: mm[2], kind: 'value' }],
  },
  {
    re: /^export\s+(const|let|var)\s+([$\w]+)/,
    get: (mm) => [{ name: mm[2], kind: 'value' }],
  },
  {
    re: /^export\s+(abstract\s+class|class|enum|namespace|module)\s+([$\w]+)/,
    get: (mm) => [{ name: mm[2], kind: 'value' }],
  },
  {
    re: /^export\s+(interface|type)\s+([$\w]+)/,
    get: (mm) => [{ name: mm[2], kind: 'type' }],
  },
  {
    re: /^export\s+type\s*\{([^}]*)\}/,
    get: (mm) => parseBraceNames(mm[1], true),
  },
  {
    re: /^export\s*\{([^}]*)\}/,
    get: (mm) => parseBraceNames(mm[1], false),
  },
];

function extractLocalExportDeclarations(text, consumedRanges) {
  const found = [];
  const exportKwRe = /\bexport\b/g;
  let m;
  while ((m = exportKwRe.exec(text))) {
    const idx = m.index;
    if (consumedRanges.some((r) => idx >= r.index && idx < r.end)) continue;
    const slice = text.slice(idx, idx + 3000);
    for (const p of LOCAL_DECL_PATTERNS) {
      const mm = p.re.exec(slice);
      if (mm && mm.index === 0) {
        found.push(...p.get(mm));
        break;
      }
    }
  }
  return found;
}

// ─── shared specifier extraction ────────────────────────────────────────────

function extractAllSpecifiers(cleanedText) {
  const dynamicCalls = extractDynamicImports(cleanedText);
  const blanked = blank(
    cleanedText,
    dynamicCalls.map((d) => ({ start: d.start, end: d.end })),
  );
  const fromStatements = extractFromStatements(blanked);
  const sideEffects = extractSideEffectImports(blanked);

  const nonLiteralDynamics = [];
  const literalSpecifiers = [];
  for (const d of dynamicCalls) {
    const lit = parseLiteralArg(d.argText);
    if (lit === null) nonLiteralDynamics.push(d.argText.trim());
    else literalSpecifiers.push(lit);
  }

  const specifiers = [
    ...fromStatements.map((s) => s.specifier),
    ...sideEffects,
    ...literalSpecifiers,
  ];

  return { specifiers, nonLiteralDynamics, fromStatements, blanked };
}

// ─── filesystem walking ──────────────────────────────────────────────────

function walkTsFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(full, extensions));
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.d.ts')) continue;
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  return results;
}

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── the check ───────────────────────────────────────────────────────────

export function checkExtBoundary(rootDir) {
  const violations = [];

  function relPath(f) {
    return path.relative(rootDir, f).split(path.sep).join('/');
  }

  const packagesDir = path.join(rootDir, 'packages');
  const allPackageDirs = fs.existsSync(packagesDir)
    ? fs
        .readdirSync(packagesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  const extPackageNames = allPackageDirs.filter((n) => n.startsWith('ext-'));
  const extPackageRoots = extPackageNames.map((n) => path.join(packagesDir, n));

  const rootPackageJson = readJsonIfExists(path.join(rootDir, 'package.json')) || {};
  const rootDevDeps = new Set(Object.keys(rootPackageJson.devDependencies || {}));

  function isTestFile(file) {
    return /\.(test|spec)\.[cm]?ts$/.test(file);
  }

  function bareName(spec) {
    return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  }

  function isDeclared(name, deps, devDeps, testFile) {
    if (deps.has(name)) return true;
    if (testFile && devDeps.has(name)) return true;
    if (testFile && rootDevDeps.has(name)) return true;
    return false;
  }

  // ── rules 1-6: every ext-* package's src ────────────────────────────────
  for (const pkgName of extPackageNames) {
    const pkgRoot = path.join(packagesDir, pkgName);
    const pkgJson = readJsonIfExists(path.join(pkgRoot, 'package.json')) || {};
    const deps = new Set(Object.keys(pkgJson.dependencies || {}));
    const devDeps = new Set(Object.keys(pkgJson.devDependencies || {}));
    const srcDir = path.join(pkgRoot, 'src');
    const files = walkTsFiles(srcDir, ['.ts', '.mts', '.cts']);

    const isExtHost = pkgName === 'ext-host';
    const surfaceEntries = isExtHost
      ? readJsonIfExists(path.join(pkgRoot, 'surface.json')) || []
      : [];

    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      const cleaned = stripComments(raw);
      const { specifiers, nonLiteralDynamics, fromStatements, blanked } =
        extractAllSpecifiers(cleaned);
      const testFile = isTestFile(file);

      for (const arg of nonLiteralDynamics) {
        violations.push({
          file: relPath(file),
          rule: 'dynamic-import-non-literal',
          specifier: arg,
        });
      }

      for (const spec of specifiers) {
        if (spec.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), spec);
          if (!isWithin(pkgRoot, resolved)) {
            violations.push({ file: relPath(file), rule: 'relative-escape', specifier: spec });
          }
          continue;
        }
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('@vimes/')) {
          const name = bareName(spec);
          if (spec.split('/').length > 2) {
            violations.push({ file: relPath(file), rule: 'deep-package-import', specifier: spec });
          }
          if (!isDeclared(name, deps, devDeps, testFile)) {
            violations.push({ file: relPath(file), rule: 'undeclared-dependency', specifier: spec });
          }
          continue;
        }
        const name = bareName(spec);
        if (!isDeclared(name, deps, devDeps, testFile)) {
          violations.push({ file: relPath(file), rule: 'undeclared-dependency', specifier: spec });
        }
      }

      // rule 6: ext-host's export surface, direct-re-export-only
      if (isExtHost) {
        const validExports = [];
        for (const st of fromStatements) {
          if (st.keyword !== 'export') continue;
          if (st.isStar) {
            violations.push({ file: relPath(file), rule: 'export-star', specifier: st.specifier });
            continue;
          }
          for (const e of st.entries) {
            if (e.hasAlias) {
              violations.push({
                file: relPath(file),
                rule: 'alias-export',
                specifier: `${e.localName} as ${e.exportedName}`,
              });
              continue;
            }
            validExports.push({ name: e.exportedName, kind: e.kind, from: st.specifier });
          }
        }

        const localDecls = extractLocalExportDeclarations(
          blanked,
          fromStatements.map((s) => ({ index: s.index, end: s.end })),
        );
        for (const d of localDecls) {
          violations.push({
            file: relPath(file),
            rule: 'local-declaration-export',
            specifier: d.name,
          });
        }

        const surfaceByName = new Map(surfaceEntries.map((s) => [s.name, s]));
        const validByName = new Map();
        for (const v of validExports) {
          validByName.set(v.name, v);
          const s = surfaceByName.get(v.name);
          if (!s) {
            violations.push({
              file: relPath(file),
              rule: 'surface-mismatch',
              specifier: `${v.name} (not in surface.json)`,
            });
          } else if (s.kind !== v.kind || s.from !== v.from) {
            violations.push({
              file: relPath(file),
              rule: 'surface-mismatch',
              specifier: `${v.name} (kind/origin mismatch)`,
            });
          }
        }
        for (const s of surfaceEntries) {
          if (!validByName.has(s.name)) {
            violations.push({
              file: relPath(file),
              rule: 'surface-mismatch',
              specifier: `${s.name} (missing from exports)`,
            });
          }
        }
      }
    }
  }

  // ── rule 7: packages/core/src never reaches a tenant ───────────────────
  {
    const coreSrc = path.join(packagesDir, 'core', 'src');
    for (const file of walkTsFiles(coreSrc, ['.ts'])) {
      const cleaned = stripComments(fs.readFileSync(file, 'utf8'));
      const { specifiers } = extractAllSpecifiers(cleaned);
      for (const spec of specifiers) {
        if (spec.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), spec);
          if (extPackageRoots.some((r) => isWithin(r, resolved))) {
            violations.push({ file: relPath(file), rule: 'core-imports-tenant', specifier: spec });
          }
        } else if (/^@vimes\/ext-/.test(spec)) {
          violations.push({ file: relPath(file), rule: 'core-imports-tenant', specifier: spec });
        }
      }
    }
  }

  // ── rule 8: packages/daemon/src only reaches a tenant by root barrel ───
  {
    const daemonSrc = path.join(packagesDir, 'daemon', 'src');
    for (const file of walkTsFiles(daemonSrc, ['.ts'])) {
      const cleaned = stripComments(fs.readFileSync(file, 'utf8'));
      const { specifiers } = extractAllSpecifiers(cleaned);
      for (const spec of specifiers) {
        if (spec.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), spec);
          if (extPackageRoots.some((r) => isWithin(r, resolved))) {
            violations.push({
              file: relPath(file),
              rule: 'daemon-deep-tenant-import',
              specifier: spec,
            });
          }
        } else if (/^@vimes\/ext-/.test(spec)) {
          if (spec.split('/').length > 2) {
            violations.push({
              file: relPath(file),
              rule: 'daemon-deep-tenant-import',
              specifier: spec,
            });
          }
        }
      }
    }
  }

  return { violations, ok: violations.length === 0 };
}

// ─── CLI wrapper (thin: parse root, call checkExtBoundary, report) ────────

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { violations, ok } = checkExtBoundary(rootDir);
  if (!ok) {
    for (const v of violations) {
      console.error(`${v.file}: ${v.rule}: ${v.specifier}`);
    }
    console.error(`check-ext-boundary: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log('check-ext-boundary: clean');
  process.exit(0);
}
