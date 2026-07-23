import {
  decideDispatch,
  dispatchRefused,
  resolveStageRunner,
  taskSessionAttached,
  taskWorktreeCreated,
  type DispatchDeferReason,
  type DispatchRefuseReason,
  type EventInput,
  type MetersState,
  type StageRunnerPlan,
  type TaskRecord,
  type TasksState,
} from '@vimes/core';
import type { SessionHost } from './sessionHost.js';
import type { WorktreeManager } from './worktreeManager.js';

// ─── slice 6 step 4a — the dispatcher EXECUTOR (daemon I/O) ──────────────────
//
// Steps 1–3 built the pure decisions: the task state machine, the tasks
// projection, and `decideDispatch`. This module is the I/O boundary that turns a
// `DispatchDecision` into a real session through the session host — and it is
// where **I10's refusal actually gets evented.**
//
// The split is the point (rule 0.3). Everything JUDGED lives in packages/core
// and is replayable with no Claude, no network and no clock; everything DONE
// lives here. This class therefore contains no policy: it reads state, hands it
// to the pure function, and executes whatever comes back. If you find yourself
// adding an `if` here that changes WHETHER something spawns, it belongs in
// `decideDispatch` instead — a second decider is a second authority (principle
// 10), and I10 stops being assertable headlessly the moment one exists.
//
// ⚠ NO TIMER. NO SCHEDULING LOOP. `dispatchTask` is called explicitly — by tests
// today, by the task API (step 4b) or a scheduler later. Scheduling policy, and
// the event-spam question that arrives with a polling loop, is deliberately out
// of this unit. Nothing in this file subscribes to anything or sets an interval.

// ─── THE ISOLATION SCOPE BOUNDARY — STEP 8: BUILT, WIRED, SHIPPED OFF ────────
//
// Step 4a left this block saying "worktree creation is step 8, and until it lands
// every task runs in `task.projectRoot`". **Step 8 has landed. The machinery is
// here — and it is OFF BY DEFAULT.**
//
// `VIMES_WORKTREE_ISOLATION` (config.ts, default **`off`**) decides which world the
// daemon is in, and the two are exhaustive:
//
//   • **`off` — TODAY'S BEHAVIOUR, BYTE-FOR-BYTE.** Every task, including one whose
//     record says `isolation: 'worktree'`, resolves to `task.projectRoot`. No git
//     command is issued, the worktree manager is never consulted, and step 4a's
//     pinned assertions below hold unchanged. D32 is still not honoured, and it
//     still says so out loud rather than pretending otherwise.
//   • **`on`** — an `isolation: 'worktree'` task runs in its own git worktree, made
//     by `WorktreeManager`. `shared-dir` still resolves to `projectRoot`, because
//     that is what the field means.
//
// **WHY IT SHIPS OFF, stated so nobody "finishes the job" by flipping the default.**
// Isolation changes WHERE REAL WORK EXECUTES ON A REAL MACHINE — new directories on
// a real disk, new branches in a real repo, agents editing files a human is not
// watching. That is precisely the class of change rule 0 reserves for evidence +
// sign-off, and it is the same discipline the watchdog took: the detection machinery
// shipped complete, and the destructive half waited for a human. The flip is Wes's,
// made deliberately and while awake. Turning it on is a config change, not a code
// change, which is exactly the property that makes the flip cheap AND reviewable.
//
// ⚠ **AND THE HALF THAT MATTERS MOST: A FAILED WORKTREE NEVER FALLS BACK TO
// `projectRoot`.** See `dispatchTask`'s `worktree-failed` branch. An isolated task
// that quietly ran in the shared directory would be the exact concurrency hazard
// isolation exists to remove, reintroduced by the error handler, and it would be
// INVISIBLE — the log would show an ordinary successful dispatch.

// The `off`-world resolver, and the default of the `resolveWorkingDirectory` seam.
// Unchanged from step 4a, deliberately: with the flag off the dispatcher must be
// byte-identical to what it was, and this function is the whole of that promise.
export function projectRootWorkingDirectory(task: TaskRecord): string {
  return task.projectRoot;
}

