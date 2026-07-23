import {
  assessStageRun,
  watchdogStale,
  withNotificationTrigger,
  type EventInput,
  type SessionRecord,
  type SessionsState,
  type StageRunObservation,
  type TasksState,
  type WatchdogPolicy,
  type WatchdogVerdict,
} from '@vimes/core';

// ─── slice 6 step 5b — the watchdog RUNNER (daemon I/O) ──────────────────────
//
// Step 5a built the pure decision (`assessStageRun`). This module is the I/O
// boundary that runs it over every live stage run and writes down what it saw.
// The split is the same one `taskDispatcher.ts` draws (rule 0.3): everything
// JUDGED lives in packages/core and replays with no Claude, no network and no
// clock; everything DONE lives here. This class therefore contains NO policy —
// it reads projections, assembles an observation, hands it to the pure function
// and acts on the verdict. **An `if` here that changes WHETHER a run is stale
// belongs in `assessStageRun`**; a second decider is a second authority
// (principle 10), and the watchdog stops being assertable headlessly the moment
// one exists.
//
// ═══ WHAT THIS UNIT DOES AND DELIBERATELY DOES NOT DO ════════════════════════
//
// **IT DETECTS AND REPORTS. IT NEVER QUARANTINES AND NEVER RETRIES.** Nothing
// here emits `task_quarantined`, kills a session, nudges a run or schedules a
// retry — in ANY branch, including the one where `assessStageRun` returns
// `quarantine`.
//
// That is a rule-0.2 (Gate-D) call, not an oversight. D30 PINNED the 15-minute
// staleness band against real measurement. It pinned **nothing** about retries:
// spike S3 measured staleness, not retry behaviour, so ⟨tune⟩
// retries-before-quarantine and the backoff curve have **no evidence behind
// them at all** — and an uncalibrated number may not drive a destructive
// action. So the pinned half ships (detection + attention) and the destructive
// half waits for a sign-off that has not happened.
//
// `wouldQuarantine` on the emitted record is how that ⟨tune⟩ gets EARNED: it
// records what we would have done, so the question "how often would we have
// quarantined, and would it have been right?" can be asked against real work
// before anything is allowed to act on it. **Because no unpinned number drives
// an action or a FAIL-able assertion here, this file pins nothing** — the
// policy is entirely caller-supplied, the retry ⟨tune⟩s only ever colour a
// recorded observation, and the tests assert the SHAPE of what is written, never
// that any particular number is right.
//
// ⚠ **A `watchdog_stale` RAISES ATTENTION, AND ATTENTION PUSHES A NOTIFICATION
// TO A REAL PERSON'S PHONE** (the I5 setter path, slice 2). A false positive is
// not a log line — it is a buzz in someone's pocket at 3am about a run that was
// fine. That is why every protection in `assessStageRun` is checked before any
// escalation, and why this runner adds no escalation of its own.
//
// ⚠ NO TIMER LIVES HERE. `checkOnce()` is called explicitly — by tests today,
// by the daemon's interval in `app.ts` in production — so the cadence is a
// daemon-boundary concern and every test drives the check by hand.

// ─── the dedup: how a run silent for HOURS produces ONE record ───────────────
//
// A check running every minute against a run that has been silent since
// yesterday must not write an event every minute. The answer needs no new state
// (principle 9): `watchdog_stale` sets `needsAttention.reason = 'stale'` through
// the existing I5 path, and that flag clears the moment the run appends again
// (the attention-clearing path slices 0–2 own). So the sessions projection
// ALREADY holds "we have reported this episode" — this runner just reads it.
//
// ⚠ **THE INTERLOCK, STATED SO IT CANNOT DRIFT.** `watchdogDecision.ts`
// classifies `'stale'` attention as NON-BLOCKING — it deliberately does not
// protect the run, so a run stays escalatable after its first report. This
// dedup uses that SAME flag as the already-reported marker. Both are correct
// and they must stay consistent: **if `'stale'` ever became a blocking reason,
// this dedup would silently become a permanent mute** (the decision would
// return healthy forever and no second episode could ever be recorded).
// Changing either classification means revisiting both.
const ALREADY_REPORTED_ATTENTION_REASON = 'stale';

export interface TaskWatchdogDeps {
  // Projection reads, called FRESH on every check and never cached in a field.
  // A watchdog judging yesterday's board is a watchdog reporting a run that has
  // since finished — and the dedup below reads attention state that the last
  // check itself may have written.
  readTasks: () => TasksState;
  readSessions: () => SessionsState;
  // The router's emit. Every event this module writes goes through it.
  emit: (events: EventInput[]) => void;
  // INJECTED clock (rule 0.3). The ONLY time source in this module; nothing here
  // calls Date.now(), and `assessStageRun` receives whatever this returns.
  nowIso: () => string;
  // The band + the (unpinned) retry ⟨tune⟩s, SUPPLIED. This module contains no
  // number of its own — rule 0.2 forbids a band living behind a silent default,
  // exactly as `assessStageRun` and `TaskDispatcher` already insist.
  policy: WatchdogPolicy;
}

