import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type {
  Liveness,
  ProjectRecord,
  ProjectsState,
  SessionRecord,
  SessionsState,
  TaskRecord,
  TasksState,
} from '@vimes/core';
import { composeOrchestratorFounding, composeOrchestratorReorientation } from '@vimes/core';
import {
  registerOrchestratorApi,
  standingNotesPathFor,
  type EnsureOrchestratorResponse,
} from './orchestratorApi.js';

// ─── S8·3 — the ensure endpoint over real HTTP requests ──────────────────────
//
// ⚠ THE INSTRUMENT THAT MATTERS IS THE SPAWN COUNTER, not the status code. D56's
// singleton is a claim about how many processes exist, and a route that founded a
// second orchestrator on every call would still answer 200 with a plausible
// appSessionId. The counter, the recorded spawn options, and the recorded turns
// are what can see the difference.
//
// The auth wall is `app.use('*', …)` in app.ts and is tested there (I14); this
// harness registers the routes alone, like the sibling route tests do for their
// own surfaces.

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-orchestrator-'));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

const PROJECT_ID = 'project-1';
const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';

function projectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: PROJECT_ID,
    root: PROJECT_ROOT,
    name: 'vimes',
    archived: false,
    ...overrides,
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
    projectRoot: PROJECT_ROOT,
    title: 'the queue run',
    stage: 'backlog',
    manualReviewRequired: false,
    isolation: 'shared-dir',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<SessionRecord> & { appSessionId: string }): SessionRecord {
  return {
    channel: 'sdk',
    cwd: PROJECT_ROOT,
    claudeSessionIds: [],
    liveness: 'running',
    needsAttention: null,
    seenAt: null,
    forkedFrom: null,
    taskRef: null,
    observedTtlTier: 'unknown',
    observedBillingBucket: 'unknown',
    name: null,
    createdAt: '2026-07-29T12:00:00.000Z',
    provider: 'claude-code',
    custody: 'host',
    ...overrides,
  };
}

interface SpawnCall {
  channel: 'sdk' | 'pty';
  cwd: string;
  name?: string;
  orchestratorForProjectId?: string;
  // The keys that must NOT be present on an interactive orchestrator spawn.
  permissionMode?: string;
  dispatched?: boolean;
  stage?: string;
}

interface HarnessOptions {
  projects?: ProjectRecord[];
  tasks?: TaskRecord[];
  sessions?: SessionRecord[];
  // Refusals, injected per test.
  spawnRefusal?: string;
  resumeRefusal?: string;
  sendRefusal?: string;
  // The notes the fs seam finds, keyed by the path the route composes.
  notesByPath?: Record<string, string>;
  standingNotesDir?: string;
  // Use the REAL fs read (no seam) — the ENOENT-degrades-to-absent case.
  useRealNotesReader?: boolean;
}

interface Harness {
  ensure: (projectId?: string) => Promise<Response>;
  spawnCalls: SpawnCall[];
  resumeCalls: string[];
  sentTurns: Array<{ appSessionId: string; text: string }>;
  sessions: () => SessionRecord[];
  notesPathsRead: string[];
  standingNotesDir: string;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  const standingNotesDir = options.standingNotesDir ?? join(temporaryDirectory, 'notes');
  const projects: ProjectsState = {
    projects: Object.fromEntries(
      (options.projects ?? [projectRecord()]).map((project) => [project.projectId, project]),
    ),
  };
  const tasks: TasksState = {
    tasks: Object.fromEntries((options.tasks ?? []).map((task) => [task.taskId, task])),
  };
  // The sessions the route reads back. The fake host MUTATES this the way the
  // real host's emitted events would move the fold — a spawn adds a `running`
  // record carrying the marking, a resume drives an existing one to `running`.
  const sessions: SessionsState = {
    sessions: Object.fromEntries(
      (options.sessions ?? []).map((session) => [session.appSessionId, session]),
    ),
  };

  const spawnCalls: SpawnCall[] = [];
  const resumeCalls: string[] = [];
  const sentTurns: Array<{ appSessionId: string; text: string }> = [];
  const notesPathsRead: string[] = [];
  let spawnCounter = 0;

