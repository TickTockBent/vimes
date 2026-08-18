import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  claudeSessionMapped,
  livenessChanged,
  nodeCheckoutBranch,
  nodeCheckoutDirName,
  nodesProjection,
  projectCreated,
  projectsProjection,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionCreated,
  sessionsProjection,
  type EventInput,
  type EventRecord,
} from '@vimes/core';
import { GitAdapter, type GitRunner } from './gitAdapter.js';
import { NodeWriter } from './nodeWriter.js';
import {
  CheckoutCoordinator,
  checkoutRefusalReasonSchema,
  type CheckoutRefusalReason,
  type InLockFollowUp,
} from './checkoutCoordinator.js';

// ─── S17·U2 — the CheckoutCoordinator (slice-17.md §3) ───────────────────────
//
// ⚠ **NO REAL GIT RUNS IN THIS FILE.** The subject is POLICY — the state table,
// the lock, the gates, compensation — so git is a deterministic FAKE WORLD
// (`FakeGitWorld` below) behind the REAL `GitAdapter` and its real argv
// discipline. Driving the real adapter rather than a stub adapter is the point:
// A6's claim is about the argument vector `worktree add` receives, and a stubbed
// adapter would let a wrong vector pass unseen. The live-fire against a real
// scratch repository is the slice's §6 machine gate, not a unit test.
//
// The event store, the projections, the writer and the id source are all REAL
// too. What is faked is exactly the two process boundaries: git, and the disk
// probe. Everything between them is the code that ships.

const PROJECT_ID = 'proj-alpha';
const PROJECT_ROOT = '/home/example/projects/alpha';
const OTHER_PROJECT_ID = 'proj-beta';
const OTHER_PROJECT_ROOT = '/home/example/projects/beta';
const WORKTREE_ROOT = '/var/lib/vimes/worktrees';

// The ids `CountingIdSource` mints, in order — so a test can name the branch and
// path an operation is ABOUT to derive, before it derives them.
function nthNodeId(oneBasedIndex: number): string {
  return `00000000-0000-4000-8000-${String(oneBasedIndex).padStart(12, '0')}`;
}
function nthCheckoutPath(oneBasedIndex: number): string {
  return `${WORKTREE_ROOT}/${nodeCheckoutDirName(nthNodeId(oneBasedIndex))}`;
}
function nthCheckoutBranch(oneBasedIndex: number): string {
  return nodeCheckoutBranch(nthNodeId(oneBasedIndex));
}

// ── the fake git world ──────────────────────────────────────────────────────
//
// A tiny, TOTAL model of the only git state these verbs touch: which local
// branches exist and at which commit, which worktrees are checked out, and what
// `origin/HEAD` points at. The runner below INTERPRETS the real adapter's argv
// against it, so a command whose shape drifts stops being understood and the
// test fails loudly rather than passing against a stub.
interface FakeWorktree {
  path: string;
  branch: string | null;
}

class FakeGitWorld {
  readonly commitByBranch = new Map<string, string>();
  readonly worktrees: FakeWorktree[] = [];
  readonly commitByRef = new Map<string, string>();
  originHeadTarget: string | null = null;
  // Ref names `check-ref-format` should reject (git knows forms our conservative
  // grammar deliberately lets through, e.g. `x@{1}` — modelled, not guessed).
  readonly malformedRefs = new Set<string>();
  // Every argv the adapter issued, in order, EXCLUDING the `--version` preflight.
  readonly commands: string[][] = [];
  // Runs AFTER a command has been answered — the seam A6 uses to move a ref in
  // the window between `rev-parse` returning and `worktree add` being issued.
  // (Before-answer would poison the very answer under test.)
  afterCommand: (args: string[]) => void = () => {};
  // Commands whose joined argv should FAIL, mapped to git's stderr.
  readonly forcedFailures = new Map<string, string>();

  resolve(ref: string): string | null {
    return this.commitByBranch.get(ref) ?? this.commitByRef.get(ref) ?? null;
  }

  worktreeListPorcelain(): string {
    return this.worktrees
      .map((worktree) => {
        const lines = [`worktree ${worktree.path}`, `HEAD ${'0'.repeat(40)}`];
        if (worktree.branch !== null) {
          lines.push(`branch refs/heads/${worktree.branch}`);
        } else {
          lines.push('detached');
        }
        return `${lines.join('\n')}\n`;
      })
      .join('\n');
  }
}

