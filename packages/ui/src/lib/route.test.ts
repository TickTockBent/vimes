// The route contract. Desktop phase 1 extracted App.vue's routing into
// lib/route.ts and changed no behaviour; this file is the evidence.
//
// HOW THIS TABLE WAS BUILT, because it matters: every case below was written by
// reading App.vue at 115e728 and asserted against a verbatim transcription of it
// BEFORE lib/route.ts existed. A table written afterwards would test the refactor
// against itself. The quirks marked QUIRK are pre-existing behaviour that this
// suite exists to KEEP — none of them is a bug fix waiting to happen here.

import { describe, expect, it } from 'vitest';
import { ROUTE_PRECEDENCE, buildHash, parseRoute, type Route, type RouteView } from './route.js';

interface RouteCase {
  hash: string;
  expected: Route;
  // Only for hashes too long or too odd to read in a test title.
  label?: string;
}

const TEN_KILOBYTE_SESSION_ID = 'a'.repeat(10_000);

// ── ASSERTION 1: the route table ────────────────────────────────────────────

const ROUTE_TABLE: readonly RouteCase[] = [
  // ── the SessionListView fallback: everything unrecognized lands here ───────
  { hash: '', expected: { view: 'sessionList', expandMeters: false }, label: "'' (no hash at all)" },
  { hash: '#', expected: { view: 'sessionList', expandMeters: false } },
  { hash: '#/', expected: { view: 'sessionList', expandMeters: false } },
  { hash: '#nonsense', expected: { view: 'sessionList', expandMeters: false } },
  { hash: '#/unknown/route', expected: { view: 'sessionList', expandMeters: false } },
  // QUIRK: params with no path are simply ignored — routePath is ''.
  { hash: '#?path=/x', expected: { view: 'sessionList', expandMeters: false } },
  // QUIRK: `/session/` with nothing after it is NOT a session route.
  { hash: '#/session/', expected: { view: 'sessionList', expandMeters: false } },
  // QUIRK: route paths are matched exactly — a trailing slash is a different path.
  { hash: '#/files/', expected: { view: 'sessionList', expandMeters: false } },
  { hash: '#/files/sub', expected: { view: 'sessionList', expandMeters: false } },
  { hash: '#/meters/', expected: { view: 'sessionList', expandMeters: false } },
  // QUIRK: and matching is case-sensitive.
  { hash: '#/METERS', expected: { view: 'sessionList', expandMeters: false } },
  { hash: '#/Search', expected: { view: 'sessionList', expandMeters: false } },

  // ── the SAME view, a different prop: this is why Route carries props ───────
  { hash: '#/meters', expected: { view: 'sessionList', expandMeters: true } },
  { hash: '#/meters?anything=1', expected: { view: 'sessionList', expandMeters: true } },
  // QUIRK: the leading '#' is optional. location.hash always supplies one.
  { hash: '/meters', expected: { view: 'sessionList', expandMeters: true }, label: "'/meters' (no leading #)" },

  // ── EditorView: `/files` WITH a `path` param ──────────────────────────────
  {
    hash: '#/files?path=/tmp/a.ts',
    expected: { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: null },
  },
  {
    hash: '#/files?path=/tmp/a.ts&line=42',
    expected: { view: 'editor', path: '/tmp/a.ts', line: 42, returnToParam: null },
  },
  {
    hash: '#/files?path=/tmp/a.ts&line=0',
    expected: { view: 'editor', path: '/tmp/a.ts', line: 0, returnToParam: null },
  },
  {
    // QUIRK: Number('') is 0, and 0 is finite — an empty `line` means line 0.
    hash: '#/files?path=/tmp/a.ts&line=',
    expected: { view: 'editor', path: '/tmp/a.ts', line: 0, returnToParam: null },
  },
  {
    hash: '#/files?path=/tmp/a.ts&line=abc',
    expected: { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: null },
  },
  {
    hash: '#/files?path=/tmp/a.ts&line=Infinity',
    expected: { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: null },
  },
  {
    // QUIRK: Number() accepts exponent notation.
    hash: '#/files?path=/tmp/a.ts&line=1e3',
    expected: { view: 'editor', path: '/tmp/a.ts', line: 1000, returnToParam: null },
  },
  {
    // QUIRK: Number() accepts hex literals.
    hash: '#/files?path=/tmp/a.ts&line=0x10',
    expected: { view: 'editor', path: '/tmp/a.ts', line: 16, returnToParam: null },
  },
  {
    // QUIRK: Number() trims surrounding whitespace.
    hash: '#/files?path=/tmp/a.ts&line=%20%207%20',
    expected: { view: 'editor', path: '/tmp/a.ts', line: 7, returnToParam: null },
  },
  {
    // QUIRK: negatives and fractions pass the isFinite check.
    hash: '#/files?path=/tmp/a.ts&line=-5',
    expected: { view: 'editor', path: '/tmp/a.ts', line: -5, returnToParam: null },
  },
  {
    hash: '#/files?path=/tmp/a.ts&line=3.9',
    expected: { view: 'editor', path: '/tmp/a.ts', line: 3.9, returnToParam: null },
  },
  {
    // QUIRK: an EMPTY path is still the editor — the test is `path === null`.
    hash: '#/files?path=',
    expected: { view: 'editor', path: '', line: undefined, returnToParam: null },
  },
  {
    // QUIRK: URLSearchParams decodes '+' as a space.
    hash: '#/files?path=a+b',
    expected: { view: 'editor', path: 'a b', line: undefined, returnToParam: null },
  },
  {
    hash: '#/files?path=%2Ftmp%2Fa%20b.ts',
    expected: { view: 'editor', path: '/tmp/a b.ts', line: undefined, returnToParam: null },
  },
  {
    // QUIRK: duplicate params — `.get()` returns the FIRST.
    hash: '#/files?path=a&path=b',
    expected: { view: 'editor', path: 'a', line: undefined, returnToParam: null },
  },
  {
    // QUIRK: URLSearchParams is lenient about a lone '%'; it does NOT throw.
    hash: '#/files?path=%',
    expected: { view: 'editor', path: '%', line: undefined, returnToParam: null },
  },
  {
    hash: '#/files?path=a#b',
    expected: { view: 'editor', path: 'a#b', line: undefined, returnToParam: null },
  },
  {
    hash: '#/files?path=x&returnTo=git',
    expected: { view: 'editor', path: 'x', line: undefined, returnToParam: 'git' },
  },
  {
    // The route carries the RAW param. Neutralizing an unrecognized value is
    // decideEditorReturn's job (lib/gitReview.ts), not this module's.
    hash: '#/files?path=x&returnTo=evil',
    expected: { view: 'editor', path: 'x', line: undefined, returnToParam: 'evil' },
  },
  {
    // PRECEDENCE: the editor beats the file tree on the same `/files` path.
    hash: '#/files?dir=/d&path=/f',
    expected: { view: 'editor', path: '/f', line: undefined, returnToParam: null },
  },

  // ── FileTreeView: `/files` WITHOUT a `path` param ─────────────────────────
  { hash: '#/files', expected: { view: 'fileTree', initialDir: null } },
  { hash: '#/files?', expected: { view: 'fileTree', initialDir: null } },
  { hash: '#/files?dir=/tmp', expected: { view: 'fileTree', initialDir: '/tmp' } },
  {
    // QUIRK: an empty `dir` reaches the tree as '', not null — a distinct input,
    // because the tree's fallback-to-first-root is keyed on null.
    hash: '#/files?dir=',
    expected: { view: 'fileTree', initialDir: '' },
  },
  { hash: '#/files?dir=%2Ftmp%2Fa%20b', expected: { view: 'fileTree', initialDir: '/tmp/a b' } },
  { hash: '#/files?line=3', expected: { view: 'fileTree', initialDir: null } },

  // ── the single-purpose panels ─────────────────────────────────────────────
  { hash: '#/search', expected: { view: 'search' } },
  { hash: '#/search?x=1', expected: { view: 'search' } },
  { hash: '#/terminal', expected: { view: 'terminal' } },
  { hash: '#/git', expected: { view: 'git' } },
  { hash: '#/cost', expected: { view: 'cost' } },
  { hash: '#/tasks', expected: { view: 'tasks' } },

  // ── StreamView ────────────────────────────────────────────────────────────
  { hash: '#/session/abc', expected: { view: 'stream', appSessionId: 'abc' } },
  { hash: '#/session/a%20b', expected: { view: 'stream', appSessionId: 'a b' } },
  {
    // QUIRK: the `(.+)` capture is greedy and crosses slashes.
    hash: '#/session/a/b',
    expected: { view: 'stream', appSessionId: 'a/b' },
  },
  { hash: '#/session/abc?foo=1', expected: { view: 'stream', appSessionId: 'abc' } },
  { hash: '#/session/%E6%97%A5%E6%9C%AC', expected: { view: 'stream', appSessionId: '日本' } },
  { hash: '#/session/日本', expected: { view: 'stream', appSessionId: '日本' } },
  {
    // PRECEDENCE: a session id that spells a panel route is still a session.
    hash: '#/session/files',
    expected: { view: 'stream', appSessionId: 'files' },
  },
  {
    hash: `#/session/${TEN_KILOBYTE_SESSION_ID}`,
    expected: { view: 'stream', appSessionId: TEN_KILOBYTE_SESSION_ID },
    label: "'#/session/' + 10 KB of 'a'",
  },
];

