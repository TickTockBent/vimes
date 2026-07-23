import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '@vimes/core';
import type { GitRunResult, GitRunner } from './gitAdapter.js';
import { loadConfigFromEnv } from './config.js';
import { WorktreeManager } from './worktreeManager.js';

// ─── slice 6 step 8, assertions 4–7 — the worktree manager ───────────────────
//
// ⚠ **NOT ONE REAL GIT COMMAND RUNS IN THIS FILE, AND NO WORKTREE IS EVER CREATED
// ANYWHERE.** Every case drives a FAKE `GitRunner` that records the arg-vectors it
// was handed and replays canned stdout/stderr. That is not merely convenient: this
// test suite runs inside the vimes checkout, and a manager test that actually
// created a worktree would leave one in the repo it is being developed in.
//
// The recorded arg-vectors are the load-bearing instrument, exactly as `spawnCalls`
// is in taskDispatcher.test.ts. For idempotence it is not enough to see the right
// path come back — an implementation that ran `git worktree add` a second time and
// swallowed git's "already exists" error would return the same path while paying
// for a subprocess and clobbering nothing only by luck. So the reuse case asserts
// WHICH COMMANDS RAN, not just what came back.

const PROJECT_ROOT = '/home/ticktockbent/projects/infrastructure/vimes';
const WORKTREE_ROOT = '/var/lib/vimes-worktrees';
const TASK_ID = 'task-dispatch-0001';
// Derived by core's pure `worktreePaths` — restated here as literals on purpose, so
// this file pins the CONTRACT rather than re-running the derivation it is checking.
const EXPECTED_BRANCH = 'vimes/task-task-dispatch-0001';
const EXPECTED_PATH = `${WORKTREE_ROOT}/task-task-dispatch-0001`;

// A fixed clock: two readings per ensureWorktree (start, end), stepping by a known
// amount, so `setupMs` is a deterministic number rather than a race.
const CLOCK_START_MS = 1_000_000;
const CLOCK_STEP_MS = 250;

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    projectRoot: PROJECT_ROOT,
    stage: 'implementing',
    manualReviewRequired: false,
    isolation: 'worktree',
    gates: {},
    sessionRefs: [],
    createdBy: 'human',
    lastHeartbeatAt: null,
    staleRetries: 0,
    ...overrides,
  };
}

// Real `git worktree list --porcelain` output (the shape gitAdapter's parser was
// unit-tested against in Spike G), with an optional extra record for this task.
function worktreeListOutput(extraRecords: string[] = []): string {
  const mainRecord = [
    `worktree ${PROJECT_ROOT}`,
    'HEAD 81ddf1600000000000000000000000000000000a',
    'branch refs/heads/master',
  ].join('\n');
  return [mainRecord, ...extraRecords].join('\n\n') + '\n\n';
}

function taskWorktreeRecord(path = EXPECTED_PATH, branch = EXPECTED_BRANCH): string {
  return [
    `worktree ${path}`,
    'HEAD 81ddf1600000000000000000000000000000000a',
    `branch refs/heads/${branch}`,
  ].join('\n');
}

interface RecordedGitCall {
  args: string[];
  cwd: string;
}

interface FakeGit {
  runner: GitRunner;
  calls: RecordedGitCall[];
  argVectors: () => string[][];
}

// Responses are keyed by the git SUBCOMMAND (args[1]) so a case only has to say
// what `list` and `add` should do. An unstubbed subcommand succeeds emptily.
// `throwOnSubcommand` makes the runner itself explode, which is a different failure
// from git exiting non-zero and the manager has to survive both.
function fakeGit(
  responses: Partial<Record<string, GitRunResult>> = {},
  throwOnSubcommand?: string,
): FakeGit {
  const calls: RecordedGitCall[] = [];
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    if (throwOnSubcommand !== undefined && args[1] === throwOnSubcommand) {
      throw new Error('runner exploded');
    }
    return responses[args[1] ?? ''] ?? { stdout: '', stderr: '', exitCode: 0 };
  };
  return { runner, calls, argVectors: () => calls.map((call) => call.args) };
}

