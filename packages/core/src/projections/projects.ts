import { sep } from 'node:path';
import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord, ProjectRecord } from '../schemas.js';
import type { Projection } from './projection.js';
import {
  EVENT_TYPES,
  projectArchivedPayloadSchema,
  projectCreatedPayloadSchema,
  projectUpdatedPayloadSchema,
} from '../events.js';

// ─── S8·1 — the project registry projection (PURE, packages/core) ────────────
//
// D42's declared boundaries, folded from the 'projects' stream. A project is a
// directory a HUMAN picked; nothing here infers one (D37), and no project state is
// written anywhere but the log (I12) — this is the only place it is READ back into
// a shape the picker, the writer or `projectForCwd` can look at.
//
// STREAM-LOCAL (D34, architecture.md): this fold consumes ONLY 'projects' events.
// Attribution — "which project does this cwd belong to?" — is deliberately NOT a
// cross-stream fold that watches sessions or cost rows go by; it is the pure
// read-time derivation at the bottom of this file, computed on demand from cwd.
// That is exactly what makes declaring a project retroactively scope all of its
// history for free, with no backfill and no migration (D42's payoff).

export interface ProjectsState {
  projects: Record<string, ProjectRecord>;
}

// Immutably replace one project; a no-op when the project is unknown (log is
// truth, nothing throws — updates for projects we never saw created are ignored
// and never fabricate a record). Mirrors `withInstance` in projections/instances.ts.
function withProject(
  state: ProjectsState,
  projectId: string,
  update: (project: ProjectRecord) => ProjectRecord,
): ProjectsState {
  const existingProject = state.projects[projectId];
  if (existingProject === undefined) {
    return state;
  }
  return {
    projects: { ...state.projects, [projectId]: update(existingProject) },
  };
}

export const projectsProjection: Projection<ProjectsState> = {
  id: 'projects',

  init(): ProjectsState {
    return { projects: {} };
  },

  // TOTAL: unknown event types are no-ops; events for unknown projects are
  // no-ops; a malformed payload is a no-op. Nothing throws (I8's spirit — hostile
  // input must not crash a fold). PURE: `state` is never mutated, because
  // snapshots share references with live state and boot replays a snapshot
  // forward.
  apply(state: ProjectsState, event: EventRecord): ProjectsState {
    switch (event.type) {
      case EVENT_TYPES.projectCreated: {
        const parsed = projectCreatedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        if (state.projects[payload.projectId] !== undefined) {
          // Duplicate creation is a no-op — never clobber an existing record.
          // Replay safety: a re-delivered or re-appended birth record must not
          // un-archive a project or reset metadata it has since been given.
          return state;
        }
        const bornProject: ProjectRecord = {
          projectId: payload.projectId,
          root: payload.root,
          // ⚠ SPREAD RATHER THAN DEFAULTED, and the difference is the point.
          // `archived` below folds to a documented starting value because every
          // project HAS an archived-ness; `name`/`description` have no such
          // neutral value — `''` is a name someone chose, and D42's basename
          // fallback is a READ-TIME derivation that must never be stored (see
          // `projectRecordSchema`). Absent stays absent: a birth record with no
          // name folds to a record with NO name key, and the picker falls back
          // to the directory basename rather than rendering a blank row.
          ...(payload.name === undefined ? {} : { name: payload.name }),
          ...(payload.description === undefined ? {} : { description: payload.description }),
          // A CREATED project is LIVE. The birth record does not carry this — it
          // is the schema's documented starting value, filled in here rather than
          // in the event, so the event stays a statement of intent and the
          // projection owns the record shape (the same division `task_created`
          // draws for `manualReviewRequired` / `sessionRefs`).
          archived: false,
        };
        return { projects: { ...state.projects, [payload.projectId]: bornProject } };
      }

      case EVENT_TYPES.projectUpdated: {
        const parsed = projectUpdatedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // Unknown project → no-op (I8 totality): an update for a projectId no
        // `project_created` ever introduced must never fabricate a record.
        //
        // PATCH SEMANTICS, field by field, identical to `work_order_amended`'s
        // fold: **present in the payload → REPLACES the record's field; absent →
        // the record's field is left exactly as it was.** A rename that omits the
        // description leaves the description untouched.
        //
        // ⚠ THE WRITER OMITS ABSENT FIELDS RATHER THAN SENDING `undefined` FOR
        // THEM, and that is what makes the distinction expressible at all: this
        // fold reads PRESENCE to decide what to replace, so an
        // `undefined`-valued key would be the difference between "leave the name
        // as it was" and "clear it".
        //
        // ⚠ `root` is not patchable — it is not on the payload at all. See
        // `projectUpdatedPayloadSchema`: a different directory is a different
        // project, and moving a boundary would silently re-attribute every
        // session and cost row that ever sat under the old prefix.
        return withProject(state, payload.projectId, (project) => ({
          // I12: a NEW record by spread — the previous one is never mutated in
          // place, because snapshots share references with live state.
          ...project,
          ...(payload.name === undefined ? {} : { name: payload.name }),
          ...(payload.description === undefined ? {} : { description: payload.description }),
        }));
      }

      case EVENT_TYPES.projectArchived: {
        const parsed = projectArchivedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) {
          return state;
        }
        const payload = parsed.data;
        // ⚠ **THE RECORD STAYS IN THE MAP.** Archiving raises a flag; it does not
        // delete. D42's lifecycle is created → optionally initialized →
        // optionally archived, and nothing is ever removed from an append-only
        // log (I12) — but the reason this matters to the PROJECTION is
        // attribution: a cost row or a session from last month still sits under
        // the archived root, and dropping the record would make that history
        // un-attributable the instant somebody tidied up. `projectForCwd` skips
        // archived projects when matching a LIVE cwd; every other reader still
        // sees the record, flag and all.
        //
        // Naturally idempotent: folding the same archival twice writes `true`
        // twice, leaving no accumulating trace (the writer refuses the second
        // one anyway, honestly — see `ProjectWriter.archiveProject`).
        return withProject(state, payload.projectId, (project) => ({
          ...project,
          archived: true,
        }));
      }

      // ── deliberately NOT folded ────────────────────────────────────────────
      //
      // `project_initialized` — RESERVED (rule 0.5, D42), for the onboarding hook
      //   in `design-directions.md` → "Project onboarding". NOTHING EMITS IT and
      //   nothing folds it: the record has no field it would set, and inventing
      //   one here would be building half a workflow nobody asked for yet. When
      //   the hook lands it brings its own record shape, in its own diff.
      //
      // ...along with every other event type, which does not change a
      // ProjectRecord.
      default:
        return state;
    }
  },

  serialize(state: ProjectsState): string {
    // canonicalJson sorts keys deeply, so the `projects` Record's INSERTION order
    // cannot leak into the bytes. Never hand-roll the ordering here.
    return canonicalJson(state);
  },
};

