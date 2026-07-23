// The app's routing, extracted from App.vue (desktop phase 1, 2026-07-23). Pure:
// no Vue, no DOM, no `window`, no clock, no locale — every branch is unit-tested
// without a browser (route.test.ts), the same split as lib/gitReview.ts and
// lib/costDisplay.ts. App.vue keeps ownership of `window.location.hash` and the
// `hashchange` listener; this module only maps a string to a decision and back.
//
// WHY THIS EXISTS AT ALL. Routing was inline in a `.vue`, and `.vue` files are
// not tested here — so the app's navigation, the thing every screen depends on,
// was its only untested logic. Extracting it changes no behaviour; it makes the
// behaviour assertable. (docs/design-directions.md, "The retrofit, scoped".)
//
// TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
//
//   1. **A route names a view AND its props.** Route → view is NOT 1:1: `#/` and
//      `#/meters` render the SAME SessionListView and differ only in
//      `expandMeters`. A model keyed on a view name alone loses that silently.
//   2. **Precedence is data, not template order.** It used to live in the order
//      of App.vue's `v-if` / `v-else-if` chain, where a reordering during an
//      unrelated edit would change behaviour with nothing to catch it. It is now
//      `ROUTE_RULES`, and `ROUTE_PRECEDENCE` is `.map()`-derived from that same
//      array, so the exported order cannot drift from the resolved order.
//
// TOTALITY (I8). `parseRoute` never throws, for any input: empty, malformed,
// unknown, hostile, or 10 KB long. Everything unrecognized lands on the same
// SessionListView fallback the app has always shown.
//
// EVERY QUIRK BELOW IS DELIBERATE. This module was written against a
// characterization table taken from App.vue BEFORE it was touched; where the old
// code was surprising (`Number('')` is line 0, `+` decodes to a space, an empty
// `path` still opens the editor), the surprise is preserved and commented, not
// repaired. Fixing a quirk here would be a behaviour change wearing a refactor's
// clothes.

// ── the route model ─────────────────────────────────────────────────────────

export type RouteView =
  | 'editor'
  | 'fileTree'
  | 'search'
  | 'terminal'
  | 'git'
  | 'cost'
  | 'tasks'
  | 'stream'
  | 'sessionList';

// `#/files?path=…` — the CM6 editor on one file.
export interface EditorRoute {
  view: 'editor';
  path: string;
  // Absent or unparseable → undefined, and EditorView opens at the top.
  line: number | undefined;
  // The RAW `returnTo` param, deliberately un-interpreted. The whitelist that
  // decides where "back" lands is `decideEditorReturn` in lib/gitReview.ts — it
  // has its own tests and its own semantics, and folding it in here would give
  // this module an opinion about git that it has no business holding.
  returnToParam: string | null;
}

// `#/files` — the file tree.
export interface FileTreeRoute {
  view: 'fileTree';
  // The `dir` param, set when returning from the editor. null → the tree opens
  // at its first root.
  initialDir: string | null;
}

export interface SearchRoute {
  view: 'search';
}
export interface TerminalRoute {
  view: 'terminal';
}
export interface GitRoute {
  view: 'git';
}
export interface CostRoute {
  view: 'cost';
}
export interface TasksRoute {
  view: 'tasks';
}

// `#/session/<id>` — one session's stream.
export interface StreamRoute {
  view: 'stream';
  appSessionId: string;
}

// Everything else. `expandMeters` is why this is not just a view name: `#/meters`
// is the deep-link target of the threshold-notification push and arrives with the
// meters strip already open, while `#/` shows the same view collapsed.
export interface SessionListRoute {
  view: 'sessionList';
  expandMeters: boolean;
}

export type Route =
  | EditorRoute
  | FileTreeRoute
  | SearchRoute
  | TerminalRoute
  | GitRoute
  | CostRoute
  | TasksRoute
  | StreamRoute
  | SessionListRoute;

// ── parsing ─────────────────────────────────────────────────────────────────