function buildManager(
  fake: FakeGit,
  options: { worktreeRoot?: string } = {},
): { manager: WorktreeManager; clockReadCount: () => number } {
  let clockReadCount = 0;
  const manager = new WorktreeManager({
    runner: fake.runner,
    worktreeRoot: options.worktreeRoot ?? WORKTREE_ROOT,
    // The INJECTED clock (rule 0.3). Steps by a fixed amount per read, so elapsed
    // time is a function of how many readings the code takes — deterministic, and
    // it also makes an accidental extra clock read visible.
    nowMs: () => {
      const currentMs = CLOCK_START_MS + clockReadCount * CLOCK_STEP_MS;
      clockReadCount += 1;
      return currentMs;
    },
  });
  return { manager, clockReadCount: () => clockReadCount };
}

describe('WorktreeManager — assertion 4: creation is array args with a -- guard', () => {
  it('lists first, then adds the derived branch at the derived path', async () => {
    const fake = fakeGit({ list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 } });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({
      ok: true,
      path: EXPECTED_PATH,
      branch: EXPECTED_BRANCH,
      reused: false,
    });
    expect(fake.argVectors()).toEqual([
      ['worktree', 'list', '--porcelain'],
      // ⚠ THE INJECTION-SAFETY SHAPE, asserted element by element: the branch is
      // BOUND to `-b` (so it can never be read as an option), and the path sits
      // AFTER a `--` guard (so a leading dash could never be read as one either).
      ['worktree', 'add', '-b', EXPECTED_BRANCH, '--', EXPECTED_PATH],
    ]);
    // The `--` really is before the task-derived operand, not merely present.
    const addArgs = fake.argVectors()[1]!;
    expect(addArgs.indexOf('--')).toBeLessThan(addArgs.indexOf(EXPECTED_PATH));
    // Both commands run IN THE PROJECT ROOT — a worktree is added from the repo it
    // belongs to, never from the worktree root or the daemon's cwd.
    expect(fake.calls.map((call) => call.cwd)).toEqual([PROJECT_ROOT, PROJECT_ROOT]);
  });

  it('never builds a shell string — every element is a separate argument', async () => {
    // The boundary `gitAdapter` documents, restated as an assertion: nothing the
    // caller supplies is ever concatenated into one argv element.
    const fake = fakeGit({ list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 } });
    const { manager } = buildManager(fake);
    await manager.ensureWorktree(taskRecord());

    for (const argVector of fake.argVectors()) {
      for (const argument of argVector) {
        expect(argument).not.toContain(' ');
      }
    }
  });

  it('a hostile taskId still produces one safe operand', async () => {
    // The sanitiser lives in core and is tested there; this is the END-TO-END proof
    // that the manager passes its output through unmodified and that no traversal
    // reaches an argv element.
    const fake = fakeGit({ list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 } });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord({ taskId: '../../etc/passwd' }));

    expect(result.ok).toBe(true);
    expect(result.path.startsWith(`${WORKTREE_ROOT}/`)).toBe(true);
    expect(result.path).not.toContain('..');
    expect(result.branch.startsWith('vimes/task-')).toBe(true);
    const addArgs = fake.argVectors()[1]!;
    expect(addArgs).toEqual(['worktree', 'add', '-b', result.branch, '--', result.path]);
  });
});