export interface TaskDispatcherDeps {
  // The narrow seam onto the session host — injectable so tests drive a FAKE and
  // never spawn a real Claude process.
  //
  // ⚠ Widened by exactly one method beyond `spawnSession`: `decideDispatch`
  // REQUIRES `hasLiveRun`, and no other dependency here can answer it. Defaulting
  // that input to `false` would make the `already-running` refusal structurally
  // unreachable — a double-spawn guard that cannot fire. `isLive` is already
  // documented in sessionHost.ts as an "observation seam (tests / dispatcher)",
  // i.e. this exact consumer, and it is the SAME liveness the rest of the daemon
  // reads, so there is no second definition of "alive" (slice-6 architecture).
  //
  // ⚠ STEP 7 WIDENS IT BY TWO MORE, each earning its place:
  //   • `resumeSession` — the fix loop's whole point. `resolveStageRunner` can now
  //     answer "resume the hot author", and no other method can carry that out.
  //   • `sendMessage` — the session host's EXISTING message path, used by the
  //     instruction seam below. It is the same path a human turn takes; the
  //     dispatcher does not get a private one (principle 9 — one way in).
  // No further methods: a dispatcher that can kill, rename or answer gates is a
  // second session authority, and this module deliberately is not one.
  sessionHost: Pick<SessionHost, 'spawnSession' | 'isLive' | 'resumeSession' | 'sendMessage'>;
  // The router's emit. Every event this module writes goes through it.
  emit: (events: EventInput[]) => void;
  // Projection reads, called fresh on every attempt — never cached in a field.
  // A dispatcher deciding against a stale board is a dispatcher spawning against
  // a gate that has since failed.
  readTasks: () => TasksState;
  readMeters: () => MetersState;
  // INJECTED clock (rule 0.3). The ONLY time source in this module; nothing here
  // calls Date.now(), and `decideDispatch` receives whatever this returns.
  nowIso: () => string;
  // The METER staleness band, from config (`deriveStaleAfterMs`). REQUIRED with
  // no default: rule 0.2 forbids pinning a ⟨tune⟩ band as a silent default, and
  // this one decides whether a meter reading counts as current at all.
  staleAfterMs: number;
  // Where a stage run executes WHEN NO WORKTREE IS INVOLVED — i.e. the flag is off,
  // or the task asked for `shared-dir`. The default is `projectRootWorkingDirectory`
  // and it is the whole of the flag-off behaviour.
  //
  // ⚠ CONSULTED ON THE SPAWN PATH ONLY. A RESUMED session keeps the cwd it was
  // created with — `SessionHost.resumeSession` takes no cwd and resumes "from the
  // RECORDED cwd" (I3) — and that is correct, not an omission: the hot author's
  // cache is scoped to machine+directory (D6), so moving it would throw away the
  // exact thing the resume exists to keep. Under isolation the resumed session is
  // already sitting IN its worktree, because that is where it was spawned.
  resolveWorkingDirectory?: (task: TaskRecord) => string;

  // ── ISOLATION (step 8) — the two deps that make D32 real, and the flag ───────
  //
  // The worktree maker. Kept to `ensureWorktree` alone (`Pick`, the same narrowing
  // the session-host seam uses): the dispatcher may CREATE a worker directory and
  // may not destroy one. `removeWorktree` exists on the class and is wired to
  // nothing — see its comment; when a worktree should be destroyed is Wes's policy
  // decision, and a dispatcher that could reach it would be the place that decision
  // got made by accident.
  worktreeManager?: Pick<WorktreeManager, 'ensureWorktree'>;

  // ⚠ **THE SHIPPING FLAG. DEFAULT `false` = TODAY'S BEHAVIOUR EXACTLY.**
  //
  // Optional, and its absence means OFF, so every existing construction of this
  // class — app.ts before this step, and every test written before it — keeps the
  // behaviour it had without naming the field. That is deliberate: the safe value
  // is the one you get by saying nothing.
  //
  // When false, `task.isolation` is read and NOT acted on, exactly as in step 4a,
  // and no git command is issued on any dispatch path. When true, an
  // `isolation: 'worktree'` task gets a real worktree. `app.ts` passes
  // `config.worktreeIsolation === 'on'`.
  worktreeIsolationEnabled?: boolean;