function caseTitle(routeCase: RouteCase): string {
  return routeCase.label ?? JSON.stringify(routeCase.hash);
}

describe('parseRoute — the route table', () => {
  for (const routeCase of ROUTE_TABLE) {
    it(`${caseTitle(routeCase)} → ${routeCase.expected.view}`, () => {
      expect(parseRoute(routeCase.hash)).toEqual(routeCase.expected);
    });
  }

  it('covers every view the app can render', () => {
    const viewsInTable = new Set<RouteView>(ROUTE_TABLE.map((routeCase) => routeCase.expected.view));
    expect([...viewsInTable].sort()).toEqual([...ROUTE_PRECEDENCE].sort());
  });
});

// ── ASSERTION 2: round-trip ─────────────────────────────────────────────────

const ROUND_TRIP_ROUTES: readonly Route[] = [
  { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: null },
  { view: 'editor', path: '/tmp/a.ts', line: 42, returnToParam: null },
  { view: 'editor', path: '/tmp/a.ts', line: 0, returnToParam: null },
  { view: 'editor', path: '/tmp/a.ts', line: -5, returnToParam: null },
  { view: 'editor', path: '/tmp/a.ts', line: 3.9, returnToParam: null },
  { view: 'editor', path: '/tmp/a.ts', line: 7, returnToParam: 'git' },
  { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: 'git' },
  { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: 'evil' },
  { view: 'editor', path: '', line: undefined, returnToParam: null },
  { view: 'editor', path: '/tmp/a b.ts', line: undefined, returnToParam: null },
  { view: 'editor', path: '/tmp/a+b.ts', line: undefined, returnToParam: null },
  { view: 'editor', path: '/tmp/a&b=c?d#e.ts', line: undefined, returnToParam: null },
  { view: 'editor', path: '/tmp/%.ts', line: undefined, returnToParam: null },
  { view: 'editor', path: '/tmp/日本.ts', line: 1, returnToParam: null },
  { view: 'fileTree', initialDir: null },
  { view: 'fileTree', initialDir: '/tmp' },
  { view: 'fileTree', initialDir: '/tmp/a b' },
  { view: 'fileTree', initialDir: '/tmp/a+b' },
  { view: 'fileTree', initialDir: '/tmp/日本' },
  { view: 'search' },
  { view: 'terminal' },
  { view: 'git' },
  { view: 'cost' },
  { view: 'tasks' },
  { view: 'stream', appSessionId: 'abc' },
  { view: 'stream', appSessionId: 'a b' },
  { view: 'stream', appSessionId: 'a/b' },
  { view: 'stream', appSessionId: 'a?b#c&d=e' },
  { view: 'stream', appSessionId: '%' },
  { view: 'stream', appSessionId: '日本' },
  { view: 'stream', appSessionId: TEN_KILOBYTE_SESSION_ID },
  { view: 'sessionList', expandMeters: false },
  { view: 'sessionList', expandMeters: true },
];