// A hash split into its path and its query. Internal: nothing outside this module
// should need to think in terms of raw params again.
interface SplitHash {
  routePath: string;
  params: URLSearchParams;
}

// Format: `#/files?path=/a/b&line=3`. The leading '#' is optional — location.hash
// always supplies one, but a caller that strips it gets the same answer.
function splitHash(hash: string): SplitHash {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const questionIndex = raw.indexOf('?');
  const routePath = questionIndex >= 0 ? raw.slice(0, questionIndex) : raw;
  // URLSearchParams is deliberately lenient: duplicate keys resolve to the first
  // via `.get()`, a lone '%' survives as '%', and '+' decodes to a space. All
  // three are pre-existing behaviour and all three are pinned in route.test.ts.
  const params = new URLSearchParams(questionIndex >= 0 ? raw.slice(questionIndex + 1) : '');
  return { routePath, params };
}

// `Number()` is what the old code used, and it is looser than it looks: '' is 0,
// '0x10' is 16, ' 7 ' is 7, and '1e3' is 1000. Only NaN and the infinities are
// rejected. Kept exactly — a stricter parse would reject line numbers that work
// in the deployed app today.
function parseLineParam(lineParam: string | null): number | undefined {
  if (lineParam === null) {
    return undefined;
  }
  const parsedLine = Number(lineParam);
  return Number.isFinite(parsedLine) ? parsedLine : undefined;
}

// `decodeURIComponent` THROWS on a malformed escape ('%', '%zz'), and in App.vue
// that threw during render — `#/session/%` crashed the app. Totality (I8) forbids
// that here, so a malformed id degrades to the raw, undecoded segment: the route
// is still recognized as a session route, and only the id's decoding is lost.
// This is the ONE deliberate divergence from pre-refactor behaviour in this
// module, and it replaces a crash with a session that simply will not be found.
function decodeSessionSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const SESSION_PATH_PATTERN = /^\/session\/(.+)$/;

// A precedence branch: the view it can produce, and the props it derives when it
// claims the hash. Returning null means "not mine, try the next one".
interface RouteRule {
  readonly view: RouteView;
  readonly match: (split: SplitHash) => Route | null;
}

// ⚠ ORDER IS BEHAVIOUR. This is App.vue's old v-if / v-else-if chain, top to
// bottom. Two orderings in here are load-bearing:
//
//   • the editor before the file tree — both answer to `/files`, and the editor
//     claims it whenever a `path` param is present; and
//   • the session route below every panel route, and the session list below
//     everything, as the total fallback.
//
// Swapping any two entries reddens route.test.ts (both the precedence assertion
// and the overlap cases). That is the point: this list is the contract.
const ROUTE_RULES: readonly RouteRule[] = [
  {
    view: 'editor',
    match: ({ routePath, params }) => {
      if (routePath !== '/files') {
        return null;
      }
      const path = params.get('path');
      // QUIRK, PRESERVED: the test is `path === null`, not `path === ''`. So
      // `#/files?path=` opens the editor on the empty path rather than the tree.
      if (path === null) {
        return null;
      }
      return {
        view: 'editor',
        path,
        line: parseLineParam(params.get('line')),
        returnToParam: params.get('returnTo'),
      };
    },
  },
  {
    view: 'fileTree',
    match: ({ routePath, params }) =>
      routePath === '/files' ? { view: 'fileTree', initialDir: params.get('dir') } : null,
  },
  {
    view: 'search',
    match: ({ routePath }) => (routePath === '/search' ? { view: 'search' } : null),
  },
  {
    view: 'terminal',
    match: ({ routePath }) => (routePath === '/terminal' ? { view: 'terminal' } : null),
  },
  {
    view: 'git',
    match: ({ routePath }) => (routePath === '/git' ? { view: 'git' } : null),
  },
  {
    view: 'cost',
    match: ({ routePath }) => (routePath === '/cost' ? { view: 'cost' } : null),
  },
  {
    view: 'tasks',
    match: ({ routePath }) => (routePath === '/tasks' ? { view: 'tasks' } : null),
  },
  {
    view: 'stream',
    match: ({ routePath }) => {
      const sessionMatch = SESSION_PATH_PATTERN.exec(routePath);
      const sessionSegment = sessionMatch?.[1];
      // QUIRK, PRESERVED: `(.+)` is greedy and crosses slashes, so
      // `#/session/a/b` is the session 'a/b'. And `#/session/` (nothing after the
      // slash) does not match at all — it falls through to the session list.
      if (sessionSegment === undefined || sessionSegment === '') {
        return null;
      }
      const appSessionId = decodeSessionSegment(sessionSegment);
      // The old chain tested `v-else-if="activeSessionId"` — a TRUTHINESS test,
      // so an id that decoded to '' would have fallen through. No encoding
      // produces an empty decode, but the branch is mirrored rather than
      // "cleaned up", because this file's job is to be identical, not tidy.
      return appSessionId === '' ? null : { view: 'stream', appSessionId };
    },
  },
  {
    // The total fallback: this rule matches everything, which is what makes
    // `parseRoute` total.
    view: 'sessionList',
    match: ({ routePath }) => ({ view: 'sessionList', expandMeters: routePath === '/meters' }),
  },
];

