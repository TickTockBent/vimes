// ─── S8·2 — the project context, as pure functions (D61 + D42) ───────────────
//
// D61 put the PROJECT IN THE PATH and left the HASH to the view stack:
//
//   vimes.wshoffner.dev/                            → the picker (D42's landing)
//   vimes.wshoffner.dev/infrastructure/johnny/      → that project, last layout
//   vimes.wshoffner.dev/infrastructure/johnny/#/session/x  → a deep link in it
//
// Everything that turns a URL into a project — and a project into a scope — lives
// here, as pure functions with no Vue, no DOM, no `window`, no localStorage and no
// fetch. The store and App.vue own every side effect (reading location, writing
// storage, navigating); this module only maps values to decisions, the same split
// lib/route.ts drew for hash routing and for the same reason: `.vue` files are not
// tested here, so the app's navigation must not live in one.
//
// TOTALITY (I8). Nothing here throws, for any input: empty, malformed, hostile,
// percent-encoded, or 10 KB long.

// One project as the picker sees it — the daemon's `ProjectListEntry`
// (packages/daemon/src/projectApi.ts), reflected rather than imported, because
// `@vimes/core` and the daemon's types are deliberate non-dependencies of this
// package (see lib/taskBoard.ts, which reflects TaskRecord the same way).
export interface ProjectView {
  readonly projectId: string;
  readonly root: string;
  readonly name?: string;
  readonly description?: string;
  readonly archived: boolean;
  // The URL segment for this project, DERIVED server-side from the configured
  // roots. `''` when the project IS a configured root (declaring `~/projects`
  // itself is legal, D42 nesting) and `null` when it sits under no root at all —
  // neither is URL-addressable, and both are reachable through the picker only.
  readonly pathSegment: string | null;
}

// ── the path → segment parse ────────────────────────────────────────────────