  const app = new Hono();
  registerOrchestratorApi(app, {
    readProjects: () => projects,
    readSessions: () => sessions,
    readTasks: () => tasks,
    sessionHost: {
      spawnSession: (spawnOptions) => {
        spawnCalls.push(spawnOptions as SpawnCall);
        if (options.spawnRefusal !== undefined) {
          return { refused: true, reason: options.spawnRefusal };
        }
        spawnCounter += 1;
        const appSessionId = `spawned-${spawnCounter}`;
        sessions.sessions[appSessionId] = sessionRecord({
          appSessionId,
          cwd: spawnOptions.cwd,
          liveness: 'running',
          name: spawnOptions.name ?? null,
          // The birth record's marking, exactly as `session_created` carries it.
          ...(spawnOptions.orchestratorForProjectId === undefined
            ? {}
            : { orchestratorForProjectId: spawnOptions.orchestratorForProjectId }),
          createdAt: `2026-07-29T13:0${spawnCounter}:00.000Z`,
        });
        return { appSessionId };
      },
      resumeSession: (appSessionId) => {
        resumeCalls.push(appSessionId);
        if (options.resumeRefusal !== undefined) {
          return { refused: true, reason: options.resumeRefusal };
        }
        const resumed = sessions.sessions[appSessionId];
        if (resumed !== undefined) {
          sessions.sessions[appSessionId] = { ...resumed, liveness: 'running' };
        }
        return { appSessionId };
      },
      sendMessage: (appSessionId, text) => {
        sentTurns.push({ appSessionId, text });
        return options.sendRefusal === undefined
          ? { ok: true }
          : { refused: true, reason: options.sendRefusal };
      },
    },
    standingNotesDir,
    ...(options.useRealNotesReader === true
      ? {}
      : {
          readStandingNotes: (notesPath: string) => {
            notesPathsRead.push(notesPath);
            return options.notesByPath?.[notesPath];
          },
        }),
  });

  return {
    ensure: async (projectId = PROJECT_ID) =>
      app.request(`/api/projects/${projectId}/orchestrator`, { method: 'POST' }),
    spawnCalls,
    resumeCalls,
    sentTurns,
    sessions: () => Object.values(sessions.sessions),
    notesPathsRead,
    standingNotesDir,
  };
}

// The orchestrator record a project already has, at a given liveness.
function existingOrchestrator(liveness: Liveness, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return sessionRecord({
    appSessionId: 'orchestrator-1',
    liveness,
    orchestratorForProjectId: PROJECT_ID,
    name: 'Orchestrator — vimes',
    ...overrides,
  });
}

describe('POST /api/projects/:projectId/orchestrator — the registry gate', () => {
  it('404s an unknown project, and spawns nothing', async () => {
    const harness = buildHarness();
    const response = await harness.ensure('no-such-project');
    expect(response.status).toBe(404);
    expect(harness.spawnCalls).toEqual([]);
  });

  it('409s an ARCHIVED project (archived-project), and spawns nothing', async () => {
    const harness = buildHarness({ projects: [projectRecord({ archived: true })] });
    const response = await harness.ensure();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ detail: 'archived-project' });
    expect(harness.spawnCalls).toEqual([]);
  });
});

