// A minimal, in-house markdown parser for the message stream (docs/design-
// directions.md "Markdown rendering in the message stream"). Pure logic, no
// DOM, no HTML strings anywhere — StreamView.vue renders the returned
// structure with plain Vue elements, so every text node is escaped by Vue by
// construction. This codebase has no raw-HTML-binding directive anywhere and
// must never grow one: a sanitizer that has to stay correct forever is a
// worse guarantee than a tree that cannot inject because it is never HTML in
// the first place.
//
// Grammar is deliberately small (v1, per the design-directions entry): ATX
// headings, fenced code (opaque contents), one-level bullet/ordered lists,
// horizontal rules, and inline `code`/`**strong**`/`*em*`/`[label](href)`.
// Everything else — tables, blockquotes, nested lists, footnotes, images,
// autolinking, syntax highlighting, raw HTML — is explicitly out. Anything
// the grammar does not recognize degrades to literal text (rule C): losing a
// sentence is a worse failure than showing a stray asterisk.
//
// Folded into this same unit (2026-07-23, Wes): a code span shaped like a
// file path becomes a `path` node so the view can turn it into a link that
// opens the VIMES editor. Detection is CODE-SPAN ONLY (never free prose) —
// see classifyCodeSpan below.

import { extensionOf } from './languageByExtension.js';

export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: MarkdownInline[] }
  | { kind: 'em'; children: MarkdownInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: MarkdownInline[] }
  // A code span whose content is shaped like a file path (see classifyCodeSpan).
  // `raw` is the ORIGINAL backtick content, byte-identical, so a view that
  // decides not to link it can still render the span unchanged.
  | { kind: 'path'; raw: string; path: string; line: number | null };

export interface MarkdownListItem {
  inlines: MarkdownInline[];
}