describe('parseRoute(buildHash(route)) === route', () => {
  for (const route of ROUND_TRIP_ROUTES) {
    const routeLabel =
      route.view === 'stream' && route.appSessionId.length > 40
        ? 'stream (10 KB id)'
        : JSON.stringify(route);
    it(routeLabel, () => {
      expect(parseRoute(buildHash(route))).toEqual(route);
    });
  }

  it('exercises every view', () => {
    const viewsCovered = new Set<RouteView>(ROUND_TRIP_ROUTES.map((route) => route.view));
    expect([...viewsCovered].sort()).toEqual([...ROUTE_PRECEDENCE].sort());
  });

  it("the ONE lossy shape: an empty initialDir builds a bare '#/files' and parses back as null", () => {
    // Pre-existing: navigateToFiles('') emitted '#/files' because its guard was
    // `dir.length > 0`. Pinned rather than smoothed over — the asymmetry is old
    // behaviour, and "fixing" it would change an emitted URL.
    expect(buildHash({ view: 'fileTree', initialDir: '' })).toBe('#/files');
    expect(parseRoute('#/files')).toEqual({ view: 'fileTree', initialDir: null });
  });
});

// ── ASSERTION 3: precedence is explicit and pinned ──────────────────────────

describe('precedence — the old v-if chain, now data', () => {
  it('is exactly App.vue\'s v-if / v-else-if order at 115e728', () => {
    // ⚠ Changing this list changes which view a hash renders. It is the contract,
    // not a description of one — swap any two entries and this reddens.
    expect([...ROUTE_PRECEDENCE]).toEqual([
      'editor',
      'fileTree',
      'search',
      'terminal',
      'git',
      'cost',
      'tasks',
      'stream',
      'sessionList',
    ]);
  });

  it('the editor beats the file tree for the same /files path', () => {
    expect(parseRoute('#/files?path=/f').view).toBe('editor');
    expect(parseRoute('#/files?dir=/d&path=/f').view).toBe('editor');
    // …and only a `path` param flips it. `dir` alone leaves the tree in place.
    expect(parseRoute('#/files?dir=/d').view).toBe('fileTree');
  });

  it('the session route loses to every panel route above it', () => {
    // A session id may SPELL a panel route; the panel rules are keyed on the
    // whole routePath, so they never claim `/session/<id>`.
    for (const panelName of ['files', 'search', 'terminal', 'git', 'cost', 'tasks', 'meters']) {
      expect(parseRoute(`#/session/${panelName}`)).toEqual({
        view: 'stream',
        appSessionId: panelName,
      });
    }
  });

  it('the session list is last and claims everything left over', () => {
    expect(ROUTE_PRECEDENCE[ROUTE_PRECEDENCE.length - 1]).toBe('sessionList');
    expect(parseRoute('#/definitely-not-a-route').view).toBe('sessionList');
  });
});

