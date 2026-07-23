// The panel-stack contract (desktop phase 2). panelStack.ts layers a STACK of
// panels over lib/route.ts's single-route primitives; this file is the evidence
// that it does so ADDITIVELY — every URL that works today produces a
// byte-identical hash and parses to a one-element stack, and only a reserved
// `#/stack/` marker unlocks anything new.
//
// The single-panel hashes below are PORTED from route.test.ts on purpose: the
// whole claim of phase 2 is that panelStack changes nothing about them, so the
// proof reuses the very strings phase 1 pinned.

import { describe, expect, it } from 'vitest';
import { buildHash, parseRoute, type Route } from './route.js';
import { buildPanelStackHash, parsePanelStack, type PanelStack } from './panelStack.js';

const TEN_KILOBYTE_SESSION_ID = 'a'.repeat(10_000);

// Hashes ported from route.test.ts's ROUTE_TABLE — a representative spread across
// every view and its quirks (empty line, '+' path, the lossy empty dir, a session
// id that spells a panel name, unicode, the fallback). These are the strings
// whose behaviour phase 2 must leave untouched.
const PORTED_SINGLE_PANEL_HASHES: readonly string[] = [
  '', // home (no hash at all)
  '#',
  '#/',
  '#/meters',
  '#/meters?anything=1',
  '#nonsense',
  '#/unknown/route',
  '#/files',
  '#/files?dir=/tmp',
  '#/files?dir=', // the empty-dir quirk: builds to a bare '#/files'
  '#/files?path=/tmp/a.ts',
  '#/files?path=/tmp/a.ts&line=42',
  '#/files?path=/tmp/a.ts&line=', // Number('') is 0 → line 0
  '#/files?path=a+b', // '+' decodes to a space
  '#/files?path=x&returnTo=git',
  '#/files?dir=/d&path=/f', // precedence: editor beats tree
  '#/search',
  '#/terminal',
  '#/git',
  '#/cost',
  '#/tasks',
  '#/session/abc',
  '#/session/a%20b',
  '#/session/a/b', // greedy capture crosses slashes
  '#/session/files', // a session id that spells a panel route
  '#/session/日本',
];

// ── ASSERTION 1: single-panel byte-identity ─────────────────────────────────
// buildPanelStackHash([parseRoute(h)]) is the SAME BYTES as buildHash(parseRoute(h)).
// This is the invariant the retrofit rests on: the canonical single-panel form is
// unchanged, so every bookmark/paste/deep-link is emitted exactly as it is now.

describe('a single panel is byte-identical to today', () => {
  for (const hash of PORTED_SINGLE_PANEL_HASHES) {
    const route = parseRoute(hash);
    it(`${JSON.stringify(hash)} → ${JSON.stringify(buildHash(route))}`, () => {
      expect(buildPanelStackHash([route])).toBe(buildHash(route));
    });
  }
});

// ── ASSERTION 2: a non-`#/stack/` hash is a length-1 stack of its route ──────

describe('parsePanelStack of an ordinary hash is exactly [parseRoute(hash)]', () => {
  for (const hash of PORTED_SINGLE_PANEL_HASHES) {
    it(`${JSON.stringify(hash)} → single panel`, () => {
      const stack = parsePanelStack(hash);
      expect(stack).toHaveLength(1);
      expect(stack[0]).toEqual(parseRoute(hash));
    });
  }
});

// ── ASSERTION 3: multi-panel round-trip ─────────────────────────────────────
// parsePanelStack(buildPanelStackHash(stack)) deep-equals stack, for 2- and
// 3-panel stacks. Every route used here is one that route.test.ts already proved
// round-trips single-handedly (i.e. NOT the lossy {fileTree, initialDir:''}
// shape, which route.ts intentionally collapses to null — we do not fight it).

const ROUND_TRIPPABLE_ROUTES: readonly Route[] = [
  { view: 'sessionList', expandMeters: false },
  { view: 'sessionList', expandMeters: true },
  { view: 'stream', appSessionId: 'abc' },
  { view: 'stream', appSessionId: 'a b/c' },
  { view: 'stream', appSessionId: '日本' },
  { view: 'stream', appSessionId: '%' },
  { view: 'editor', path: '/tmp/a.ts', line: 42, returnToParam: null },
  { view: 'editor', path: '/tmp/a b.ts', line: undefined, returnToParam: 'git' },
  { view: 'editor', path: '', line: undefined, returnToParam: null },
  { view: 'fileTree', initialDir: null },
  { view: 'fileTree', initialDir: '/tmp/a b' },
  { view: 'search' },
  { view: 'terminal' },
  { view: 'git' },
  { view: 'cost' },
  { view: 'tasks' },
];

describe('multi-panel stacks survive a round trip', () => {
  const twoPanel: PanelStack = [
    { view: 'stream', appSessionId: 'abc' },
    { view: 'editor', path: '/tmp/a.ts', line: 42, returnToParam: null },
  ];
  const threePanel: PanelStack = [
    { view: 'sessionList', expandMeters: false }, // a home panel builds to '' — the empty-segment case
    { view: 'git' },
    { view: 'stream', appSessionId: 'a b/c' },
  ];

  it('a 2-panel stack round-trips', () => {
    expect(parsePanelStack(buildPanelStackHash(twoPanel))).toEqual(twoPanel);
  });

  it('a 3-panel stack round-trips (including a home panel that builds to "")', () => {
    expect(parsePanelStack(buildPanelStackHash(threePanel))).toEqual(threePanel);
  });

  it('every round-trippable route survives as one panel of a 2-panel stack', () => {
    // Pair each route with a fixed neighbour so the stack is genuinely length 2
    // (never collapsing to the byte-identical single-panel path).
    const neighbour: Route = { view: 'terminal' };
    for (const route of ROUND_TRIPPABLE_ROUTES) {
      const stack: PanelStack = [route, neighbour];
      expect(parsePanelStack(buildPanelStackHash(stack))).toEqual(stack);
    }
  });
});

