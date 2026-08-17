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
  // ── the TREE fallback: home, and everything unrecognized (S15·U2, A7) ──────
  // Every hash in this block resolved to the session list before the S15·U2
  // cutover, and that view is gone entirely since S16·U5. The shape of the
  // block is unchanged on purpose — these are the SAME strings phase 1 pinned,
  // re-pointed at the view that now claims them, so the cases that are
  // load-bearing for a REASON (the quirks below) keep testing the quirk and not
  // the view name.
  { hash: '', expected: { view: 'tree' }, label: "'' (no hash at all)" },
  { hash: '#', expected: { view: 'tree' } },
  { hash: '#/', expected: { view: 'tree' } },
  { hash: '#nonsense', expected: { view: 'tree' } },
  { hash: '#/unknown/route', expected: { view: 'tree' } },
  // QUIRK: params with no path are simply ignored — routePath is ''.
  { hash: '#?path=/x', expected: { view: 'tree' } },
  // A7's explicitly-rejected branch: the tree route has NO `?root=` param, so a
  // hash that carries one is a plain tree. Scoping is expansion state.
  { hash: '#/?root=x', expected: { view: 'tree' } },
  { hash: '#?root=project:abc', expected: { view: 'tree' } },
  // QUIRK: `/session/` with nothing after it is NOT a session route.
  { hash: '#/session/', expected: { view: 'tree' } },
  // QUIRK: route paths are matched exactly — a trailing slash is a different path.
  { hash: '#/files/', expected: { view: 'tree' } },
  { hash: '#/files/sub', expected: { view: 'tree' } },
  { hash: '#/meters/', expected: { view: 'tree' } },
  { hash: '#/sessions/', expected: { view: 'tree' } },
  // QUIRK: and matching is case-sensitive.
  { hash: '#/METERS', expected: { view: 'tree' } },
  { hash: '#/Search', expected: { view: 'tree' } },
  { hash: '#/Sessions', expected: { view: 'tree' } },

  // ── THE DEAD HASHES (S16·U5, S16-A2) ──────────────────────────────────────
  // `#/sessions` and `#/meters` named the session list until S16·U5 deleted the
  // view. They are RE-PINNED here rather than removed, and they are re-pinned in
  // the fallback block on purpose: the URLs are real, they are in bookmarks and
  // in every push notification sent before the retarget (decision 2), and what
  // they must do now is land somewhere that works. They fall through to the
  // tree — no redirect, no error, no special case — exactly like `#/nonsense`
  // two blocks up. The `?anything=1` and no-leading-`#` variants are kept from
  // the old block so the fall-through is proven for the same input shapes the
  // live route was proven for.
  { hash: '#/sessions', expected: { view: 'tree' } },
  { hash: '#/sessions?anything=1', expected: { view: 'tree' } },
  { hash: '#/meters', expected: { view: 'tree' } },
  { hash: '#/meters?anything=1', expected: { view: 'tree' } },
  // QUIRK: the leading '#' is optional. location.hash always supplies one.
  { hash: '/meters', expected: { view: 'tree' }, label: "'/meters' (no leading #)" },
  { hash: '/sessions', expected: { view: 'tree' }, label: "'/sessions' (no leading #)" },

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
  // S16·U5: the two sessionList rows are gone with the view. The "exercises
  // every view" case below is what keeps this list honest either way — it
  // compares the views covered here against ROUTE_PRECEDENCE, so deleting a
  // view without deleting its row (or the reverse) reddens immediately.
  { view: 'tree' },
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
      // S15·U2 gave the tree the last slot — the total fallback — and pushed the
      // session list up one, from "claims everything left over" to two explicit
      // paths. S16·U5 deleted that entry outright, so the tree's slot is now
      // directly below `stream`. Everything above is untouched, and has been
      // through both changes: the precedence of the panel routes is the part of
      // this list that is a contract, and it never moved.
      'tree',
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
    // whole routePath, so they never claim `/session/<id>`. `meters`/`sessions`
    // stay in this list after S16·U5 deleted their rules: an id that spells a
    // DEAD hash must parse as that id too, and the whole point of the loop is
    // that no rule above ever looks at a path SUFFIX.
    for (const panelName of ['files', 'search', 'terminal', 'git', 'cost', 'tasks', 'meters', 'sessions']) {
      expect(parseRoute(`#/session/${panelName}`)).toEqual({
        view: 'stream',
        appSessionId: panelName,
      });
    }
  });

  it('the TREE is last and claims everything left over (S15·U2 — the cutover)', () => {
    expect(ROUTE_PRECEDENCE[ROUTE_PRECEDENCE.length - 1]).toBe('tree');
    expect(parseRoute('#/definitely-not-a-route').view).toBe('tree');
  });

  it('home — the empty hash and `#/` — is the tree (A7)', () => {
    // The cutover itself, as one assertion. Sabotage target: make the fallback
    // rule produce anything other than the tree and exactly this reddens.
    expect(parseRoute('')).toEqual({ view: 'tree' });
    expect(parseRoute('#')).toEqual({ view: 'tree' });
    expect(parseRoute('#/')).toEqual({ view: 'tree' });
  });

  // ⚠ THE TWO DEAD HASHES, RE-PINNED (S16·U5, S16-A2). These two cases used to
  // assert that the session list SURVIVED at `#/sessions` (F1's escape hatch)
  // and that `#/meters` was unchanged by the cutover. The view is deleted, so
  // the claim inverts: the hashes must now DEGRADE, and degrade the same way
  // every unknown hash does. Kept as their own named cases rather than folded
  // silently into the fallback table because "this URL used to mean something
  // and now lands on home" is the fact a reader of this file will come looking
  // for. Sabotage target: give `parseRoute` a `/sessions` arm again and exactly
  // these reddens.
  it('`#/sessions` is DEAD and falls through to the tree (the deletion, as one assertion)', () => {
    expect(parseRoute('#/sessions')).toEqual({ view: 'tree' });
    // Indistinguishable from any other unclaimed hash — no redirect, no marker,
    // no memory of what it used to be.
    expect(parseRoute('#/sessions')).toEqual(parseRoute('#/definitely-not-a-route'));
  });

  it('`#/meters` is DEAD too — an old push-notification deep link still opens home', () => {
    // The threshold-notification push deep-linked here until decision 2
    // retargeted it, so notifications already delivered still carry this hash.
    // Landing on the tree is the graceful answer; throwing or blanking is not.
    expect(parseRoute('#/meters')).toEqual({ view: 'tree' });
    expect(parseRoute('#/meters')).toEqual(parseRoute(''));
  });

  it('the tree route rejects `?root=` by not knowing it (A7, decided not accidental)', () => {
    // Scoping the tree is client expansion state (slice-15 §1). A scope param
    // would be a second source of record for the same fact, so the codec parses
    // `#/?root=x` as a PLAIN tree — identical to `#/`, params and all.
    expect(parseRoute('#/?root=x')).toEqual(parseRoute('#/'));
    expect(parseRoute('#/?root=project:abc')).toEqual({ view: 'tree' });
    // …and it does not survive a build either: there is nothing to serialize.
    expect(buildHash(parseRoute('#/?root=x'))).toBe('');
  });
});