// ─── the attribution primitive (D42's payoff) ────────────────────────────────
//
// ⚠ **THIS FUNCTION IS THE ONLY ATTRIBUTION AUTHORITY IN VIMES.** Every consumer
// that needs "which project does this directory belong to?" — the picker, the
// scoped session list, the scoped cost ledger — calls THIS. Nobody re-derives
// prefix matching locally: a second implementation is a second opinion, and the
// day one of them gets the segment-boundary rule below wrong is the day two
// surfaces disagree about what a project contains (principle 9).
//
// PURE and TOTAL: no clock, no I/O, no fs probe, no realpath. It compares the
// strings it is given. Canonicalization is the CALLER's job and happens once, at
// declaration time — `projectApi.ts` resolves a root through `resolveWithinRoots`
// before it is ever written — so what is stored is already canonical and this
// function never has to guess.
//
// LONGEST-PREFIX-WINS over NON-ARCHIVED projects (D42: "overlap →
// longest-prefix-wins"). Nesting is a FEATURE, not an error: a user may declare
// both `~/projects` and `~/projects/vimes`, and a cwd inside vimes belongs to
// vimes — the most specific declared boundary is the one that means something.
//
// ARCHIVED PROJECTS ARE SKIPPED. Archiving is how a boundary stops claiming live
// work; the record stays in the map (history readers still resolve it by id), but
// it no longer competes for a cwd. That is also what frees the root: a later
// declaration of the same directory mints a NEW projectId and wins the match,
// with no ambiguity about which of the two owns the cwd.
//
// TIES CANNOT OCCUR. Two live projects with the SAME root would both match at the
// same length, and the winner would depend on `Object.values` order — which is
// exactly why `ProjectWriter.createProject` refuses an exact-match live root
// (`duplicate-root`, nothing emitted) rather than leaving the ambiguity for this
// function to break arbitrarily.
export function projectForCwd(state: ProjectsState, cwd: string): ProjectRecord | null {
  let deepestMatch: ProjectRecord | null = null;
  for (const project of Object.values(state.projects)) {
    if (project.archived) {
      continue;
    }
    if (!isWithinProjectRoot(cwd, project.root)) {
      continue;
    }
    if (deepestMatch === null || project.root.length > deepestMatch.root.length) {
      deepestMatch = project;
    }
  }
  return deepestMatch;
}

// ⚠ **PATH-SEGMENT-AWARE, AND THIS IS THE LOAD-BEARING LINE.** A bare
// `cwd.startsWith(root)` would attribute `~/projects/vimes-2` to the project
// `~/projects/vimes` — a sibling directory silently swallowed by its neighbour's
// boundary, taking its sessions and its costs with it. The `root + sep` guard
// makes the boundary EXACT: a cwd matches only when it IS the root or sits
// strictly beneath it, on a segment boundary.
//
// This is the same guard `isWithinRoot` in packages/daemon/src/filePaths.ts uses
// for the file-API threat wall, deliberately spelled the same way, because it is
// the same mistake in two places and both are worth being obvious about. `sep`
// comes from node:path rather than a hard-coded '/' for the same reason the
// daemon's does — it is a pure constant, not I/O, so rule 0.3 has nothing to say
// about it.
// EXPORTED by S8·3 so the orchestrator's board scoping asks THIS question rather
// than spelling a second `startsWith` (principle 9 — one containment rule, not two).
export function isWithinProjectRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root + sep);
}