describe('POST …/orchestrator — the singleton (D56)', () => {
  it('TWO ensures produce ONE spawn — the second finds the first', async () => {
    const harness = buildHarness();
    const first = (await (await harness.ensure()).json()) as EnsureOrchestratorResponse;
    const second = (await (await harness.ensure()).json()) as EnsureOrchestratorResponse;
    expect(first.outcome).toBe('founded');
    expect(second.outcome).toBe('already-live');
    expect(harness.spawnCalls).toHaveLength(1);
    expect(first).toMatchObject({ appSessionId: 'spawned-1' });
    expect(second).toMatchObject({ appSessionId: 'spawned-1' });
  });

  it('an ensure for ANOTHER project founds that project its own orchestrator', async () => {
    const harness = buildHarness({
      projects: [
        projectRecord(),
        projectRecord({ projectId: 'project-2', root: '/home/ticktockbent/projects/johnny', name: 'johnny' }),
      ],
    });
    await harness.ensure();
    await harness.ensure('project-2');
    expect(harness.spawnCalls.map((call) => call.orchestratorForProjectId)).toEqual([
      PROJECT_ID,
      'project-2',
    ]);
  });

  it('a LIVE orchestrator short-circuits: no spawn, no resume, and NO message', async () => {
    const harness = buildHarness({ sessions: [existingOrchestrator('running')] });
    const response = await harness.ensure();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'already-live',
      appSessionId: 'orchestrator-1',
    });
    expect(harness.spawnCalls).toEqual([]);
    expect(harness.resumeCalls).toEqual([]);
    expect(harness.sentTurns).toEqual([]);
  });

  it('a SPAWNING orchestrator is live too — a resume already in flight is not a second one', async () => {
    const harness = buildHarness({ sessions: [existingOrchestrator('spawning')] });
    expect(await (await harness.ensure()).json()).toMatchObject({ outcome: 'already-live' });
    expect(harness.spawnCalls).toEqual([]);
    expect(harness.resumeCalls).toEqual([]);
  });

  it('ignores a session marked for a DIFFERENT project', async () => {
    const harness = buildHarness({
      sessions: [existingOrchestrator('running', { orchestratorForProjectId: 'project-2' })],
    });
    expect(await (await harness.ensure()).json()).toMatchObject({ outcome: 'founded' });
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('ignores an ORDINARY session in the same project (no marking, not an orchestrator)', async () => {
    const harness = buildHarness({
      sessions: [sessionRecord({ appSessionId: 'ordinary-1', liveness: 'running' })],
    });
    expect(await (await harness.ensure()).json()).toMatchObject({ outcome: 'founded' });
  });
});

describe('POST …/orchestrator — resume (the lazy-maintenance path)', () => {
  it('DORMANT → resumed through the existing resume op, with NO reorientation turn', async () => {
    const harness = buildHarness({ sessions: [existingOrchestrator('dormant')] });
    const response = await harness.ensure();
    expect(await response.json()).toEqual({ outcome: 'resumed', appSessionId: 'orchestrator-1' });
    expect(harness.resumeCalls).toEqual(['orchestrator-1']);
    expect(harness.spawnCalls).toEqual([]);
    // A dormant orchestrator ended its turn cleanly — it has no restart story.
    expect(harness.sentTurns).toEqual([]);
  });

  it('INTERRUPTED → resumed plus exactly ONE reorientation turn, and it IS the composer output', async () => {
    const harness = buildHarness({ sessions: [existingOrchestrator('interrupted')] });
    const response = (await (await harness.ensure()).json()) as EnsureOrchestratorResponse;
    expect(response).toMatchObject({
      outcome: 'resumed',
      appSessionId: 'orchestrator-1',
      briefingDelivery: { status: 'sent' },
    });
    expect(harness.resumeCalls).toEqual(['orchestrator-1']);
    expect(harness.sentTurns).toHaveLength(1);
    expect(harness.sentTurns[0]).toEqual({
      appSessionId: 'orchestrator-1',
      text: composeOrchestratorReorientation({
        projectName: 'vimes',
        notesPath: standingNotesPathFor(harness.standingNotesDir, PROJECT_ID),
      }),
    });
  });

  it('a REFUSED resume rides the envelope honestly, and sends nothing', async () => {
    const harness = buildHarness({
      sessions: [existingOrchestrator('interrupted')],
      resumeRefusal: 'preflight-failed',
    });
    expect(await (await harness.ensure()).json()).toEqual({
      outcome: 'resume-refused',
      reason: 'preflight-failed',
    });
    expect(harness.sentTurns).toEqual([]);
    expect(harness.spawnCalls).toEqual([]);
  });

  it('prefers the NEWEST non-dead record when several are marked', async () => {
    const harness = buildHarness({
      sessions: [
        existingOrchestrator('dormant', {
          appSessionId: 'older',
          createdAt: '2026-07-01T00:00:00.000Z',
        }),
        existingOrchestrator('dormant', {
          appSessionId: 'newer',
          createdAt: '2026-07-28T00:00:00.000Z',
        }),
      ],
    });
    expect(await (await harness.ensure()).json()).toMatchObject({ appSessionId: 'newer' });
    expect(harness.resumeCalls).toEqual(['newer']);
  });

  it('a DEAD newest record does not shadow a resumable older one', async () => {
    const harness = buildHarness({
      sessions: [
        existingOrchestrator('dormant', {
          appSessionId: 'older',
          createdAt: '2026-07-01T00:00:00.000Z',
        }),
        existingOrchestrator('dead', {
          appSessionId: 'dead-newest',
          createdAt: '2026-07-28T00:00:00.000Z',
        }),
      ],
    });
    expect(await (await harness.ensure()).json()).toMatchObject({
      outcome: 'resumed',
      appSessionId: 'older',
    });
  });
});

