// The panel STACK, layered over lib/route.ts (desktop phase 2, 2026-07-23). This
// is route.ts's sibling: same posture (pure, no Vue/DOM/window/clock), same
// totality law (I8 — never throws, for any input), same voice (name the quirks,
// name why the encoding is shaped as it is). It lifts "the app is at ONE route"
// to "the app is a STACK of routes (panels)" — D39's panel model — WITHOUT
// changing any URL that works today.
//
// WHY A SEPARATE LAYER, AND WHY IT MAY NOT TOUCH route.ts. Phase 1 pinned
// parseRoute/buildHash with a characterization table taken from pre-refactor
// App.vue. Those are the SINGLE-PANEL primitives, finished and load-bearing; this
// module CALLS and WRAPS them and never re-implements them. A panel is exactly a
// Route here (D39): a richer Panel object (focus, stable id) is phase 3+4's
// concern if it needs one, so phase 2 keeps the type honest — a stack is a list
// of routes.
//
// THE ONE INVARIANT THE WHOLE RETROFIT RESTS ON. `buildPanelStackHash([route])`
// returns EXACTLY `buildHash(route)` — byte-identical, down to the empty string
// for home and every `/files` quirk. So today's URLs, bookmarks, and the
// deep-link push target (`#/meters`, `#/session/x`) are unchanged, and a hash
// with no stack marker parses to `[parseRoute(hash)]`. Multi-panel is the ONLY
// thing that looks new, and it hides behind a reserved marker that a
// single-panel URL can never wear.

import { buildHash, parseRoute, type Route } from './route.js';

// A panel holds exactly one route (D39). ALWAYS length >= 1 after a parse — the
// app is never "at no panel", and every parse below guarantees it structurally
// (see parsePanelStack). Phase 2 keeps `panel === Route`; phase 3+4 may enrich it.
export type PanelStack = readonly Route[];

// The reserved marker for a multi-panel hash. `#/stack/` can NEVER collide with a
// single-panel URL: there is no `/stack` rule in route.ts's ROUTE_RULES (a
// `#/stack/...` URL parses to the sessionList fallback TODAY, so reserving it is
// purely additive — nothing real changes), and no `buildHash` output starts with
// it (asserted in the test). Detection strips the optional leading '#' first,
// exactly as route.ts's splitHash does, so `/stack/...` (no '#') is recognized too.
const STACK_HASH_PREFIX = '#/stack/';
const STACK_PATH_PREFIX = '/stack/';

// decodeURIComponent THROWS on a malformed escape ('%', '%zz'). Totality (I8)
// forbids a throw, so a malformed panel segment degrades to its raw, undecoded
// form — the SAME posture route.ts takes in decodeSessionSegment. A junk segment
// then simply parseRoutes to the sessionList fallback; it never crashes a parse.
function decodePanelSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Total (I8): every input resolves to a stack of length >= 1, nothing throws.
export function parsePanelStack(hash: string): PanelStack {
  // Strip the optional leading '#' before testing for the marker — location.hash
  // always supplies one, but a caller that stripped it gets the same answer.
  const withoutLeadingHash = hash.startsWith('#') ? hash.slice(1) : hash;

  if (!withoutLeadingHash.startsWith(STACK_PATH_PREFIX)) {
    // TODAY'S WORLD, unchanged: no marker → exactly one panel, exactly the route
    // parseRoute would have resolved. parseRoute is total, so this branch is
    // total and its result is ALWAYS length 1. This is the byte-identical half of
    // the invariant, on the parse side.
    return [parseRoute(hash)];
  }

  // Multi-panel: split the remainder on '/'. Each panel's buildHash was
  // encodeURIComponent'd on the way out, so its own '/' and '#' are escaped and
  // cannot be mistaken for the '/' that joins panels — splitting is unambiguous.
  // `String.split` on any string (even '') yields at least one element, so the
  // result is ALWAYS length >= 1 — never an empty stack, even for a bare
  // `#/stack/` (which yields one empty segment → one sessionList fallback).
  const encodedPanels = withoutLeadingHash.slice(STACK_PATH_PREFIX.length).split('/');
  return encodedPanels.map((segment) => parseRoute(decodePanelSegment(segment)));
}