// ── ASSERTION 4: route → (view, props) is not 1:1 ───────────────────────────

describe('one view, two hashes: a route names a view AND its props', () => {
  // ⚠ RE-ANCHORED (S16·U5). This describe used to carry the sessionList pair —
  // `#/sessions` and `#/meters`, one view differing only in `expandMeters` —
  // as its proof that route → view is not 1:1. Both hashes and the view died
  // in the deletion, and the claim they were proving did NOT: it is why `Route`
  // is a discriminated union of shapes rather than a bare view name, and
  // dropping the assertion with the view would leave that design undefended.
  // The file tree is the surviving instance of the same shape — one view, one
  // optional prop, two hashes that must not collapse to each other.
  it('`#/files` and `#/files?dir=…` are ONE view differing only in a prop', () => {
    const bareTree = parseRoute('#/files');
    const seededTree = parseRoute('#/files?dir=/tmp/a');
    expect(bareTree).toEqual({ view: 'fileTree', initialDir: null });
    expect(seededTree).toEqual({ view: 'fileTree', initialDir: '/tmp/a' });
    expect(bareTree.view).toBe(seededTree.view);
  });

  it('and build back to different hashes', () => {
    expect(buildHash({ view: 'fileTree', initialDir: null })).toBe('#/files');
    expect(buildHash({ view: 'fileTree', initialDir: '/tmp/a' })).toBe('#/files?dir=%2Ftmp%2Fa');
  });

  // …and the harder half of the same point: the SAME path, two DIFFERENT views,
  // separated by a prop's presence. A model keyed on the path alone loses this.
  it('`#/files?path=…` is a different VIEW off the same path', () => {
    expect(parseRoute('#/files?path=/tmp/a.ts').view).toBe('editor');
    expect(parseRoute('#/files?dir=/tmp/a').view).toBe('fileTree');
  });

  it("home is the empty string, and it is the TREE's — the only view that owns it", () => {
    expect(buildHash({ view: 'tree' })).toBe('');
    expect(parseRoute('')).toEqual({ view: 'tree' });
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
    // Was `'#/meters?%'` until S16·U5. The property under test is splitHash +
    // URLSearchParams leniency on a malformed escape in the QUERY, and with the
    // `/meters` rule deleted that string took the identical code path as any
    // other unclaimed path — so the case is re-spelled on a path that is
    // unclaimed on purpose rather than by history.
    '#/unclaimed?%',
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
    // navigateHome() emitted '' then and emits '' now — the bytes are pinned,
    // the VIEW behind them is the tree since S15·U2. The two sessionList rows
    // that sat here (`#/sessions`, `#/meters`) went with the view in S16·U5:
    // there is no longer a route shape that builds either string, which is
    // exactly why nothing can round-trip through them.
    { builderCall: 'navigateHome()', route: { view: 'tree' }, hash: '' },
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