// ── ASSERTION 4: route → (view, props) is not 1:1 ───────────────────────────

describe("'#/' and '#/meters' are the same view with a different prop", () => {
  it('both resolve to sessionList, differing only in expandMeters', () => {
    const home = parseRoute('#/');
    const meters = parseRoute('#/meters');
    expect(home).toEqual({ view: 'sessionList', expandMeters: false });
    expect(meters).toEqual({ view: 'sessionList', expandMeters: true });
    expect(home.view).toBe(meters.view);
  });

  it('and build back to different hashes', () => {
    expect(buildHash({ view: 'sessionList', expandMeters: false })).toBe('');
    expect(buildHash({ view: 'sessionList', expandMeters: true })).toBe('#/meters');
  });
});

// ── ASSERTION 5: totality (I8) ──────────────────────────────────────────────

describe('parseRoute is total — nothing throws, everything resolves', () => {
  const HOSTILE_HASHES: readonly string[] = [
    '',
    '#',
    '#/',
    '#nonsense',
    '#/unknown/route',
    '#?',
    '#/files?',
    '#/files?&&&',
    '#/files?=',
    '#/files?path=a&path=b&path=c',
    '#/files?path=%',
    '#/files?path=%zz',
    '#/files?%=%',
    '#/session/%',
    '#/session/%zz',
    '#/session/%E6%97',
    '#/meters?%',
    '#'.repeat(1000),
    '?'.repeat(1000),
    `#/session/${'a'.repeat(10_000)}`,
    `#/files?path=${'b'.repeat(10_000)}`,
    '#/session/日本語のセッション',
    // Escaped, not literal: a raw NUL or a bidi override in source is a hazard
    // in its own right, and a hostile-input case must not become one.
    '#/files?path=/tmp/\u0000null.ts',
    '#/\u202Ereversed',
    '#//////',
    '#/files?path=<script>alert(1)</script>',
    '#/../../etc/passwd',
  ];

  for (const hostileHash of HOSTILE_HASHES) {
    const label = hostileHash.length > 40 ? `${hostileHash.slice(0, 20)}… (${hostileHash.length} chars)` : JSON.stringify(hostileHash);
    it(`${label} resolves without throwing`, () => {
      expect(() => parseRoute(hostileHash)).not.toThrow();
      expect(ROUTE_PRECEDENCE).toContain(parseRoute(hostileHash).view);
    });
  }

  it('a malformed percent-escape in a session id degrades to the raw segment', () => {
    // The one place this module is DELIBERATELY different from pre-refactor
    // App.vue, which called decodeURIComponent unguarded and threw a URIError
    // during render. I8 forbids a throw here; the route stays a session route and
    // only the decoding is lost, so the session simply will not be found.
    expect(parseRoute('#/session/%')).toEqual({ view: 'stream', appSessionId: '%' });
    expect(parseRoute('#/session/%zz')).toEqual({ view: 'stream', appSessionId: '%zz' });
  });

  it('unknown routes land on the same fallback as no route at all', () => {
    expect(parseRoute('#/unknown/route')).toEqual(parseRoute(''));
  });
});