describe('WorktreeManager — assertion 5: ensureWorktree is IDEMPOTENT', () => {
  it('reuses an existing worktree and does NOT call `git worktree add` again', async () => {
    // ⚠ THE ASSERTION THAT MATTERS IS THE ARG-VECTOR ONE. Returning the right path
    // is not proof of idempotence; running exactly one command — the list — is.
    const fake = fakeGit({
      list: { stdout: worktreeListOutput([taskWorktreeRecord()]), stderr: '', exitCode: 0 },
    });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({ ok: true, path: EXPECTED_PATH, reused: true });
    expect(fake.argVectors()).toEqual([['worktree', 'list', '--porcelain']]);
    expect(fake.argVectors().some((argVector) => argVector[1] === 'add')).toBe(false);
  });

  it('a repeated dispatch converges: created once, then reused forever', async () => {
    // The retry story end to end. The fake's list output starts empty and gains the
    // record the first `add` would have produced — so the second and third calls see
    // the world the first one made.
    let worktreeExists = false;
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === 'list') {
        return {
          stdout: worktreeListOutput(worktreeExists ? [taskWorktreeRecord()] : []),
          stderr: '',
          exitCode: 0,
        };
      }
      worktreeExists = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const manager = new WorktreeManager({
      runner,
      worktreeRoot: WORKTREE_ROOT,
      nowMs: () => CLOCK_START_MS,
    });

    const firstResult = await manager.ensureWorktree(taskRecord());
    const secondResult = await manager.ensureWorktree(taskRecord());
    const thirdResult = await manager.ensureWorktree(taskRecord());

    expect(firstResult).toMatchObject({ ok: true, reused: false, path: EXPECTED_PATH });
    expect(secondResult).toMatchObject({ ok: true, reused: true, path: EXPECTED_PATH });
    expect(thirdResult).toMatchObject({ ok: true, reused: true, path: EXPECTED_PATH });
    // Exactly ONE add across three dispatches.
    expect(calls.filter((argVector) => argVector[1] === 'add')).toHaveLength(1);
  });

  it('recognises the worktree by BRANCH even when it sits at another path', async () => {
    // The branch is derived from the taskId alone, so a worktree holding it IS this
    // task's worktree wherever it lives. A path-only check would try to `add` a
    // branch git already has checked out and fail forever.
    const relocatedPath = '/somewhere/else/task-task-dispatch-0001';
    const fake = fakeGit({
      list: {
        stdout: worktreeListOutput([taskWorktreeRecord(relocatedPath)]),
        stderr: '',
        exitCode: 0,
      },
    });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({ ok: true, reused: true, path: relocatedPath });
    expect(fake.argVectors()).toEqual([['worktree', 'list', '--porcelain']]);
  });

  it('a DIFFERENT task’s worktree is not mistaken for this one', () => {
    // The other direction, so reuse cannot degrade into "any worktree will do".
    const otherRecord = taskWorktreeRecord(
      `${WORKTREE_ROOT}/task-some-other-task`,
      'vimes/task-some-other-task',
    );
    const fake = fakeGit({
      list: { stdout: worktreeListOutput([otherRecord]), stderr: '', exitCode: 0 },
    });
    const { manager } = buildManager(fake);

    return manager.ensureWorktree(taskRecord()).then((result) => {
      expect(result).toMatchObject({ ok: true, reused: false, path: EXPECTED_PATH });
      expect(fake.argVectors()).toHaveLength(2);
    });
  });
});

