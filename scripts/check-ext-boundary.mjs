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
// Deliberately dependency-free: a small hand-rolled JS lexer (comments,
// strings, template literals with `${}` substitutions, regex literals) feeding
// a specifier scanner, `node:` builtins only. No AST parser — this is a
// mechanical gate, not a linter; §3.3's deviation flag (a purpose-built script
// instead of an eslint rule) stands.
//
// AMENDED per S18-F3 (docs/slice-18.md §6c, post-close cold review). The
// review found five holes in the U1 machinery; all five are closed here:
//   (a) the old hand-rolled comment stripper read a regex literal ending
//       `\//` as a line comment and blanked the REST OF THE LINE — a deep
//       import sharing that line passed clean. Fail-open in the primary
//       gate. Replaced by the lexer below.
//   (b) rules 7/8 walked core/daemon with ['.ts'] only (the ext zones already
//       took .ts/.mts/.cts) and dropped non-literal dynamic imports there.
//       All three zones now share SOURCE_EXTENSIONS and the same
//       dynamic-import refusal.
//   (c) rule 6 never checked a surface.json row's `from`, nor an export
//       statement's specifier against §3.2's single signed upstream. A
//       relative re-export plus a matching lying row passed. Now
//       `non-core-reexport` + `surface-illegal-origin`.
//   (d) isMainModule() compared paths without realpath and returned false on
//       error — a fail-OPEN wrapper (a symlinked invocation ran nothing).
//       It now realpaths both sides and RUNS the check when it cannot tell.
//   (e) import-shaped text inside a string or template literal false-
//       positived: the old stripper deliberately PRESERVED string bodies so
//       the specifier regexes could still see specifiers. REPRODUCED (five
//       variants, all five false-positive). The lexer masks string interiors
//       and hands the real, escape-decoded values to the extractors through
//       a position-keyed map, so a specifier is read from a string the lexer
//       identified — never from text that merely looks like one.
//
// Rule table (file: rule: specifier — every violation, never just the first):
//
//   dynamic-import-non-literal   ALL THREE ZONES: import(x) where x is not a
//                                 string literal (rule 2; extended to
//                                 core/daemon per S18-F3(b))
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
//   export-star                  ext-host/src/index.ts ONLY: `export * from …`
//                                 (rule 6)
//   alias-export                 ext-host/src/index.ts ONLY: any exported
//                                 name that differs from its upstream
//                                 original — the `as` laundering closed by
//                                 §3.2 (rule 6)
//   non-core-reexport            ext-host/src/index.ts ONLY: a re-export whose
//                                 specifier is not the ONE signed upstream
//                                 (`@vimes/core`) — relative re-exports of
//                                 local modules included, whatever
//                                 surface.json claims (rule 6, S18-F3(c))
//   surface-illegal-origin       ext-host/surface.json: a row whose `from` is
//                                 not `@vimes/core` — the allowlist cannot
//                                 legalise a second upstream (rule 6,
//                                 S18-F3(c))
//   local-declaration-export     ext-host/src/index.ts ONLY: an exported
//                                 name that is NOT a direct re-export from an
//                                 allowlisted upstream (a local const/
//                                 function/class/type/interface/default, or a
//                                 brace re-export of a local name) (rule 6)
//   surface-mismatch              ext-host/src/index.ts ONLY: the set of
//                                 clean direct re-exports does not equal
//                                 surface.json's rows (name+kind+origin),
//                                 either direction (rule 6)
//   non-index-reexport           ext-host/src, every file EXCEPT index.ts
//                                 (AMENDED per S18-F2, docs/slice-18.md §5b):
//                                 any `export … from` statement, star or
//                                 named — only the barrel re-exports; local
//                                 declarations (test-only helpers included)
//                                 are unrestricted here (rule 6)
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

// The ONE signed upstream ext-host may re-export from (§3.2).
const SIGNED_UPSTREAM = '@vimes/core';

// Every zone walks the same extension set (S18-F3(b)).
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts'];