function fakeGitRunner(world: FakeGitWorld): GitRunner {
  const ok = (stdout = ''): { stdout: string; stderr: string; exitCode: number } => ({
    stdout,
    stderr: '',
    exitCode: 0,
  });
  const fail = (stderr: string): { stdout: string; stderr: string; exitCode: number } => ({
    stdout: '',
    stderr,
    exitCode: 1,
  });

  const answer = async (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const joined = args.join(' ');
    const forced = world.forcedFailures.get(joined);
    if (forced !== undefined) {
      return fail(forced);
    }

    // rev-parse --verify --quiet --end-of-options <ref>^{commit}
    if (args[0] === 'rev-parse') {
      const peeled = args[args.length - 1] ?? '';
      const ref = peeled.replace(/\^\{commit\}$/, '');
      const commit = world.resolve(ref);
      return commit === null ? fail('') : ok(`${commit}\n`);
    }
    // check-ref-format refs/heads/<candidate>
    if (args[0] === 'check-ref-format') {
      const candidate = (args[1] ?? '').replace(/^refs\/heads\//, '');
      return world.malformedRefs.has(candidate) ? fail('') : ok();
    }
    // symbolic-ref --quiet refs/remotes/origin/HEAD
    if (args[0] === 'symbolic-ref') {
      return world.originHeadTarget === null ? fail('') : ok(`${world.originHeadTarget}\n`);
    }
    // show-ref --verify --quiet -- refs/heads/<branch>
    if (args[0] === 'show-ref') {
      const branch = (args[args.length - 1] ?? '').replace(/^refs\/heads\//, '');
      return world.commitByBranch.has(branch) ? ok() : fail('');
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return ok(world.worktreeListPorcelain());
    }
    // worktree add -b <branch> -- <path> <commit>
    if (args[0] === 'worktree' && args[1] === 'add' && args[2] === '-b') {
      const branch = args[3] ?? '';
      const path = args[5] ?? '';
      const commit = args[6] ?? '';
      if (world.commitByBranch.has(branch)) {
        return fail(`fatal: a branch named '${branch}' already exists`);
      }
      world.commitByBranch.set(branch, commit);
      world.worktrees.push({ path, branch });
      return ok();
    }
    // worktree add -- <path> <branch>
    if (args[0] === 'worktree' && args[1] === 'add' && args[2] === '--') {
      const path = args[3] ?? '';
      const branch = args[4] ?? '';
      world.worktrees.push({ path, branch });
      return ok();
    }
    // worktree remove -- <path>
    if (args[0] === 'worktree' && args[1] === 'remove') {
      const path = args[3] ?? '';
      const index = world.worktrees.findIndex((worktree) => worktree.path === path);
      if (index < 0) {
        return fail(`fatal: '${path}' is not a working tree`);
      }
      world.worktrees.splice(index, 1);
      return ok();
    }
    // branch -D -- <branch>
    if (args[0] === 'branch' && args[1] === '-D') {
      const branch = args[3] ?? '';
      if (!world.commitByBranch.delete(branch)) {
        return fail(`error: branch '${branch}' not found.`);
      }
      return ok();
    }
    return fail(`fake git: unmodelled command '${joined}'`);
  };

  return async (args) => {
    if (args[0] === '--version') {
      return ok('git version 2.43.0');
    }
    world.commands.push([...args]);
    const result = await answer([...args]);
    world.afterCommand([...args]);
    return result;
  };
}

// ── the harness ─────────────────────────────────────────────────────────────

interface CoordinatorHarness {
  coordinator: CheckoutCoordinator;
  world: FakeGitWorld;
  store: MemoryEventStore;
  nodeEvents: () => EventRecord[];
  nodeEventTypes: () => string[];
  warnings: string[];
  existingPaths: Set<string>;
  /** Make the NEXT `node_created` write throw — A8's injected bookkeeping failure. */
  failNextNodeWrite: (failure: Error) => void;
  declareProject: (projectId: string, root: string) => void;
  seedSession: (session: {
    appSessionId: string;
    cwd: string;
    liveness?: 'spawning' | 'running' | 'dormant' | 'interrupted' | 'dead';
    withTranscript?: boolean;
  }) => void;
}

function buildHarness(): CoordinatorHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-08-18T12:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  const world = new FakeGitWorld();
  const warnings: string[] = [];
  const existingPaths = new Set<string>();
  let pendingNodeWriteFailure: Error | null = null;

  const readProjects = () => replayFromEmpty(projectsProjection, readAllStreamsGrouped(store));
  const readNodes = () => replayFromEmpty(nodesProjection, readAllStreamsGrouped(store));
  const readSessions = () => replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store));

  const appendEvents = (events: EventInput[]): void => {
    store.append(events);
  };

  const nodeWriter = new NodeWriter({
    emit: (events) => {
      if (pendingNodeWriteFailure !== null) {
        const failure = pendingNodeWriteFailure;
        pendingNodeWriteFailure = null;
        throw failure;
      }
      appendEvents(events);
    },
    readProjects,
    readNodes,
    readSessions,
    // The writer never mints for the checkout path (§3.2) — a source that would
    // make that visible if it ever did.
    ids: {
      uuid: () => {
        throw new Error('NodeWriter must not mint an id on the checkout path');
      },
    },
  });

  const coordinator = new CheckoutCoordinator({
    adapter: new GitAdapter({ runner: fakeGitRunner(world) }),
    nodeWriter,
    emit: appendEvents,
    ids: new CountingIdSource(),
    readProjects,
    readNodes,
    readSessions,
    worktreeRoot: WORKTREE_ROOT,
    pathExists: async (path) => existingPaths.has(path),
    logWarn: (message) => warnings.push(message),
  });

  return {
    coordinator,
    world,
    store,
    nodeEvents: () => store.read('nodes', 1),
    nodeEventTypes: () => store.read('nodes', 1).map((record) => record.type),
    warnings,
    existingPaths,
    failNextNodeWrite: (failure) => {
      pendingNodeWriteFailure = failure;
    },
    declareProject: (projectId, root) => {
      store.append([projectCreated({ projectId, root })]);
    },
    seedSession: ({ appSessionId, cwd, liveness = 'running', withTranscript = false }) => {
      const events: EventInput[] = [
        sessionCreated({
          appSessionId,
          channel: 'sdk',
          cwd,
          name: null,
          forkedFrom: null,
          taskRef: null,
        }),
      ];
      if (withTranscript) {
        events.push(
          claudeSessionMapped({
            appSessionId,
            claudeSessionId: `claude-${appSessionId}`,
            jsonlPath: `/home/example/.claude/projects/x/${appSessionId}.jsonl`,
          }),
        );
      }
      events.push(livenessChanged({ appSessionId, to: liveness, cause: 'test' }));
      store.append(events);
    },
  };
}