// ── ASSERTION 4: the reserved prefix does not collide ───────────────────────

describe('the `#/stack/` marker is reserved and unambiguous', () => {
  it('a multi-panel hash carries the marker and parses back as a multi-panel stack', () => {
    const stack: PanelStack = [
      { view: 'stream', appSessionId: 'abc' },
      { view: 'git' },
    ];
    const hash = buildPanelStackHash(stack);
    expect(hash.startsWith('#/stack/')).toBe(true);
    expect(parsePanelStack(hash)).toHaveLength(2);
  });

  it('a normal `#/session/x` is NEVER a stack — it is a length-1 stack', () => {
    expect(parsePanelStack('#/session/abc')).toEqual([
      { view: 'stream', appSessionId: 'abc' },
    ]);
    // A session id that literally spells "stack" is still one session panel.
    expect(parsePanelStack('#/session/stack')).toEqual([
      { view: 'stream', appSessionId: 'stack' },
    ]);
  });

  it('`#/stack` WITHOUT a trailing slash is the sessionList fallback, exactly as today', () => {
    // No marker (the prefix is `/stack/`, with the slash), so it flows through
    // parseRoute like any unrecognized hash → a length-1 fallback stack.
    expect(parsePanelStack('#/stack')).toEqual([
      { view: 'sessionList', expandMeters: false },
    ]);
  });
});

// ── ASSERTION 5: totality (I8) — nothing throws, every result is length >= 1 ─

describe('parsePanelStack is total — nothing throws, every stack is non-empty', () => {
  const HOSTILE_HASHES: readonly string[] = [
    '',
    '#',
    '#/',
    '#nonsense',
    '#/unknown/route',
    '#/stack/', // bare marker → one empty segment → one fallback panel
    '#/stack/%', // a malformed percent-escape segment must DEGRADE, not throw
    '#/stack/%zz',
    '#/stack/%/%zz/%E6%97', // several malformed escapes
    '#/stack/junk/more-junk/still-junk', // all segments parseRoute to the fallback
    '#/stack/%23%2Fgit/%23%2Fsession%2Fabc', // a well-formed 2-panel hash
    '#'.repeat(10_000),
    `#/stack/${'a'.repeat(10_000)}`,
    `#/session/${TEN_KILOBYTE_SESSION_ID}`,
    '#/‮reversed',
    '#//////',
  ];

  for (const hostileHash of HOSTILE_HASHES) {
    const label =
      hostileHash.length > 40
        ? `${hostileHash.slice(0, 20)}… (${hostileHash.length} chars)`
        : JSON.stringify(hostileHash);
    it(`${label} → non-empty stack, no throw`, () => {
      expect(() => parsePanelStack(hostileHash)).not.toThrow();
      const stack = parsePanelStack(hostileHash);
      expect(stack.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('a malformed `#/stack/%` segment degrades to the raw segment, then the fallback', () => {
    // decodePanelSegment('%') can't decode, so it hands parseRoute the raw '%',
    // which is an unrecognized path → the sessionList fallback. No URIError.
    expect(parsePanelStack('#/stack/%')).toEqual([
      { view: 'sessionList', expandMeters: false },
    ]);
  });
});

// ── ASSERTION 6: an empty stack builds to '' (defined, not a throw) ──────────

describe('buildPanelStackHash of an empty stack', () => {
  it("is '' (home) — defined for totality, never a throw, and it round-trips", () => {
    expect(buildPanelStackHash([])).toBe('');
    // '' parses back to the sessionList fallback — a length-1 stack, so the
    // degenerate empty input recovers into a valid one.
    expect(parsePanelStack(buildPanelStackHash([]))).toEqual([
      { view: 'sessionList', expandMeters: false },
    ]);
  });
});

// ── ASSERTION 7: the home / empty edge ──────────────────────────────────────

describe('the home panel is the empty string, both directions', () => {
  it("[sessionList,false] builds to '' and '' parses to [sessionList,false]", () => {
    expect(buildPanelStackHash([{ view: 'sessionList', expandMeters: false }])).toBe('');
    expect(parsePanelStack('')).toEqual([{ view: 'sessionList', expandMeters: false }]);
  });
});

// ── ASSERTION 8: no buildHash output can be mistaken for the stack marker ────

describe('no single-panel hash starts with the reserved `#/stack/` marker', () => {
  it('every buildHash output avoids the marker, so single vs multi is unambiguous', () => {
    // If any route built to `#/stack/…`, a single panel could be misread as a
    // stack. None can — there is no `/stack` route — and this pins that fact.
    for (const route of ROUND_TRIPPABLE_ROUTES) {
      const hash = buildHash(route);
      expect(hash.startsWith('#/stack/')).toBe(false);
      expect(hash.startsWith('/stack/')).toBe(false);
    }
  });
});
