import { isAbsolute, resolve } from 'node:path';
import { taskWorktreeBranch, taskWorktreeDirName, type TaskRecord } from '@vimes/core';
import { parseWorktrees, type GitRunner } from './gitAdapter.js';

// ─── slice 6 step 8 — the worktree manager (daemon I/O) ──────────────────────
//
// D32 pinned `worktree` as the default isolation and step 4a deliberately did not
// honour it: every task, whatever its record said, ran in `task.projectRoot`. This
// class is the half that makes the field real — it turns a `TaskRecord` into a
// checked-out git worktree the dispatcher can spawn into.
//
// ⚠ **THE WHOLE THING SHIPS BEHIND AN OFF-BY-DEFAULT FLAG.** Nothing here runs in
// production until `VIMES_WORKTREE_ISOLATION=on` — see `config.ts` and the
// dispatcher's resolution note. This module is complete, wired and tested; the
// behaviour-changing flip is a human's, made deliberately.
//
// What this module is NOT:
//   • It is not a git service. `gitAdapter.ts` owns the read/parse surface the git
//     API serves; this owns exactly two write commands (`worktree add`, `worktree
//     remove`) and REUSES that module's runner seam and its `parseWorktrees`
//     parser rather than growing a second one (principle 9 — one source of record
//     for git's output shape, and rule 0.6 keeps drift in one place).
//   • It is not a decider. It never asks WHETHER a task should be isolated; the
//     dispatcher asks that, from the task's own `isolation` field plus the flag.
//   • It is not a policy about DESTRUCTION — see `removeWorktree`.
//
// The injection-safety discipline is `gitAdapter`'s, verbatim and for the same
// reason: **ARRAY ARGS ONLY, NEVER A SHELL STRING**, and a `--` guard before any
// task-derived operand so git can never read a path as an option. Verified against
// git 2.43.0 before this module was written: `git worktree add -b <branch> --
// <path>` and `git worktree remove -- <path>` both accept the guard.

export interface WorktreeManagerDeps {
  // The SAME injectable subprocess seam every other git caller uses. Tests inject a
  // fake; production passes `defaultGitRunner`. Nothing in this file shells out.
  runner: GitRunner;
  // The parent directory every task worktree is created under. REQUIRED with no
  // default: a default would be a policy about where a worker's files land on a
  // real disk, and that belongs at the config boundary where an operator can see
  // it (`VIMES_WORKTREE_ROOT`).
  worktreeRoot: string;
  // INJECTED clock (rule 0.3), in MILLISECONDS. The only time source in this
  // module; nothing here calls Date.now(). It exists for exactly one purpose: to
  // measure `setupMs`, which is D32's explicitly-unmeasured cost axis. A fixed
  // clock in a test therefore produces a deterministic setup cost.
  nowMs: () => number;
}

// Why a worktree operation failed. A SMALL enum in the spirit of `GitOpError`,
// with git's own stderr always carried alongside in `detail` — so the enum can stay
// coarse without any information being lost.
export type WorktreeFailureReason =
  // The runner could not start git at all (spawn failure → exitCode null).
  | 'git-unavailable'
  // `git worktree list` exited non-zero in `task.projectRoot`. Overwhelmingly this
  // is "not a git repository" (verified: exit 128), but the classification is
  // deliberately not parsed out of the message — git's own words ride in `detail`.
  | 'not-a-repo'
  // `git worktree add` exited non-zero. This is where "the path already exists as a
  // file", "a branch named X already exists" and "permission denied" all land;
  // again, git says which, verbatim, in `detail`.
  | 'worktree-add-failed'
  // `git worktree remove` exited non-zero (dirty worktree, missing path, …).
  | 'worktree-remove-failed'
  // The manager refused before running git: `worktreeRoot` is not an absolute path,
  // so every derived path would be relative to whatever cwd the daemon happens to
  // hold. The ONE failure that is ours rather than git's.
  | 'worktree-root-not-absolute';

export type EnsureWorktreeResult =
  | {
      readonly ok: true;
      // The absolute path the dispatcher spawns into.
      readonly path: string;
      readonly branch: string;
      // TRUE when the worktree already existed and nothing was created. The
      // idempotence flag: the dispatcher uses it to decide whether there is a
      // creation to event, because `task_worktree_created` must describe a real
      // creation.
      readonly reused: boolean;
      // Milliseconds the whole `ensureWorktree` call took, from the injected clock.
      // Present on the reuse path too — a reuse costs one `git worktree list`, and
      // knowing what that costs is part of pricing the axis.
      readonly setupMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: WorktreeFailureReason;
      // Git's own stderr, trimmed, or our own one-line explanation. NEVER a stack
      // and never a dump of the environment.
      readonly detail: string;
      // The names we WOULD have used. Carried on the failure path so the caller can
      // report which worktree could not be made without re-deriving it.
      readonly path: string;
      readonly branch: string;
      readonly setupMs: number;
    };