// A repo with one live project, a `main` branch at a known commit, and the main
// checkout listed as a worktree — the starting point for almost every case.
function harnessWithRepo(): CoordinatorHarness {
  const harness = buildHarness();
  harness.declareProject(PROJECT_ID, PROJECT_ROOT);
  harness.world.commitByBranch.set('main', 'commit-main-1');
  harness.world.worktrees.push({ path: PROJECT_ROOT, branch: 'main' });
  return harness;
}

function refusalReasonOf(result: { outcome: string; reason?: CheckoutRefusalReason }): CheckoutRefusalReason {
  expect(result.outcome).toBe('refused');
  const reason = result.reason;
  expect(reason).toBeDefined();
  // Every reason is a member of the CLOSED enum — never free text.
  expect(checkoutRefusalReasonSchema.options).toContain(reason);
  return reason as CheckoutRefusalReason;
}

// ── A1: §3.10's state table, row by row ─────────────────────────────────────

describe('CheckoutCoordinator — A1: the §3.10 state table, row by row', () => {
  it('create: mints a branch off the resolved default and records provenance', async () => {
    const harness = harnessWithRepo();
    const result = await harness.coordinator.create({ projectId: PROJECT_ID });

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') {
      return;
    }
    expect(result.node.nodeId).toBe(nthNodeId(1));
    expect(result.node.provenance).toEqual({
      branch: nthCheckoutBranch(1),
      baseRef: 'main',
      resolvedCommit: 'commit-main-1',
      path: nthCheckoutPath(1),
    });
    expect(result.node.directory).toBe(nthCheckoutPath(1));
    // ONE nodes-stream event, and it is the birth record — not a second family.
    expect(harness.nodeEventTypes()).toEqual([EVENT_TYPES.nodeCreated]);
    // The checkout really exists in the fake world, at the derived path.
    expect(harness.world.worktrees.map((worktree) => worktree.path)).toContain(nthCheckoutPath(1));
  });

  it('create: §3.1 prefers origin/HEAD, then local main, then local master, then REFUSES', async () => {
    const withOrigin = harnessWithRepo();
    withOrigin.world.originHeadTarget = 'refs/remotes/origin/trunk';
    withOrigin.world.commitByRef.set('refs/remotes/origin/trunk', 'commit-trunk');
    const originResult = await withOrigin.coordinator.create({ projectId: PROJECT_ID });
    expect(originResult.outcome === 'created' && originResult.node.provenance).toMatchObject({
      baseRef: 'refs/remotes/origin/trunk',
      resolvedCommit: 'commit-trunk',
    });

    // No origin/HEAD, no `main`, but a `master` — step 3.
    const masterOnly = buildHarness();
    masterOnly.declareProject(PROJECT_ID, PROJECT_ROOT);
    masterOnly.world.commitByBranch.set('master', 'commit-master');
    const masterResult = await masterOnly.coordinator.create({ projectId: PROJECT_ID });
    expect(masterResult.outcome === 'created' && masterResult.node.provenance).toMatchObject({
      baseRef: 'master',
      resolvedCommit: 'commit-master',
    });

    // Nothing at all — step 4. An explicit base ref is then required.
    const bare = buildHarness();
    bare.declareProject(PROJECT_ID, PROJECT_ROOT);
    const bareResult = await bare.coordinator.create({ projectId: PROJECT_ID });
    expect(refusalReasonOf(bareResult)).toBe('no-default-branch');
    expect(bare.nodeEventTypes()).toEqual([]);
  });

  it('create: an explicit base ref is validated by BOTH halves of §3.9', async () => {
    const harness = harnessWithRepo();
    harness.world.malformedRefs.add('legal-to-us@ILLEGAL-to-git');

    // The pure grammar's half — git is never asked.
    const grammarRefusal = await harness.coordinator.create({ projectId: PROJECT_ID, baseRef: '../etc' });
    expect(refusalReasonOf(grammarRefusal)).toBe('invalid-ref');
    expect(grammarRefusal.outcome === 'refused' && grammarRefusal.detail).toBe('dot-dot');
    expect(harness.world.commands.some((call) => call[0] === 'check-ref-format')).toBe(false);

    // git's half — inside our grammar, outside git's.
    harness.world.malformedRefs.add('inside.our.grammar');
    const gitRefusal = await harness.coordinator.create({
      projectId: PROJECT_ID,
      baseRef: 'inside.our.grammar',
    });
    expect(refusalReasonOf(gitRefusal)).toBe('invalid-ref');
    expect(gitRefusal.outcome === 'refused' && gitRefusal.detail).toBe('check-ref-format');
    expect(harness.nodeEventTypes()).toEqual([]);
  });

  it('create: a well-formed ref that names nothing is unresolvable-ref, not git-failed', async () => {
    const harness = harnessWithRepo();
    const result = await harness.coordinator.create({ projectId: PROJECT_ID, baseRef: 'no/such/ref' });
    expect(refusalReasonOf(result)).toBe('unresolvable-ref');
    expect(harness.nodeEventTypes()).toEqual([]);
  });

  it('create: branch-already-exists NAMES the checkout path when one exists', async () => {
    const harness = harnessWithRepo();
    // The branch this create would derive is already there AND checked out.
    harness.world.commitByBranch.set(nthCheckoutBranch(1), 'commit-x');
    harness.world.worktrees.push({ path: '/somewhere/else', branch: nthCheckoutBranch(1) });

    const result = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(refusalReasonOf(result)).toBe('branch-already-exists');
    expect(result.outcome === 'refused' && result.detail).toBe('/somewhere/else');
    expect(harness.nodeEventTypes()).toEqual([]);
  });

  it('create: branch-already-exists OMITS the detail when the branch has no checkout', async () => {
    const harness = harnessWithRepo();
    harness.world.commitByBranch.set(nthCheckoutBranch(1), 'commit-x');

    const result = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(refusalReasonOf(result)).toBe('branch-already-exists');
    // ⚠ Round 2's wording catch: ABSENT, not empty-string, not the derived path.
    expect(result.outcome === 'refused' && result.detail).toBeUndefined();
  });

  it('create: an unknown or archived project refuses before any git command runs', async () => {
    const harness = harnessWithRepo();
    const result = await harness.coordinator.create({ projectId: 'proj-nope' });
    expect(refusalReasonOf(result)).toBe('unknown-project');
    expect(harness.world.commands).toEqual([]);
  });

  it('open: a branch that does not exist locally is branch-not-found', async () => {
    const harness = harnessWithRepo();
    const result = await harness.coordinator.open({ projectId: PROJECT_ID, branch: 'feature/ghost' });
    expect(refusalReasonOf(result)).toBe('branch-not-found');
    expect(harness.nodeEventTypes()).toEqual([]);
  });

  it('open: a branch checked out in ANOTHER worktree refuses — no reuse, no adoption', async () => {
    const harness = harnessWithRepo();
    harness.world.commitByBranch.set('feature/x', 'commit-fx');
    harness.world.worktrees.push({ path: '/elsewhere/feature-x', branch: 'feature/x' });

    const result = await harness.coordinator.open({ projectId: PROJECT_ID, branch: 'feature/x' });
    expect(refusalReasonOf(result)).toBe('branch-checked-out-elsewhere');
    expect(result.outcome === 'refused' && result.detail).toBe('/elsewhere/feature-x');
    // The foreign path is REPORTED, never reused.
    expect(harness.world.worktrees).toHaveLength(2);
  });

  it('open: a branch checked out in the MAIN checkout refuses by the same row', async () => {
    const harness = harnessWithRepo();
    // `main` is the main worktree's branch in the seeded world.
    const result = await harness.coordinator.open({ projectId: PROJECT_ID, branch: 'main' });
    expect(refusalReasonOf(result)).toBe('branch-checked-out-elsewhere');
    expect(result.outcome === 'refused' && result.detail).toBe(PROJECT_ROOT);
  });

  it('open: an occupied derived path is checkout-unrecorded-mismatch — loud, never repaired', async () => {
    const harness = harnessWithRepo();
    harness.world.commitByBranch.set('feature/x', 'commit-fx');
    harness.existingPaths.add(nthCheckoutPath(1));

    const result = await harness.coordinator.open({ projectId: PROJECT_ID, branch: 'feature/x' });
    expect(refusalReasonOf(result)).toBe('checkout-unrecorded-mismatch');
    expect(harness.world.commands.some((call) => call[0] === 'worktree' && call[1] === 'add')).toBe(false);
  });

  it('open: the free branch lands at the fresh node-derived path, tip recorded as resolvedCommit', async () => {
    const harness = harnessWithRepo();
    harness.world.commitByBranch.set('feature/x', 'commit-fx');

    const result = await harness.coordinator.open({ projectId: PROJECT_ID, branch: 'feature/x' });
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') {
      return;
    }
    expect(result.node.provenance).toEqual({
      branch: 'feature/x',
      baseRef: 'feature/x',
      resolvedCommit: 'commit-fx',
      path: nthCheckoutPath(1),
    });
    // ⚠ The PATH is node-derived even though the BRANCH is the caller's — §3.4.
    expect(result.node.provenance?.path).toBe(nthCheckoutPath(1));
    // …and `open` minted NO branch: `-b` never appeared.
    const addCommand = harness.world.commands.find(
      (call) => call[0] === 'worktree' && call[1] === 'add',
    );
    expect(addCommand).toEqual(['worktree', 'add', '--', nthCheckoutPath(1), 'feature/x']);
  });

  it('remove: removes the disk, emits checkout_removed, and PRESERVES the branch', async () => {
    const harness = harnessWithRepo();
    const created = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(created.outcome).toBe('created');

    const result = await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    expect(result).toEqual({
      outcome: 'removed',
      nodeId: nthNodeId(1),
      path: nthCheckoutPath(1),
      branch: nthCheckoutBranch(1),
      diskRemoved: true,
    });
    expect(harness.nodeEventTypes()).toEqual([EVENT_TYPES.nodeCreated, EVENT_TYPES.checkoutRemoved]);
    // A10: the branch survives, and no `branch -D` was ever issued.
    expect(harness.world.commitByBranch.has(nthCheckoutBranch(1))).toBe(true);
    expect(harness.world.commands.some((call) => call[0] === 'branch')).toBe(false);
    // …and so does the node, its provenance, and its tree position.
    const node = replayFromEmpty(nodesProjection, readAllStreamsGrouped(harness.store)).nodes[nthNodeId(1)];
    expect(node?.provenance?.path).toBe(nthCheckoutPath(1));
    expect(node?.closed).toBe(false);
  });

  it('remove: a SECOND remove is an idempotent success no-op with NO second event', async () => {
    const harness = harnessWithRepo();
    await harness.coordinator.create({ projectId: PROJECT_ID });
    await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    const typesAfterFirst = harness.nodeEventTypes();

    const second = await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    expect(second).toEqual({
      outcome: 'removed',
      nodeId: nthNodeId(1),
      path: nthCheckoutPath(1),
      branch: nthCheckoutBranch(1),
      diskRemoved: false,
    });
    // ⚠ NO SECOND `checkout_removed` — the audit fact says disk WAS removed.
    expect(harness.nodeEventTypes()).toEqual(typesAfterFirst);
  });

  it('remove: an unknown node, and a node with no provenance, each refuse by name', async () => {
    const harness = harnessWithRepo();
    expect(refusalReasonOf(await harness.coordinator.remove({ nodeId: 'node-nope' }))).toBe('unknown-node');

    // A plain group node, born through the PUBLIC writer path with provenance null.
    const groupNode = new NodeWriter({
      emit: (events) => harness.store.append(events),
      readProjects: () => replayFromEmpty(projectsProjection, readAllStreamsGrouped(harness.store)),
      readNodes: () => replayFromEmpty(nodesProjection, readAllStreamsGrouped(harness.store)),
      readSessions: () => replayFromEmpty(sessionsProjection, readAllStreamsGrouped(harness.store)),
      ids: new CountingIdSource(),
    }).createNode({ projectId: PROJECT_ID, parentNodeId: null, name: 'a group', directory: null });
    expect(groupNode.outcome).toBe('created');
    if (groupNode.outcome !== 'created') {
      return;
    }
    expect(refusalReasonOf(await harness.coordinator.remove({ nodeId: groupNode.node.nodeId }))).toBe(
      'not-a-checkout',
    );
    // §3.4: the target is derived from PROVENANCE ONLY, so a node without one
    // has no target and nothing on disk is touched.
    expect(harness.world.commands.some((call) => call[1] === 'remove')).toBe(false);
  });

  it('every member of the closed refusal vocabulary reads as a fact, never as free text', () => {
    for (const reason of checkoutRefusalReasonSchema.options) {
      expect(reason).toMatch(/^[a-z0-9-]+$/);
    }
    // ⚠ §3.3: "checkout busy" as a refusal DOES NOT EXIST — the lock queues.
    expect(checkoutRefusalReasonSchema.options).not.toContain('busy');
    expect(checkoutRefusalReasonSchema.options).not.toContain('checkout-busy');
  });
});