  // ── THE INSTRUCTION SEAM — MACHINERY ONLY, CONTENT DELIBERATELY ABSENT ──────
  //
  // A stage run is currently told NOTHING: the dispatcher starts a session and
  // sends no prompt. This seam is where the words will go, and the default is
  // `() => null`, i.e. **exactly today's behaviour — nothing is sent.**
  //
  // ⚠ **NO PROMPT TEXT IS WRITTEN ANYWHERE IN THIS STEP, ON PURPOSE.** What a
  // review prompt or a fix prompt actually SAYS is a product decision for Wes and
  // is explicitly deferred; writing one here would pin content nobody signed off,
  // which is rule 0.2's discipline applied to words instead of numbers. The seam
  // exists so the machinery is complete and testable now and the words can land
  // later without reshaping anything.
  //
  // It receives the `StageRunnerPlan` as well as the task because the two stages
  // want opposite briefings — a fresh reviewer needs orientation it does not have,
  // a resumed author needs only the flaw — and a composer cannot tell them apart
  // from the task alone.
  //
  // Returning `null` or an empty string sends nothing. A non-empty string is sent
  // ONCE, through `sessionHost.sendMessage`, after the session exists.
  composeStageInstruction?: (task: TaskRecord, plan: StageRunnerPlan) => string | null;
}

// What happened to a composed stage instruction. Present on a result ONLY when an
// instruction was actually composed — under the default seam the field is absent
// and every result is byte-identical to step 4a's.
export type StageInstructionDelivery =
  | { readonly status: 'sent' }
  // Composed but not delivered: the host refused the send, or the composer or the
  // host threw. Reported rather than swallowed — a stage run that silently never
  // received its brief would look like a working dispatch and behave like an idle
  // agent. It does NOT fail the dispatch: the session exists and is attached, and
  // un-attaching it would be a worse lie than an undelivered instruction.
  | { readonly status: 'not-delivered'; readonly reason: string };

// The outcome of ONE explicit dispatch attempt.
//
// ⚠ TWO VOCABULARIES, KEPT APART. `refused` carries step 3's DECISION vocabulary
// (`DispatchRefuseReason`) — the dispatcher looked at the task and said no.
// `spawn-failed` is an EXECUTION outcome: the decision was `spawn`, we tried, and
// the session host did not produce a session. It gets its own outcome and carries
// the HOST's reason string verbatim, because inventing a `DispatchRefuseReason`
// for it would put an execution failure into a decision enum that `dispatch_refused`
// records — and the log would then claim the dispatcher refused work it actually
// attempted.
//
// ⚠ STEP 7 ADDS TWO EXECUTION OUTCOMES, `resumed` and `resume-failed`, as SIBLINGS
// of `spawned` / `spawn-failed` rather than as a flag on them. A caller reading the
// log or the API envelope must be able to tell "a fresh stranger started this
// stage" from "the hot author picked it back up" without decoding a boolean —
// they are different events in the world, and the independence rule is about
// exactly that difference. Both additions are PURELY ADDITIVE: the existing
// variants are unchanged field-for-field, which is why every step-4a/4b assertion
// still holds verbatim.
export type DispatchAttemptResult =
  | {
      readonly outcome: 'spawned';
      readonly taskId: string;
      readonly stage: string;
      readonly appSessionId: string;
      readonly cwd: string;
      // Absent unless an instruction was composed — see the seam above.
      readonly instructionDelivery?: StageInstructionDelivery;
    }
  | {
      // THE FIX LOOP RAN: this stage was picked up by the session that authored
      // the work, not by a new one. No `cwd` field, deliberately — the resumed
      // session keeps its own recorded working directory and the dispatcher never
      // chose one, so reporting a resolved path here would be a fabricated fact.
      readonly outcome: 'resumed';
      readonly taskId: string;
      readonly stage: string;
      readonly appSessionId: string;
      readonly instructionDelivery?: StageInstructionDelivery;
    }
  | {
      readonly outcome: 'refused';
      readonly taskId: string;
      readonly reason: DispatchRefuseReason;
    }
  | {
      readonly outcome: 'deferred';
      readonly taskId: string;
      readonly reason: DispatchDeferReason;
      readonly meterId: string;
    }
  | {
      readonly outcome: 'spawn-failed';
      readonly taskId: string;
      // The session host's own refusal reason, verbatim. NOT a DispatchRefuseReason.
      readonly reason: string;
    }
  | {
      // A refused resume is an EXECUTION outcome, exactly like `spawn-failed`, and
      // for exactly the same reason: the DECISION was to run this stage, we tried,
      // and the host did not produce a live session. It invents no
      // `DispatchRefuseReason` — putting it in the decision enum would make
      // `dispatch_refused` claim the dispatcher refused work it actually attempted.
      // Its own outcome rather than a shared `spawn-failed` so a reader can see
      // WHICH call failed; the two are not interchangeable in a post-mortem.
      readonly outcome: 'resume-failed';
      readonly taskId: string;
      // Which session we tried to bring back — the missing half of a bare reason.
      readonly appSessionId: string;
      // The session host's own refusal reason, verbatim. NOT a DispatchRefuseReason.
      readonly reason: string;
    }
  | {
      // ⚠ **STEP 8'S EXECUTION OUTCOME, AND THE SAFETY ONE.** The decision was to
      // run this stage, the task asked for worktree isolation, the flag was on, and
      // the worktree COULD NOT BE MADE. Nothing spawned, nothing resumed, no
      // `task_session_attached` was written, and — the point — **the task did NOT
      // fall back to `projectRoot`.**
      //
      // A fallback would be the tempting fix and it is the bug: an isolated task
      // silently sharing the project directory with whatever else is running there
      // is precisely the concurrency hazard isolation exists to remove, and it would
      // leave a log indistinguishable from a healthy dispatch. Refusing to run is
      // the honest answer; the caller decides what to do about it.
      //
      // A SIBLING of `spawn-failed`, not a `DispatchRefuseReason`: the two
      // vocabularies stay apart exactly as steps 4a and 7 kept them. Putting this in
      // the decision enum would make `dispatch_refused` claim the dispatcher refused
      // work it actually attempted.
      readonly outcome: 'worktree-failed';
      readonly taskId: string;
      // The manager's classified reason plus git's own words, verbatim. NOT a
      // `DispatchRefuseReason`.
      readonly reason: string;
    }
  | { readonly outcome: 'unknown-task'; readonly taskId: string };