describe('WorktreeManager — assertion 6: every failure is a RESULT, never a throw', () => {
  // Each case names a real failure the design listed, and asserts three things: it
  // did not throw, it classified the failure, and it CARRIED GIT'S OWN STDERR — a
  // coarse enum is only acceptable because nothing git said is lost.

  it('git missing (spawn failure, exitCode null) → git-unavailable', async () => {
    const fake = fakeGit({
      list: { stdout: '', stderr: 'spawn git ENOENT', exitCode: null },
    });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({
      ok: false,
      reason: 'git-unavailable',
      detail: 'spawn git ENOENT',
      path: EXPECTED_PATH,
      branch: EXPECTED_BRANCH,
    });
  });

  it('not a repo (list exits non-zero) → not-a-repo, with git’s words', async () => {
    const fake = fakeGit({
      list: {
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
        exitCode: 128,
      },
    });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({ ok: false, reason: 'not-a-repo' });
    expect(result.ok === false && result.detail).toContain('not a git repository');
    // And NO add was attempted against a directory that is not a repo.
    expect(fake.argVectors()).toEqual([['worktree', 'list', '--porcelain']]);
  });

  it('the path already exists as a FILE → worktree-add-failed, with git’s words', async () => {
    const fake = fakeGit({
      list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 },
      add: { stdout: '', stderr: `fatal: '${EXPECTED_PATH}' already exists\n`, exitCode: 128 },
    });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({ ok: false, reason: 'worktree-add-failed' });
    expect(result.ok === false && result.detail).toBe(`fatal: '${EXPECTED_PATH}' already exists`);
  });

  it('the branch already exists → worktree-add-failed, with git’s words', async () => {
    const fake = fakeGit({
      list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 },
      add: {
        stdout: '',
        stderr: `fatal: a branch named '${EXPECTED_BRANCH}' already exists\n`,
        exitCode: 128,
      },
    });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({ ok: false, reason: 'worktree-add-failed' });
    expect(result.ok === false && result.detail).toContain('already exists');
  });

  it('permission denied → worktree-add-failed, with git’s words', async () => {
    const fake = fakeGit({
      list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 },
      add: {
        stdout: '',
        stderr: `fatal: could not create directory '${EXPECTED_PATH}': Permission denied\n`,
        exitCode: 128,
      },
    });
    const { manager } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({ ok: false, reason: 'worktree-add-failed' });
    expect(result.ok === false && result.detail).toContain('Permission denied');
  });

  it('a RUNNER THAT THROWS is caught — an injected adapter is never assumed well-behaved', async () => {
    const fake = fakeGit({}, 'list');
    const { manager } = buildManager(fake);

    let result: Awaited<ReturnType<WorktreeManager['ensureWorktree']>> | undefined;
    await expect(
      (async () => {
        result = await manager.ensureWorktree(taskRecord());
      })(),
    ).resolves.toBeUndefined();

    expect(result).toMatchObject({
      ok: false,
      reason: 'git-unavailable',
      detail: 'git-runner-threw:runner exploded',
    });
  });

  it('a RELATIVE worktreeRoot is refused BEFORE git is touched', async () => {
    // Our own precondition rather than git's: a relative root would resolve against
    // whatever cwd the daemon happens to hold, i.e. a directory nobody chose.
    const fake = fakeGit();
    const { manager } = buildManager(fake, { worktreeRoot: 'relative/worktrees' });

    const result = await manager.ensureWorktree(taskRecord());

    expect(result).toMatchObject({ ok: false, reason: 'worktree-root-not-absolute' });
    expect(fake.calls).toHaveLength(0);
  });

  it('NO failure path ever returns the project root as a working directory', async () => {
    // ⚠ THE SAFETY PROPERTY, ASSERTED AT THE MANAGER TOO. The dispatcher is where a
    // fallback would actually bite, but a manager that quietly answered "just use
    // projectRoot" would make the dispatcher's guard unreachable. Every failure
    // result carries `ok: false` and the path it WOULD have used — never the shared
    // directory.
    const failureCases: GitRunResult[] = [
      { stdout: '', stderr: 'spawn git ENOENT', exitCode: null },
      { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 },
    ];
    for (const listResponse of failureCases) {
      const fake = fakeGit({ list: listResponse });
      const { manager } = buildManager(fake);
      const result = await manager.ensureWorktree(taskRecord());
      expect(result.ok).toBe(false);
      expect(result.path).not.toBe(PROJECT_ROOT);
      expect(JSON.stringify(result)).not.toContain(`"${PROJECT_ROOT}"`);
    }
  });
});

describe('WorktreeManager — assertion 7: setupMs comes from the INJECTED clock', () => {
  it('is deterministic under a fixed clock, and measures the whole call', async () => {
    const fake = fakeGit({ list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 } });
    const { manager, clockReadCount } = buildManager(fake);

    const result = await manager.ensureWorktree(taskRecord());

    // Two readings: one before the list, one after the add returns. The stepping
    // clock therefore reports exactly one step of elapsed time.
    expect(clockReadCount()).toBe(2);
    expect(result.setupMs).toBe(CLOCK_STEP_MS);
  });

  it('two managers with the same fixed clock report the SAME setupMs', async () => {
    // Determinism stated as the property rather than as a number: nothing here reads
    // a wall clock, so identical inputs give identical output.
    const measureOnce = async (): Promise<number> => {
      const fake = fakeGit({ list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 } });
      const { manager } = buildManager(fake);
      return (await manager.ensureWorktree(taskRecord())).setupMs;
    };
    expect(await measureOnce()).toBe(await measureOnce());
  });

  it('a FROZEN clock reports 0 — the value is the clock’s, not the wall’s', async () => {
    // The blunt proof that no `Date.now()` hides in this module: freeze the injected
    // clock and the measured cost is zero no matter how long the call really took.
    const fake = fakeGit({ list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 } });
    const manager = new WorktreeManager({
      runner: fake.runner,
      worktreeRoot: WORKTREE_ROOT,
      nowMs: () => 42,
    });

    const result = await manager.ensureWorktree(taskRecord());

    expect(result.setupMs).toBe(0);
  });

  it('reports setupMs on the REUSE path and on the FAILURE path too', async () => {
    // A reuse costs one `git worktree list`, and knowing what that costs is part of
    // pricing D32's axis; a failure that reported no cost would leave a hole in the
    // same column.
    const reuseFake = fakeGit({
      list: { stdout: worktreeListOutput([taskWorktreeRecord()]), stderr: '', exitCode: 0 },
    });
    const reuseResult = await buildManager(reuseFake).manager.ensureWorktree(taskRecord());
    expect(reuseResult).toMatchObject({ reused: true, setupMs: CLOCK_STEP_MS });

    const failureFake = fakeGit({ list: { stdout: '', stderr: 'fatal: nope', exitCode: 128 } });
    const failureResult = await buildManager(failureFake).manager.ensureWorktree(taskRecord());
    expect(failureResult).toMatchObject({ ok: false, setupMs: CLOCK_STEP_MS });
  });
});

