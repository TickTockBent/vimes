import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  projectsProjection,
  readAllStreamsGrouped,
  replayFromEmpty,
  type EventInput,
  type ProjectsState,
} from '@vimes/core';
import {
  ProjectWriter,
  type ArchiveProjectResult,
  type CreateProjectResult,
  type UpdateProjectResult,
} from './projectWriter.js';

// ─── S8·1 — the SOLE project writer ──────────────────────────────────────────
//
// ⚠ THE INSTRUMENT THAT MATTERS HERE IS THE EVENT LOG, NOT THE RETURN VALUE.
// Three of this class's outcomes are REFUSALS whose whole content is "and nothing
// was written" — `duplicate-root`, `empty-update`, `already-archived` — and a
// writer that returned the right outcome while quietly emitting an event would
// satisfy every return-value assertion in this file while corrupting the registry
// (a duplicate root gives `projectForCwd` a tie it cannot break; a second
// `project_archived` claims a human archived something twice). So every refusal
// case asserts the EMITTED-EVENTS LIST, not merely the returned union member.
//
// The harness folds the real `projectsProjection` over a real MemoryEventStore, so
// `readProjects` is a genuine fold of what was actually written — not a hand-held
// state object the writer could agree with by construction.

const ROOT_PROJECTS = '/home/ticktockbent/projects';
const ROOT_VIMES = '/home/ticktockbent/projects/infrastructure/vimes';

interface WriterHarness {
  writer: ProjectWriter;
  // Every event the writer emitted, in order.
  emitted: EventInput[];
  // How many times the writer read the projection.
  readProjectsCallCount: () => number;
  // The projection as folded from the store RIGHT NOW.
  currentProjects: () => ProjectsState;
}

function buildHarness(): WriterHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-07-29T12:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  const emitted: EventInput[] = [];
  let readProjectsCallCount = 0;

  const currentProjects = (): ProjectsState =>
    replayFromEmpty(projectsProjection, readAllStreamsGrouped(store));

  const writer = new ProjectWriter({
    emit: (events) => {
      emitted.push(...events);
      store.append(events);
    },
    readProjects: () => {
      readProjectsCallCount += 1;
      return currentProjects();
    },
    // A COUNTING id source, injected (rule 0.3): projectIds are byte-identical run
    // to run, so nothing in this file depends on randomUUID.
    ids: new CountingIdSource(),
  });

  return {
    writer,
    emitted,
    readProjectsCallCount: () => readProjectsCallCount,
    currentProjects,
  };
}

function eventTypes(events: EventInput[]): string[] {
  return events.map((event) => event.type);
}

