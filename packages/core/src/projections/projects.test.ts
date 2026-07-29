import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput, EventRecord, ProjectRecord } from '../schemas.js';
import { projectRecordSchema } from '../schemas.js';
import {
  projectArchived,
  projectCreated,
  projectInitialized,
  projectUpdated,
  taskCreated,
} from '../events.js';
import { readAllStreamsGrouped, replayFromEmpty } from './projection.js';
import { projectForCwd, projectsProjection, type ProjectsState } from './projects.js';

// ─── S8·1 — the project registry projection + the attribution primitive ──────
//
// Two things are under test here and they carry different weight. The FOLD is
// ordinary projection work (create / patch / archive, totality, replay
// equivalence). `projectForCwd` is the one function in VIMES that answers "which
// project owns this directory?", so the segment-boundary case below is not a nice
// extra — it is the case that decides whether a sibling directory gets silently
// swallowed by its neighbour's boundary, taking its sessions and its costs along.

const PROJECT_A = 'project-aaaa-0001';
const PROJECT_B = 'project-bbbb-0002';
const ROOT_PROJECTS = '/home/ticktockbent/projects';
const ROOT_VIMES = '/home/ticktockbent/projects/infrastructure/vimes';

function makeStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock('2026-07-29T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

// Fold a list of event batches through the projection exactly as boot would.
function stateFromLog(batches: EventInput[][]): ProjectsState {
  const store = makeStore();
  for (const batch of batches) {
    store.append(batch);
  }
  return replayFromEmpty(projectsProjection, readAllStreamsGrouped(store));
}

// A single recorded event, for the cases that need to apply one event to a
// hand-built state (purity, malformed payloads, unknown types).
function recordOf(input: EventInput): EventRecord {
  const store = makeStore();
  store.append([input]);
  return store.read(input.stream, 1)[0]!;
}

function declareProjectA(): EventInput {
  return projectCreated({ projectId: PROJECT_A, root: ROOT_VIMES, name: 'VIMES' });
}

// A hand-built state, for the `projectForCwd` cases that care about ROOTS and
// nothing else. Built through the fold rather than by hand so the records are the
// real folded shape.
function stateWithProjects(
  declarations: ReadonlyArray<{ projectId: string; root: string; archived?: boolean }>,
): ProjectsState {
  return stateFromLog([
    declarations.map((declaration) =>
      projectCreated({ projectId: declaration.projectId, root: declaration.root }),
    ),
    declarations
      .filter((declaration) => declaration.archived === true)
      .map((declaration) => projectArchived({ projectId: declaration.projectId })),
  ]);
}

describe('projects projection — project_created', () => {
  it('inserts a well-formed ProjectRecord that the schema accepts', () => {
    const state = stateFromLog([[declareProjectA()]]);
    const project = state.projects[PROJECT_A]!;
    const parsed = projectRecordSchema.safeParse(project);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(project).toEqual({
      projectId: PROJECT_A,
      root: ROOT_VIMES,
      name: 'VIMES',
      archived: false,
    });
  });

  it('a CREATED project is LIVE — `archived` folds to false, not from the event', () => {
    // The birth record does not carry `archived`; the projection owns the record
    // shape and fills the documented starting value, exactly as `task_created`
    // folds `manualReviewRequired: false`.
    const birthRecord = declareProjectA();
    expect('archived' in (birthRecord.payload as Record<string, unknown>)).toBe(false);
    expect(stateFromLog([[birthRecord]]).projects[PROJECT_A]!.archived).toBe(false);
  });

  it('ABSENT STAYS ABSENT: an unnamed project has NO name and NO description key', () => {
    // D42's basename fallback is a READ-TIME derivation and must never be stored.
    // `toEqual` alone would not catch an `undefined`-valued key, so presence is
    // asserted directly — that difference is the one that changes the bytes (I6).
    const state = stateFromLog([[projectCreated({ projectId: PROJECT_B, root: ROOT_PROJECTS })]]);
    const project = state.projects[PROJECT_B]!;
    expect('name' in project).toBe(false);
    expect('description' in project).toBe(false);
    expect(project).toEqual({ projectId: PROJECT_B, root: ROOT_PROJECTS, archived: false });
  });

  it('a duplicate projectId is a NO-OP — never clobber an existing record', () => {
    // Replay safety, the same guarantee `task_created` carries: a re-delivered or
    // re-appended birth record must not un-archive a project or reset metadata it
    // has since been given.
    const state = stateFromLog([
      [declareProjectA()],
      [projectUpdated({ projectId: PROJECT_A, name: 'renamed after birth' })],
      [projectArchived({ projectId: PROJECT_A })],
      // The SAME id arriving a second time, with different content.
      [projectCreated({ projectId: PROJECT_A, root: '/somewhere/else', name: 'a second birth' })],
    ]);
    expect(state.projects[PROJECT_A]).toEqual({
      projectId: PROJECT_A,
      root: ROOT_VIMES,
      name: 'renamed after birth',
      archived: true,
    });
  });
});

describe('projects projection — project_updated (patch semantics)', () => {
  it('PRESENT REPLACES: a named field overwrites what the record carried', () => {
    const state = stateFromLog([
      [projectCreated({ projectId: PROJECT_A, root: ROOT_VIMES, name: 'VIMES', description: 'old' })],
      [projectUpdated({ projectId: PROJECT_A, name: 'VIMES (the session host)' })],
    ]);
    expect(state.projects[PROJECT_A]!.name).toBe('VIMES (the session host)');
  });

  it('ABSENT LEAVES ALONE: an omitted field survives the patch untouched', () => {
    // The load-bearing half of the patch semantics. The rename above omitted the
    // description; restating it would be the only alternative, and it would make
    // every rename a full rewrite that clobbers whatever a concurrent one changed.
    const state = stateFromLog([
      [
        projectCreated({
          projectId: PROJECT_A,
          root: ROOT_VIMES,
          name: 'VIMES',
          description: 'the description nobody touched',
        }),
      ],
      [projectUpdated({ projectId: PROJECT_A, name: 'a new name' })],
    ]);
    expect(state.projects[PROJECT_A]!.description).toBe('the description nobody touched');
  });

  it('an update can ADD a field the birth record never carried', () => {
    // Absent-at-birth is not absent-forever: naming an unnamed project is the
    // ordinary case the picker will drive.
    const state = stateFromLog([
      [projectCreated({ projectId: PROJECT_B, root: ROOT_PROJECTS })],
      [projectUpdated({ projectId: PROJECT_B, description: 'everything under ~/projects' })],
    ]);
    expect(state.projects[PROJECT_B]).toEqual({
      projectId: PROJECT_B,
      root: ROOT_PROJECTS,
      description: 'everything under ~/projects',
      archived: false,
    });
    expect('name' in state.projects[PROJECT_B]!).toBe(false);
  });

  it('never touches `root` — the payload cannot express it (D42)', () => {
    // A boundary move would silently re-attribute every session and cost row that
    // ever sat under the old prefix. The payload has no such field; this pins that
    // a hostile caller sending one changes nothing.
    const state = stateFromLog([
      [declareProjectA()],
      [
        recordPayloadOverride(projectUpdated({ projectId: PROJECT_A, name: 'still vimes' }), {
          root: '/somewhere/else/entirely',
        }),
      ],
    ]);
    expect(state.projects[PROJECT_A]!.root).toBe(ROOT_VIMES);
    expect(state.projects[PROJECT_A]!.name).toBe('still vimes');
  });

  it('an update for an UNKNOWN project is a no-op and fabricates nothing (I8)', () => {
    const state = stateFromLog([
      [declareProjectA()],
      [projectUpdated({ projectId: PROJECT_B, name: 'a project nobody declared' })],
    ]);
    expect(state.projects[PROJECT_B]).toBeUndefined();
    expect(Object.keys(state.projects)).toEqual([PROJECT_A]);
    expect(state.projects[PROJECT_A]!.name).toBe('VIMES');
  });
});

describe('projects projection — project_archived (the record STAYS)', () => {
  it('raises the flag and KEEPS the record in the map', () => {
    // ⚠ The whole point of archive-not-delete: a cost row from last month still
    // sits under this root, and dropping the record would make that history
    // un-attributable the instant somebody tidied up.
    const state = stateFromLog([[declareProjectA()], [projectArchived({ projectId: PROJECT_A })]]);
    expect(state.projects[PROJECT_A]).toEqual({
      projectId: PROJECT_A,
      root: ROOT_VIMES,
      name: 'VIMES',
      archived: true,
    });
  });

  it('is naturally idempotent — folding the same archival twice writes true twice', () => {
    const state = stateFromLog([
      [declareProjectA()],
      [projectArchived({ projectId: PROJECT_A })],
      [projectArchived({ projectId: PROJECT_A })],
    ]);
    expect(state.projects[PROJECT_A]!.archived).toBe(true);
    expect(Object.keys(state.projects)).toEqual([PROJECT_A]);
  });

  it('an archival for an UNKNOWN project is a no-op (I8)', () => {
    const state = stateFromLog([[declareProjectA()], [projectArchived({ projectId: PROJECT_B })]]);
    expect(state.projects[PROJECT_B]).toBeUndefined();
    expect(state.projects[PROJECT_A]!.archived).toBe(false);
  });
});

describe('projects projection — project_initialized is deliberately NOT folded', () => {
  it('leaves the state byte-identical (RESERVED, rule 0.5 — D42 onboarding hook)', () => {
    // The reservation asserted rather than only documented: a reserved event that
    // quietly changed a record would be half a workflow nobody asked for. The
    // record has no field it would set, and this is what proves it stays that way.
    const priorState = stateFromLog([[declareProjectA()]]);
    const nextState = projectsProjection.apply(
      priorState,
      recordOf(projectInitialized({ projectId: PROJECT_A })),
    );
    expect(nextState).toBe(priorState);
    expect(projectsProjection.serialize(nextState)).toBe(projectsProjection.serialize(priorState));
  });
});

describe('projects projection — hostile and unknown input (I8 totality)', () => {
  const hostileEventRecords: ReadonlyArray<readonly [string, EventRecord]> = [
    [
      'project_created with a non-string root',
      recordOf({ stream: 'projects', type: 'project_created', payload: { projectId: PROJECT_B, root: 42 } }),
    ],
    [
      'project_created with no payload fields at all',
      recordOf({ stream: 'projects', type: 'project_created', payload: {} }),
    ],
    [
      'project_updated with a non-string name',
      recordOf({ stream: 'projects', type: 'project_updated', payload: { projectId: PROJECT_A, name: [] } }),
    ],
    [
      'project_archived with a null payload',
      recordOf({ stream: 'projects', type: 'project_archived', payload: null }),
    ],
    [
      'a task event that wandered onto this fold',
      recordOf(
        taskCreated({
          taskId: 'task-aaaa-0001',
          projectRoot: ROOT_VIMES,
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
        }),
      ),
    ],
    [
      'an event type nobody has ever heard of',
      recordOf({ stream: 'projects', type: 'project_teleported', payload: { projectId: PROJECT_A } }),
    ],
  ];

  for (const [caseName, hostileRecord] of hostileEventRecords) {
    it(`${caseName} is a no-op and never throws`, () => {
      const priorState = stateFromLog([[declareProjectA()]]);
      const serializedBefore = projectsProjection.serialize(priorState);
      let nextState: ProjectsState | undefined;
      expect(() => {
        nextState = projectsProjection.apply(priorState, hostileRecord);
      }).not.toThrow();
      expect(nextState).toBe(priorState);
      expect(projectsProjection.serialize(priorState)).toBe(serializedBefore);
    });
  }
});

describe('projects projection — purity and replay (I12, I6)', () => {
  it('does not mutate the state it was handed (I12)', () => {
    const priorState = stateFromLog([[declareProjectA()]]);
    const serializedBefore = projectsProjection.serialize(priorState);

    const nextState = projectsProjection.apply(
      priorState,
      recordOf(projectUpdated({ projectId: PROJECT_A, description: 'the prior state must not learn this' })),
    );

    expect(projectsProjection.serialize(priorState)).toBe(serializedBefore);
    expect(nextState).not.toBe(priorState);
    expect(nextState.projects[PROJECT_A]).not.toBe(priorState.projects[PROJECT_A]);
  });

  it('I6 double-fold: a log carrying EVERY event kind folds byte-identically twice', () => {
    // The determinism the registry rests on. Nothing in this fold is computed —
    // ids come from the events, `archived` is a recorded fact, metadata is
    // recorded verbatim — so a second fold of the same log produces the same
    // bytes. The log deliberately includes the RESERVED `project_initialized` and
    // a foreign 'tasks' event, so "the fold ignores them consistently" is part of
    // what is being pinned.
    const fullLog: EventInput[][] = [
      [
        projectCreated({ projectId: PROJECT_A, root: ROOT_VIMES, name: 'VIMES' }),
        projectCreated({ projectId: PROJECT_B, root: ROOT_PROJECTS }),
      ],
      [
        projectUpdated({ projectId: PROJECT_B, name: 'everything', description: 'the parent root' }),
        projectInitialized({ projectId: PROJECT_A }),
      ],
      [
        taskCreated({
          taskId: 'task-aaaa-0001',
          projectRoot: ROOT_VIMES,
          createdBy: 'human',
          isolation: 'worktree',
          stage: 'backlog',
        }),
      ],
      [projectArchived({ projectId: PROJECT_A })],
    ];
    const firstFold = stateFromLog(fullLog);
    const secondFold = stateFromLog(fullLog);
    expect(projectsProjection.serialize(secondFold)).toBe(projectsProjection.serialize(firstFold));
    // Not vacuous: the twice-folded state really carries the whole lifecycle.
    expect(firstFold.projects[PROJECT_A]!.archived).toBe(true);
    expect(firstFold.projects[PROJECT_B]).toEqual({
      projectId: PROJECT_B,
      root: ROOT_PROJECTS,
      name: 'everything',
      description: 'the parent root',
      archived: false,
    });
  });
});

// ─── projectForCwd — THE attribution authority ───────────────────────────────

describe('projectForCwd — longest-prefix-wins over live boundaries (D42)', () => {
  it('matches a cwd strictly beneath a declared root', () => {
    const state = stateWithProjects([{ projectId: PROJECT_A, root: ROOT_VIMES }]);
    expect(projectForCwd(state, `${ROOT_VIMES}/packages/core`)?.projectId).toBe(PROJECT_A);
  });

  it('matches when the cwd IS the root exactly', () => {
    const state = stateWithProjects([{ projectId: PROJECT_A, root: ROOT_VIMES }]);
    expect(projectForCwd(state, ROOT_VIMES)?.projectId).toBe(PROJECT_A);
  });

  it('⚠ SEGMENT BOUNDARY: the root `.../vimes` does NOT match the cwd `.../vimes-2`', () => {
    // THE case this function exists to get right. A bare `startsWith` would
    // attribute a whole sibling repo — its sessions, its cost rows — to its
    // neighbour's boundary, and nothing anywhere would report an error.
    const state = stateWithProjects([{ projectId: PROJECT_A, root: ROOT_VIMES }]);
    expect(projectForCwd(state, `${ROOT_VIMES}-2`)).toBeNull();
    expect(projectForCwd(state, `${ROOT_VIMES}-2/packages/core`)).toBeNull();
    // ...and the near-miss in the other direction: a PREFIX of the root is not
    // inside it either.
    expect(projectForCwd(state, '/home/ticktockbent/projects/infrastructure')).toBeNull();
  });

  it('NESTING IS A FEATURE: the deepest declared boundary wins', () => {
    // D42 in as many words — a user may declare both `~/projects` and
    // `~/projects/vimes`, and a cwd under vimes belongs to vimes. Order of
    // declaration must not matter, so both orders are folded.
    const parentFirst = stateWithProjects([
      { projectId: PROJECT_B, root: ROOT_PROJECTS },
      { projectId: PROJECT_A, root: ROOT_VIMES },
    ]);
    const childFirst = stateWithProjects([
      { projectId: PROJECT_A, root: ROOT_VIMES },
      { projectId: PROJECT_B, root: ROOT_PROJECTS },
    ]);
    for (const state of [parentFirst, childFirst]) {
      expect(projectForCwd(state, `${ROOT_VIMES}/packages/daemon`)?.projectId).toBe(PROJECT_A);
      // ...and a sibling that only the PARENT contains still resolves to the parent.
      expect(projectForCwd(state, `${ROOT_PROJECTS}/working/consulting`)?.projectId).toBe(PROJECT_B);
    }
  });

  it('ARCHIVED projects are excluded from the match', () => {
    // Archiving is how a boundary stops claiming live work. The record is still in
    // the map — the fold keeps it — so this is genuinely testing the skip and not
    // a record that vanished.
    const state = stateWithProjects([{ projectId: PROJECT_A, root: ROOT_VIMES, archived: true }]);
    expect(state.projects[PROJECT_A]!.archived).toBe(true);
    expect(projectForCwd(state, `${ROOT_VIMES}/packages/core`)).toBeNull();
  });

  it('an archived DEEP boundary yields to the live shallow one, not to null', () => {
    // The interesting half of exclusion: skipping the deepest match must fall
    // through to the next-best LIVE boundary rather than giving up.
    const state = stateWithProjects([
      { projectId: PROJECT_B, root: ROOT_PROJECTS },
      { projectId: PROJECT_A, root: ROOT_VIMES, archived: true },
    ]);
    expect(projectForCwd(state, `${ROOT_VIMES}/packages/core`)?.projectId).toBe(PROJECT_B);
  });

  it('returns null when no declared boundary contains the cwd', () => {
    const state = stateWithProjects([{ projectId: PROJECT_A, root: ROOT_VIMES }]);
    expect(projectForCwd(state, '/var/lib/something-else')).toBeNull();
    // ...and an empty registry attributes nothing, which is the first-launch state
    // D42's blank picker describes.
    expect(projectForCwd(projectsProjection.init(), ROOT_VIMES)).toBeNull();
  });

  it('returns the RECORD, not just an id — the caller needs the name and the flag', () => {
    const state = stateFromLog([[declareProjectA()]]);
    const attributed: ProjectRecord | null = projectForCwd(state, `${ROOT_VIMES}/docs`);
    expect(attributed).toEqual({
      projectId: PROJECT_A,
      root: ROOT_VIMES,
      name: 'VIMES',
      archived: false,
    });
  });
});

// Build an event whose payload carries an EXTRA field the constructor's type does
// not admit — the only way to test what the fold does with a hostile-but-parsable
// payload without weakening the constructor's own typing.
function recordPayloadOverride(input: EventInput, extraFields: Record<string, unknown>): EventInput {
  return { ...input, payload: { ...(input.payload as Record<string, unknown>), ...extraFields } };
}