describe('POST …/orchestrator — founding and refounding (D56 rotation)', () => {
  it('founds with the SDK channel, the marking, the display name — and NO dispatched footing', async () => {
    const harness = buildHarness();
    await harness.ensure();
    expect(harness.spawnCalls).toHaveLength(1);
    const spawn = harness.spawnCalls[0]!;
    expect(spawn).toMatchObject({
      channel: 'sdk',
      cwd: PROJECT_ROOT,
      name: 'Orchestrator — vimes',
      orchestratorForProjectId: PROJECT_ID,
    });
    // D56: an INTERACTIVE session. None of the dispatched-run keys may appear.
    expect(Object.keys(spawn)).not.toContain('permissionMode');
    expect(Object.keys(spawn)).not.toContain('dispatched');
    expect(Object.keys(spawn)).not.toContain('stage');
  });

  it('names the project by its ROOT BASENAME when the record has no name (D42 fallback)', async () => {
    const unnamed = projectRecord();
    delete (unnamed as { name?: string }).name;
    const harness = buildHarness({ projects: [unnamed] });
    await harness.ensure();
    expect(harness.spawnCalls[0]!.name).toBe('Orchestrator — vimes');
  });

  it('delivers the founding briefing as exactly ONE turn, and it IS the composer output', async () => {
    const notesPath = standingNotesPathFor(join(temporaryDirectory, 'notes'), PROJECT_ID);
    const harness = buildHarness({
      tasks: [taskRecord()],
      notesByPath: { [notesPath]: 'banked: the ledger ingest is idempotent.\n' },
    });
    const response = (await (await harness.ensure()).json()) as EnsureOrchestratorResponse;
    expect(response).toMatchObject({
      outcome: 'founded',
      appSessionId: 'spawned-1',
      briefingDelivery: { status: 'sent' },
    });
    // A FIRST founding carries no `refounded` key at all.
    expect(response).not.toHaveProperty('refounded');
    expect(harness.sentTurns).toHaveLength(1);
    expect(harness.sentTurns[0]!.text).toContain('You are the standing orchestrator for this project');
    expect(harness.sentTurns[0]!.text).toContain('banked: the ledger ingest is idempotent.');
    expect(harness.sentTurns[0]!.text).toContain('  - [aaaaaaaa] the queue run — backlog');
  });

  it('scopes the briefing board to THIS project — a sibling root never rides along', async () => {
    const harness = buildHarness({
      tasks: [
        taskRecord({ taskId: 'mine-0000', title: 'mine' }),
        taskRecord({
          taskId: 'theirs-00',
          title: 'theirs',
          projectRoot: `${PROJECT_ROOT}-2`,
        }),
      ],
    });
    await harness.ensure();
    expect(harness.sentTurns[0]!.text).toContain('mine');
    expect(harness.sentTurns[0]!.text).not.toContain('theirs');
  });

  it('reads the notes at <notesDir>/<projectId>.md and omits the section when there are none', async () => {
    const harness = buildHarness();
    await harness.ensure();
    expect(harness.notesPathsRead).toEqual([
      join(harness.standingNotesDir, `${PROJECT_ID}.md`),
    ]);
    expect(harness.sentTurns[0]!.text).not.toContain('Your standing notes, as you last left them');
  });

  it('a MISSING notes file (real fs, ENOENT) degrades to a founding without the section', async () => {
    const harness = buildHarness({
      standingNotesDir: join(temporaryDirectory, 'notes-that-do-not-exist'),
      useRealNotesReader: true,
    });
    const response = (await (await harness.ensure()).json()) as EnsureOrchestratorResponse;
    expect(response).toMatchObject({ outcome: 'founded' });
    expect(harness.sentTurns[0]!.text).not.toContain('Your standing notes, as you last left them');
  });

  it('a REAL notes file on disk is carried into the founding briefing verbatim', async () => {
    const notesDir = mkdtempSync(join(temporaryDirectory, 'real-notes-'));
    writeFileSync(join(notesDir, `${PROJECT_ID}.md`), '# banked\n\nthe fence is D21.\n');
    const harness = buildHarness({ standingNotesDir: notesDir, useRealNotesReader: true });
    await harness.ensure();
    expect(harness.sentTurns[0]!.text).toContain('# banked\n\nthe fence is D21.');
  });

  it('REFOUNDS over a dead predecessor, marks `refounded: true`, and carries the notes forward', async () => {
    const notesDir = mkdtempSync(join(temporaryDirectory, 'refound-notes-'));
    writeFileSync(join(notesDir, `${PROJECT_ID}.md`), 'the previous transcript banked this.\n');
    const harness = buildHarness({
      sessions: [existingOrchestrator('dead')],
      standingNotesDir: notesDir,
      useRealNotesReader: true,
    });
    const response = (await (await harness.ensure()).json()) as EnsureOrchestratorResponse;
    expect(response).toMatchObject({
      outcome: 'founded',
      appSessionId: 'spawned-1',
      refounded: true,
    });
    expect(harness.resumeCalls).toEqual([]);
    expect(harness.sentTurns[0]!.text).toContain('the previous transcript banked this.');
  });

  it('the founding turn is byte-identical to the composer called with the same facts', async () => {
    const harness = buildHarness({ tasks: [taskRecord()] });
    await harness.ensure();
    expect(harness.sentTurns[0]!.text).toBe(
      composeOrchestratorFounding({
        projectName: 'vimes',
        projectRoot: PROJECT_ROOT,
        notesPath: standingNotesPathFor(harness.standingNotesDir, PROJECT_ID),
        board: {
          projectRoot: PROJECT_ROOT,
          taskCount: 1,
          stageCounts: [{ stage: 'backlog', count: 1 }],
          tasks: [
            {
              taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
              shortId: 'aaaaaaaa',
              label: 'the queue run',
              stage: 'backlog',
              sessionRunCount: 0,
            },
          ],
        },
      }),
    );
  });
});