describe('ProjectWriter — createProject', () => {
  it('emits exactly one project_created and returns the record AS FOLDED, not an echo', () => {
    // The returned record is compared against the projection's own fold of the
    // log, so an implementation that hand-built the return value would have to
    // hand-build it identically to the projection — and a projection/event
    // disagreement shows up here immediately (I12).
    const harness = buildHarness();
    const result = harness.writer.createProject({ root: ROOT_VIMES, name: 'VIMES' });

    expect(result.outcome).toBe('created');
    const project = (result as Extract<CreateProjectResult, { outcome: 'created' }>).project;
    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.projectCreated]);
    expect(harness.emitted[0]!.stream).toBe('projects');
    expect(project).toEqual(harness.currentProjects().projects[project.projectId]);
    expect(project).toEqual({
      projectId: project.projectId,
      root: ROOT_VIMES,
      name: 'VIMES',
      archived: false,
    });
  });

  it('mints its projectId from the INJECTED source (rule 0.3)', () => {
    // A CountingIdSource makes the id deterministic; nothing here reaches for
    // randomUUID, which is what makes the byte-identity assertions above possible
    // at all.
    const harness = buildHarness();
    const first = harness.writer.createProject({ root: ROOT_VIMES });
    const second = harness.writer.createProject({ root: ROOT_PROJECTS });
    const firstId = (first as Extract<CreateProjectResult, { outcome: 'created' }>).project.projectId;
    const secondId = (second as Extract<CreateProjectResult, { outcome: 'created' }>).project
      .projectId;
    expect(firstId).toBe(new CountingIdSource().uuid());
    expect(secondId).not.toBe(firstId);
  });

  it('ABSENT STAYS ABSENT: an unnamed declaration carries NO name key into the event', () => {
    // D42's basename fallback is a read-time derivation, so the birth record must
    // carry no name at all — asserted on the EVENT PAYLOAD and not only on the
    // record, because that is where the bytes live (I6).
    const harness = buildHarness();
    const result = harness.writer.createProject({ root: ROOT_VIMES });

    const birthPayload = harness.emitted[0]!.payload as Record<string, unknown>;
    expect('name' in birthPayload).toBe(false);
    expect('description' in birthPayload).toBe(false);
    expect(birthPayload).toEqual({
      projectId: (result as Extract<CreateProjectResult, { outcome: 'created' }>).project.projectId,
      root: ROOT_VIMES,
    });
  });

  it('refuses an EXACT-match live root — duplicate-root, and NOTHING is emitted', () => {
    // ⚠ THE LOG IS THE INSTRUMENT. A second record for the same directory would
    // give `projectForCwd` a tie it cannot break, and every cwd under that root
    // would attribute to whichever record `Object.values` happened to yield first.
    const harness = buildHarness();
    const first = harness.writer.createProject({ root: ROOT_VIMES, name: 'VIMES' });
    const existingId = (first as Extract<CreateProjectResult, { outcome: 'created' }>).project
      .projectId;
    harness.emitted.length = 0;

    const second = harness.writer.createProject({ root: ROOT_VIMES, name: 'VIMES again' });
    expect(second).toEqual({ outcome: 'duplicate-root', projectId: existingId });
    expect(harness.emitted).toEqual([]);
    expect(Object.keys(harness.currentProjects().projects)).toEqual([existingId]);
  });

  it('a refused duplicate CONSUMES NO ID — the next declaration gets the id it would have had', () => {
    // The check runs before any id is minted, exactly as `amendWorkOrder`
    // validates before minting: a refused request must not shift the deterministic
    // id sequence a later successful one draws from (rule 0.3).
    const withDuplicate = buildHarness();
    withDuplicate.writer.createProject({ root: ROOT_VIMES });
    withDuplicate.writer.createProject({ root: ROOT_VIMES });
    const afterDuplicate = withDuplicate.writer.createProject({ root: ROOT_PROJECTS });

    const withoutDuplicate = buildHarness();
    withoutDuplicate.writer.createProject({ root: ROOT_VIMES });
    const withoutRefusal = withoutDuplicate.writer.createProject({ root: ROOT_PROJECTS });

    expect(
      (afterDuplicate as Extract<CreateProjectResult, { outcome: 'created' }>).project.projectId,
    ).toBe((withoutRefusal as Extract<CreateProjectResult, { outcome: 'created' }>).project.projectId);
  });

  it('NESTING IS NOT A DUPLICATE: a root under an existing one is created (D42)', () => {
    // D42 makes overlap a feature and resolves it with longest-prefix-wins, so a
    // writer that refused nesting would refuse the design.
    const harness = buildHarness();
    harness.writer.createProject({ root: ROOT_PROJECTS });
    const nested = harness.writer.createProject({ root: ROOT_VIMES });
    expect(nested.outcome).toBe('created');
    expect(eventTypes(harness.emitted)).toEqual([
      EVENT_TYPES.projectCreated,
      EVENT_TYPES.projectCreated,
    ]);
  });

  it('ARCHIVING FREES THE ROOT, and the re-declaration mints a NEW id', () => {
    // ⚠ IDENTITY IS THE ID, NOT THE PATH. Reviving the archived record would
    // silently re-attach a fresh declaration to whatever metadata — and whatever
    // meaning — the old one had; minting a new one leaves both histories intact.
    const harness = buildHarness();
    const first = harness.writer.createProject({ root: ROOT_VIMES, name: 'the first vimes' });
    const originalId = (first as Extract<CreateProjectResult, { outcome: 'created' }>).project
      .projectId;
    harness.writer.archiveProject(originalId);

    const second = harness.writer.createProject({ root: ROOT_VIMES, name: 'the second vimes' });
    expect(second.outcome).toBe('created');
    const revivedId = (second as Extract<CreateProjectResult, { outcome: 'created' }>).project
      .projectId;
    expect(revivedId).not.toBe(originalId);

    // Both records survive: the archived one keeps its own history and its own name.
    const projects = harness.currentProjects().projects;
    expect(projects[originalId]).toEqual({
      projectId: originalId,
      root: ROOT_VIMES,
      name: 'the first vimes',
      archived: true,
    });
    expect(projects[revivedId]!.archived).toBe(false);
  });

  it('reads the projection FRESH on every call, never a cached field', () => {
    const harness = buildHarness();
    const readsBefore = harness.readProjectsCallCount();
    harness.writer.createProject({ root: ROOT_VIMES });
    harness.writer.createProject({ root: ROOT_PROJECTS });
    expect(harness.readProjectsCallCount()).toBeGreaterThan(readsBefore + 1);
  });
});