describe('WorktreeManager — removeWorktree is BUILT AND WIRED TO NOTHING', () => {
  // ⚠ These cases exercise the function directly. **Nothing in VIMES calls it** —
  // see the method's own comment: when a task's worktree should be destroyed is a
  // policy decision with real trade-offs (disk against preserving the work context)
  // and it is Wes's, not an implementer's. Testing it now is rule 0.5: the shape
  // lands early so whichever answer is chosen needs no new plumbing.

  it('removes an existing worktree with array args and a -- guard', async () => {
    const fake = fakeGit({
      list: { stdout: worktreeListOutput([taskWorktreeRecord()]), stderr: '', exitCode: 0 },
    });
    const { manager } = buildManager(fake);

    const result = await manager.removeWorktree(taskRecord());

    expect(result).toEqual({ ok: true, path: EXPECTED_PATH, removed: true });
    expect(fake.argVectors()).toEqual([
      ['worktree', 'list', '--porcelain'],
      ['worktree', 'remove', '--', EXPECTED_PATH],
    ]);
  });

  it('is a no-op when there is nothing to remove, and says so', async () => {
    const fake = fakeGit({ list: { stdout: worktreeListOutput(), stderr: '', exitCode: 0 } });
    const { manager } = buildManager(fake);

    const result = await manager.removeWorktree(taskRecord());

    expect(result).toEqual({ ok: true, path: EXPECTED_PATH, removed: false });
    expect(fake.argVectors()).toEqual([['worktree', 'list', '--porcelain']]);
  });

  it('a refused removal is a RESULT carrying git’s words, never a throw', async () => {
    const fake = fakeGit({
      list: { stdout: worktreeListOutput([taskWorktreeRecord()]), stderr: '', exitCode: 0 },
      remove: {
        stdout: '',
        stderr: `fatal: '${EXPECTED_PATH}' contains modified or untracked files, use --force to delete it\n`,
        exitCode: 128,
      },
    });
    const { manager } = buildManager(fake);

    const result = await manager.removeWorktree(taskRecord());

    expect(result).toMatchObject({ ok: false, reason: 'worktree-remove-failed' });
    expect(result.ok === false && result.detail).toContain('modified or untracked files');
  });

  it('never passes --force — a dirty worktree is preserved, not destroyed', async () => {
    // The work context is the thing a human looks at when asking "what did that
    // agent actually do?". Forcing removal past uncommitted work would throw exactly
    // that away, and nothing in this step is entitled to make that call.
    const fake = fakeGit({
      list: { stdout: worktreeListOutput([taskWorktreeRecord()]), stderr: '', exitCode: 0 },
    });
    const { manager } = buildManager(fake);
    await manager.removeWorktree(taskRecord());

    for (const argVector of fake.argVectors()) {
      expect(argVector).not.toContain('--force');
      expect(argVector).not.toContain('-f');
    }
  });

  it('does NOT delete the branch — that would destroy commits', async () => {
    const fake = fakeGit({
      list: { stdout: worktreeListOutput([taskWorktreeRecord()]), stderr: '', exitCode: 0 },
    });
    const { manager } = buildManager(fake);
    await manager.removeWorktree(taskRecord());

    expect(fake.argVectors().some((argVector) => argVector[0] === 'branch')).toBe(false);
    expect(fake.argVectors().some((argVector) => argVector.includes('-D'))).toBe(false);
  });
});