// What the working-directory resolution produced. The FAILURE arm carries no
// directory at all, deliberately: there is no "the directory we would have used"
// field for a caller to reach for, so a fallback to `projectRoot` cannot be written
// by accident from the shape of this type.
type WorkingDirectoryResolution =
  | {
      readonly ok: true;
      readonly cwd: string;
      // Emitted BEFORE the spawn when a worktree was really created. Absent on the
      // plain path and on a reuse — see `taskWorktreeCreated`'s own note on why a
      // reuse must not claim a creation.
      readonly worktreeEvent?: EventInput;
    }
  | { readonly ok: false; readonly reason: string };

export class TaskDispatcher {
  private readonly deps: TaskDispatcherDeps;
  private readonly resolveWorkingDirectory: (task: TaskRecord) => string;
  private readonly composeStageInstruction: (
    task: TaskRecord,
    plan: StageRunnerPlan,
  ) => string | null;

  constructor(deps: TaskDispatcherDeps) {
    this.deps = deps;
    this.resolveWorkingDirectory = deps.resolveWorkingDirectory ?? projectRootWorkingDirectory;
    // THE DEFAULT IS SILENCE — today's behaviour exactly. See the seam's note:
    // the words are Wes's decision and are deliberately not written in this step.
    this.composeStageInstruction = deps.composeStageInstruction ?? (() => null);
  }