// ── ASSERTION 6: the builders and the parser agree ──────────────────────────

describe('buildHash reproduces what App.vue\'s navigate* builders emitted', () => {
  // Each case is one old builder call and the exact string it produced. The
  // builders and the parser disagreeing is the bug this pairing exists to catch,
  // so every one is also parsed back.
  const BUILDER_CASES: readonly { builderCall: string; route: Route; hash: string }[] = [
    { builderCall: 'navigateHome()', route: { view: 'sessionList', expandMeters: false }, hash: '' },
    {
      builderCall: "navigateToSession('abc')",
      route: { view: 'stream', appSessionId: 'abc' },
      hash: '#/session/abc',
    },
    {
      builderCall: "navigateToSession('a b/c')",
      route: { view: 'stream', appSessionId: 'a b/c' },
      hash: '#/session/a%20b%2Fc',
    },
    { builderCall: 'navigateToFiles()', route: { view: 'fileTree', initialDir: null }, hash: '#/files' },
    {
      builderCall: "navigateToFiles('/tmp/a b')",
      route: { view: 'fileTree', initialDir: '/tmp/a b' },
      // encodeURIComponent, so a space is %20 — NOT the '+' the editor emits.
      hash: '#/files?dir=%2Ftmp%2Fa%20b',
    },
    { builderCall: 'navigateToSearch()', route: { view: 'search' }, hash: '#/search' },
    { builderCall: 'navigateToTerminal()', route: { view: 'terminal' }, hash: '#/terminal' },
    { builderCall: 'navigateToGit()', route: { view: 'git' }, hash: '#/git' },
    { builderCall: 'navigateToCost()', route: { view: 'cost' }, hash: '#/cost' },
    { builderCall: 'navigateToTasks()', route: { view: 'tasks' }, hash: '#/tasks' },
    {
      builderCall: "navigateToEditor('/tmp/a.ts')",
      route: { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: null },
      hash: '#/files?path=%2Ftmp%2Fa.ts',
    },
    {
      builderCall: "navigateToEditor('/tmp/a.ts', 42)",
      route: { view: 'editor', path: '/tmp/a.ts', line: 42, returnToParam: null },
      hash: '#/files?path=%2Ftmp%2Fa.ts&line=42',
    },
    {
      builderCall: "navigateToEditor('/tmp/a.ts', undefined, 'git')",
      route: { view: 'editor', path: '/tmp/a.ts', line: undefined, returnToParam: 'git' },
      hash: '#/files?path=%2Ftmp%2Fa.ts&returnTo=git',
    },
    {
      // Param ORDER is part of the emitted string: path, line, returnTo.
      builderCall: "navigateToEditor('/tmp/a.ts', 3, 'git')",
      route: { view: 'editor', path: '/tmp/a.ts', line: 3, returnToParam: 'git' },
      hash: '#/files?path=%2Ftmp%2Fa.ts&line=3&returnTo=git',
    },
    {
      // URLSearchParams, so a space is '+' — NOT the %20 the tree's dir emits.
      builderCall: "navigateToEditor('/tmp/a b.ts')",
      route: { view: 'editor', path: '/tmp/a b.ts', line: undefined, returnToParam: null },
      hash: '#/files?path=%2Ftmp%2Fa+b.ts',
    },
  ];

  for (const builderCase of BUILDER_CASES) {
    it(`${builderCase.builderCall} → ${JSON.stringify(builderCase.hash)}`, () => {
      expect(buildHash(builderCase.route)).toBe(builderCase.hash);
      expect(parseRoute(builderCase.hash)).toEqual(builderCase.route);
    });
  }

  it("navigateToFiles(null) and navigateToFiles('') both emitted a bare '#/files'", () => {
    expect(buildHash({ view: 'fileTree', initialDir: null })).toBe('#/files');
    expect(buildHash({ view: 'fileTree', initialDir: '' })).toBe('#/files');
  });
});