// What happened to ONE stage run in ONE check.
export type WatchdogRunOutcome =
  | {
      // A `watchdog_stale` was written for this run.
      readonly outcome: 'reported';
      readonly taskId: string;
      readonly appSessionId: string;
      readonly verdict: WatchdogVerdict;
      // TRUE when the verdict was `quarantine` and we deliberately did not
      // quarantine. The calibration column; never an instruction.
      readonly wouldQuarantine: boolean;
    }
  | {
      // Stale, but this episode is already on the board — nothing written.
      readonly outcome: 'already-reported';
      readonly taskId: string;
      readonly appSessionId: string;
      readonly verdict: WatchdogVerdict;
    }
  | {
      // healthy / unknown → NOTHING is written. Named rather than omitted so a
      // caller can see the run was examined and cleared.
      readonly outcome: 'silent';
      readonly taskId: string;
      readonly appSessionId: string;
      readonly verdict: WatchdogVerdict;
    }
  | {
      // The task references a session the sessions projection does not have.
      // Skipped without a verdict and without a throw (I8's spirit).
      readonly outcome: 'unknown-session';
      readonly taskId: string;
      readonly appSessionId: string;
    };

export interface WatchdogCheckSummary {
  // The single clock read this check made, stamped once and reused for every
  // run examined, so one check judges one instant.
  readonly checkedAt: string;
  // How many (task, sessionRef) pairs were looked at.
  readonly runsExamined: number;
  // How many `watchdog_stale` events were written. NEVER anything else.
  readonly staleReportsEmitted: number;
  readonly outcomes: readonly WatchdogRunOutcome[];
}

export class TaskWatchdog {
  private readonly deps: TaskWatchdogDeps;

  constructor(deps: TaskWatchdogDeps) {
    this.deps = deps;
  }

  /**
   * Examine every stage run once, right now. TOTAL: every path returns a
   * summary and NOTHING throws — a watchdog that throws is a watchdog that has
   * silently stopped watching, and this one is called from an interval nobody
   * is reading the output of.
   *
   * What is written, and what deliberately is not:
   *
   *   • `stale` or `quarantine` → **at most ONE** `watchdog_stale` per run,
   *     carrying the evidence the record needs to explain itself (taskId,
   *     observedSilenceMs, retryNumber, wouldQuarantine), paired with its
   *     `notification_trigger` exactly as every other attention setter is.
   *
   *   • `healthy` / `unknown` → **NOTHING.** Not a "still fine" record, not a
   *     "cannot tell" record. Same reasoning as the dispatcher's silent
   *     `defer`: a check that writes a record per poll fills the log with
   *     non-events for as long as the condition holds, and pillar 5 (attention
   *     is the scarce resource) loses.
   *
   *   • `task_quarantined` → **NEVER, in any branch.** See the header.
   */
  checkOnce(): WatchdogCheckSummary {
    // ONE clock read for the whole check (rule 0.3): every run is judged
    // against the same instant, so a check is a single snapshot judgement and
    // repeated calls under a fixed clock are byte-identical.
    const checkedAtIso = this.deps.nowIso();
    const tasksState = this.deps.readTasks();
    const sessionsState = this.deps.readSessions();

    const outcomes: WatchdogRunOutcome[] = [];
    let staleReportsEmitted = 0;
    // Within a single check the sessions state is read ONCE, so the attention
    // flag cannot reflect a report this same check just wrote. This set closes
    // that window: one session gets at most one record per check even if two
    // tasks somehow reference it.
    const reportedSessionIdsThisCheck = new Set<string>();

    for (const task of Object.values(tasksState.tasks)) {
      // Task → session comes from the TASKS projection's `sessionRefs`, which
      // is the ONE source of that link: `spawnSession` writes `taskRef: null`,
      // so `session.taskRef` is never populated for a stage run (the known gap
      // recorded in taskDispatcher.ts). Reading the link from the side that
      // actually holds it is also what keeps this a same-stream question for
      // each projection — neither fold learns anything from the other's stream.
      for (const sessionRef of task.sessionRefs) {
        const session = sessionsState.sessions[sessionRef.appSessionId];
        if (session === undefined) {
          // A ref to a session the projection does not have. Skipped, never a
          // throw and never an event: we cannot observe a run we cannot see,
          // and "cannot see" is never grounds for escalation.
          outcomes.push({
            outcome: 'unknown-session',
            taskId: task.taskId,
            appSessionId: sessionRef.appSessionId,
          });
          continue;
        }

        const verdict = assessStageRun(
          buildStageRunObservation(task.taskId, session),
          this.deps.policy,
          checkedAtIso,
        );

        if (verdict.verdict !== 'stale' && verdict.verdict !== 'quarantine') {
          // healthy / unknown → silence. Deliberately not evented.
          outcomes.push({
            outcome: 'silent',
            taskId: task.taskId,
            appSessionId: session.appSessionId,
            verdict,
          });
          continue;
        }

        if (
          session.needsAttention?.reason === ALREADY_REPORTED_ATTENTION_REASON ||
          reportedSessionIdsThisCheck.has(session.appSessionId)
        ) {
          // This episode is already on the board (see the dedup note above).
          outcomes.push({
            outcome: 'already-reported',
            taskId: task.taskId,
            appSessionId: session.appSessionId,
            verdict,
          });
          continue;
        }

        const wouldQuarantine = verdict.verdict === 'quarantine';
        this.deps.emit(
          withNotificationTrigger(
            watchdogStale({
              appSessionId: session.appSessionId,
              taskId: task.taskId,
              observedSilenceMs: verdict.observedSilenceMs,
              // Which EPISODE this is, 1-based, continuous across the
              // stale→quarantine boundary: the `stale` verdict names the
              // episode directly, and a `quarantine` verdict names the retries
              // already exhausted, so the episode being recorded now is the
              // next one. The payload field is called `retryNumber` to match
              // the verdict field it copies verbatim; read it as "episode",
              // because nothing retries.
              retryNumber: wouldQuarantine
                ? verdict.retriesExhausted + 1
                : verdict.retryNumber,
              // ⟨CALIBRATION FIELD⟩ — what we WOULD have done, never an
              // instruction to do it. See the header: this is how the retry
              // ⟨tune⟩ earns its pin.
              wouldQuarantine,
            }),
          ),
        );
        reportedSessionIdsThisCheck.add(session.appSessionId);
        staleReportsEmitted += 1;
        outcomes.push({
          outcome: 'reported',
          taskId: task.taskId,
          appSessionId: session.appSessionId,
          verdict,
          wouldQuarantine,
        });
      }
    }

    return {
      checkedAt: checkedAtIso,
      runsExamined: outcomes.length,
      staleReportsEmitted,
      outcomes,
    };
  }
}

