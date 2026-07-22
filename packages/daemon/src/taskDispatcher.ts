import {
  decideDispatch,
  dispatchRefused,
  taskSessionAttached,
  type DispatchDeferReason,
  type DispatchRefuseReason,
  type EventInput,
  type MetersState,
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
  sessionHost: Pick<SessionHost, 'spawnSession' | 'isLive'>;
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
  resolveWorkingDirectory?: (task: TaskRecord) => string;
}

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
export type DispatchAttemptResult =
  | {
      readonly outcome: 'spawned';
      readonly taskId: string;
      readonly stage: string;
      readonly appSessionId: string;
      readonly cwd: string;
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
  | { readonly outcome: 'unknown-task'; readonly taskId: string };

export class TaskDispatcher {
  private readonly deps: TaskDispatcherDeps;
  private readonly resolveWorkingDirectory: (task: TaskRecord) => string;

  constructor(deps: TaskDispatcherDeps) {
    this.deps = deps;
    this.resolveWorkingDirectory = deps.resolveWorkingDirectory ?? projectRootWorkingDirectory;
  }

  /**
   * Attempt to dispatch ONE task, right now. TOTAL: every path returns a result
   * and NOTHING throws — a dispatcher that throws is a dispatcher that has
   * silently stopped, and this one is called from an HTTP handler (step 4b) and
   * eventually a scheduler.
   *
   * What gets written, and what deliberately does not:
   *
   *   • `spawn`  → the session host spawns an SDK session in the resolved cwd,
   *     then ONE `task_session_attached` records the link. Emitted only AFTER a
   *     real `appSessionId` comes back, so the board never shows a ref to a
   *     session that does not exist.
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
        return {
          outcome: 'spawned',
          taskId: task.taskId,
          stage: decision.stage,
          appSessionId: spawnResult.appSessionId,
          cwd,
        };
      }
    }
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