  /**
   * Attempt to dispatch ONE task, right now. TOTAL: every path returns a result
   * and NOTHING throws — a dispatcher that throws is a dispatcher that has
   * silently stopped, and this one is called from an HTTP handler (step 4b) and
   * eventually a scheduler.
   *
   * What gets written, and what deliberately does not:
   *
   *   • `spawn`  → `resolveStageRunner` (step 7) says WHO runs the stage, and the
   *     answer is one of two:
   *       – `mode: 'spawn'`  → the session host spawns an SDK session in the
   *         resolved cwd, then ONE `task_session_attached` records the link.
   *         Emitted only AFTER a real `appSessionId` comes back, so the board
   *         never shows a ref to a session that does not exist. **A `review` stage
   *         ALWAYS lands here — see the independence rule in stageRunner.ts.**
   *       – `mode: 'resume'` → THE FIX LOOP: the session that authored the work is
   *         resumed instead, and the same `task_session_attached` records that it
   *         is now running this stage too.
   *     Either way an optional composed instruction is sent afterwards; the
   *     default composer sends nothing, which is today's behaviour exactly.
   *
   *   • `refuse` → ONE `dispatch_refused { taskId, reason }`. **THIS IS I10.**
   *     The invariant is not satisfied by refusing; it is satisfied by refusing
   *     AND RECORDING IT. A refusal nobody wrote down is, for I10's purposes, a
   *     refusal that never happened — and the whole point of the headroom gate is
   *     that a human can later ask "why did nothing run last night?" and get an
   *     answer out of the log rather than a shrug.
   *
   *   • `defer`  → **NOTHING IS EMITTED.** Stated loudly because the symmetry is
   *     tempting and wrong: a defer is NOT a refusal. Nothing was denied and no
   *     state changed — the task simply is not dispatched yet, and any surface can
   *     re-derive the identical defer from `decideDispatch` whenever it likes,
   *     because the function is pure. Eventing here would write one record per
   *     attempt for as long as the window stays shut, which under any future
   *     scheduling loop is an unbounded log of "still waiting" — the log filling
   *     with non-events, and pillar 5 (attention is the scarce resource) losing.
   *
   *   • unknown task → a result saying so. No spawn, no event, no throw.
   *
   * ⚠ **ASYNC SINCE STEP 8, and the reason is structural rather than stylistic:**
   * creating a worktree is a SUBPROCESS, and a subprocess cannot be awaited from a
   * synchronous function. Nothing else about the contract moved — every RESULT SHAPE
   * is unchanged field-for-field, so the `/api/tasks/:taskId/dispatch` envelope is
   * byte-identical, and the method is still total (it returns a rejected promise for
   * nothing; every path resolves to a result).
   *
   * ⚠ **STILL NO CONCURRENCY CONTROL, and that is unchanged rather than overlooked.**
   * `dispatchTask` is called once per explicit request; two overlapping calls for the
   * SAME task were already possible before this step and are still handled by
   * `decideDispatch`'s `already-running` guard plus the session host's own I11
   * backstop. `ensureWorktree` adds a third: it is idempotent, so a racing pair
   * converges on one directory rather than two. What no layer has today is a lock —
   * that is a scheduler's problem, and there is still no scheduler.
   */
  async dispatchTask(taskId: string): Promise<DispatchAttemptResult> {
    const task = this.deps.readTasks().tasks[taskId];
    if (task === undefined) {
      // The log is truth: we do not dispatch, and we do not record, a task that
      // does not exist. Writing a `dispatch_refused` here would put a taskId into
      // the task stream that no `task_created` ever introduced.
      return { outcome: 'unknown-task', taskId };
    }

    const decision = decideDispatch({
      task,
      meters: this.deps.readMeters(),
      nowIso: this.deps.nowIso(),
      staleAfterMs: this.deps.staleAfterMs,
      hasLiveRun: this.hasLiveRun(task),
    });

    switch (decision.action) {
      case 'refuse': {
        // I10's evented refusal. Note what is NOT here: no spawn call above it,
        // and none below it — the refusal branch returns before any I/O, so the
        // session host is never reached at all on this path.
        this.deps.emit([dispatchRefused({ taskId: task.taskId, reason: decision.reason })]);
        return { outcome: 'refused', taskId: task.taskId, reason: decision.reason };
      }

      case 'defer': {
        // Deliberately silent — see the `defer` note above.
        return {
          outcome: 'deferred',
          taskId: task.taskId,
          reason: decision.reason,
          meterId: decision.meterId,
        };
      }

      case 'spawn': {
        // WHETHER is settled (`decideDispatch` said run it). WHO runs it is a
        // SECOND, separate question, answered by a second pure function — step 7.
        // Note the shape: `decideDispatch` never sees this, and `resolveStageRunner`
        // never sees the meters. Neither can drift into the other's job, and I10
        // stays assertable against the decision function alone.
        const runnerPlan = resolveStageRunner(task);
        if (runnerPlan.mode === 'resume') {
          // THE FIX LOOP. The task came back down `review → implementing`, so the
          // work has an author and the author is cache-warm (D6: prompt cache is
          // scoped to machine+directory, and a resume lands in the same directory).
          return this.resumeStageRun(task, decision.stage, runnerPlan);
        }
        // WHERE it runs. Under the flag this may create a git worktree, which is
        // why the whole method is async.
        const workingDirectory = await this.resolveSpawnWorkingDirectory(task);
        if (!workingDirectory.ok) {
          // ⚠ **NO FALLBACK. NO SPAWN. NO EVENT.** The task asked to be isolated and
          // it could not be; running it in the shared project root anyway would be
          // the concurrency hazard isolation exists to remove, and the log would show
          // an ordinary successful dispatch. So nothing runs, and the failure is
          // reported to the caller as a first-class outcome.
          //
          // Nothing is emitted here on purpose, matching `spawn-failed`: no session
          // exists to attach, and no `dispatch_refused` is invented because that enum
          // is the DECISION vocabulary and this decision was `spawn`. The failure is
          // in the RESULT, which the API returns verbatim.
          return {
            outcome: 'worktree-failed',
            taskId: task.taskId,
            reason: workingDirectory.reason,
          };
        }
        const cwd = workingDirectory.cwd;
        if (workingDirectory.worktreeEvent !== undefined) {
          // BEFORE the spawn, deliberately. The directory exists at this point and
          // the session does not; recording it after the spawn would leave a window
          // in which an agent is running somewhere the log has never mentioned.
          this.deps.emit([workingDirectory.worktreeEvent]);
        }
        // Stage runs are ORDINARY SESSIONS (spec §3.5) on the 'sdk' channel:
        // everything slices 1–5b built — stream, diff, cost, resume, attention —
        // applies to a stage run for free. There is no parallel session concept.
        //
        // KNOWN GAP, recorded rather than hidden: `spawnSession` writes
        // `taskRef: null` into `session_created`, and sessionHost.ts is frozen for
        // this step, so the session→task backlink does not exist yet. The link
        // lives ONLY on the task side, in the `task_session_attached` below.
        let spawnResult;
        try {
          spawnResult = this.deps.sessionHost.spawnSession({ channel: 'sdk', cwd });
        } catch (spawnError) {
          // The host's contract is to refuse rather than throw, but a dispatcher
          // must survive its adapters regardless.
          return {
            outcome: 'spawn-failed',
            taskId: task.taskId,
            reason: `spawn-threw:${describeThrown(spawnError)}`,
          };
        }
        if ('refused' in spawnResult) {
          // The spawn did not yield a session (preflight, typically). NO
          // `task_session_attached` — there is no session to attach — and NO
          // `dispatch_refused`, on two counts: this was an execution failure
          // rather than a decision (see the vocabulary note above), and the
          // session host ALREADY evented its own refusal. Recording it again here
          // would double-count one failure as two facts in the log.
          return { outcome: 'spawn-failed', taskId: task.taskId, reason: spawnResult.reason };
        }
        this.deps.emit([
          taskSessionAttached({
            taskId: task.taskId,
            stage: decision.stage,
            appSessionId: spawnResult.appSessionId,
          }),
        ]);
        const instructionDelivery = this.deliverStageInstruction(
          task,
          runnerPlan,
          spawnResult.appSessionId,
        );
        return {
          outcome: 'spawned',
          taskId: task.taskId,
          stage: decision.stage,
          appSessionId: spawnResult.appSessionId,
          cwd,
          // Spread rather than set: under the default seam the key is ABSENT, so
          // the result is byte-identical to step 4a's and every prior assertion
          // (and the `/api/tasks/:id/dispatch` envelope) is untouched.
          ...(instructionDelivery === undefined ? {} : { instructionDelivery }),
        };
      }
    }
  }

