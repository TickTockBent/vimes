import {
  decideDispatch,
  dispatchRefused,
  resolveStageRunner,
  taskSessionAttached,
  type DispatchDeferReason,
  type DispatchRefuseReason,
  type EventInput,
  type MetersState,
  type StageRunnerPlan,
  type TaskRecord,
  type TasksState,
} from '@vimes/core';
import type { SessionHost } from './sessionHost.js';

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

// ─── THE ISOLATION SCOPE BOUNDARY — LOUD ON PURPOSE ──────────────────────────
//
// **D32 pinned `worktree` as the default isolation. WORKTREE CREATION IS STEP 8.
// Until step 8 lands, EVERY task — including one whose record says
// `isolation: 'worktree'` — runs in `task.projectRoot`, i.e. ISOLATION IS NOT YET
// HONOURED.**
//
// `task.isolation` is therefore a field this step deliberately READS AND DOES NOT
// ACT ON, which is exactly the kind of gap that becomes a silent bug: the record
// says worktree, the board will say worktree, and two workers would happily edit
// the same files. Rather than ignore the field quietly, the working directory is
// resolved through an EXPLICIT INJECTED SEAM whose default is named and exported
// below. Step 8 replaces this resolver with real worktree resolution; the test
// `taskDispatcher.test.ts` ASSERTS the current (wrong-for-D32) behaviour, so the
// day step 8 lands, that assertion reddens and the change is deliberate and
// visible instead of accidental.
//
// If you are reading this because a worker clobbered another worker's files:
// this is the gap, and step 8 is the fix. Do not paper over it here.
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
  // Where a stage run executes. See the isolation boundary note above — the
  // default is `task.projectRoot` and it is NOT D32-correct yet.
  //
  // ⚠ CONSULTED ON THE SPAWN PATH ONLY. A RESUMED session keeps the cwd it was
  // created with — `SessionHost.resumeSession` takes no cwd and resumes "from the
  // RECORDED cwd" (I3) — and that is correct, not an omission: the hot author's
  // cache is scoped to machine+directory (D6), so moving it would throw away the
  // exact thing the resume exists to keep. Step 8 makes that directory a worktree.
  resolveWorkingDirectory?: (task: TaskRecord) => string;

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
  | { readonly outcome: 'unknown-task'; readonly taskId: string };

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
   */
  dispatchTask(taskId: string): DispatchAttemptResult {
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
        const cwd = this.resolveWorkingDirectory(task);
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