// ── A4: the remove gate, both prongs, independently ─────────────────────────

describe('CheckoutCoordinator — A4: the §3.3 remove gate, prong by prong', () => {
  async function harnessWithCheckout(): Promise<CoordinatorHarness> {
    const harness = harnessWithRepo();
    const created = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(created.outcome).toBe('created');
    return harness;
  }

  it('prong (a): a LIVE session with EMPTY claudeSessionIds blocks removal', async () => {
    const harness = await harnessWithCheckout();
    harness.seedSession({
      appSessionId: 'sess-live',
      cwd: nthCheckoutPath(1),
      liveness: 'running',
      withTranscript: false,
    });

    const result = await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    expect(refusalReasonOf(result)).toBe('checkout-in-use');
    expect(result.outcome === 'refused' && result.detail).toBe('sess-live');
    // Nothing removed, nothing emitted.
    expect(harness.world.worktrees.some((worktree) => worktree.path === nthCheckoutPath(1))).toBe(true);
    expect(harness.nodeEventTypes()).toEqual([EVENT_TYPES.nodeCreated]);
  });

  it('prong (b): a DEAD session WITH a transcript blocks removal', async () => {
    const harness = await harnessWithCheckout();
    harness.seedSession({
      appSessionId: 'sess-dead-resumable',
      cwd: nthCheckoutPath(1),
      liveness: 'dead',
      withTranscript: true,
    });

    const result = await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    expect(refusalReasonOf(result)).toBe('checkout-in-use');
    expect(result.outcome === 'refused' && result.detail).toBe('sess-dead-resumable');
  });

  it('neither prong: a DEAD session with NO transcript does NOT block removal', async () => {
    const harness = await harnessWithCheckout();
    harness.seedSession({
      appSessionId: 'sess-dead-empty',
      cwd: nthCheckoutPath(1),
      liveness: 'dead',
      withTranscript: false,
    });

    const result = await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    expect(result.outcome).toBe('removed');
    expect(harness.nodeEventTypes()).toContain(EVENT_TYPES.checkoutRemoved);
  });

  it('a session in a DIFFERENT directory never blocks, whichever prong it would trip', async () => {
    const harness = await harnessWithCheckout();
    harness.seedSession({ appSessionId: 'sess-elsewhere', cwd: PROJECT_ROOT, withTranscript: true });
    const result = await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    expect(result.outcome).toBe('removed');
  });

  it('names EVERY blocker, once each, sorted', async () => {
    const harness = await harnessWithCheckout();
    harness.seedSession({ appSessionId: 'sess-b', cwd: nthCheckoutPath(1), liveness: 'running' });
    harness.seedSession({
      appSessionId: 'sess-a',
      cwd: nthCheckoutPath(1),
      liveness: 'dormant',
      withTranscript: true,
    });
    const result = await harness.coordinator.remove({ nodeId: nthNodeId(1) });
    expect(refusalReasonOf(result)).toBe('checkout-in-use');
    // `sess-a` trips BOTH prongs; it is named once.
    expect(result.outcome === 'refused' && result.detail).toBe('sess-a,sess-b');
  });
});