export type MarkdownBlock =
  | { kind: 'paragraph'; inlines: MarkdownInline[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: MarkdownInline[] }
  | { kind: 'codeBlock'; language: string | null; code: string }
  | { kind: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { kind: 'rule' };

// ---------------------------------------------------------------------------
// Block-level parsing
// ---------------------------------------------------------------------------

// A closing fence is a line that, once trimmed, is nothing but three-or-more
// backticks — no language token. An OPENING fence permits a trailing language
// token; a line with one qualifies as both a possible opener and (since its
// backtick run alone would also satisfy the bare pattern once the language is
// stripped) is still only matched here for the bare/closing shape.
function isBareFenceLine(line: string): boolean {
  if (!line.startsWith('```')) {
    return false;
  }
  let idx = 0;
  while (line[idx] === '`') {
    idx += 1;
  }
  return line.slice(idx).trim().length === 0;
}

function matchFenceOpen(line: string): { language: string | null } | null {
  if (!line.startsWith('```')) {
    return null;
  }
  let idx = 0;
  while (line[idx] === '`') {
    idx += 1;
  }
  const rest = line.slice(idx).trim();
  return { language: rest.length > 0 ? rest : null };
}

// A `#` run needs a space (or end of line) right after it to count as a
// heading — "#no-space" is deliberately a paragraph, not a heading (v1
// grammar, assertion 1).
function matchHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const match = /^(#{1,6})(?:[ \t](.*))?$/.exec(line);
  if (match === null) {
    return null;
  }
  const level = match[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
  return { level, text: match[2] ?? '' };
}

function isRuleLine(line: string): boolean {
  const trimmed = line.trim();
  return /^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed) || /^_{3,}$/.test(trimmed);
}

// A list marker needs the marker character(s) followed by a space/tab — a
// bare "-" glued to the next word (or a hyphen mid-sentence, which never
// starts a line with a marker anyway since this is anchored at `^`) is not a
// list (assertion 3). Up to 3 leading spaces tolerated, matching the loose
// convention most assistant output actually uses.
function matchListItem(line: string): { ordered: boolean; text: string } | null {
  const bulletMatch = /^ {0,3}[-*+][ \t](.*)$/.exec(line);
  if (bulletMatch !== null) {
    return { ordered: false, text: bulletMatch[1]! };
  }
  const orderedMatch = /^ {0,3}\d+\.[ \t](.*)$/.exec(line);
  if (orderedMatch !== null) {
    return { ordered: true, text: orderedMatch[1]! };
  }
  return null;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  // Totality (I8): a non-string (untyped caller, e.g. a stray `null`/
  // `undefined` slipping past the type system) degrades to no blocks rather
  // than throwing.
  if (typeof source !== 'string' || source.length === 0) {
    return [];
  }
  // CRLF/lone-CR normalize to LF before line-splitting so Windows-style
  // assistant output and Unix output parse identically; `\r` carries no
  // visible glyph, so this does not touch the "no input loses characters"
  // guarantee (rule assertion 7 is about visible text).
  const normalized = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const lineCount = lines.length;

  // Precompute every line that could close a fence, once, up front. Locating
  // a fence's closer by re-scanning forward from each opener would be O(n)
  // per opener — a document made entirely of unterminated "```lang" openers
  // (no closer anywhere) would then cost O(n^2), which is exactly the
  // catastrophic-backtracking shape this module is required to avoid. A
  // single monotonic pointer into this precomputed list gives every fence
  // lookup amortized O(1), for O(n) total across the whole document.
  const bareFenceLineIndices: number[] = [];
  for (let idx = 0; idx < lineCount; idx += 1) {
    if (isBareFenceLine(lines[idx]!)) {
      bareFenceLineIndices.push(idx);
    }
  }
  let bareFencePointer = 0;

  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let listState: { ordered: boolean; items: MarkdownListItem[] } | null = null;

  function flushParagraph(): void {
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', inlines: parseInline(paragraphLines.join('\n'), 0) });
      paragraphLines = [];
    }
  }
  function flushList(): void {
    if (listState !== null) {
      blocks.push({ kind: 'list', ordered: listState.ordered, items: listState.items });
      listState = null;
    }
  }
  function flushOpenBlocks(): void {
    flushParagraph();
    flushList();
  }

  let i = 0;
  while (i < lineCount) {
    const line = lines[i]!;

    if (line.trim().length === 0) {
      flushOpenBlocks();
      i += 1;
      continue;
    }

    const fenceOpen = matchFenceOpen(line);
    if (fenceOpen !== null) {
      // Advance the pointer past every closer at or before this opener so it
      // stays monotonic across the whole document, then take the next one.
      while (bareFencePointer < bareFenceLineIndices.length && bareFenceLineIndices[bareFencePointer]! <= i) {
        bareFencePointer += 1;
      }
      const closeLineIndex = bareFencePointer < bareFenceLineIndices.length ? bareFenceLineIndices[bareFencePointer]! : -1;
      if (closeLineIndex !== -1) {
        flushOpenBlocks();
        const codeLines = lines.slice(i + 1, closeLineIndex);
        // Contents inside a fence are OPAQUE (B2 extended to blocks): no
        // inline parsing, no heading detection, nothing — the model's code
        // stays exactly what it wrote.
        blocks.push({ kind: 'codeBlock', language: fenceOpen.language, code: codeLines.join('\n') });
        i = closeLineIndex + 1;
        continue;
      }
      // No closer anywhere in the rest of the document: an unterminated fence
      // is NOT swallowed as one giant opaque block to end-of-document (that
      // would silently eat everything after it). It degrades — this line
      // falls through to the same per-line classification as any other line,
      // which (since a backtick-fence line matches none of heading/rule/
      // list) lands it in the paragraph buffer as literal text.
    }

    const heading = matchHeading(line);
    if (heading !== null) {
      flushOpenBlocks();
      blocks.push({ kind: 'heading', level: heading.level, inlines: parseInline(heading.text, 0) });
      i += 1;
      continue;
    }

    if (isRuleLine(line)) {
      flushOpenBlocks();
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    const listItem = matchListItem(line);
    if (listItem !== null) {
      flushParagraph();
      if (listState !== null && listState.ordered !== listItem.ordered) {
        flushList();
      }
      if (listState === null) {
        listState = { ordered: listItem.ordered, items: [] };
      }
      listState.items.push({ inlines: parseInline(listItem.text, 0) });
      i += 1;
      continue;
    }

    // Plain content line joins whatever paragraph is in progress. Lists in
    // this grammar are flat (scope A: "one level, flat items") so a non-list
    // line always closes one in progress rather than being folded into it.
    flushList();
    paragraphLines.push(line);
    i += 1;
  }
  flushOpenBlocks();
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Recursion happens only for the CONTENTS of a matched `**`/`*`/link-label —
// each recursive call operates on a strictly smaller slice than its caller,
// but adversarially crafted nesting could still, in principle, chain many
// small slices into deep recursion. This cap is the hard backstop: total
// inline work is bounded by O(MAX_DEPTH * length) no matter how the input is
// shaped, per the "no catastrophic backtracking" requirement. It is not
// expected to ever bind on real assistant output.
const MAX_INLINE_RECURSION_DEPTH = 40;

// Source-file extensions scope F treats a code span's content as path-shaped
// for (F1). Kept explicit and small by design — this is the allowlist that
// keeps `application/json` (no extension) and `and/or` (no extension) from
// ever becoming a link; only a recognized extension or a leading path marker
// (/, ./, ../, ~/) qualifies.
const PATH_CANDIDATE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'mjs',
  'vue',
  'json',
  'md',
  'sh',
  'py',
  'rs',
  'yml',
  'yaml',
  'toml',
  'css',
  'html',
  'sql',
]);

function hasPathLeadingMarker(path: string): boolean {
  return path.startsWith('/') || path.startsWith('./') || path.startsWith('../') || path.startsWith('~/');
}

// The segment to run the extension check against: everything before the
// FIRST colon, or the whole text if there is none. This is deliberately NOT
// the same string `splitPathAndLine` reports as `path` — for `foo.ts:bar` that
// reports the WHOLE string (F2: a non-numeric suffix means there is no line,
// so nothing gets stripped), and naively checking the extension of
// "foo.ts:bar" would see "ts:bar" as the extension and reject a span the spec
// explicitly requires to qualify (F1 example: `foo.ts:bar`). Extension
// candidacy and the reported `path`/`line` split are two different questions
// answered from the same text.
function extensionCandidateSegment(codeSpanText: string): string {
  const firstColon = codeSpanText.indexOf(':');
  return firstColon === -1 ? codeSpanText : codeSpanText.slice(0, firstColon);
}

// Digits, with an optional leading '-' so "a.ts:0" and "a.ts:-3" are both
// recognized as line-syntax (F2: "Line 0 or negative → null") rather than
// falling into the "not a line at all" branch that `foo.ts:bar` takes.
function isLineDigits(candidate: string): boolean {
  if (candidate.length === 0) {
    return false;
  }
  let start = 0;
  if (candidate[0] === '-') {
    if (candidate.length === 1) {
      return false;
    }
    start = 1;
  }
  for (let idx = start; idx < candidate.length; idx += 1) {
    const code = candidate.charCodeAt(idx);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

function normalizeLine(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Splits a `:line` or `:line:col` suffix off the end of a code-span's text.
// A deliberately explicit, hand-rolled scan rather than one clever regex
// (`^(.*):(\d+)(?::(\d+))?$`) — greedy backtracking on that pattern actually
// prefers the SHORTEST trailing colon-digit group it can find while still
// matching (it stops backtracking `.*` as soon as a match succeeds), which
// for "a.ts:42:7" yields path="a.ts:42", line=7 — the opposite of what F2
// wants (line: 42, column 7 ignored). Manual last-colon / second-last-colon
// inspection avoids the ambiguity entirely and is easier to reason about besides.
function splitPathAndLine(text: string): { path: string; line: number | null } {
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) {
    return { path: text, line: null };
  }
  const afterLast = text.slice(lastColon + 1);
  if (!isLineDigits(afterLast)) {
    // Suffix after the final colon isn't line-shaped at all (e.g. "bar" in
    // `foo.ts:bar`) — F2: the WHOLE string is the path, line stays null.
    return { path: text, line: null };
  }
  const beforeLast = text.slice(0, lastColon);
  const secondLastColon = beforeLast.lastIndexOf(':');
  if (secondLastColon !== -1) {
    const middleSegment = beforeLast.slice(secondLastColon + 1);
    if (isLineDigits(middleSegment)) {
      // `file:LINE:COL` — line is the middle group, the trailing group is a
      // column VIMES's editor takes no argument for and so is discarded.
      return { path: beforeLast.slice(0, secondLastColon), line: normalizeLine(Number(middleSegment)) };
    }
  }
  // `file:LINE` — the one colon-digit group present is the line.
  return { path: beforeLast, line: normalizeLine(Number(afterLast)) };
}

// F1: is this code span's content shaped like a file path? Whitespace
// anywhere disqualifies it outright (`npm run build` stays ordinary code) —
// checked on the FULL original text, before any suffix stripping, since a
// path can never legitimately contain a space. The fail-safe direction is
// "stay an ordinary code node": a missed link costs a click, a wrong one is a
// confusing dead end (F1).
function classifyPathCandidate(codeSpanText: string): { path: string; line: number | null } | null {
  if (codeSpanText.length === 0 || /\s/.test(codeSpanText)) {
    return null;
  }
  const { path, line } = splitPathAndLine(codeSpanText);
  if (path.length === 0) {
    return null;
  }
  const extensionSegment = extensionCandidateSegment(codeSpanText);
  if (hasPathLeadingMarker(path) || PATH_CANDIDATE_EXTENSIONS.has(extensionOf(extensionSegment))) {
    return { path, line };
  }
  return null;
}

// Code span classification (B2 extended by F): the span's TEXT is never
// re-parsed as markdown either way — this only decides which of two inert
// leaf kinds it becomes.
function classifyCodeSpan(codeSpanText: string): MarkdownInline {
  const pathCandidate = classifyPathCandidate(codeSpanText);
  if (pathCandidate !== null) {
    return { kind: 'path', raw: codeSpanText, path: pathCandidate.path, line: pathCandidate.line };
  }
  return { kind: 'code', text: codeSpanText };
}

// B3: link hrefs are an injection vector even with no raw-HTML rendering
// anywhere in the app — an `<a href>`
// bound to `javascript:…` still executes on click. Only http:, https:,
// mailto:, and same-page-relative hrefs render as links; everything else
// (including scheme-relative `//host`, which is a same-scheme injection
// vector on an https page) renders as plain text.
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

// ASCII control characters, by code point (0x00-0x1F plus DEL 0x7F) -- a
// numeric-comparison helper rather than a regex character class, so nothing
// resembling an escaped control byte sits in this source file itself.
function isAsciiControlCharCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

// Browsers strip ASCII control characters (including tab/newline/CR) from
// anywhere in a URL before parsing its scheme — "java\tscript:" is exactly
// this bypass, and a naive `startsWith('javascript:')` check would miss it.
// Stripping every such character out first, matching that behavior, closes
// the hole regardless of where in the string it was hidden.
function stripAsciiControlCharacters(value: string): string {
  let result = '';
  for (let idx = 0; idx < value.length; idx += 1) {
    const code = value.charCodeAt(idx);
    if (!isAsciiControlCharCode(code)) {
      result += value[idx];
    }
  }
  return result;
}

function classifyHref(hrefRaw: string): { allowed: true; href: string } | { allowed: false } {
  const stripped = stripAsciiControlCharacters(hrefRaw).trim();
  if (stripped.length === 0) {
    return { allowed: false };
  }
  if (stripped.startsWith('//')) {
    return { allowed: false }; // scheme-relative, e.g. "//evil.example"
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (schemeMatch === null) {
    return { allowed: true, href: stripped }; // no scheme at all -> same-page relative href
  }
  const scheme = `${schemeMatch[1]!.toLowerCase()}:`;
  return ALLOWED_URL_SCHEMES.has(scheme) ? { allowed: true, href: stripped } : { allowed: false };
}

// Attempts to parse a `[label](href)` starting at `text[start] === '['`.
// Returns null for anything structurally malformed (no closing `]`, no `(`
// immediately after, no closing `)`) — the caller then treats `[` as an
// ordinary character and every byte of the malformed attempt is preserved
// character-by-character by the normal scan (assertion 7: no input loses
// characters).
function tryParseLink(
  text: string,
  start: number,
  depth: number,
): { node: MarkdownInline; nextIndex: number } | null {
  const closeBracket = text.indexOf(']', start + 1);
  if (closeBracket === -1) {
    return null;
  }
  if (text[closeBracket + 1] !== '(') {
    return null;
  }
  const closeParen = text.indexOf(')', closeBracket + 2);
  if (closeParen === -1) {
    return null;
  }
  const label = text.slice(start + 1, closeBracket);
  const hrefRaw = text.slice(closeBracket + 2, closeParen);
  const nextIndex = closeParen + 1;
  const classification = classifyHref(hrefRaw);
  if (!classification.allowed) {
    // B3, pinned: a syntactically valid link with a disallowed/unparseable
    // scheme never becomes a clickable element. The label survives as plain
    // text; the href does not. This is the one place inline parsing
    // deliberately drops source characters — dropping the href IS the safety
    // property here, not an accidental loss.
    return { node: { kind: 'text', text: label }, nextIndex };
  }
  return {
    node: { kind: 'link', href: classification.href, children: parseInline(label, depth + 1) },
    nextIndex,
  };
}

function parseInline(text: string, depth: number): MarkdownInline[] {
  if (depth > MAX_INLINE_RECURSION_DEPTH) {
    return text.length > 0 ? [{ kind: 'text', text }] : [];
  }

  const result: MarkdownInline[] = [];
  let textBuffer = '';
  const flushText = (): void => {
    if (textBuffer.length > 0) {
      result.push({ kind: 'text', text: textBuffer });
      textBuffer = '';
    }
  };

  const length = text.length;
  let i = 0;
  while (i < length) {
    const ch = text[i]!;

    // B2: a code span is parsed FIRST and its contents are inert — this is
    // the very first branch checked, so `**not bold**` inside backticks can
    // never be reinterpreted as emphasis by the branches below.
    if (ch === '`') {
      const closeIndex = text.indexOf('`', i + 1);
      if (closeIndex === -1) {
        textBuffer += ch;
        i += 1;
        continue;
      }
      flushText();
      result.push(classifyCodeSpan(text.slice(i + 1, closeIndex)));
      i = closeIndex + 1;
      continue;
    }

    // B1, pinned and non-negotiable: `_` is never checked for emphasis
    // anywhere in this scanner. Only `*`/`**` are emphasis markers — an
    // underscore is always literal text, so `MIN_VISIBLE_PERCENT` and
    // `__init__` survive byte-identical.
    if (ch === '*') {
      if (text[i + 1] === '*') {
        const closeIndex = text.indexOf('**', i + 2);
        if (closeIndex !== -1) {
          flushText();
          result.push({ kind: 'strong', children: parseInline(text.slice(i + 2, closeIndex), depth + 1) });
          i = closeIndex + 2;
          continue;
        }
        // No closing "**" anywhere ahead: this "*" is unmatched. Consume just
        // the one character literally and let the loop re-evaluate the next
        // "*" independently, rather than swallowing the rest of the text.
        textBuffer += '*';
        i += 1;
        continue;
      }
      const closeIndex = text.indexOf('*', i + 1);
      if (closeIndex !== -1) {
        flushText();
        result.push({ kind: 'em', children: parseInline(text.slice(i + 1, closeIndex), depth + 1) });
        i = closeIndex + 1;
        continue;
      }
      textBuffer += '*';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const linkResult = tryParseLink(text, i, depth);
      if (linkResult !== null) {
        flushText();
        result.push(linkResult.node);
        i = linkResult.nextIndex;
        continue;
      }
      textBuffer += ch;
      i += 1;
      continue;
    }

    textBuffer += ch;
    i += 1;
  }
  flushText();
  return result;
}

// ---------------------------------------------------------------------------
// Scope F3 — pure path resolution (no fetch, no fs; StreamView builds the
// href from this). Path resolution belongs here, not inline in the .vue, so
// it is unit-testable in isolation from Vue/DOM.
//
// F4, decided deliberately (not missed): there is NO existence check here or
// in the view. This module stays synchronous/pure/deterministic; a path the
// agent invented becomes a link that opens the editor and reports
// not-found, which is an honest outcome. The daemon's fileApi is the one
// authority on what actually exists AND on what is in-bounds — see the note
// below on `resolveWithinRoots` for why this function does not replicate
// that check either.
// ---------------------------------------------------------------------------

// Collapses `.`/`..`/empty segments. `anchor` is whatever prefix cannot be
// popped past: '/' for an absolute path (climbing above root is a no-op, not
// an error — matches ordinary path-normalize semantics), '~' for a home-
// relative path, or '' for an ordinary relative path (where a leading `..`
// that has nothing left to pop is preserved, since there IS more path above
// the starting point).
function normalizeSlashPath(path: string, anchor: '/' | '~' | ''): string {
  const rest = anchor === '' ? path : path.slice(1).replace(/^\/+/, '');
  const segments = rest.split('/');
  const output: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (output.length > 0 && output[output.length - 1] !== '..') {
        output.pop();
      } else if (anchor === '') {
        output.push('..');
      }
      // anchor === '/' or '~' with nothing to pop: climbing above the anchor
      // is dropped, not an error — the daemon's own allowlist check is what
      // actually decides reachability (see resolvePathAgainstCwd's comment).
      continue;
    }
    output.push(segment);
  }
  const joined = output.join('/');
  if (anchor === '/') {
    return `/${joined}`;
  }
  if (anchor === '~') {
    return joined.length > 0 ? `~/${joined}` : '~';
  }
  return joined.length > 0 ? joined : '.';
}

// An absolute path is used as-is (normalized); a relative one resolves
// against the session's cwd (F3). A `..` that walks the result outside the
// project roots is NOT rejected here — it is normalized like any other path,
// and the daemon's `resolveWithinRoots` (packages/daemon/src/filePaths.ts) is
// what actually 403s it with zero product bytes. Duplicating that allowlist
// check client-side would make the UI a second, driftable authority over a
// fact the daemon owns (principle 9) — this function only ever does the
// string arithmetic, never the security decision.
export function resolvePathAgainstCwd(cwd: string, rawPath: string): string {
  if (rawPath.startsWith('/')) {
    return normalizeSlashPath(rawPath, '/');
  }
  if (rawPath.startsWith('~')) {
    // Home-relative: the browser has no notion of the daemon's $HOME to
    // expand this against, and joining it onto cwd would produce nonsense
    // (".../cwd/~/x"). Left as-is (normalized past the tilde) so the daemon's
    // own resolution — or its honest not-found — is what the user sees.
    return normalizeSlashPath(rawPath, '~');
  }
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  return normalizeSlashPath(`${base}/${rawPath}`, '/');
}