// The inverse of parsePanelStack. Total: never throws, for any stack.
export function buildPanelStackHash(stack: PanelStack): string {
  // An empty stack should never occur — every parse yields length >= 1, and no
  // caller produces one — but a total builder must still answer. '' is home: the
  // safest possible "nothing", and it round-trips (parsePanelStack('') is the
  // sessionList fallback), so a stray empty stack degrades gracefully, not into a
  // throw.
  if (stack.length === 0) {
    return '';
  }

  // THE INVARIANT: a single panel is byte-identical to today. Not
  // `#/stack/<enc(...)>` — literally buildHash(route). Every existing bookmark,
  // paste, and deep-link target is emitted exactly as it is now, including the
  // empty string for home and the two distinct `/files` encodings.
  if (stack.length === 1) {
    return buildHash(stack[0]!);
  }

  // Two or more panels: the reserved marker, then each panel's own buildHash,
  // encodeURIComponent'd (so its internal '/', '#', '?' survive as %2F/%23/%3F),
  // joined by the '/' that separates panels. An empty segment is fine — a home
  // panel builds to '', encodeURIComponent('') is '', and split preserves the
  // empty slot on the way back, so `[home, git]` round-trips through
  // `#/stack//%23%2Fgit`.
  return (
    STACK_HASH_PREFIX + stack.map((route) => encodeURIComponent(buildHash(route))).join('/')
  );
}

// ── mutation ops (phase 3) ───────────────────────────────────────────────────
//
// Three pure primitives the shell composes into navigation. Each returns a NEW
// PanelStack — never mutates its argument, same immutable posture as the parse/
// build pair above — and each preserves the length->=1 invariant PanelStack
// already promises. What they do NOT decide: how many panels the viewport
// RENDERS (that is lib/layoutMode.ts, a separate axis) or WHEN the shell should
// push vs replace (that policy lives in the shell unit, not here). The stack can
// hold more panels than are ever shown; these ops don't know or care.

// Append a panel. The stack grows by exactly one; the shell renders the
// trailing N of whatever this returns. An empty stack is structurally
// impossible (every parse guarantees length >= 1), but totality (I8) means this
// still has to answer rather than throw — pushing onto nothing is defined as
// starting a new one-panel stack, the same floor popPanel below rests on.
export function pushPanel(stack: PanelStack, route: Route): PanelStack {
  return [...stack, route];
}

// Drop the trailing panel ("back"). NEVER returns an empty stack: a length-1
// stack pops TO ITSELF, unchanged. This is the totality floor the whole panel
// model rests on — "the app is never at no panel" (mirrors parsePanelStack's
// own invariant) — so the shell can call this unconditionally on any "back"
// action without a guard for "is there anything left to pop".
export function popPanel(stack: PanelStack): PanelStack {
  if (stack.length <= 1) {
    return stack;
  }
  return stack.slice(0, -1);
}

// Replace the trailing panel's route in place; every earlier panel is
// untouched and the length does not change. On a length-1 stack this IS
// today's single-panel navigation (swap the one route) — nothing new, just the
// N=1 degenerate case of the general op. An empty stack again can't occur, but
// totality says: starting a fresh one-panel stack is the sane answer, same as
// pushPanel — there is no "top" to replace, so replace degrades to push.
export function replaceTopPanel(stack: PanelStack, route: Route): PanelStack {
  if (stack.length === 0) {
    return [route];
  }
  return [...stack.slice(0, -1), route];
}

// Open `route` as if navigating FROM the panel at `index`: everything AFTER
// that panel is discarded, then `route` is pushed. This is the shell's core
// navigation policy (phase 3+4) — clicking a session in the list (index 0) when
// the stack is [list, stream, editor] gives [list, stream], exactly like acting
// from a browser back-state replaces what was "forward" of it. Composed from the
// existing primitives, so it inherits their immutable, length->=1 posture.
//
// The index is CLAMPED for totality (I8): a negative index behaves as index 0
// (keep only the first panel, then push), an over-large index (>= length)
// behaves as the last panel (a plain pushPanel — nothing truncated). On the
// (structurally impossible) empty stack, `length - 1` is -1, so the clamp floors
// to 0, slice(0, 1) of [] is [], and pushPanel starts a fresh one-panel stack —
// the same floor pushPanel/popPanel rest on.
export function openPanelFrom(stack: PanelStack, index: number, route: Route): PanelStack {
  const clampedIndex = Math.max(0, Math.min(index, stack.length - 1));
  return pushPanel(stack.slice(0, clampedIndex + 1), route);
}