export type RemoveWorktreeResult =
  | { readonly ok: true; readonly path: string; readonly removed: boolean }
  | {
      readonly ok: false;
      readonly reason: WorktreeFailureReason;
      readonly detail: string;
      readonly path: string;
    };

export class WorktreeManager {
  private readonly deps: WorktreeManagerDeps;

  constructor(deps: WorktreeManagerDeps) {
    this.deps = deps;
  }

  /**
   * Make sure this task has its worktree, and say where it is.
   *
   * **IDEMPOTENT, and that is the headline property.** A task that is dispatched
   * twice — a retry, a daemon restart, a fix loop that ran long — must land in the
   * directory it already has, not accumulate a second one. So the first thing this
   * does is ASK GIT what worktrees exist (`git worktree list --porcelain`, parsed
   * by `gitAdapter`'s own parser) and, if this task's is among them, return it
   * without running another git command at all.
   *
   * **TOTAL: every failure is a RETURNED RESULT and nothing throws.** A manager
   * that throws is a manager that takes the dispatcher — and therefore an HTTP
   * request — down with it, and the dispatcher's own contract is that it never
   * throws either.
   *
   * ⚠ **THERE IS NO FALLBACK TO `projectRoot` ANYWHERE IN THIS CLASS.** Not on a
   * missing git, not on a broken repo, not on a failed add. If this returns
   * `ok: false` the caller has NO working directory, which is the point: silently
   * running an isolated task in the shared project root is exactly the concurrency
   * hazard isolation exists to remove, and it would be invisible in the log.
   */
  async ensureWorktree(task: TaskRecord): Promise<EnsureWorktreeResult> {
    const startedAtMs = this.deps.nowMs();
    const branch = taskWorktreeBranch(task.taskId);
    const expectedPath = this.worktreePathFor(task);
    const elapsedMs = (): number => this.deps.nowMs() - startedAtMs;

    // Our own precondition, checked before git is touched. A relative worktree root
    // would resolve against whatever cwd the daemon process happens to hold, which
    // is a directory nobody chose.
    if (!isAbsolute(this.deps.worktreeRoot)) {
      return {
        ok: false,
        reason: 'worktree-root-not-absolute',
        detail: `worktreeRoot must be an absolute path, got '${this.deps.worktreeRoot}'`,
        path: expectedPath,
        branch,
        setupMs: elapsedMs(),
      };
    }

    const existing = await this.findExistingWorktree(task.projectRoot, expectedPath, branch);
    if (!existing.ok) {
      return { ...existing, path: expectedPath, branch, setupMs: elapsedMs() };
    }
    if (existing.worktree !== null) {
      // Already there. NO `git worktree add` is issued — asserting that is what
      // proves the idempotence, because an implementation that added again and
      // swallowed the "already exists" error would look identical from the outside.
      return { ok: true, path: existing.worktree.path, branch, reused: true, setupMs: elapsedMs() };
    }

    // `-b <branch>` binds the branch as the option's VALUE (it can never be read as
    // an option itself, the same discipline `git commit -m <message>` uses), and the
    // `--` guard puts the path where no leading dash can be misread. Array args, no
    // shell.
    const addResult = await this.runGit(task.projectRoot, [
      'worktree',
      'add',
      '-b',
      branch,
      '--',
      expectedPath,
    ]);
    if (!addResult.ok) {
      return {
        ok: false,
        reason: addResult.spawnFailed ? 'git-unavailable' : 'worktree-add-failed',
        detail: addResult.detail,
        path: expectedPath,
        branch,
        setupMs: elapsedMs(),
      };
    }
    // `setupMs` is read AFTER the add returns, so it measures the checkout — the
    // number D32 asked step 8 to produce.
    return { ok: true, path: expectedPath, branch, reused: false, setupMs: elapsedMs() };
  }