// ── A6: the immutable base ──────────────────────────────────────────────────

describe('CheckoutCoordinator — A6: the base is the COMMIT, never the moving ref', () => {
  it('a ref that moves between resolve and add does not change what was checked out', async () => {
    const harness = harnessWithRepo();
    // The fake git world moves `main` the instant the resolution is answered —
    // the interleaving §3.1 exists to close.
    harness.world.afterCommand = (args) => {
      if (args[0] === 'rev-parse') {
        harness.world.commitByBranch.set('main', 'commit-main-2-MOVED');
      }
    };

    const result = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') {
      return;
    }
    // The ADD's operand is the resolved commit…
    const addCommand = harness.world.commands.find(
      (call) => call[0] === 'worktree' && call[1] === 'add',
    );
    expect(addCommand?.[addCommand.length - 1]).toBe('commit-main-1');
    // …and the recorded provenance matches it, not where the ref went.
    expect(result.node.provenance?.resolvedCommit).toBe('commit-main-1');
    expect(result.node.provenance?.baseRef).toBe('main');
    // The world really did move — the test would be vacuous otherwise.
    expect(harness.world.commitByBranch.get('main')).toBe('commit-main-2-MOVED');
  });
});

// ── A7: the coordinator lock ────────────────────────────────────────────────