describe('ProjectWriter — updateProject', () => {
  function harnessWithProject(): { harness: WriterHarness; projectId: string } {
    const harness = buildHarness();
    const created = harness.writer.createProject({ root: ROOT_VIMES, name: 'VIMES' });
    harness.emitted.length = 0;
    return {
      harness,
      projectId: (created as Extract<CreateProjectResult, { outcome: 'created' }>).project.projectId,
    };
  }

  it('emits one project_updated and returns the record AS FOLDED', () => {
    const { harness, projectId } = harnessWithProject();
    const result = harness.writer.updateProject(projectId, { description: 'a description' });

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.projectUpdated]);
    expect(harness.emitted[0]!.stream).toBe('projects');
    const project = (result as Extract<UpdateProjectResult, { outcome: 'updated' }>).project;
    expect(project).toEqual(harness.currentProjects().projects[projectId]);
    expect(project).toEqual({
      projectId,
      root: ROOT_VIMES,
      name: 'VIMES',
      description: 'a description',
      archived: false,
    });
  });

  it('OMITS an absent field from the payload rather than sending `undefined`', () => {
    // Load-bearing rather than tidy: the FOLD reads presence to decide what to
    // replace, so an `undefined`-valued key would be the difference between "leave
    // the name as it was" and "clear it".
    const { harness, projectId } = harnessWithProject();
    harness.writer.updateProject(projectId, { description: 'only the description' });
    expect(harness.emitted[0]!.payload).toEqual({ projectId, description: 'only the description' });
  });

  it('an all-absent patch is `empty-update` and NOTHING is emitted', () => {
    // The `empty-amendment` precedent: a well-formed request that asks for nothing
    // is log noise, not an update.
    const { harness, projectId } = harnessWithProject();
    const result: UpdateProjectResult = harness.writer.updateProject(projectId, {});
    expect(result).toEqual({ outcome: 'empty-update' });
    expect(harness.emitted).toEqual([]);
  });

  it('an unknown project is `unknown-project` and NOTHING is emitted', () => {
    // Writing an update for a projectId no `project_created` ever introduced would
    // put a phantom project in the log.
    const { harness } = harnessWithProject();
    const result: UpdateProjectResult = harness.writer.updateProject('project-nobody-declared', {
      name: 'a name for nothing',
    });
    expect(result).toEqual({ outcome: 'unknown-project', projectId: 'project-nobody-declared' });
    expect(harness.emitted).toEqual([]);
  });

  it('patches an ARCHIVED project — archiving is not a freeze', () => {
    // Nothing in D42 says an archived project's metadata is immutable, and
    // correcting the description of retired work is a legitimate act. Stated
    // explicitly so a future reader does not add the guard by reflex.
    const { harness, projectId } = harnessWithProject();
    harness.writer.archiveProject(projectId);
    harness.emitted.length = 0;

    const result = harness.writer.updateProject(projectId, { name: 'retired, and renamed' });
    expect(result.outcome).toBe('updated');
    expect((result as Extract<UpdateProjectResult, { outcome: 'updated' }>).project).toEqual({
      projectId,
      root: ROOT_VIMES,
      name: 'retired, and renamed',
      archived: true,
    });
  });
});

describe('ProjectWriter — archiveProject', () => {
  function harnessWithProject(): { harness: WriterHarness; projectId: string } {
    const harness = buildHarness();
    const created = harness.writer.createProject({ root: ROOT_VIMES, name: 'VIMES' });
    harness.emitted.length = 0;
    return {
      harness,
      projectId: (created as Extract<CreateProjectResult, { outcome: 'created' }>).project.projectId,
    };
  }

  it('emits one project_archived and returns the record AS FOLDED, still present', () => {
    // ⚠ ARCHIVE, NOT DELETE — the returned record proves the projection still
    // holds it, which is what keeps the history under its root attributable.
    const { harness, projectId } = harnessWithProject();
    const result = harness.writer.archiveProject(projectId);

    expect(eventTypes(harness.emitted)).toEqual([EVENT_TYPES.projectArchived]);
    expect(harness.emitted[0]!.stream).toBe('projects');
    expect(harness.emitted[0]!.payload).toEqual({ projectId });
    const project = (result as Extract<ArchiveProjectResult, { outcome: 'archived' }>).project;
    expect(project).toEqual(harness.currentProjects().projects[projectId]);
    expect(project.archived).toBe(true);
  });

  it('a second archival is `already-archived` and NOTHING is emitted', () => {
    // ⚠ IDEMPOTENCE REFUSED HONESTLY. The fold would be identical either way, so
    // only the log can tell an honest refusal from a silent accept — and a second
    // `project_archived` would claim a human archived this twice.
    const { harness, projectId } = harnessWithProject();
    harness.writer.archiveProject(projectId);
    harness.emitted.length = 0;

    const result: ArchiveProjectResult = harness.writer.archiveProject(projectId);
    expect(result).toEqual({ outcome: 'already-archived', projectId });
    expect(harness.emitted).toEqual([]);
  });

  it('an unknown project is `unknown-project` and NOTHING is emitted', () => {
    const { harness } = harnessWithProject();
    const result: ArchiveProjectResult = harness.writer.archiveProject('project-nobody-declared');
    expect(result).toEqual({ outcome: 'unknown-project', projectId: 'project-nobody-declared' });
    expect(harness.emitted).toEqual([]);
  });
});