  /**
   * Destroy this task's worktree.
   *
   * ⚠ **BUILT, TESTED, AND WIRED TO NOTHING. DELIBERATELY.** No caller anywhere in
   * VIMES invokes this: not the dispatcher, not the watchdog, not the task API, not
   * a timer. There is no GC, no reaper and no `on done → remove` rule, and adding
   * one is NOT a follow-up chore — it is a policy decision with real trade-offs and
   * it is **Wes's, not an implementer's**:
   *
   *   • Removing on `done` reclaims disk promptly, but throws away the WORK CONTEXT
   *     — the branch, the uncommitted diff, the thing you look at when you ask "what
   *     did that agent actually do?" — at exactly the moment a human might want it.
   *   • Never removing is safe and auditable and grows unboundedly on a real disk.
   *   • Removing on explicit request keeps the human in the loop and needs a surface
   *     that does not exist yet (the board is step 9).
   *
   * The machinery exists now so that whichever answer is chosen needs no new
   * plumbing (rule 0.5 — the shape lands early, the behaviour waits for sign-off).
   * If you are about to wire this to a trigger: that is a decision record, not a
   * patch.
   *
   * Note it does NOT delete the branch (`git worktree remove` leaves
   * `vimes/task-<id>` in place). Deleting the branch would destroy commits, which is
   * a strictly larger decision than reclaiming a directory, and it is not this
   * function's to make either.
   */
  async removeWorktree(task: TaskRecord): Promise<RemoveWorktreeResult> {
    const expectedPath = this.worktreePathFor(task);
    const branch = taskWorktreeBranch(task.taskId);

    if (!isAbsolute(this.deps.worktreeRoot)) {
      return {
        ok: false,
        reason: 'worktree-root-not-absolute',
        detail: `worktreeRoot must be an absolute path, got '${this.deps.worktreeRoot}'`,
        path: expectedPath,
      };
    }

    const existing = await this.findExistingWorktree(task.projectRoot, expectedPath, branch);
    if (!existing.ok) {
      return { ...existing, path: expectedPath };
    }
    if (existing.worktree === null) {
      // Nothing to remove — the same idempotence the ensure path has, from the other
      // side. `removed: false` says so rather than pretending work happened.
      return { ok: true, path: expectedPath, removed: false };
    }

    const removeResult = await this.runGit(task.projectRoot, [
      'worktree',
      'remove',
      '--',
      existing.worktree.path,
    ]);
    if (!removeResult.ok) {
      return {
        ok: false,
        reason: removeResult.spawnFailed ? 'git-unavailable' : 'worktree-remove-failed',
        detail: removeResult.detail,
        path: existing.worktree.path,
      };
    }
    return { ok: true, path: existing.worktree.path, removed: true };
  }

  // The absolute path this task's worktree occupies. Derived, never remembered: the
  // NAME comes from core's pure `taskWorktreeDirName` (which is where the hostile-id
  // sanitising lives), and only the ROOT comes from config.
  worktreePathFor(task: TaskRecord): string {
    return resolve(this.deps.worktreeRoot, taskWorktreeDirName(task.taskId));
  }

  /**
   * Is this task's worktree already checked out? Answered from `git worktree list
   * --porcelain`, parsed by **gitAdapter's own `parseWorktrees`** — the one parser
   * that knows git's output shape (rule 0.6 keeps that knowledge in one module).
   *
   * A record matches on EITHER its path or its branch, and the branch half matters:
   * if the branch is already checked out somewhere ELSE, `git worktree add -b` would
   * fail with "already exists" and a path-only check would report that as a broken
   * worktree forever. Since the branch is derived from the taskId alone, a worktree
   * holding it IS this task's worktree, wherever it sits — so the caller is given the
   * path git actually reports rather than the one we would have picked.
   */
  private async findExistingWorktree(
    projectRoot: string,
    expectedPath: string,
    branch: string,
  ): Promise<
    | { ok: true; worktree: { path: string; branch: string | null } | null }
    | { ok: false; reason: WorktreeFailureReason; detail: string }
  > {
    const listResult = await this.runGit(projectRoot, ['worktree', 'list', '--porcelain']);
    if (!listResult.ok) {
      return {
        ok: false,
        reason: listResult.spawnFailed ? 'git-unavailable' : 'not-a-repo',
        detail: listResult.detail,
      };
    }
    const branchRef = `refs/heads/${branch}`;
    for (const worktree of parseWorktrees(listResult.stdout)) {
      // `resolve` on both sides so a trailing slash or a `.` segment in the
      // configured root cannot make an existing worktree look absent — which would
      // send us into `git worktree add` and produce a confusing "already exists".
      if (resolve(worktree.path) === resolve(expectedPath) || worktree.branch === branchRef) {
        return { ok: true, worktree: { path: worktree.path, branch: worktree.branch } };
      }
    }
    return { ok: true, worktree: null };
  }

  // One git invocation, TOTAL. Mirrors `GitAdapter.run`'s mapping: a spawn failure
  // (exitCode null — git absent, ENOENT) is distinguished from a non-zero exit, and
  // a runner that THROWS is caught here rather than escaping, because an injected
  // adapter is not something this class gets to assume well-behaved.
  private async runGit(
    cwd: string,
    args: string[],
  ): Promise<
    { ok: true; stdout: string } | { ok: false; spawnFailed: boolean; detail: string }
  > {
    let runResult;
    try {
      runResult = await this.deps.runner(args, cwd);
    } catch (runError) {
      return {
        ok: false,
        spawnFailed: true,
        detail: `git-runner-threw:${runError instanceof Error ? runError.message : String(runError)}`,
      };
    }
    if (runResult.exitCode === null) {
      return { ok: false, spawnFailed: true, detail: runResult.stderr.trim() };
    }
    if (runResult.exitCode !== 0) {
      return { ok: false, spawnFailed: false, detail: runResult.stderr.trim() };
    }
    return { ok: true, stdout: runResult.stdout };
  }
}