describe('CheckoutCoordinator — A7: the queued lock (the rev-2 hazard, replayed)', () => {
  it('a remove behind a create-with-follow-up WAITS, then SEES the spawned session', async () => {
    const harness = harnessWithRepo();

    // Two deferreds drive the interleaving — no timers, no sleeps: the LOCK is
    // what is being proven, not a race that happens to come out our way.
    let signalFollowUpReached = (): void => {};
    const followUpReached = new Promise<void>((resolveReached) => {
      signalFollowUpReached = resolveReached;
    });
    let releaseFollowUp = (): void => {};
    const followUpReleased = new Promise<void>((resolveRelease) => {
      releaseFollowUp = resolveRelease;
    });

    const spawnInsideLock: InLockFollowUp = async (checkout) => {
      signalFollowUpReached();
      await followUpReleased;
      // U3's spawn+attach, modelled: the session is born INSIDE the checkout,
      // with `claudeSessionIds: []` (SP8·2) — the exact window rev 2 left open.
      harness.seedSession({ appSessionId: 'sess-dispatched', cwd: checkout.path, liveness: 'spawning' });
    };

    const createPromise = harness.coordinator.create({ projectId: PROJECT_ID }, spawnInsideLock);
    await followUpReached;

    // The node exists, the checkout exists, the session does NOT yet. Anything
    // evaluating the gate right now would let the removal through.
    expect(harness.nodeEventTypes()).toEqual([EVENT_TYPES.nodeCreated]);

    let removeSettled = false;
    const removePromise = harness.coordinator
      .remove({ nodeId: nthNodeId(1) })
      .then((result) => {
        removeSettled = true;
        return result;
      });

    // Give the microtask queue every chance to run the remove early. It cannot:
    // the lock is still held by the create's follow-up.
    for (let drainPass = 0; drainPass < 20; drainPass += 1) {
      await Promise.resolve();
    }
    expect(removeSettled).toBe(false);
    expect(harness.world.commands.some((call) => call[0] === 'worktree' && call[1] === 'remove')).toBe(
      false,
    );

    releaseFollowUp();
    const createResult = await createPromise;
    expect(createResult.outcome).toBe('created');

    const removeResult = await removePromise;
    // ⚠ The in-lock re-read SAW the session the follow-up spawned. Not "busy" —
    // a STATE refusal, which is the only 409 §3.3 allows.
    expect(refusalReasonOf(removeResult)).toBe('checkout-in-use');
    expect(removeResult.outcome === 'refused' && removeResult.detail).toBe('sess-dispatched');
    expect(harness.world.worktrees.some((worktree) => worktree.path === nthCheckoutPath(1))).toBe(true);
  });

  it('the lock is PER PROJECT: a second project is not serialized behind the first', async () => {
    const harness = harnessWithRepo();
    harness.declareProject(OTHER_PROJECT_ID, OTHER_PROJECT_ROOT);
    harness.world.commitByBranch.set('main', 'commit-main-1');

    let releaseFirst = (): void => {};
    const firstReleased = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });
    let signalFirstReached = (): void => {};
    const firstReached = new Promise<void>((resolveReached) => {
      signalFirstReached = resolveReached;
    });

    const blockedCreate = harness.coordinator.create({ projectId: PROJECT_ID }, async () => {
      signalFirstReached();
      await firstReleased;
    });
    await firstReached;

    // A DIFFERENT project's create runs to completion while the first is parked.
    const otherResult = await harness.coordinator.create({ projectId: OTHER_PROJECT_ID });
    expect(otherResult.outcome).toBe('created');

    releaseFirst();
    expect((await blockedCreate).outcome).toBe('created');
  });

  it('a failed operation does not poison the queue behind it', async () => {
    const harness = harnessWithRepo();
    harness.failNextNodeWrite(new Error('event store is down'));
    await expect(harness.coordinator.create({ projectId: PROJECT_ID })).rejects.toThrow(
      'event store is down',
    );
    // The next waiter on the SAME project's lock runs normally.
    const next = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(next.outcome).toBe('created');
  });
});