// ─── the config boundary (slice 6 step 8) ────────────────────────────────────
//
// Same idiom as the watchdog's knobs in taskWatchdog.test.ts: the parser is tested
// where its feature lives. `loadConfigFromEnv` is pure over the env object it is
// handed, so nothing here reads `process.env` or touches a real deployment.

describe('config — VIMES_WORKTREE_ISOLATION defaults to OFF', () => {
  it('⚠ THE SHIPPING PROMISE: an unset env means `off`', () => {
    // If this ever reads `on`, the daemon has started isolating real work on a real
    // machine without anybody deciding to. That is the whole point of the assertion.
    expect(loadConfigFromEnv({}).worktreeIsolation).toBe('off');
    expect(loadConfigFromEnv({ VIMES_WORKTREE_ISOLATION: '' }).worktreeIsolation).toBe('off');
  });

  it('accepts on/off, case- and whitespace-insensitively', () => {
    // An operator who meant to turn it on and typed it in caps must not silently get
    // the off world.
    expect(loadConfigFromEnv({ VIMES_WORKTREE_ISOLATION: 'on' }).worktreeIsolation).toBe('on');
    expect(loadConfigFromEnv({ VIMES_WORKTREE_ISOLATION: 'ON' }).worktreeIsolation).toBe('on');
    expect(loadConfigFromEnv({ VIMES_WORKTREE_ISOLATION: '  on  ' }).worktreeIsolation).toBe('on');
    expect(loadConfigFromEnv({ VIMES_WORKTREE_ISOLATION: 'Off' }).worktreeIsolation).toBe('off');
  });

  it('REFUSES an unrecognised value rather than reading it as `off`', () => {
    // Off is the safe direction, which is exactly why defaulting to it here would be
    // dangerous in the other sense: an operator who wrote `=true` and believed their
    // workers were isolated would be running everything in the shared project root,
    // with nothing anywhere to tell them.
    for (const hostileValue of ['true', '1', 'yes', 'enabled', 'onn']) {
      expect(() => loadConfigFromEnv({ VIMES_WORKTREE_ISOLATION: hostileValue })).toThrow(
        /VIMES_WORKTREE_ISOLATION/,
      );
    }
  });
});

describe('config — VIMES_WORKTREE_ROOT defaults beside the data dir', () => {
  it('defaults to a SIBLING of the data dir, never inside a project root', () => {
    // The file/git/search APIs scope themselves to `projectRoots ∪ live-session
    // cwds`. A worktree root inside a project root would make every task's private
    // worker directory browsable as if it were a project of its own.
    const config = loadConfigFromEnv({
      VIMES_DB_PATH: '/srv/vimes-data/events.db',
      VIMES_PROJECT_ROOTS: '/home/someone/projects',
    });
    expect(config.dataDir).toBe('/srv/vimes-data');
    expect(config.worktreeRoot).toBe('/srv/vimes-data-worktrees');
    for (const projectRoot of config.projectRoots) {
      expect(config.worktreeRoot.startsWith(`${projectRoot}/`)).toBe(false);
    }
  });

  it('follows VIMES_DATA_DIR when that is what names the data dir', () => {
    const config = loadConfigFromEnv({
      VIMES_DB_PATH: '/srv/elsewhere/events.db',
      VIMES_DATA_DIR: '/var/lib/vimes',
    });
    expect(config.worktreeRoot).toBe('/var/lib/vimes-worktrees');
  });

  it('an explicit root wins, and is resolved absolute', () => {
    expect(
      loadConfigFromEnv({ VIMES_WORKTREE_ROOT: '/mnt/fast/worktrees/' }).worktreeRoot,
    ).toBe('/mnt/fast/worktrees');
    expect(loadConfigFromEnv({ VIMES_WORKTREE_ROOT: '/mnt/a/b/../worktrees' }).worktreeRoot).toBe(
      '/mnt/a/worktrees',
    );
  });
});