// `location.pathname` → the project segment, or null for "no project named".
//
// TOTAL AND SUSPICIOUS, in that order. The daemon never trusts a segment (every
// declaration re-resolves its root against the configured roots server-side), but
// this function's OUTPUT is used to build URLs and to prefill a path, so it must
// never emit something with a `..` in it. Hostile input either normalizes away or
// resolves to null; there is no third outcome.
export function parseProjectPath(pathname: string): string | null {
  // A pathname should carry neither, but a caller may hand us a whole URL tail.
  const withoutQuery = pathname.split('?')[0]!.split('#')[0]!;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(withoutQuery);
  } catch {
    // A malformed escape ('%', '%zz') is not a project — and unlike route.ts's
    // session id, degrading to the RAW segment would be worse than useless here:
    // it could still contain the very `%2e%2e` we are decoding to catch.
    return null;
  }

  const segments: string[] = [];
  for (const rawSegment of decodedPath.split('/')) {
    if (rawSegment === '' || rawSegment === '.') {
      // Empty (a leading/trailing/doubled slash) and '.' are noise — dropped, so
      // `//infra//johnny/` normalizes to `infra/johnny` rather than failing.
      continue;
    }
    if (rawSegment === '..') {
      // NEVER normalized by climbing. Resolving `a/../b` to `b` would make two
      // different URLs the same project and hand an attacker a way to write a
      // path that reads as one thing and resolves as another.
      return null;
    }
    segments.push(rawSegment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

// ── segment → project ───────────────────────────────────────────────────────

// Resolve a URL segment against the DECLARED registry (D42 — never inferred).
// ARCHIVED PROJECTS DO NOT MATCH: archiving is how a boundary stops claiming
// live work, and a URL that still opened one would be a scope nobody expects.
// Null → the caller shows the picker (bare, or in declare-prefill mode).
export function resolveProject(
  segment: string | null,
  projects: readonly ProjectView[],
): ProjectView | null {
  if (segment === null || segment === '') {
    return null;
  }
  for (const project of projects) {
    if (!project.archived && project.pathSegment === segment) {
      return project;
    }
  }
  return null;
}

// The absolute root a "declare this?" form pre-fills when a URL names a segment
// no project claims — D61's onboarding door: the URL itself proposes the
// declaration. FIRST base only; VIMES runs one configured root today (D21), and
// guessing which of several the human meant is a decision, not a default.
//
// ⚠ THIS IS A PREFILL, NOT AN AUTHORIZATION. The composed path is a suggestion in
// a text box; POST /api/projects re-resolves it against the configured roots
// server-side (D60), so a hand-edited value is refused there, not here.
export function declarePrefill(
  segment: string | null,
  rootsBases: readonly string[],
): string | null {
  const firstBase = rootsBases[0];
  if (segment === null || segment === '' || firstBase === undefined || firstBase === '') {
    return null;
  }
  return firstBase.endsWith('/') ? `${firstBase}${segment}` : `${firstBase}/${segment}`;
}

// ── the declare answer, as a sentence ───────────────────────────────────────

export type DeclareOutcome =
  | { kind: 'declared'; sentence: string }
  | { kind: 'refused'; sentence: string };

// Turn POST /api/projects' VERBATIM status+body into something a human reads.
// The sibling of `describeCreateResponse` in lib/taskBoard.ts, and total in the
// same way: an unrecognized status is reported honestly with its number rather
// than collapsed into a generic failure.
//
// ⚠ THE STATUS IS THE VERDICT. Nothing here re-decides whether the declaration
// happened — the daemon already did, and a 403 is D60's fence speaking (see
// projectApi.ts). Status 0 is `postTaskApi`'s "the request never reached the
// daemon", which must never read as a refusal the daemon made.
export function describeDeclareResponse(status: number, body: unknown): DeclareOutcome {
  const detail = readStringField(body, 'detail');
  switch (status) {
    case 200:
      return { kind: 'declared', sentence: 'Project declared.' };
    case 400:
      return {
        kind: 'refused',
        sentence:
          detail === 'no-such-directory'
            ? 'No such directory — a project boundary has to be a directory that exists.'
            : detail === 'not-a-directory'
              ? 'That path is a file, not a directory.'
              : 'That was not a declaration the daemon could read.',
      };
    case 403:
      // D60/D21: the roots are the fence, and widening it is an /etc/vimes/env
      // edit plus a restart — deliberately NOT something this form can do.
      return {
        kind: 'refused',
        sentence: 'Outside the configured project roots — VIMES will not declare a project there.',
      };
    case 409:
      return { kind: 'refused', sentence: 'That directory is already a project.' };
    case 0:
      return { kind: 'refused', sentence: 'The request never reached the daemon — nothing was declared.' };
    default:
      return { kind: 'refused', sentence: `The daemon answered ${status}; nothing was declared.` };
  }
}

function readStringField(body: unknown, field: string): string | null {
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

// ── the scoping predicate ───────────────────────────────────────────────────

// ⚠⚠ **THIS IS A MIRROR OF CORE'S ATTRIBUTION AUTHORITY, NOT A SECOND OPINION.**
//
// `projectForCwd` / `isWithinProjectRoot` in
// `packages/core/src/projections/projects.ts` is THE only authority on "which
// project does this directory belong to?" — its own comment says so, and it means
// it. This function answers the same question in the browser, for one project at
// a time, because `@vimes/core` is a deliberate non-dependency of `packages/ui`
// (it is a node package: `node:path`, the event store, zod 3) and there is no
// import that would make this file unnecessary.
//
// THE PRECEDENT FOR EXISTING AT ALL is `taskApi.ts`'s THIRD MIRROR of the stage
// vocabulary (`TASK_STAGE_VALUES`, and its own copy in lib/taskBoard.ts): where a
// cross-package import is impossible, the repo re-declares and then BINDS THE
// COPIES WITH A TEST rather than pretending the copy is not a copy. The daemon
// binds its mirror at the type level (`exhaustiveVocabulary`); a predicate has no
// type-level binding available, so the binding here is the TRAP TEST — the
// identical `.../vimes` vs `.../vimes-2` case that core's own comment names as
// the load-bearing line, pinned in projectContext.test.ts against BOTH
// implementations' shared rule.
//
// ⚠ IF THE RULE IN CORE CHANGES, CHANGE IT HERE IN THE SAME DIFF. There is no
// build that will catch the drift for you. Nothing in this unit edits the core
// file; the authority stays where it is.
//
// SEGMENT-BOUNDARY-AWARE, and that is the whole content: a bare
// `cwd.startsWith(root)` attributes `~/projects/vimes-2` to `~/projects/vimes` —
// a sibling directory swallowed by its neighbour's boundary, taking its sessions
// and its costs with it. Core spells the guard with node's `sep`; this file
// hard-codes '/' because there is no `node:path` in a browser and VIMES's daemon,
// roots, and every cwd it has ever seen are POSIX (D21's `~/projects`).
export function cwdWithinProject(cwd: string, projectRoot: string): boolean {
  if (cwd === '' || projectRoot === '') {
    return false;
  }
  return cwd === projectRoot || cwd.startsWith(`${projectRoot}/`);
}

// ── display ─────────────────────────────────────────────────────────────────

// D42's name fallback, DERIVED HERE and never stored: "absent a name, the
// directory basename is the name". The record deliberately carries no name key
// when none was given (projectApi.ts / the birth record), precisely so that
// "unnamed" and "named after its folder" stay distinguishable in the log while
// reading identically on screen.
//
// NEVER BLANK — the last resort is the root itself, because a picker row with no
// text is a row nobody can tap on purpose.
export function projectDisplayName(project: ProjectView): string {
  const declaredName = project.name?.trim() ?? '';
  if (declaredName !== '') {
    return declaredName;
  }
  const trimmedRoot = project.root.replace(/\/+$/, '');
  const basename = trimmedRoot.slice(trimmedRoot.lastIndexOf('/') + 1);
  return basename === '' ? project.root : basename;
}

// ── last-layout memory (D61's third leg) ────────────────────────────────────

// One key per project: opening johnny restores johnny's panel stack, not the last
// stack anyone had anywhere. Keyed on the projectId, not the segment — a project
// renamed or re-declared under a different path keeps (or correctly loses) its own
// memory rather than inheriting a stranger's.
export function layoutStorageKey(projectId: string): string {
  return `vimes:layout:${projectId}`;
}

// The hash to open a project at. Three-way, in this order (D61):
//
//   1. **A PRESENT LOCATION HASH ALWAYS WINS.** A deep link is an explicit
//      instruction — someone shared `/infrastructure/johnny/#/session/x`, or a
//      push notification pointed there. Overriding it with a remembered layout
//      would make the app ignore the URL it was just handed.
//   2. The remembered layout for this project, if there is one.
//   3. The default view — the empty hash, which is what "go home" has always
//      written (see buildHash's sessionList case).
//
// A stored value that is not a hash is IGNORED rather than applied: storage is
// user-writable, and `location.hash = <junk>` is a navigation. `'#'` alone is not
// a layout either — it is what a bare fragment leaves behind.
export function initialHashFor(locationHash: string, storedLayout: string | null): string {
  if (locationHash !== '' && locationHash !== '#') {
    return locationHash;
  }
  if (storedLayout !== null && storedLayout.startsWith('#') && storedLayout !== '#') {
    return storedLayout;
  }
  return '';
}