  /**
   * WHERE this stage run executes — the whole of step 8's decision, in one place.
   *
   * Three worlds, and the first two are the same world:
   *
   *   1. **Flag OFF** (the default, and production today) → the injected
   *      `resolveWorkingDirectory` seam, whose default is `task.projectRoot`.
   *      `task.isolation` is not even read. **NO GIT COMMAND IS ISSUED**, which is
   *      the assertable form of "byte-identical to before this step".
   *   2. **Flag on, `isolation: 'shared-dir'`** → the same seam, same answer. That
   *      is what the field means; D32 kept the per-task override precisely so a cost
   *      surprise is a config change rather than a redesign.
   *   3. **Flag on, `isolation: 'worktree'`** → the manager. Success carries the
   *      worktree path and, when something was really created, the event that
   *      records it. Failure carries a reason AND NO DIRECTORY.
   *
   * ⚠ A manager that is absent while the flag is on is a FAILURE, not a silent
   * downgrade to `projectRoot`. It means somebody wired the daemon inconsistently,
   * and the safe reading of "isolate this" plus "no isolator" is "do not run", not
   * "run it in the shared directory and say nothing".
   *
   * Never throws: the manager's contract is a returned result, and a manager that
   * broke it is caught here anyway.
   */
  private async resolveSpawnWorkingDirectory(
    task: TaskRecord,
  ): Promise<WorkingDirectoryResolution> {
    if (this.deps.worktreeIsolationEnabled !== true || task.isolation !== 'worktree') {
      return { ok: true, cwd: this.resolveWorkingDirectory(task) };
    }
    const worktreeManager = this.deps.worktreeManager;
    if (worktreeManager === undefined) {
      return { ok: false, reason: 'worktree-isolation-enabled-without-a-manager' };
    }
    let ensureResult;
    try {
      ensureResult = await worktreeManager.ensureWorktree(task);
    } catch (ensureError) {
      // The manager's contract is to refuse rather than throw, but a dispatcher must
      // survive its adapters regardless — the same posture the spawn path takes.
      return { ok: false, reason: `worktree-threw:${describeThrown(ensureError)}` };
    }
    if (!ensureResult.ok) {
      // The classified reason AND git's own words, so a post-mortem does not need
      // the daemon's stderr to tell "git is missing" from "that path is a file".
      return { ok: false, reason: `${ensureResult.reason}:${ensureResult.detail}` };
    }
    return {
      ok: true,
      cwd: ensureResult.path,
      // A REUSE CREATED NOTHING, so it events nothing. See the event's own note: a
      // false `task_worktree_created` would be both an untrue fact in an append-only
      // log and a near-zero reading poisoning D32's setup-cost column.
      ...(ensureResult.reused
        ? {}
        : {
            worktreeEvent: taskWorktreeCreated({
              taskId: task.taskId,
              path: ensureResult.path,
              branch: ensureResult.branch,
              setupMs: ensureResult.setupMs,
            }),
          }),
    };
  }