// ── A8: compensation ────────────────────────────────────────────────────────

describe('CheckoutCoordinator — A8: §3.7 compensation leaves zero orphans', () => {
  it('create: an event-write throw removes the checkout AND the branch, then fails loudly', async () => {
    const harness = harnessWithRepo();
    harness.failNextNodeWrite(new Error('nodes stream unavailable'));

    await expect(harness.coordinator.create({ projectId: PROJECT_ID })).rejects.toThrow(
      'nodes stream unavailable',
    );

    // ⚠ ZERO ORPHANS: no checkout, no branch, nothing recorded.
    expect(harness.world.worktrees.some((worktree) => worktree.path === nthCheckoutPath(1))).toBe(false);
    expect(harness.world.commitByBranch.has(nthCheckoutBranch(1))).toBe(false);
    expect(harness.nodeEventTypes()).toEqual([]);
    expect(await harness.coordinator.listOrphans()).toEqual([]);
    // Both compensating commands really ran, in order.
    const compensating = harness.world.commands.filter(
      (call) => (call[0] === 'worktree' && call[1] === 'remove') || call[0] === 'branch',
    );
    expect(compensating).toEqual([
      ['worktree', 'remove', '--', nthCheckoutPath(1)],
      ['branch', '-D', '--', nthCheckoutBranch(1)],
    ]);

    // …and a fresh create succeeds beside the wreckage, with a fresh identity.
    const fresh = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(fresh.outcome).toBe('created');
    expect(fresh.outcome === 'created' && fresh.node.nodeId).toBe(nthNodeId(2));
  });

  it('create: a FOLLOW-UP throw compensates identically — the spawn is part of the sequence', async () => {
    const harness = harnessWithRepo();
    await expect(
      harness.coordinator.create({ projectId: PROJECT_ID }, async () => {
        throw new Error('spawn refused');
      }),
    ).rejects.toThrow('spawn refused');

    expect(harness.world.worktrees.some((worktree) => worktree.path === nthCheckoutPath(1))).toBe(false);
    expect(harness.world.commitByBranch.has(nthCheckoutBranch(1))).toBe(false);
    expect(await harness.coordinator.listOrphans()).toEqual([]);
  });

  it('open: compensation removes the checkout ONLY — the pre-existing branch SURVIVES', async () => {
    const harness = harnessWithRepo();
    harness.world.commitByBranch.set('feature/precious', 'commit-fp');
    harness.failNextNodeWrite(new Error('nodes stream unavailable'));

    await expect(
      harness.coordinator.open({ projectId: PROJECT_ID, branch: 'feature/precious' }),
    ).rejects.toThrow('nodes stream unavailable');

    expect(harness.world.worktrees.some((worktree) => worktree.path === nthCheckoutPath(1))).toBe(false);
    // ⚠ THE WHOLE POINT: the branch was the human's, not ours to delete.
    expect(harness.world.commitByBranch.get('feature/precious')).toBe('commit-fp');
    expect(harness.world.commands.some((call) => call[0] === 'branch')).toBe(false);
  });

  it('a compensation that itself fails is logged LOUD and still rethrows the original', async () => {
    const harness = harnessWithRepo();
    harness.failNextNodeWrite(new Error('nodes stream unavailable'));
    harness.world.forcedFailures.set(
      `worktree remove -- ${nthCheckoutPath(1)}`,
      'fatal: contains modified or untracked files',
    );

    await expect(harness.coordinator.create({ projectId: PROJECT_ID })).rejects.toThrow(
      // The ORIGINAL failure, not the compensation's — that is what a human needs.
      'nodes stream unavailable',
    );
    expect(harness.warnings.join('\n')).toContain('compensation FAILED to remove');
    // …and what it left behind is exactly an orphan, which discovery then finds.
    const orphans = await harness.coordinator.listOrphans();
    expect(orphans).toEqual([
      { projectId: PROJECT_ID, path: nthCheckoutPath(1), branch: `refs/heads/${nthCheckoutBranch(1)}` },
    ]);
  });
});