// The precedence order, derived from the rules that actually resolve the route so
// the two cannot disagree. Exported so a test can hold the order itself, not just
// its consequences.
export const ROUTE_PRECEDENCE: readonly RouteView[] = ROUTE_RULES.map((rule) => rule.view);

// Total (I8): every input resolves, nothing throws.
export function parseRoute(hash: string): Route {
  const split = splitHash(hash);
  for (const rule of ROUTE_RULES) {
    const matched = rule.match(split);
    if (matched !== null) {
      return matched;
    }
  }
  // Unreachable — the last rule matches everything. Present because the compiler
  // cannot know that, and a silent `undefined` would be worse than a redundant
  // literal.
  return { view: 'sessionList', expandMeters: false };
}

// ── building ────────────────────────────────────────────────────────────────

// The inverse of `parseRoute`, byte-for-byte identical to the `navigate*` builders
// App.vue used to carry. `parseRoute(buildHash(route))` returns `route` for every
// route this can express.
//
// ⚠ THE TWO `/files` FORMS ENCODE DIFFERENTLY, AND THAT IS PRESERVED. The editor
// goes through `URLSearchParams.toString()` (a space becomes '+'); the tree's
// `dir` goes through `encodeURIComponent` (a space becomes '%20'). Both decode
// back to the same string, so nothing depends on the difference — but the emitted
// hash is what a user sees, bookmarks and pastes, so it is kept as it was.
export function buildHash(route: Route): string {
  switch (route.view) {
    case 'editor': {
      // Param order is part of the output: path, then line, then returnTo.
      const params = new URLSearchParams({ path: route.path });
      if (route.line !== undefined) {
        params.set('line', String(route.line));
      }
      if (route.returnToParam !== null) {
        params.set('returnTo', route.returnToParam);
      }
      return `#/files?${params.toString()}`;
    }
    case 'fileTree':
      // QUIRK, PRESERVED: an empty `initialDir` emits a bare `#/files`, exactly
      // as `navigateToFiles('')` did. So `{ initialDir: '' }` is the one route
      // shape that does NOT survive a round trip — it comes back as null. That
      // asymmetry is old behaviour, and it is asserted rather than smoothed over.
      return route.initialDir !== null && route.initialDir.length > 0
        ? `#/files?dir=${encodeURIComponent(route.initialDir)}`
        : '#/files';
    case 'search':
      return '#/search';
    case 'terminal':
      return '#/terminal';
    case 'git':
      return '#/git';
    case 'cost':
      return '#/cost';
    case 'tasks':
      return '#/tasks';
    case 'stream':
      return `#/session/${encodeURIComponent(route.appSessionId)}`;
    case 'sessionList':
      // Home is the EMPTY string, not '#/': assigning '' to location.hash clears
      // the fragment, which is what "go home" has always produced.
      return route.expandMeters ? '#/meters' : '';
  }
}