// Assemble the pure decision's input from ONE session record. Every field is
// read off the session — the record whose stream owns these facts (D34) — so
// nothing here folds, derives or second-guesses anything.
function buildStageRunObservation(taskId: string, session: SessionRecord): StageRunObservation {
  return {
    appSessionId: session.appSessionId,
    taskId,
    // The same liveness and attention state the rest of the daemon reads. The
    // watchdog never derives a second notion of "alive" or "blocked".
    liveness: session.liveness,
    needsAttention: session.needsAttention,
    // D34: the heartbeat is `SessionRecord.lastAppendAt` — advanced only by
    // transcript appends, never by daemon bookkeeping. Absent (an old record
    // that predates the field) reads as "never observed", which `assessStageRun`
    // turns into `unknown` and never escalates.
    lastHeartbeatAt: session.lastAppendAt ?? null,
    lastResumeBoundaryAt: lastResumeBoundaryOf(session),
    // ⚠ **D30'S OTHER RULE, CLOSED HERE (slice 6 step 6a).** 5a reserved
    // `correctionQueuedAt` and already honours it; 5b left it unset because
    // nothing observed the fact yet. Step 6a is what observes it: the sessions
    // projection folds `correction_queued` → `pendingCorrectionAt` and
    // `correction_delivered` → `null`, so this line is a READ of an observed
    // fact and adds no policy (`watchdogDecision.ts` is untouched).
    //
    // **Why the line matters.** D5 measured a correction sitting in the SDK
    // queue for **30.4 s** against a 40 s tool, with an UNBOUNDED worst case (a
    // long build or test suite), because injection is bounded by the next model
    // call and does not preempt an in-flight tool. For that whole window a run
    // that is being actively steered is INDISTINGUISHABLE from a run going
    // quiet. D30 says it explicitly: a queued-but-undelivered correction is NOT
    // staleness. Without this read the watchdog reports a healthy corrected run
    // as stale — and a stale report raises attention, and attention **pushes a
    // notification to a real person's phone** about work that was fine.
    //
    // `?? null` is the old-record path: a session record written before the
    // field existed has no pending correction, which is the same as none.
    correctionQueuedAt: session.pendingCorrectionAt ?? null,
    //
    // D34: the episode count is `SessionRecord.staleEpisodes`. Absent (a record
    // predating the field) reads as zero episodes so far.
    staleRetriesSoFar: session.staleEpisodes ?? 0,
  };
}

// When this session last crossed a RESUME BOUNDARY, per D30 condition (2).
//
// A `claude_session_mapped` IS the append a resume produces, so the newest
// mapping's `observedAt` is the boundary. Read as the LAST element rather than
// by comparing timestamps: the sessions projection APPENDS mappings in log
// order and never sorts them (I1 — rotation changes only the mapping), so array
// order is observation order, and a string comparison would silently depend on
// every `observedAt` being the same ISO shape.
//
// For a FIRST mapping this marks a session that has just started and has not
// appended anything else yet — `assessStageRun` reads that as `resume-boundary`
// and protects it. That is the safe direction, and it is why a just-spawned run
// is never reported stale.
function lastResumeBoundaryOf(session: SessionRecord): string | null {
  const newestMapping = session.claudeSessionIds.at(-1);
  return newestMapping === undefined ? null : newestMapping.observedAt;
}