  /**
   * Resume the hot author for a fix. The `spawn` path's mirror image, and it
   * differs in exactly three ways — each one deliberate:
   *
   *   1. No cwd is resolved. The session comes back in its OWN recorded directory
   *      (I3), which is the directory its prompt cache is scoped to (D6).
   *   2. The `appSessionId` is not new. `resumeSession` returns the SAME id, so
   *      this is the same session running a second stage for this task — which is
   *      the point of the fix loop, not an accident to be defended against.
   *   3. A failure is `resume-failed`, not `spawn-failed`.
   *
   * ⚠ **THE I11 INTERACTION, stated where it happens.** `SessionHost.resumeSession`
   * REFUSES a session that already has a live process ("a live session is never
   * re-spawned"), and `decideDispatch` has already refused `already-running` before
   * control reaches here. THE TWO GUARDS AGREE, AND THEY ARE INDEPENDENT. The
   * dispatcher's guard reads the task's refs against `isLive` at decision time; the
   * host's reads its own live-process registry at the instant of the call. This one
   * is the BACKSTOP: it does not depend on the dispatcher's view of liveness being
   * current, so a race between the liveness read and the resume — the exact window
   * a scheduling loop will widen — ends in a refusal rather than a double-run. Do
   * not "simplify" by trusting the earlier check; the earlier check is the
   * optimisation and this one is the guarantee.
   */
  private resumeStageRun(
    task: TaskRecord,
    stage: string,
    plan: Extract<StageRunnerPlan, { mode: 'resume' }>,
  ): DispatchAttemptResult {
    let resumeResult;
    try {
      resumeResult = this.deps.sessionHost.resumeSession(plan.appSessionId);
    } catch (resumeError) {
      // Same contract as the spawn path: the host's job is to refuse rather than
      // throw, and a dispatcher must survive its adapters regardless.
      return {
        outcome: 'resume-failed',
        taskId: task.taskId,
        appSessionId: plan.appSessionId,
        reason: `resume-threw:${describeThrown(resumeError)}`,
      };
    }
    if ('refused' in resumeResult) {
      // NO `task_session_attached` — the ref would claim a stage run that is not
      // running. NO `dispatch_refused` either, on the same two counts as a failed
      // spawn: this was an execution failure rather than a decision, and the host
      // already evented its own refusal (I11's `transition_rejected`, or a
      // preflight rejection). Recording it again would double-count one failure.
      return {
        outcome: 'resume-failed',
        taskId: task.taskId,
        appSessionId: plan.appSessionId,
        reason: resumeResult.reason,
      };
    }

    // The link, recorded for the CURRENT stage. The id is the host's, never one
    // the dispatcher invented — `resumeSession` hands back the same session id.
    //
    // ⚠ WHAT THE PROJECTION DOES WITH THIS REPEAT, verified against the real fold
    // rather than assumed: `projections/tasks.ts` dedupes `task_session_attached`
    // ON `appSessionId` ALONE, so a second attach for a session already on the
    // task is a NO-OP and the existing ref KEEPS ITS ORIGINAL STAGE. Today that is
    // lossless, because the only resume `resolveStageRunner` can produce is an
    // `implementing` ref for an `implementing` stage — both fields already match,
    // and the event is an exact duplicate whose whole content is already in state.
    // It is still emitted: the log records what happened, and a projection's
    // idempotence is the projection's business (I6 replays either way).
    // IF A FUTURE RULE EVER RESUMES ACROSS STAGES, the board would under-report —
    // the ref would still read `implementing` while the session ran `review`. That
    // would be a PROJECTION decision (key on stage+session, or a new event), never
    // a workaround here.
    this.deps.emit([
      taskSessionAttached({
        taskId: task.taskId,
        stage,
        appSessionId: resumeResult.appSessionId,
      }),
    ]);
    const instructionDelivery = this.deliverStageInstruction(task, plan, resumeResult.appSessionId);
    return {
      outcome: 'resumed',
      taskId: task.taskId,
      stage,
      appSessionId: resumeResult.appSessionId,
      ...(instructionDelivery === undefined ? {} : { instructionDelivery }),
    };
  }