// ─── the lexer (S18-F3 a/e) ────────────────────────────────────────────────
//
// One pass over the source producing:
//   masked  — same LENGTH as the input (indices are interchangeable), with
//             comment bodies, string/template interiors and whole regex
//             literals replaced by spaces; newlines are preserved so line
//             structure survives.
//   strings — Map from the index of an opening ' or " to
//             { value, end }, the escape-DECODED literal and the index just
//             past its closing quote.
//
// The extractors below match on `masked` — so import-shaped text inside a
// string can never be read as an import (F3(e)) — and recover the true
// specifier through `strings` (which is why masking the interior costs
// nothing). A regex literal is consumed as a unit, so `/foo\//` can no longer
// be misread as a line comment (F3(a)).
//
// Conservative by construction: the only genuinely ambiguous token in JS
// lexing is `/` (regex-start vs division) after `)` or `}`. There, this lexer
// TRIES the regex reading and backtracks to division unless the literal
// closes on the same line — the reading that never lets an unclosed guess
// swallow code. After an atom (identifier, number, `]`, a string, another
// regex) `/` is division, which is the only legal reading anyway.

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'yield',
  'await',
  'case',
  'throw',
]);

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

const SIMPLE_ESCAPES = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  0: '\0',
};

function decodeStringLiteral(rawBody) {
  if (!rawBody.includes('\\')) return rawBody;
  let decoded = '';
  for (let i = 0; i < rawBody.length; i++) {
    const c = rawBody[i];
    if (c !== '\\') {
      decoded += c;
      continue;
    }
    const next = rawBody[i + 1];
    if (next === undefined) return rawBody;
    if (next === 'x') {
      const hex = rawBody.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return rawBody;
      decoded += String.fromCharCode(parseInt(hex, 16));
      i += 3;
      continue;
    }
    if (next === 'u') {
      if (rawBody[i + 2] === '{') {
        const close = rawBody.indexOf('}', i + 3);
        const hex = close === -1 ? '' : rawBody.slice(i + 3, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return rawBody;
        decoded += String.fromCodePoint(parseInt(hex, 16));
        i = close;
        continue;
      }
      const hex = rawBody.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return rawBody;
      decoded += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    decoded += Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next)
      ? SIMPLE_ESCAPES[next]
      : next;
    i += 1;
  }
  return decoded;
}

export function lexModule(text) {
  const length = text.length;
  // split('') is per UTF-16 code unit, so array indices match string indices
  // (Array.from would be code-POINT based and silently shift on astral chars).
  const masked = text.split('');
  const strings = new Map();

  function blankRange(start, end) {
    for (let k = Math.max(0, start); k < end && k < length; k++) {
      if (masked[k] !== '\n') masked[k] = ' ';
    }
  }

  // From `from` (just past a backtick or a substitution's `}`), blank the
  // template chunk up to its terminator. Returns where to resume and whether
  // the terminator was a `${` substitution (which is real code).
  function scanTemplateChunk(from) {
    let k = from;
    while (k < length) {
      const ch = text[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '`') {
        blankRange(from, k);
        return { next: k + 1, substitution: false };
      }
      if (ch === '$' && text[k + 1] === '{') {
        blankRange(from, k);
        return { next: k + 2, substitution: true };
      }
      k++;
    }
    blankRange(from, length);
    return { next: length, substitution: false };
  }

  // A regex literal never spans a newline: if we do not find its closing
  // delimiter on this line, the `/` was division after all.
  function scanRegexLiteral(start) {
    let k = start + 1;
    let inCharacterClass = false;
    while (k < length) {
      const ch = text[k];
      if (ch === '\n') return -1;
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '[') inCharacterClass = true;
      else if (ch === ']') inCharacterClass = false;
      else if (ch === '/' && !inCharacterClass) return k + 1;
      k++;
    }
    return -1;
  }

  function scanQuoted(start, quote) {
    let k = start + 1;
    while (k < length) {
      const ch = text[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === quote) return { end: k + 1, body: text.slice(start + 1, k), terminated: true };
      if (ch === '\n') return { end: k, body: text.slice(start + 1, k), terminated: false };
      k++;
    }
    return { end: length, body: text.slice(start + 1), terminated: false };
  }

  // 'start' | 'punct' | 'word' | 'atom' — what precedes the cursor, for the
  // regex-vs-division decision. 'atom' (identifier value, `]`, a closed
  // string/template/regex) forbids a regex; `)` and `}` stay 'punct' and get
  // the try-and-backtrack treatment described above.
  let previousKind = 'start';
  let previousWord = '';
  const templateStack = [];
  let braceDepth = 0;
  let i = 0;

  function resumeTemplate(from) {
    const chunk = scanTemplateChunk(from);
    if (chunk.substitution) {
      templateStack.push(braceDepth);
      braceDepth = 0;
      previousKind = 'start';
      previousWord = '';
    } else {
      previousKind = 'atom';
      previousWord = '';
    }
    return chunk.next;
  }

  while (i < length) {
    const c = text[i];

    if (c === '/' && text[i + 1] === '/') {
      let k = i;
      while (k < length && text[k] !== '\n') k++;
      blankRange(i, k);
      i = k;
      continue; // a comment is not significant: previousKind is unchanged
    }

    if (c === '/' && text[i + 1] === '*') {
      let k = i + 2;
      while (k < length && !(text[k] === '*' && text[k + 1] === '/')) k++;
      const end = Math.min(length, k + 2);
      blankRange(i, end);
      i = end;
      continue;
    }

    if (c === '/') {
      const regexAllowed =
        previousKind === 'start' ||
        previousKind === 'punct' ||
        (previousKind === 'word' && REGEX_PRECEDING_KEYWORDS.has(previousWord));
      if (regexAllowed) {
        const end = scanRegexLiteral(i);
        if (end !== -1) {
          blankRange(i, end);
          i = end;
          previousKind = 'atom';
          previousWord = '';
          continue;
        }
      }
      previousKind = 'punct';
      previousWord = '';
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      const { end, body } = scanQuoted(i, c);
      strings.set(i, { value: decodeStringLiteral(body), end });
      blankRange(i + 1, end - 1);
      i = end;
      previousKind = 'atom';
      previousWord = '';
      continue;
    }

    if (c === '`') {
      i = resumeTemplate(i + 1);
      continue;
    }

    if (c === '{') {
      braceDepth++;
      previousKind = 'punct';
      previousWord = '';
      i++;
      continue;
    }

    if (c === '}') {
      if (templateStack.length > 0 && braceDepth === 0) {
        braceDepth = templateStack.pop();
        i = resumeTemplate(i + 1);
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      previousKind = 'punct';
      previousWord = '';
      i++;
      continue;
    }

    if (IDENTIFIER_CHAR.test(c)) {
      let k = i;
      while (k < length && IDENTIFIER_CHAR.test(text[k])) k++;
      previousWord = text.slice(i, k);
      previousKind = 'word';
      i = k;
      continue;
    }

    if (/\s/.test(c)) {
      i++;
      continue; // whitespace is not significant
    }

    previousKind = c === ']' ? 'atom' : 'punct';
    previousWord = '';
    i++;
  }

  return { masked: masked.join(''), strings };
}

// ─── dynamic import() extraction (balanced-paren over MASKED text) ──────────

function extractDynamicImports(masked) {
  const results = [];
  let searchFrom = 0;
  while (true) {
    const kwIndex = masked.indexOf('import', searchFrom);
    if (kwIndex === -1) break;
    const before = kwIndex === 0 ? '' : masked[kwIndex - 1];
    const after = masked[kwIndex + 6];
    if (IDENTIFIER_CHAR.test(before) || (after !== undefined && IDENTIFIER_CHAR.test(after))) {
      searchFrom = kwIndex + 6;
      continue;
    }
    let cursor = kwIndex + 6;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor++;
    if (masked[cursor] !== '(') {
      searchFrom = kwIndex + 6;
      continue;
    }
    const argStart = cursor + 1;
    let depth = 1;
    let i = argStart;
    while (i < masked.length && depth > 0) {
      const c = masked[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const argEnd = i - 1;
    results.push({
      start: kwIndex,
      end: i,
      argStart,
      argText: masked.slice(argStart, Math.max(argStart, argEnd)),
    });
    searchFrom = i;
  }
  return results;
}

// A dynamic argument counts as literal only when the lexer itself identified
// a quoted string at the argument's first non-space position and nothing but
// a second argument follows it. `'a' + b`, a template literal, and a bare
// identifier are all refused (fail-closed).
function resolveLiteralArg(call, strings) {
  const leadingSpace = call.argText.length - call.argText.trimStart().length;
  const record = strings.get(call.argStart + leadingSpace);
  if (!record) return null;
  const tail = call.argText.slice(record.end - call.argStart).trim();
  if (tail !== '' && !tail.startsWith(',')) return null;
  return record.value;
}

function blank(text, spans) {
  const chars = text.split('');
  for (const { start, end } of spans) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

// ─── static `import/export … from '…'` extraction ──────────────────────────

const FROM_STATEMENT_RE =
  /\b(import|export)\b((?:(?!;)[\s\S])*?)\bfrom\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3/gd;

const SIDE_EFFECT_IMPORT_RE = /\bimport\s*(['"])/gd;

// ONE brace-entry parser (review finding 6). `export { a, type B as C }` and
// `import { … }` share it; callers that only want exported names read
// `exportedName` + `kind`.
function parseBraceEntries(raw, statementIsTypeOnly) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const em = part.match(/^(type\s+)?([$\w]+)(\s+as\s+([$\w]+))?$/);
      if (!em) {
        return {
          localName: part,
          exportedName: part,
          hasAlias: false,
          kind: statementIsTypeOnly ? 'type' : 'value',
        };
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

function extractFromStatements(masked, strings) {
  const results = [];
  let m;
  FROM_STATEMENT_RE.lastIndex = 0;
  while ((m = FROM_STATEMENT_RE.exec(masked))) {
    const [full, keyword, middle, , rawSpecifier] = m;
    const quoteStart = m.indices[3][0];
    const record = strings.get(quoteStart);
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
      specifier: record ? record.value : rawSpecifier,
      isStar,
      entries,
    });
  }
  return results;
}

function extractSideEffectImports(masked, strings) {
  const results = [];
  let m;
  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_IMPORT_RE.exec(masked))) {
    const quoteStart = m.indices[1][0];
    const record = strings.get(quoteStart);
    if (!record) continue;
    results.push(record.value);
    SIDE_EFFECT_IMPORT_RE.lastIndex = record.end;
  }
  return results;
}

// ─── local export declarations (ext-host laundering detection, rule 6) ─────

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
    get: (mm) => braceExportNames(mm[1], true),
  },
  {
    re: /^export\s*\{([^}]*)\}/,
    get: (mm) => braceExportNames(mm[1], false),
  },
];

