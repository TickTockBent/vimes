import {
  projectArchived,
  projectCreated,
  projectUpdated,
  type EventInput,
  type IdSource,
  type ProjectRecord,
  type ProjectsState,
} from '@vimes/core';

// ─── S8·1 — the SOLE WRITER of project state (daemon I/O) ────────────────────
//
// D42's registry is event-sourced, and this class is the ONE place a
// `project_created`, a `project_updated` or a `project_archived` is written.
// Everything else — the REST API in this same unit, the picker that will call it
// (S8·2), any later onboarding workflow — is a CALLER of it.
//
// The shape is `taskWriter.ts`'s, deliberately and line for line: fresh
// projection reads per call, an injected id source, one emit per accepted
// operation, a read-back from the fold as the return value, and a discriminated
// union of outcomes so callers tell the cases apart WITHOUT inspecting HTTP
// semantics (the MCP surface and the picker both need that, and neither has
// status codes to branch on).
//
// ⚠ **VALIDATION OF THE ROOT ITSELF IS THE ROUTE'S JOB, NOT THIS CLASS'S.**
// `projectApi.ts` resolves the requested directory through `resolveWithinRoots`
// against the STATIC config roots (D60) and probes that it exists and is a
// directory BEFORE calling in here; this writer trusts the root it is handed, in
// exactly the division `taskApi.ts`/`taskWriter.ts` already draw for
// `projectRoot`. What this class DOES own is the registry's own consistency rules
// — one live declaration per directory, no metadata patch that changes nothing,
// no second archival of an already-archived project.
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()`. Every method runs to
// completion inside the call that invoked it, and the only non-determinism is the
// injected id source.

export interface ProjectWriterDeps {
  // The router's emit — the ONLY write path. Nothing here touches the store, a
  // snapshot or a projection object directly.
  emit: (events: EventInput[]) => void;
  // Projection reads, called FRESH on every call and never cached in a field. A
  // writer working from a stale registry is a writer that would re-declare a root
  // somebody just declared, or archive a project that is already archived
  // (mirrors `TaskWriterDeps.readTasks`).
  readProjects: () => ProjectsState;
  // INJECTED (rule 0.3). The only source of new projectIds; nothing here calls
  // randomUUID, so a test with a CountingIdSource gets byte-identical ids.
  ids: IdSource;
}

// What a DECLARER names. Deliberately NOT a `ProjectRecord`: `projectId` is
// minted here and `archived` is the projection's business — letting a caller
// supply either would let the API declare a project that was born archived, or
// mint a second record under an id that already exists.
export interface CreateProjectInput {
  // ALREADY RESOLVED AND ALLOW-LIST-CHECKED by the route (D60). What is persisted
  // is what was checked, so the record can never carry a `..` segment or a
  // symlink that resolves somewhere else later.
  readonly root: string;
  // OPTIONAL. Absent → the birth record carries NO `name` key at all (never
  // `''`), and D42's directory-basename fallback happens at READ time in the
  // picker. Same for `description`.
  readonly name?: string;
  readonly description?: string;
}

// The PATCH half of `CreateProjectInput`: the mutable metadata, every field
// optional. Deliberately NOT a `Partial<ProjectRecord>` — `root`, `projectId` and
// `archived` are not patchable through this door (a different directory is a
// different project, D42; archiving has its own method), and a `Partial` would
// quietly offer all three.
export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string;
}

// The outcome of ONE declaration.
export type CreateProjectResult =
  | { readonly outcome: 'created'; readonly project: ProjectRecord }
  // An EXACT-match LIVE root is already declared. Nothing emitted — a second
  // record for the same directory would give `projectForCwd` a tie it cannot
  // break, and every cwd under that root would attribute to whichever record
  // `Object.values` happened to yield first. The EXISTING projectId comes back so
  // the caller can point the human at the project they already have.
  //
  // ⚠ **NESTING IS NOT A DUPLICATE.** Declaring `~/projects/vimes` when
  // `~/projects` already exists is legal and expected — D42 makes overlap a
  // feature and resolves it with longest-prefix-wins. Only an exact match is
  // refused.
  | { readonly outcome: 'duplicate-root'; readonly projectId: string };

// The outcome of ONE metadata patch.
export type UpdateProjectResult =
  | { readonly outcome: 'updated'; readonly project: ProjectRecord }
  // Nothing emitted. There was no project to patch, and writing an update for a
  // projectId no `project_created` ever introduced would put a phantom project in
  // the log (the same posture `TaskWriter`'s `unknown-task` takes).
  | { readonly outcome: 'unknown-project'; readonly projectId: string }
  // Both patch fields absent. Nothing emitted: an update that changes nothing is
  // log noise, not an update — the `empty-amendment` precedent, exactly.
  | { readonly outcome: 'empty-update' };

// The outcome of ONE archival.
export type ArchiveProjectResult =
  | { readonly outcome: 'archived'; readonly project: ProjectRecord }
  | { readonly outcome: 'unknown-project'; readonly projectId: string }
  // ⚠ **IDEMPOTENCE REFUSED HONESTLY, AND NOTHING EMITTED.** Re-archiving would
  // fold to the identical record, so silently accepting it would be harmless to
  // the STATE and misleading in the LOG: a second `project_archived` says a human
  // archived the project twice, which is not what happened. The log is the audit
  // trail; it does not get told a thing occurred because the answer was
  // convenient.
  | { readonly outcome: 'already-archived'; readonly projectId: string };

// Thrown ONLY when the log and the projection disagree: an event was written and
// the fold did not produce the record it describes. That is a rule-0.1 finding
// (the log is the source of record, I12), not an input error — so it surfaces as
// a 500 with the finding in it rather than a plausible-looking 200. It is
// unreachable through any request shape; only a projection/event divergence
// produces it. The sibling of `TaskProjectionDisagreementError`.
export class ProjectProjectionDisagreementError extends Error {}

export class ProjectWriter {
  private readonly deps: ProjectWriterDeps;

  constructor(deps: ProjectWriterDeps) {
    this.deps = deps;
  }

  /**
   * Declare a project: mint an id, emit ONE `project_created`, and return the
   * record **as the projection folded it**.
   *
   * ⚠ The read-back is the point, not a formality (the same reasoning
   * `TaskWriter.createTask` states): returning a hand-built echo of the input
   * would make this method agree with itself by construction, where reading the
   * fold proves the log is the source of record (I12) and turns any
   * projection/event disagreement into an immediate, loud failure instead of a
   * registry that quietly disagrees with its own log.
   *
   * ⚠ **THE DUPLICATE CHECK IS OVER LIVE PROJECTS ONLY, AND THAT IS DELIBERATE:
   * ARCHIVING FREES THE ROOT.** Re-declaring an archived project's directory
   * mints a **NEW projectId** rather than reviving the old record — identity is
   * the id, not the path. The old record keeps its own history (and keeps
   * resolving for anything that stored its id), and the new one starts clean;
   * reviving would silently re-attach a fresh declaration to whatever metadata,
   * and whatever meaning, the archived one had.
   */
  createProject(input: CreateProjectInput): CreateProjectResult {
    // Fresh read, every call. See `ProjectWriterDeps.readProjects`.
    const declaredProjects = Object.values(this.deps.readProjects().projects);
    const liveProjectWithSameRoot = declaredProjects.find(
      (project) => !project.archived && project.root === input.root,
    );
    if (liveProjectWithSameRoot !== undefined) {
      // Nothing emitted — see `CreateProjectResult`'s note on the tie this
      // prevents. The check runs BEFORE any id is minted, so a refused
      // declaration consumes nothing from the injected source and the id sequence
      // a later successful one mints from is the one it would have had if the
      // duplicate request had never arrived (the same ordering discipline
      // `amendWorkOrder` states for its criterion pass).
      return { outcome: 'duplicate-root', projectId: liveProjectWithSameRoot.projectId };
    }

    const projectId = this.deps.ids.uuid();
    this.deps.emit([
      projectCreated({
        projectId,
        root: input.root,
        // Omitted rather than sent as `undefined`/`''` when the declarer named
        // nothing, so an unnamed project's birth record carries no such key at
        // all and the picker's basename fallback stays a read-time derivation
        // (D42). The same byte discipline `createTask` follows for `title`.
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      }),
    ]);

    const bornProject = this.deps.readProjects().projects[projectId];
    if (bornProject === undefined) {
      throw new ProjectProjectionDisagreementError(
        `project_created was written for ${projectId} but the projects projection did not fold it`,
      );
    }
    return { outcome: 'created', project: bornProject };
  }

  /**
   * Patch a project's mutable metadata: emit ONE `project_updated` carrying only
   * the fields the caller named, and return the record **as the projection folded
   * it** (same I12 read-back reasoning as `createProject`).
   *
   * PATCH SEMANTICS: present replaces, absent leaves alone — see the fold in
   * `projections/projects.ts`. This method omits an absent field from the payload
   * rather than sending `undefined` for it, and that is load-bearing rather than
   * merely tidy: the fold reads PRESENCE to decide what to replace.
   *
   * TOTAL OVER ITS INPUT SPACE: no (projectId, input) pair throws (I8). The one
   * throw below is not input-driven — it is the projection/log divergence that is
   * a rule-0.1 finding.
   *
   * ⚠ **`root` IS NOT PATCHABLE HERE, AND THAT IS NOT A MISSING FEATURE.** D42:
   * the directory IS the boundary, so a different directory is a different
   * project — declare it. See `projectUpdatedPayloadSchema` for what moving a
   * boundary would silently do to every session and cost row under the old prefix.
   */
  updateProject(projectId: string, input: UpdateProjectInput): UpdateProjectResult {
    // Fresh read, every call.
    const project = this.deps.readProjects().projects[projectId];
    if (project === undefined) {
      return { outcome: 'unknown-project', projectId };
    }

    if (input.name === undefined && input.description === undefined) {
      // Nothing emitted — the `empty-amendment` precedent. A caller that named
      // nothing at all writes nothing at all.
      return { outcome: 'empty-update' };
    }

    this.deps.emit([
      projectUpdated({
        projectId: project.projectId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      }),
    ]);

    const updatedProject = this.deps.readProjects().projects[projectId];
    if (updatedProject === undefined) {
      // Unreachable through any request shape (the project existed a moment ago
      // and nothing deletes projects — archiving keeps the record) — see
      // ProjectProjectionDisagreementError. Echoing a hand-built record here would
      // hide exactly the divergence the read-back exists to expose.
      throw new ProjectProjectionDisagreementError(
        `project_updated was written for ${projectId} but the projects projection no longer holds it`,
      );
    }
    return { outcome: 'updated', project: updatedProject };
  }

  /**
   * Archive a project: emit ONE `project_archived` and return the record **as the
   * projection folded it**.
   *
   * ⚠ **ARCHIVE, NOT DELETE.** Nothing is removed from the log (I12) and nothing
   * is removed from the projection — the record stays, with `archived: true`, so
   * the sessions and cost rows that ever sat under its root remain attributable.
   * There is deliberately no delete method anywhere in this class, and no DELETE
   * route in `projectApi.ts`.
   *
   * ⚠ **UN-ARCHIVING IS NOT HERE EITHER**, and that is rule 0.5 rather than an
   * omission: nothing consumes it yet. When a consumer exists it arrives as its
   * own event with its own decision, not as a boolean this method learns to flip
   * both ways.
   *
   * TOTAL OVER ITS INPUT SPACE: no projectId throws (I8). The one throw below is
   * the rule-0.1 projection/log divergence.
   */
  archiveProject(projectId: string): ArchiveProjectResult {
    // Fresh read, every call.
    const project = this.deps.readProjects().projects[projectId];
    if (project === undefined) {
      return { outcome: 'unknown-project', projectId };
    }
    if (project.archived) {
      // Nothing emitted — see `ArchiveProjectResult`'s note. The state would be
      // identical either way; the LOG would not be, and the log is the audit trail.
      return { outcome: 'already-archived', projectId: project.projectId };
    }

    this.deps.emit([projectArchived({ projectId: project.projectId })]);

    const archivedProject = this.deps.readProjects().projects[projectId];
    if (archivedProject === undefined) {
      // Unreachable — archiving does not remove the record; that is the whole
      // point of the fold. See ProjectProjectionDisagreementError.
      throw new ProjectProjectionDisagreementError(
        `project_archived was written for ${projectId} but the projects projection no longer holds it`,
      );
    }
    return { outcome: 'archived', project: archivedProject };
  }
}