// ⚠ SP8·2's HARD REQUIREMENT, pinned: `claude --resume` needs an EXACT cwd match,
// so the cwd the daemon spawns with must be the RECORD's string and nothing else.
describe('POST …/orchestrator — cwd is VERBATIM from the record (SP8·2)', () => {
  it('spawns with the declared root even when it would realpath somewhere else', async () => {
    const realRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'real-root-')));
    const linkedRoot = join(temporaryDirectory, `linked-root-${Date.now()}`);
    symlinkSync(realRoot, linkedRoot);
    // Guard the guard: the two paths really are different, so a route that
    // resolved the root would produce a visibly different cwd.
    expect(realpathSync(linkedRoot)).not.toBe(linkedRoot);

    const harness = buildHarness({ projects: [projectRecord({ root: linkedRoot })] });
    await harness.ensure();
    expect(harness.spawnCalls[0]!.cwd).toBe(linkedRoot);
    expect(harness.spawnCalls[0]!.cwd).not.toBe(realpathSync(linkedRoot));
  });

  it('does not normalize a trailing-slash root either — the record is the truth', async () => {
    const harness = buildHarness({ projects: [projectRecord({ root: `${PROJECT_ROOT}/` })] });
    await harness.ensure();
    expect(harness.spawnCalls[0]!.cwd).toBe(`${PROJECT_ROOT}/`);
  });
});

describe('POST …/orchestrator — refusals ride the envelope', () => {
  it('a preflight-refused spawn reports `spawn-refused` with the reason, and sends nothing', async () => {
    const harness = buildHarness({ spawnRefusal: 'preflight-failed' });
    const response = await harness.ensure();
    // 200 with the envelope — the dispatch route's convention (here is what
    // happened), never a 4xx that invites retry machinery.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'spawn-refused',
      reason: 'preflight-failed',
    });
    expect(harness.sentTurns).toEqual([]);
  });

  it('a refused briefing is reported, not swallowed — the session still exists', async () => {
    const harness = buildHarness({ sendRefusal: 'no-live-process' });
    expect(await (await harness.ensure()).json()).toMatchObject({
      outcome: 'founded',
      appSessionId: 'spawned-1',
      briefingDelivery: { status: 'not-delivered', reason: 'no-live-process' },
    });
  });
});