function braceExportNames(raw, isTypeStatement) {
  return parseBraceEntries(raw, isTypeStatement).map((e) => ({
    name: e.exportedName,
    kind: e.kind,
  }));
}

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

function analyzeSource(raw) {
  const { masked, strings } = lexModule(raw);
  const dynamicCalls = extractDynamicImports(masked);
  const blanked = blank(
    masked,
    dynamicCalls.map((d) => ({ start: d.start, end: d.end })),
  );
  const fromStatements = extractFromStatements(blanked, strings);
  const sideEffects = extractSideEffectImports(blanked, strings);

  const nonLiteralDynamics = [];
  const literalSpecifiers = [];
  for (const call of dynamicCalls) {
    const literal = resolveLiteralArg(call, strings);
    if (literal === null) nonLiteralDynamics.push(call.argText.trim());
    else literalSpecifiers.push(literal);
  }

  const specifiers = [
    ...fromStatements.map((s) => s.specifier),
    ...sideEffects,
    ...literalSpecifiers,
  ];

  return { specifiers, nonLiteralDynamics, fromStatements, blanked };
}

// ─── filesystem walking ──────────────────────────────────────────────────

// ONE tree walker, parameterized by extensions (review finding 6).
function walkSourceFiles(dir, extensions = SOURCE_EXTENSIONS) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSourceFiles(full, extensions));
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

  function analyzeFile(file) {
    return analyzeSource(fs.readFileSync(file, 'utf8'));
  }

  // ── rules 1-6: every ext-* package's src ────────────────────────────────
  for (const pkgName of extPackageNames) {
    const pkgRoot = path.join(packagesDir, pkgName);
    const pkgJson = readJsonIfExists(path.join(pkgRoot, 'package.json')) || {};
    const deps = new Set(Object.keys(pkgJson.dependencies || {}));
    const devDeps = new Set(Object.keys(pkgJson.devDependencies || {}));
    const srcDir = path.join(pkgRoot, 'src');
    const files = walkSourceFiles(srcDir);

    const isExtHost = pkgName === 'ext-host';
    const surfaceEntries = isExtHost
      ? readJsonIfExists(path.join(pkgRoot, 'surface.json')) || []
      : [];

    // rule 6 (S18-F3(c)): the allowlist itself may only name the ONE signed
    // upstream. A row pointing anywhere else — a relative module, a third-
    // party package — is refused before any export is compared against it,
    // so a lying row can never legalise its statement.
    if (isExtHost) {
      for (const row of surfaceEntries) {
        if (row.from !== SIGNED_UPSTREAM) {
          violations.push({
            file: relPath(path.join(pkgRoot, 'surface.json')),
            rule: 'surface-illegal-origin',
            specifier: `${row.name} (from ${JSON.stringify(row.from)}, not ${SIGNED_UPSTREAM})`,
          });
        }
      }
    }

    for (const file of files) {
      const { specifiers, nonLiteralDynamics, fromStatements, blanked } = analyzeFile(file);
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

      // rule 6: ext-host's export surface, direct-re-export-only.
      // AMENDED per S18-F2 (docs/slice-18.md §5b): surface-equality only
      // makes sense against the ONE barrel file — index.ts. Every OTHER file
      // under ext-host/src (test files, future helpers) is instead forbidden
      // from re-exporting anything at all; local declarations are fine there
      // (e.g. a test-only const), so the checks below diverge by file.
      if (isExtHost) {
        const isIndexFile = path.relative(srcDir, file) === 'index.ts';

        if (!isIndexFile) {
          for (const st of fromStatements) {
            if (st.keyword !== 'export') continue;
            violations.push({
              file: relPath(file),
              rule: 'non-index-reexport',
              specifier: st.isStar ? `* from ${st.specifier}` : st.specifier,
            });
          }
          continue;
        }

        const validExports = [];
        for (const st of fromStatements) {
          if (st.keyword !== 'export') continue;
          if (st.isStar) {
            violations.push({ file: relPath(file), rule: 'export-star', specifier: st.specifier });
            continue;
          }
          // S18-F3(c): §3.2 says every barrel statement re-exports from the
          // signed upstream. A relative re-export of a local module is a
          // violation HERE, whatever surface.json says about the names.
          if (st.specifier !== SIGNED_UPSTREAM) {
            violations.push({
              file: relPath(file),
              rule: 'non-core-reexport',
              specifier: st.specifier,
            });
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

  // ── rules 7-8: the engine and host zones ───────────────────────────────
  // ONE zone scanner (review finding 6), parameterized by the rule name and
  // by which bare `@vimes/ext-*` specifiers are illegal there: ALL of them in
  // core (rule 7 — the engine knows no tenants), only DEEP ones in the daemon
  // (rule 8 — the host consumes tenants through their root barrels).
  // Both zones walk SOURCE_EXTENSIONS and refuse non-literal dynamic imports
  // exactly as the ext zones do (S18-F3(b)).
  function scanEngineZone(srcDir, rule, bareSpecifierIsIllegal) {
    for (const file of walkSourceFiles(srcDir)) {
      const { specifiers, nonLiteralDynamics } = analyzeFile(file);
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
          if (extPackageRoots.some((r) => isWithin(r, resolved))) {
            violations.push({ file: relPath(file), rule, specifier: spec });
          }
        } else if (/^@vimes\/ext-/.test(spec) && bareSpecifierIsIllegal(spec)) {
          violations.push({ file: relPath(file), rule, specifier: spec });
        }
      }
    }
  }

  scanEngineZone(path.join(packagesDir, 'core', 'src'), 'core-imports-tenant', () => true);
  scanEngineZone(
    path.join(packagesDir, 'daemon', 'src'),
    'daemon-deep-tenant-import',
    (spec) => spec.split('/').length > 2,
  );

  return { violations, ok: violations.length === 0 };
}

// ─── CLI wrapper (thin: parse root, call checkExtBoundary, report) ────────

// S18-F3(d): fail CLOSED. Both sides are realpath'd so a symlinked invocation
// (`node /usr/local/bin/check-boundary` → this file) still recognises itself
// as main, and if the comparison cannot be made at all we RUN the check
// rather than silently skipping it. An imported module keeps argv[1] pointing
// at the importing runner (vitest), which realpaths cleanly to a different
// file — so the tests import this module without double-running it.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const invoked = fs.realpathSync(path.resolve(process.argv[1]));
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return invoked === self;
  } catch {
    return true;
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