  /**
   * Compose and send this stage run's instruction, if there is one.
   *
   * Returns `undefined` when NOTHING WAS COMPOSED — which is the default, and the
   * whole of today's behaviour: no composer, no message, no result field. The
   * distinction between "no instruction exists" and "an instruction failed to
   * arrive" is the reason this returns `undefined` rather than a status of its own.
   *
   * ⚠ Never throws, and never fails the dispatch. The session exists and is
   * attached by the time we get here; unwinding that because a message did not
   * land would leave a live session the task no longer references.
   */
  private deliverStageInstruction(
    task: TaskRecord,
    plan: StageRunnerPlan,
    appSessionId: string,
  ): StageInstructionDelivery | undefined {
    let instructionText: string | null;
    try {
      instructionText = this.composeStageInstruction(task, plan);
    } catch (composeError) {
      return { status: 'not-delivered', reason: `compose-threw:${describeThrown(composeError)}` };
    }
    // `null` and the empty string are the same instruction: none. An empty send
    // would still cost a turn and would read to the agent as a prompt.
    if (typeof instructionText !== 'string' || instructionText.length === 0) {
      return undefined;
    }
    let sendResult;
    try {
      // The SAME path a human turn takes (`SessionHost.sendMessage`), which also
      // echoes the turn into the event log as a `message(role:'user')` — so a
      // stage run's brief is visible in the transcript exactly like any other
      // instruction. The dispatcher does not get a private channel.
      sendResult = this.deps.sessionHost.sendMessage(appSessionId, instructionText);
    } catch (sendError) {
      return { status: 'not-delivered', reason: `send-threw:${describeThrown(sendError)}` };
    }
    if ('refused' in sendResult) {
      return { status: 'not-delivered', reason: sendResult.reason };
    }
    return { status: 'sent' };
  }

  // Is a stage run already live for this task? Derived from the task's OWN refs
  // against the host's live-process registry — the same liveness the rest of the
  // daemon reads. A task with no refs has no live run by construction, which is
  // why `sessionRefs` had to become real (the core half of this step) before this
  // question could be asked at all.
  private hasLiveRun(task: TaskRecord): boolean {
    return task.sessionRefs.some((sessionRef) =>
      this.deps.sessionHost.isLive(sessionRef.appSessionId),
    );
  }
}

// A one-line description of a thrown value — never a stack, never a payload dump.
function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