// ── A9: orphan discovery ────────────────────────────────────────────────────

describe('CheckoutCoordinator — A9: orphan discovery is discovery, never adoption', () => {
  it('lists an unclaimed checkout under worktreeRoot, and NOT a claimed one', async () => {
    const harness = harnessWithRepo();
    const claimed = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(claimed.outcome).toBe('created');

    // A checkout nobody's provenance claims — what process death leaves behind.
    harness.world.worktrees.push({
      path: `${WORKTREE_ROOT}/node-orphaned-0001`,
      branch: 'vimes/node-orphaned-0001',
    });

    expect(await harness.coordinator.listOrphans()).toEqual([
      {
        projectId: PROJECT_ID,
        path: `${WORKTREE_ROOT}/node-orphaned-0001`,
        branch: 'refs/heads/vimes/node-orphaned-0001',
      },
    ]);
  });

  it('a worktree OUTSIDE worktreeRoot is a human’s own business, never an orphan', async () => {
    const harness = harnessWithRepo();
    harness.world.worktrees.push({ path: '/home/example/scratch/wip', branch: 'wip' });
    expect(await harness.coordinator.listOrphans()).toEqual([]);
    // …and neither is the main checkout, which the list always reports.
    expect(harness.world.worktrees.some((worktree) => worktree.path === PROJECT_ROOT)).toBe(true);
  });

  it('a fresh create beside an orphan neither collides with it nor adopts it', async () => {
    const harness = harnessWithRepo();
    harness.world.worktrees.push({
      path: `${WORKTREE_ROOT}/node-orphaned-0001`,
      branch: 'vimes/node-orphaned-0001',
    });

    const result = await harness.coordinator.create({ projectId: PROJECT_ID });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') {
      return;
    }
    // A fresh uuid ⇒ a fresh branch and path. No collision…
    expect(result.node.provenance?.path).toBe(nthCheckoutPath(1));
    expect(result.node.provenance?.path).not.toBe(`${WORKTREE_ROOT}/node-orphaned-0001`);
    // …and NO ADOPTION: the orphan is still an orphan afterwards.
    expect(await harness.coordinator.listOrphans()).toEqual([
      {
        projectId: PROJECT_ID,
        path: `${WORKTREE_ROOT}/node-orphaned-0001`,
        branch: 'refs/heads/vimes/node-orphaned-0001',
      },
    ]);
  });

  it('a project whose repository cannot be listed is SKIPPED with a warn, never a throw', async () => {
    const harness = harnessWithRepo();
    harness.world.forcedFailures.set('worktree list --porcelain', 'fatal: not a git repository');
    expect(await harness.coordinator.listOrphans()).toEqual([]);
    expect(harness.warnings.join('\n')).toContain('orphan scan skipped project');
  });
});
