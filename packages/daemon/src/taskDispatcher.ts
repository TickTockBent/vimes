import {
  completionReported,
  decideDispatch,
  deriveReviewOutcome,
  dispatchRefused,
  planSubmitted,
  resolveStageRunner,
  reviewReported,
  taskSessionAttached,
  taskWorktreeCreated,
  type ArtifactStore,
  type DispatchDeferReason,
  type DispatchRefuseReason,
  type EventInput,
  type MetersState,
  type ReportCompletionPayload,
  type ReportReviewPayload,
  type StageInstructionContext,
  type StageRunnerPlan,
  type TaskRecord,
  type TasksState,
} from '@vimes/core';
import type { SessionHost } from './sessionHost.js';
import type { TaskWriter } from './taskWriter.js';
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
// ⚠ **ONE DELIBERATE EXCEPTION TO THAT RULE, ADDED BY S7·7c: the in-flight lock**
// (`inFlightDispatches`, D54). It is an `if` that changes whether something
// spawns, and it stays HERE rather than moving into `decideDispatch`, because
// in-flight-ness is PROCESS STATE — a set of live promises inside one daemon —
// not projection state. `decideDispatch` is pure and replayable from the log;
// "another call is halfway through its `await` right now" is not a fact the log
// contains and never will be. It is execution-level in exactly the way the
// worktree failure is, which is why it returns an EXECUTION outcome rather than
// a `DispatchRefuseReason`.
//
// ⚠ NO TIMER. NO SCHEDULING LOOP. `dispatchTask` is called explicitly — by tests
// today, by the task API (step 4b, and since S7·7c by the transitions route as
// D53's dispatch-on-promotion rider) or a scheduler later. Scheduling policy, and
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
  // ⚠ STEP 7 WIDENED IT BY TWO MORE, and **S7·7b TOOK ONE BACK (D46)**:
  //   • `resumeSession` — WAS the fix loop's whole point, and is GONE from this
  //     Pick. `resolveStageRunner` no longer answers "resume the hot author", so
  //     the dispatcher no longer needs the method that carried that out. ⚠ The
  //     method still EXISTS on `SessionHost` and is still wired to the human's own
  //     resume (wsHub.ts / app.ts) — D46 rider 2 scopes the reversal to stage runs.
  //     Narrowing the Pick is the assertable form of "the dispatcher cannot resume
  //     anything any more": re-adding a resume would first have to re-widen this.
  //   • `sendMessage` — the session host's EXISTING message path, used by the
  //     instruction seam below. It is the same path a human turn takes; the
  //     dispatcher does not get a private one (principle 9 — one way in).
  // No further methods: a dispatcher that can kill, rename or answer gates is a
  // second session authority, and this module deliberately is not one.
  sessionHost: Pick<SessionHost, 'spawnSession' | 'isLive' | 'sendMessage'>;
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
  // (Pre-S7·7b this comment went on to explain why the RESUME path did not consult
  // this seam. D46 removed that path; there is now only the spawn path, so the
  // caveat has nothing left to except.)
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
  // It receives the `StageRunnerPlan` as well as the task because spawn and resume
  // wanted opposite briefings. ⚠ S7·7b: D46 left `StageRunnerPlan` with ONE mode,
  // so the argument is now constant — it is KEPT because the parameter is part of
  // the pure composer's signature in core, and because a second mode would restore
  // the need for it. What actually distinguishes a fix from a first pass is the
  // CONTEXT's fix-seed, not the plan.
  //
  // Returning `null` or an empty string sends nothing. A non-empty string is sent
  // ONCE, through `sessionHost.sendMessage`, after the session exists.
  //
  // ⚠ S7·7a WIDENS IT WITH AN OPTIONAL 3rd PARAM — the fetched plan blob (and,
  // later, S7·7b's fix-seed) as a `StageInstructionContext`. Optional so the
  // default `() => null` and every pre-S7·7a construction stay source-compatible
  // and byte-identical: a composer that ignores the context is unchanged. The
  // daemon is the only caller that can supply it, because the blob is IO the pure
  // composer must not touch — see `deliverStageInstruction` for the fetch.
  composeStageInstruction?: (
    task: TaskRecord,
    plan: StageRunnerPlan,
    context?: StageInstructionContext,
  ) => string | null;

  // ── S7·5b-i: the native plan-capture seam (D48, I10) ─────────────────────────
  //
  // `recordPlan` is the STATE-OWNING half of native plan capture. When a plan-mode
  // planner emits a plan, the fragile SDK adapter (5b-ii, later) will only OBSERVE
  // it and PROPOSE it back through a callback; the dispatcher — which owns task
  // state (principle 10 / I10) — is what actually records it. Two deps make that
  // possible, and both are REQUIRED with no default because a recorded plan without
  // either is a half-written fact:
  //
  //   • `artifactStore` — the content-addressed blob store (S7·4). The plan CONTENT
  //     lives here; the task record and the `plan_submitted` event carry only the
  //     hash. The dispatcher is the writer, never the adapter.
  //   • `taskWriter` — narrowed to `proposeTaskTransition` alone (the same `Pick`
  //     idiom the session-host seam uses), so the planning→plan-ready move goes
  //     through I7's SINGLE choke point (which emits `task_transitioned` or an
  //     evented rejection), NOT a `task_transitioned` this module hand-rolls. A
  //     dispatcher that emitted the transition itself would be a second writer of
  //     task state, and I7 would stop being assertable the moment it did.
  //
  // ⚠ NO CALLER YET. `recordPlan` is invoked by nothing in this unit — the trigger
  // (the `ExitPlanMode` interception + the `onPlanCaptured` callback) is 5b-ii. So
  // wiring these deps changes NO live behaviour and needs no restart.
  artifactStore: ArtifactStore;
  taskWriter: Pick<TaskWriter, 'proposeTaskTransition'>;
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
// ⚠ S7·7e — `resumed` AND `resume-failed` ARE GONE, AS FORETOLD. Step 7 added
// them as EXECUTION-outcome siblings of `spawned` / `spawn-failed` (not a flag on
// them) so a caller could tell "a fresh stranger started this stage" from "the hot
// author picked it back up" without decoding a boolean. D46 (S7·7b) then removed
// the dispatcher's resume path entirely (`resumeStageRun`, which stood below the
// spawn path, is gone), which made both variants declared-but-unreachable — kept
// on purpose, at the time, because their consumers lived outside this module and
// outside its tests: `packages/ui/src/lib/taskBoard.ts`'s `describeDispatchResponse`
// (a `case 'resumed':` and a `case 'resume-failed':`, each with its own headline)
// and `packages/ui/src/lib/dispatchFollow.ts`'s `sessionToSubscribeAfterDispatch`
// (which named `resumed` as the one outcome deliberately excluded despite carrying
// an appSessionId). This unit is that promised UI-inclusive removal: both switch
// cases, both mentions in dispatchFollow's comments, and their tests are gone or
// repointed to pin the honest default-branch degrade for the now-retired strings.
// Type-only change here — nothing in this class could ever construct either
// variant, so no runtime behaviour moves with this edit.
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
  | {
      // ⚠ **S7·7c'S OUTCOME — THE D54 LOCK SPEAKING.** Another `dispatchTask` call
      // for THIS SAME taskId is already in flight in this process, so this attempt
      // did nothing at all: no decision was taken, no session spawned, no event
      // written. Three things about it, each of them a choice:
      //
      //   (a) **It is an EXECUTION-vocabulary sibling of `spawn-failed` and
      //       `worktree-failed`, NOT a `DispatchRefuseReason`.** The decision
      //       function never saw this attempt — the lock fires ABOVE
      //       `decideDispatch`, before the meters are even read. Putting it in the
      //       decision enum would make a `dispatch_refused` record claim the
      //       dispatcher refused work it never judged, which is a lie in an
      //       append-only log about the one thing that log is for.
      //   (b) **It is SILENT — nothing is emitted**, the same rationale as `defer`.
      //       Nothing happened and nothing changed; the CONCURRENT attempt's own
      //       result is the record of what this task did. Eventing here would write
      //       one record per loser of a race — non-events filling the log, which is
      //       pillar 5 (attention is the scarce resource) losing.
      //   (c) **It exists because `dispatchTask` went async in step 8**, and D54
      //       named the window: `already-running` is derived from the task's OWN
      //       refs against live processes, so it can only fire once
      //       `task_session_attached` has LANDED. Between `decideDispatch` saying
      //       spawn and that event being emitted there is an `await` (worktree
      //       creation is a subprocess), and a second attempt arriving inside it
      //       used to sail straight through to a second live session on one task.
      //       That was tolerable while every dispatch was human-clicked; S7·7c makes
      //       dispatch machine-initiated (D53 promotions), which is exactly the
      //       sharpening D54 said would arrive.
      //
      // ⚠ WHAT IT DOES NOT GUARD: another PROCESS. This is an in-memory set in one
      // daemon, and there is still no scheduler and no cross-process lease.
      readonly outcome: 'in-flight';
      readonly taskId: string;
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
  // ── S7·7c — THE D54 IN-FLIGHT LOCK: taskIds with a dispatch attempt underway ──
  //
  // The only mutable state this class has ever held, and it is deliberately the
  // smallest possible shape: a set of ids, added on the way in and removed in a
  // `finally`. It is not a queue (a loser waits for nothing — it returns
  // `in-flight` immediately), not a lease (nothing expires), and not persisted —
  // a daemon restart clears it, which is correct, because the promises it was
  // tracking died with the process.
  //
  // ⚠ CORRECTNESS RESTS ON JAVASCRIPT'S SINGLE THREAD. The add is in the
  // SYNCHRONOUS PREFIX of `dispatchTask`, before its first `await`, so no other
  // call can interleave between the check and the add. That is the whole
  // mechanism; anything that moved the add below an `await` would reopen exactly
  // the window this closes.
  private readonly inFlightDispatches = new Set<string>();
  private readonly resolveWorkingDirectory: (task: TaskRecord) => string;
  private readonly composeStageInstruction: (
    task: TaskRecord,
    plan: StageRunnerPlan,
    context?: StageInstructionContext,
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
   *   • `spawn`  → `resolveStageRunner` (step 7) says WHO runs the stage, and since
   *     D46 the answer is always the same one: the session host spawns an SDK
   *     session in the resolved cwd, then ONE `task_session_attached` records the
   *     link. Emitted only AFTER a real `appSessionId` comes back, so the board
   *     never shows a ref to a session that does not exist. **A `review` stage AND
   *     a fix both land here** — see stageRunner.ts for the independence rule and
   *     for D46's reversal of the old `mode: 'resume'` fix branch. An optional
   *     composed instruction is sent afterwards, carrying the FIX-SEED when the
   *     record has one (`deliverStageInstruction`).
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
   * ⚠ **THE PER-TASK IN-FLIGHT LOCK (S7·7c, D54) — WHAT IT GUARDS AND WHAT IT DOES
   * NOT.** The FIRST thing this method does after the unknown-task lookup is claim
   * `taskId` in `inFlightDispatches`; a second call that arrives while the first is
   * still running gets `in-flight` and returns without judging, spawning or
   * emitting anything. The whole remaining body is wrapped in `try/finally` so
   * EVERY path releases — refuse, defer, spawn, worktree-failed, and a spawn that
   * threw alike. A lock released on only the happy path is a task that can never be
   * dispatched again.
   *
   *   • **GUARDS: the async window D54 named.** `already-running` is derived from
   *     the task's own `sessionRefs` against live processes, so it cannot fire until
   *     `task_session_attached` has LANDED. Since step 8 there is an `await` between
   *     the decision and that event (worktree creation is a subprocess), and a
   *     second attempt inside that window used to reach a second spawn — two live
   *     sessions on one task. Human-clicked dispatch made that rare and visible;
   *     dispatch-on-promotion (D53, S7·7c) makes it machine-initiated, which is the
   *     sharpening D54 predicted.
   *   • **DOES NOT GUARD: another process.** It is an in-memory set in one daemon.
   *     There is still NO SCHEDULER, no retry, no queue and no cross-process lease;
   *     a second daemon over the same store would contend exactly as before.
   *   • **THE POST-ATTACH GUARDS ARE UNCHANGED and still do the other half of the
   *     job.** Once the attach event has landed, `decideDispatch`'s `already-running`
   *     refusal covers every later attempt (including one arriving after this
   *     process restarted), and `SessionHost`'s I11 backstop still refuses a resume
   *     against a live process on the human's own resume path. `ensureWorktree` is
   *     idempotent on top of both, so a racing pair converges on one directory.
   *     The lock closes the gap BETWEEN them; it does not replace either.
   */
  async dispatchTask(taskId: string): Promise<DispatchAttemptResult> {
    const task = this.deps.readTasks().tasks[taskId];
    if (task === undefined) {
      // The log is truth: we do not dispatch, and we do not record, a task that
      // does not exist. Writing a `dispatch_refused` here would put a taskId into
      // the task stream that no `task_created` ever introduced.
      return { outcome: 'unknown-task', taskId };
    }

    // ── THE D54 IN-FLIGHT LOCK (S7·7c) — claimed HERE, released in the `finally` ──
    //
    // AFTER the unknown-task lookup, deliberately: a taskId nothing ever created is
    // not a task to serialise against, and claiming one would leave the set holding
    // ids that no `task_created` ever introduced. BEFORE the decision, equally
    // deliberately: the loser of a race must not read the meters, must not judge,
    // and must not be able to reach any I/O — see the outcome's own note for why it
    // is an execution fact rather than a `DispatchRefuseReason`.
    //
    // SILENT. No event, same rationale as `defer`: nothing happened and nothing
    // changed, and the concurrent attempt's own result is the record.
    if (this.inFlightDispatches.has(taskId)) {
      return { outcome: 'in-flight', taskId };
    }
    // The claim is in the SYNCHRONOUS PREFIX — no `await` stands between the check
    // above and this line, which is the whole of the guarantee on a single thread.
    this.inFlightDispatches.add(taskId);
    try {
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
          //
          // ⚠ S7·7b DELETED THE `mode === 'resume'` BRANCH THAT STOOD HERE (D46 — a
          // recorded reversal). It read "THE FIX LOOP. The task came back down
          // `review → implementing`, so the work has an author and the author is
          // cache-warm" and routed to `resumeStageRun`. `resolveStageRunner` no longer
          // has a second mode to return, so there is nothing left to branch on and the
          // spawn path below is the whole of the answer. A fix carries its context in
          // the FIX-SEED instead (see `deliverStageInstruction`).
          const runnerPlan = resolveStageRunner(task);
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
          // D48: the PLANNING stage runs write-blocked in permissionMode 'plan' so
          // the planner produces a plan rather than doing the work; the SDK adapter
          // intercepts its ExitPlanMode and hands the plan to `recordPlan` (S7·5b-ii).
          // Every other stage spawns in the default mode — the key is added ONLY for
          // planning, keeping the non-planning spawn options byte-identical.
          // D50: EVERY dispatched task session is `dispatched: true` — the SDK adapter
          // then clamps it to the closed tool allowlist (no sub-agent spawns) and
          // auto-denies AskUserQuestion (no human to answer it). The planning branch
          // also runs write-blocked in permissionMode 'plan' (D48); every other
          // dispatched stage runs permissionMode 'auto' (Anthropic's server-side
          // classifier — no per-tool gate; the PreToolUse hard-deny boundary hook is
          // a separate follow-up unit, not yet in place).
          // S7·7d: BOTH branches name the stage, because the host uses it to decide
          // WHICH report tool this session is offered (`report_completion` for
          // implementing, `report_review` for review, neither for planning). It is
          // not a branch discriminator here — it is the same fact both branches
          // already have, now travelling to the one place that needs it.
          const spawnOptions =
            decision.stage === 'planning'
              ? {
                  channel: 'sdk' as const,
                  cwd,
                  dispatched: true as const,
                  permissionMode: 'plan' as const,
                  stage: decision.stage,
                }
              : {
                  channel: 'sdk' as const,
                  cwd,
                  dispatched: true as const,
                  permissionMode: 'auto' as const,
                  stage: decision.stage,
                };
          let spawnResult;
          try {
            spawnResult = this.deps.sessionHost.spawnSession(spawnOptions);
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
    } finally {
      // ⚠ EVERY PATH RELEASES — refused, deferred, spawned, worktree-failed, and a
      // spawn that THREW alike. A `finally` rather than a delete before each return
      // precisely because the throwing path is the one a hand-placed release
      // forgets, and a task whose id is never released is a task that can never be
      // dispatched again for the life of the process — a silent, permanent stall
      // that would look exactly like "the orchestrator stopped promoting things".
      this.inFlightDispatches.delete(taskId);
    }
  }

  /**
   * Record a captured plan — the DETERMINISTIC I10 core of native plan capture
   * (D48, S7·5b-i). Called with the planner's app-session id and the plan text a
   * plan-mode run produced; NOTHING calls it yet (the SDK-adapter trigger is
   * 5b-ii), so this method changes no live behaviour on its own.
   *
   * The dispatcher owns three writes here, IN THIS ORDER, and the order is the
   * contract: store the blob → emit `plan_submitted` → propose the transition. The
   * hash the event carries must name a blob that already exists, and the transition
   * must follow the fact it depends on.
   *
   * TOTAL and NEVER THROWS on its own paths — like `dispatchTask`, it is called from
   * an adapter (5b-ii) and a method that throws is a capture that silently stopped.
   * Two paths are deliberate NO-OPS:
   *
   *   • EMPTY PLAN → nothing. A plan-mode run that emitted only whitespace captured
   *     nothing; storing an empty-hash artifact and evening a `plan_submitted` for
   *     it would be a false fact in an append-only log — the plan that never was.
   *
   *   • UNKNOWN / NON-PLANNING SESSION → nothing. If no task carries a
   *     `{ stage: 'planning', appSessionId }` ref for this planner, there is no task
   *     to record against, and fabricating one would put a plan on a task the log
   *     never tied to this session — the same "unknown → nothing" discipline
   *     `dispatchTask` and `TaskWriter` already keep.
   *
   * ⚠ THE TRANSITION GOES THROUGH `taskWriter.proposeTaskTransition` (I7's choke
   * point), NEVER a `task_transitioned` this module emits. The writer adjudicates
   * planning→plan-ready and records EITHER a `task_transitioned` or an evented
   * rejection (e.g. the task already left `planning`) — both of which are correct
   * and both of which are the writer's to make, not the dispatcher's. Emitting the
   * transition here would make this a second writer of task state and break I10/I7.
   */
  recordPlan(plannerAppSessionId: string, planText: string): void {
    // 1. EMPTY GUARD — a whitespace-only plan captured nothing; see the no-op note.
    if (planText.trim() === '') {
      return;
    }

    // 2. REVERSE-LOOKUP the owning task from its OWN planning refs. Fresh read, like
    // every other read in this module — a stale board is a board that no longer
    // reflects which session is planning what. No task claims this planner → NO-OP.
    const owningTask = Object.values(this.deps.readTasks().tasks).find((task) =>
      task.sessionRefs.some(
        (sessionRef) =>
          sessionRef.stage === 'planning' && sessionRef.appSessionId === plannerAppSessionId,
      ),
    );
    if (owningTask === undefined) {
      return;
    }

    // 3. THE FORWARD-PATH IDENTITY (full attempt tracking is S7·7b). `attempt` is
    // the count of planning refs on this task — the Nth planning run, ≥1 because we
    // just matched one, which satisfies `submitPlanPayloadSchema`'s positive-int
    // rule. `workOrderRev` defaults to 0 until the first amendment (S7·2b), matching
    // the record's absent-until-amended field.
    const planningAttempt = owningTask.sessionRefs.filter(
      (sessionRef) => sessionRef.stage === 'planning',
    ).length;
    const workOrderRev = owningTask.workOrderRev ?? 0;

    // 4. STORE THE BLOB first — the plan CONTENT lives in the artifact store, the
    // event carries only its hash. The dispatcher is the writer (I10); the injected
    // `nowIso` is the only clock (rule 0.3).
    const planEnvelope = this.deps.artifactStore.put(planText, {
      kind: 'plan',
      taskRef: { taskId: owningTask.taskId, stage: 'planning' },
      rev: workOrderRev,
      createdBy: { appSessionId: plannerAppSessionId },
      createdAt: this.deps.nowIso(),
    });

    // 5. EMIT `plan_submitted` (S7·5a) — AFTER the blob exists, so the hash it
    // carries always names stored content. The fold augments the record with
    // `planArtifactHash`; the rest of the payload stays on the event for audit.
    this.deps.emit([
      planSubmitted({
        taskId: owningTask.taskId,
        stage: 'planning',
        attempt: planningAttempt,
        workOrderRev,
        planArtifactHash: planEnvelope.hash,
        plannerSessionRef: { appSessionId: plannerAppSessionId },
      }),
    ]);

    // 6. PROPOSE planning→plan-ready through I7's choke point — LAST, and never a
    // hand-rolled emit. The writer emits `task_transitioned` (or an evented
    // rejection if the task is not in `planning`, which is correct and recorded).
    this.deps.taskWriter.proposeTaskTransition(owningTask.taskId, {
      toStage: 'plan-ready',
      proposedBy: 'dispatcher',
    });
  }

  /**
   * Record a reported review — the DETERMINISTIC I10 core of the review path
   * (S7·6b), the exact mirror of `recordPlan`. Called with the reviewer's
   * app-session id and the per-criterion verdicts a dispatched review session
   * reported through the `report_review` tool (S7·6b's SDK-adapter trigger).
   *
   * The dispatcher owns two writes here, IN THIS ORDER, and the order is the
   * contract (mirroring recordPlan's store→emit→propose): emit `review_reported`
   * (the durable record) → propose the review→done / review→implementing transition
   * through `taskWriter.proposeTaskTransition` (I7's choke point). Unlike a plan,
   * the review payload is small structured data carried inline — NO artifact store.
   *
   * TOTAL and NEVER THROWS on its own paths — like `recordPlan`, it is called from an
   * adapter and a method that throws is a capture that silently stopped. One path is
   * a deliberate NO-OP:
   *
   *   • UNKNOWN / NON-REVIEW SESSION → nothing. If no task carries a
   *     `{ stage: 'review', appSessionId }` ref for this reviewer, there is no task
   *     to record against. THIS GUARD IS WHY EXPOSING `report_review` TO EVERY
   *     DISPATCHED SESSION IS SAFE: an implementing session that never calls it is a
   *     no-op, and one that spuriously calls it is guarded here.
   *
   * ⚠ THE TRANSITION GOES THROUGH `taskWriter.proposeTaskTransition` (I7's choke
   * point), NEVER a `task_transitioned` this module emits — the same contract
   * recordPlan keeps. The writer adjudicates the move and records EITHER a
   * `task_transitioned` or an evented rejection (e.g. the task already left
   * `review`). Emitting the transition here would make this a second writer of task
   * state and break I10/I7.
   */
  recordReview(reviewerAppSessionId: string, criteria: ReportReviewPayload['criteria']): void {
    // 1. REVERSE-LOOKUP the owning task from its OWN review refs (recordPlan keys on
    // 'planning'; this keys on 'review'). Fresh read, like every other read here. No
    // task claims this reviewer with a review ref → NO-OP (the safety guard above).
    const owningTask = Object.values(this.deps.readTasks().tasks).find((task) =>
      task.sessionRefs.some(
        (sessionRef) =>
          sessionRef.stage === 'review' && sessionRef.appSessionId === reviewerAppSessionId,
      ),
    );
    if (owningTask === undefined) {
      return;
    }

    // 2. IDENTITY (mirrors recordPlan). `attempt` = count of this task's review refs
    // (≥1, we just matched one); `workOrderRev` defaults to 0 until the first
    // amendment, matching the record's absent-until-amended field.
    const reviewAttempt = owningTask.sessionRefs.filter(
      (sessionRef) => sessionRef.stage === 'review',
    ).length;
    const workOrderRev = owningTask.workOrderRev ?? 0;

    // 3. EMIT `review_reported` (S7·6a) — the durable record, FIRST, so the fact is
    // written before the consequence is proposed (recordPlan's store→emit→propose
    // ordering, minus the store).
    this.deps.emit([
      reviewReported({
        taskId: owningTask.taskId,
        stage: 'review',
        attempt: reviewAttempt,
        workOrderRev,
        criteria,
      }),
    ]);

    // 4. DERIVE the outcome (S7·6a's pure function) and PROPOSE the transition
    // through I7's choke point — LAST, and never a hand-rolled emit. `done` when
    // every task criterion has a reported pass; `implementing` on any fail or
    // incomplete coverage. The writer emits `task_transitioned` (or an evented
    // rejection if the task is not in `review`, which is correct and recorded).
    const toStage = deriveReviewOutcome(
      criteria,
      owningTask.acceptanceCriteria?.map((criterion) => criterion.id) ?? [],
    );
    this.deps.taskWriter.proposeTaskTransition(owningTask.taskId, {
      toStage,
      proposedBy: 'dispatcher',
    });
  }

  /**
   * Record a reported completion — the DETERMINISTIC I10 core of the FIX side
   * (S7·7b), the exact mirror of `recordReview`. Called with the implementer's
   * app-session id and the worklog a dispatched implementing session reported
   * through the `report_completion` tool (S7·7b's SDK-adapter trigger).
   *
   * Two writes, IN THIS ORDER, and the order is the contract (recordReview's, and
   * recordPlan's before it): emit `completion_reported` (the durable record, and
   * the source of the `lastCompletion` fold that seeds the NEXT attempt's briefing)
   * → propose the transition through `taskWriter.proposeTaskTransition`. Record the
   * FACT before the CONSEQUENCE. No artifact store: the worklog is small structured
   * data carried inline, like the review verdict and unlike a plan.
   *
   * ⚠ **THE TRANSITION IS `implementing → review`, AND THAT IS D53's OUTCOME RULE
   * MADE REAL.** D53's taxonomy: promotions are DECISIONS (a human/orchestrator
   * call), reports are OUTCOMES — the work reporting its own state — and this is
   * the second outcome edge, alongside `planning → plan-ready` on plan capture and
   * `review → done/implementing` on the verdict. There is deliberately NO CHAINING:
   * `review` is a HOLDING PEN, not an active stage, so landing there dispatches
   * NOTHING. Whether an independent reviewer is spawned, or the task is bounced
   * straight back with specific fixes, is the orchestrator's judgement — and if a
   * future unit makes this auto-dispatch a reviewer, it has reversed D53 and needs
   * its own decision record.
   *
   * TOTAL and NEVER THROWS on its own paths — like `recordReview`, it is called from
   * an adapter and a method that throws is a capture that silently stopped. One path
   * is a deliberate NO-OP:
   *
   *   • UNKNOWN / NON-IMPLEMENTING SESSION → nothing. If no task carries a
   *     `{ stage: 'implementing', appSessionId }` ref for this author, there is no
   *     task to record against. THIS GUARD IS WHY EXPOSING `report_completion` TO
   *     EVERY DISPATCHED SESSION IS SAFE: a review session that never calls it is a
   *     no-op, and one that spuriously calls it is guarded here.
   *
   * ⚠ NEVER a `task_transitioned` this module emits — same I7 contract as its two
   * siblings. The writer adjudicates; a task that has already left `implementing`
   * gets the writer's EVENTED REJECTION, not a throw and not a silent success.
   */
  recordCompletion(
    implementerAppSessionId: string,
    worklog: ReportCompletionPayload['worklog'],
  ): void {
    // 1. REVERSE-LOOKUP the owning task from its OWN implementing refs (recordPlan
    // keys on 'planning', recordReview on 'review'; this keys on 'implementing').
    // Fresh read, like every other read here. No task claims this author with an
    // implementing ref → NO-OP (the safety guard above).
    const owningTask = Object.values(this.deps.readTasks().tasks).find((task) =>
      task.sessionRefs.some(
        (sessionRef) =>
          sessionRef.stage === 'implementing' &&
          sessionRef.appSessionId === implementerAppSessionId,
      ),
    );
    if (owningTask === undefined) {
      return;
    }

    // 2. IDENTITY (mirrors recordReview). `attempt` = count of this task's
    // implementing refs (≥1, we just matched one) — and since D46 every fix SPAWNS
    // a fresh session, that count is exactly the number of implementation attempts
    // rather than an approximation of it. `workOrderRev` defaults to 0 until the
    // first amendment, matching the record's absent-until-amended field.
    const implementingAttempt = owningTask.sessionRefs.filter(
      (sessionRef) => sessionRef.stage === 'implementing',
    ).length;
    const workOrderRev = owningTask.workOrderRev ?? 0;

    // 3. EMIT `completion_reported` (S7·7b-core) — the durable record, FIRST, so the
    // fact is written before the consequence is proposed. The fold puts the whole
    // payload on `TaskRecord.lastCompletion` (latest-wins), which is what
    // `deliverStageInstruction` reads back as the next attempt's fix-seed.
    this.deps.emit([
      completionReported({
        taskId: owningTask.taskId,
        stage: 'implementing',
        attempt: implementingAttempt,
        workOrderRev,
        worklog,
      }),
    ]);

    // 4. PROPOSE `implementing → review` through I7's choke point — LAST, and never
    // a hand-rolled emit. Unlike recordReview there is NOTHING TO DERIVE: a reported
    // completion has exactly one meaning (D53), so there is no `deriveCompletion-
    // Outcome` and no pure function to call. If a rule ever makes the target depend
    // on the worklog's content, THAT is when a pure deriver earns its place in core
    // — not before.
    this.deps.taskWriter.proposeTaskTransition(owningTask.taskId, {
      toStage: 'review',
      proposedBy: 'dispatcher',
    });
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

  // ⚠ **`resumeStageRun` STOOD HERE AND WAS DELETED BY S7·7b (D46) — A RECORDED
  // REVERSAL.** It was the `spawn` path's mirror image for the fix loop: it called
  // `sessionHost.resumeSession(plan.appSessionId)`, emitted the same
  // `task_session_attached`, and returned `resumed` / `resume-failed`. It resolved
  // no cwd (I3: a resumed session comes back in its OWN recorded directory, which
  // is what D6's machine+directory prompt cache is scoped to) and it carried a long
  // note on the I11 backstop — `resumeSession` refuses a session that already has a
  // live process, INDEPENDENTLY of `decideDispatch`'s `already-running` refusal.
  //
  // None of that reasoning was wrong; D46 removed the thing it was reasoning about.
  // A fix now SPAWNS (stageRunner.ts has the two arguments), so there is no second
  // execution path in this class at all.
  //
  // ⚠ **`SessionHost.resumeSession` IS ALIVE AND MUST STAY** — D46 rider 2 scopes
  // the reversal to STAGE RUNS. `wsHub.ts` and `app.ts` still route the human's own
  // resume through it; what died is the DISPATCHER's use, which is why the
  // `sessionHost` dep `Pick` below no longer names it. The I11 backstop still
  // guards that human path, inside the host where it always lived.

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
    // ── S7·7a: fetch the approved plan blob and hand it to the composer ────────
    //
    // The composer is PURE (rule 0.3) and must not touch the artifact store, so
    // the ONE piece of IO the fresh-implementer briefing needs happens HERE, at the
    // daemon boundary, and is passed IN. The task carries only the plan's content
    // hash (`planArtifactHash`); the blob lives in the store.
    //
    // (S7·7b: "BOTH call sites (spawn and resume)" used to be true of this method.
    // D46 removed the resume path entirely — there is now exactly ONE call site.)
    //
    // ⚠ NEVER THROWS, NEVER FAILS THE DISPATCH. A store read is IO, so it is inside
    // the same try/catch discipline the rest of this method keeps: a fetch that
    // throws, or a present hash whose blob is null (shouldn't happen — the store
    // wrote it at `recordPlan`), DEGRADES to the no-plan briefing rather than
    // erroring. Absent hash → no fetch at all (the store is not consulted), so a
    // task that never planned is byte-identical to before this unit.
    let planBlobText: string | undefined;
    if (task.planArtifactHash !== undefined) {
      try {
        const planBlob = this.deps.artifactStore.getBlob(task.planArtifactHash);
        planBlobText = planBlob === null ? undefined : planBlob;
      } catch {
        // A failed blob read is not a failed dispatch — degrade to no plan. The
        // composer then falls back to its work-order-only (or generic) briefing.
        planBlobText = undefined;
      }
    }

    // ── S7·7b: the FIX-SEED (D46), read straight off the task record ───────────
    //
    // NO IO AT ALL, in deliberate contrast to the plan above: `lastReview` and
    // `lastCompletion` are FOLDED FIELDS (S7·7b-core's projection folds of
    // `review_reported` / `completion_reported`), so the seed is already in the
    // record this method was handed. That is the whole reason the payloads are
    // carried inline on their events rather than stored as blobs — a fix-seed that
    // needed a fetch would need a degrade path, and this one cannot fail.
    //
    // ⚠ **LATEST-WINS, AND STALE-REV FEEDBACK CAN RIDE ALONG. ACCEPTED FOR NOW.**
    // Both fields keep only the NEWEST report (see taskRecordSchema). After an
    // AMENDMENT (a new `workOrderRev`, D46's second correction door) the newest
    // review may have judged the OLD work-order, and it will still be rendered into
    // the new revision's briefing. The payloads each carry their own `workOrderRev`,
    // so a filter — "drop a seed whose rev is behind the task's" — is a few lines
    // away; it is deliberately NOT built in this unit, because which side of that
    // choice is right (drop it, or show it labelled as stale) is a product call
    // nobody has made. If you are here because a fixer acted on obsolete feedback,
    // this is the note you were looking for.
    //
    // ABSENT STAYS ABSENT: each key is spread in only when its source is present,
    // never set to `undefined`. A present-but-undefined key is NOT the same as an
    // absent one — `composeStageInstruction`'s contract is that an empty context
    // composes byte-identically to no context, and `'reviewFeedback' in context`
    // must stay false on a first pass.
    const reviewFeedback = task.lastReview?.criteria;
    const worklog = task.lastCompletion?.worklog;
    const instructionContext: StageInstructionContext = {
      ...(planBlobText === undefined ? {} : { plan: planBlobText }),
      ...(reviewFeedback === undefined ? {} : { reviewFeedback }),
      ...(worklog === undefined ? {} : { worklog }),
    };
    // An EMPTY context is passed as `undefined`, not as `{}` — that is what keeps a
    // first-pass dispatch byte-identical to the pre-S7·7a call, where the third
    // argument did not exist at all.
    const planContext: StageInstructionContext | undefined =
      Object.keys(instructionContext).length === 0 ? undefined : instructionContext;

    let instructionText: string | null;
    try {
      instructionText = this.composeStageInstruction(task, plan, planContext);
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
