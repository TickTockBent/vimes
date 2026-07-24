import {
  attentionCleared,
  EVENT_TYPES,
  watchdogStale,
  withNotificationTrigger,
} from '../../events.js';
import { readAllStreamsGrouped } from '../../projections/projection.js';
import type { SessionRecord } from '../../schemas.js';
import {
  assessStageRun,
  type StageRunObservation,
  type WatchdogPolicy,
  type WatchdogVerdict,
} from '../../tasks/watchdogDecision.js';
import type { ScenarioProfile } from '../scenario.js';
import type { World } from '../world.js';

// ─── slice 6 step 10 — the watchdog SCENARIO (spec §7, seventh profile) ──────
//
// A stage run goes silent → the watchdog REPORTS it stale → escalates across
// episodes → reaches the `quarantine` VERDICT **without ever killing anything**,
// and raises attention — deterministically, twice (the double-run proves it).
//
// The spine of what this proves: the watchdog DETECTS AND REPORTS. It NEVER
// quarantines, retries or kills. Quarantine ENFORCEMENT is Gate-D-parked (rule
// 0.2 — the retry ⟨tune⟩s have no evidence yet; D30 pinned only the 15-min
// band). So this scenario drives real `watchdog_stale` events (each carrying a
// `wouldQuarantine` calibration flag) through the FULL standing-assert battery
// (I6 snapshot+tail, cross-stream commutativity, attention-batch, liveness
// edges) over a log that CONTAINS them, and asserts the load-bearing negative:
// **NO `task_quarantined` event anywhere**, in any episode, including the one
// where the decision returns `quarantine`.
//
// Two genuinely-failing false-positive controls guard the slice's named rule-0.1
// finding ("the watchdog quarantines a HEALTHY run, especially one blocked at a
// gate"): CONTROL A (an appending run inside the band) and CONTROL B (a
// gate-blocked run left silent for 90 min — the 10-hour human-wait protection).

// ── the policy (scenario-local — NOT a pin) ──────────────────────────────────
// staleAfterMs uses D30's pinned 15-min band for realism; maxStaleRetries /
// retryBackoffMs are UNPINNED ⟨tune⟩s (rule 0.2) chosen small ONLY to drive the
// progression in a few steps — this scenario pins nothing and asserts
// RELATIONSHIPS (Nth episode escalates; quarantine verdict once episodes are
// exhausted), never that any number is correct.
const SCENARIO_WATCHDOG_POLICY: WatchdogPolicy = {
  staleAfterMs: 15 * 60_000,
  maxStaleRetries: 2,
  retryBackoffMs: [60_000, 120_000],
};

// Pure string→ms→string (Date.parse / new Date(<number>) / toISOString are all
// clock-free, rule 0.3 — assessStageRun itself parses timestamps this way).
// Deterministic: the same lastAppendAt every run ⇒ the same nowIso, so a 15-min
// silence costs zero world-clock steps. The argument to new Date is ALWAYS a
// number here (never argless, never a wall-clock read), which is why the
// nondeterminism grep gate stays clean.
function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

// Models packages/daemon/src/taskWatchdog.ts checkOnce() for ONE session: build
// the observation exactly as buildStageRunObservation (taskWatchdog.ts ~288-327)
// does, call the REAL assessStageRun, and on stale/quarantine emit the REAL
// watchdog_stale (paired with its notification_trigger, per the attention-batch
// rule) UNLESS this episode is already on the board (the dedup — taskWatchdog's
// ALREADY_REPORTED_ATTENTION_REASON = 'stale'). Returns the verdict so the
// profile can assert on it. wouldQuarantine = (verdict === 'quarantine') —
// RECORDED, never acted on: no task_quarantined is ever emitted.
//
// The task→session resolution the real checkOnce performs (iterate tasks →
// sessionRefs to FIND sessions) is taskWatchdog.test.ts's concern in the daemon,
// not this harness scenario's: sweepOnce is handed the session directly and
// taskId is only a payload label, so this profile emits NO task events and the
// tasks projection stays empty (it still folds/serializes deterministically).
function sweepOnce(
  world: World,
  appSessionId: string,
  taskId: string,
  nowIso: string,
): WatchdogVerdict {
  const session = world.projectionHost.sessionsState().sessions[appSessionId];
  if (session === undefined) {
    throw new Error(`watchdog-stale: sweepOnce on unknown session ${appSessionId}`);
  }

  // Mirror buildStageRunObservation field-for-field (taskWatchdog.ts) — a
  // deliberate MODEL of the runner, not a second authority over what is stale.
  const observation: StageRunObservation = {
    appSessionId: session.appSessionId,
    taskId,
    liveness: session.liveness,
    needsAttention: session.needsAttention,
    lastHeartbeatAt: session.lastAppendAt ?? null,
    lastResumeBoundaryAt: session.claudeSessionIds.at(-1)?.observedAt ?? null,
    correctionQueuedAt: session.pendingCorrectionAt ?? null,
    staleRetriesSoFar: session.staleEpisodes ?? 0,
  };

  const verdict = assessStageRun(observation, SCENARIO_WATCHDOG_POLICY, nowIso);

  // healthy / unknown → nothing is written (the dispatcher's silent-defer
  // discipline: attention is the scarce resource).
  if (verdict.verdict !== 'stale' && verdict.verdict !== 'quarantine') {
    return verdict;
  }

  // The dedup: a run silent for HOURS produces ONE record per episode. The
  // 'stale' attention flag IS the already-reported marker (needs no new state);
  // it clears when a human dismisses or the run appends, re-arming the next
  // episode. watchdog_stale deliberately classifies 'stale' as NON-blocking, so
  // the run stays escalatable — that interlock is what keeps this a dedup rather
  // than a permanent mute.
  if (session.needsAttention?.reason === 'stale') {
    return verdict;
  }

  const wouldQuarantine = verdict.verdict === 'quarantine';
  world.router.emit(
    withNotificationTrigger(
      watchdogStale({
        appSessionId: session.appSessionId,
        taskId,
        observedSilenceMs: verdict.observedSilenceMs,
        // Episode number, 1-based and continuous across the stale→quarantine
        // boundary, computed exactly as taskWatchdog does.
        retryNumber: wouldQuarantine ? verdict.retriesExhausted + 1 : verdict.retryNumber,
        // ⟨CALIBRATION FIELD⟩ — what we WOULD have done, never an instruction.
        wouldQuarantine,
      }),
    ),
  );
  return verdict;
}

function requireSession(world: World, appSessionId: string): SessionRecord {
  const session = world.projectionHost.sessionsState().sessions[appSessionId];
  if (session === undefined) {
    throw new Error(`watchdog-stale: expected session ${appSessionId} to exist`);
  }
  return session;
}

function watchdogStaleCountOn(world: World, appSessionId: string): number {
  return world.store
    .read(appSessionId, 1)
    .filter((record) => record.type === EVENT_TYPES.watchdogStale).length;
}

const watchdogStaleProfile: ScenarioProfile = {
  name: 'watchdog-stale',
  run(world) {
    // ── the STALE run ────────────────────────────────────────────────────────
    // A governed (running) stage-run session that appends once, then goes
    // silent. No real task record is needed — sweepOnce is handed the session
    // directly and taskId is a synthetic payload label (see sweepOnce's note).
    const staleTaskId = 'task-stale-1';
    const staleSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/stale' });
    const staleHandle = world.registry.spawn('sdk', staleSessionId);
    if (requireSession(world, staleSessionId).liveness !== 'running') {
      throw new Error('watchdog-stale: stale run did not reach running');
    }
    // ONE transcript append sets the heartbeat (lastAppendAt). Assistant role so
    // it does not auto-title — irrelevant to staleness, keeps the record small.
    world.fakeSdk.run(staleHandle, [
      { kind: 'message', role: 'assistant', content: 'starting the migration…' },
    ]);
    const t0 = requireSession(world, staleSessionId).lastAppendAt;
    if (t0 === undefined || t0 === null) {
      throw new Error('watchdog-stale: heartbeat (lastAppendAt) was never set on the stale run');
    }

    // ── Episode 1: silence just past the band → stale, episode 1 ─────────────
    const episodeOneVerdict = sweepOnce(world, staleSessionId, staleTaskId, minutesAfter(t0, 16));
    if (episodeOneVerdict.verdict !== 'stale' || episodeOneVerdict.retryNumber !== 1) {
      throw new Error('watchdog-stale: episode 1 was not stale/retry 1');
    }
    if (watchdogStaleCountOn(world, staleSessionId) !== 1) {
      throw new Error('watchdog-stale: episode 1 did not write exactly one watchdog_stale');
    }
    {
      const session = requireSession(world, staleSessionId);
      if (session.needsAttention?.reason !== 'stale') {
        throw new Error('watchdog-stale: episode 1 did not raise stale attention');
      }
      if (session.staleEpisodes !== 1) {
        throw new Error('watchdog-stale: episode 1 did not fold staleEpisodes to 1');
      }
    }

    // A human saw the ping and dismissed it; the run is STILL silent. Attention
    // clears; the episode count is untouched (the episode-reset mechanism).
    world.router.emit([attentionCleared({ appSessionId: staleSessionId, cause: 'dismissed' })]);
    {
      const session = requireSession(world, staleSessionId);
      if (session.needsAttention !== null) {
        throw new Error('watchdog-stale: dismiss after episode 1 did not clear attention');
      }
      if (session.staleEpisodes !== 1) {
        throw new Error('watchdog-stale: dismiss after episode 1 changed staleEpisodes');
      }
    }

    // ── Episode 2: still silent → stale, episode 2 ───────────────────────────
    const episodeTwoVerdict = sweepOnce(world, staleSessionId, staleTaskId, minutesAfter(t0, 32));
    if (episodeTwoVerdict.verdict !== 'stale' || episodeTwoVerdict.retryNumber !== 2) {
      throw new Error('watchdog-stale: episode 2 was not stale/retry 2');
    }
    if (requireSession(world, staleSessionId).staleEpisodes !== 2) {
      throw new Error('watchdog-stale: episode 2 did not fold staleEpisodes to 2');
    }
    world.router.emit([attentionCleared({ appSessionId: staleSessionId, cause: 'dismissed' })]);
    if (requireSession(world, staleSessionId).needsAttention !== null) {
      throw new Error('watchdog-stale: dismiss after episode 2 did not clear attention');
    }

    // ── Would-quarantine: episodes exhausted (2 ≥ maxStaleRetries 2) ──────────
    const wouldQuarantineVerdict = sweepOnce(world, staleSessionId, staleTaskId, minutesAfter(t0, 48));
    if (wouldQuarantineVerdict.verdict !== 'quarantine') {
      throw new Error('watchdog-stale: exhausted run did not reach the quarantine verdict');
    }
    if (requireSession(world, staleSessionId).staleEpisodes !== 3) {
      throw new Error('watchdog-stale: would-quarantine episode did not fold staleEpisodes to 3');
    }
    {
      // The record just written must carry wouldQuarantine === true.
      const lastStale = world.store
        .read(staleSessionId, 1)
        .filter((record) => record.type === EVENT_TYPES.watchdogStale)
        .at(-1);
      if (lastStale === undefined) {
        throw new Error('watchdog-stale: would-quarantine episode wrote no watchdog_stale');
      }
      if ((lastStale.payload as { wouldQuarantine?: boolean }).wouldQuarantine !== true) {
        throw new Error('watchdog-stale: would-quarantine record did not set wouldQuarantine=true');
      }
    }

    // ── THE LOAD-BEARING NEGATIVE: zero task_quarantined on ANY stream ───────
    // Detect-and-report, never kill — including the episode where the decision
    // returned `quarantine`. Quarantine ENFORCEMENT is Gate-D-parked (rule 0.2).
    const quarantinedAnywhere = readAllStreamsGrouped(world.store).filter(
      (record) => record.type === EVENT_TYPES.taskQuarantined,
    );
    if (quarantinedAnywhere.length !== 0) {
      throw new Error(
        `watchdog-stale: the watchdog KILLED a run — ${quarantinedAnywhere.length} task_quarantined event(s) emitted`,
      );
    }

    // ── CONTROL A: an appending run inside the band is NEVER reported ────────
    const appendingTaskId = 'task-appending-1';
    const appendingSessionId = world.registry.createSession({
      channel: 'sdk',
      cwd: '/home/wes/appending',
    });
    const appendingHandle = world.registry.spawn('sdk', appendingSessionId);
    world.fakeSdk.run(appendingHandle, [
      { kind: 'message', role: 'assistant', content: 'still working, appending regularly…' },
    ]);
    const appendingLastAppend = requireSession(world, appendingSessionId).lastAppendAt;
    if (appendingLastAppend === undefined || appendingLastAppend === null) {
      throw new Error('watchdog-stale: control A never set a heartbeat');
    }
    const appendingVerdict = sweepOnce(
      world,
      appendingSessionId,
      appendingTaskId,
      minutesAfter(appendingLastAppend, 1), // 1 min < 15-min band
    );
    if (appendingVerdict.verdict !== 'healthy' || appendingVerdict.reason !== 'appending') {
      throw new Error('watchdog-stale: control A (appending) was not healthy/appending');
    }
    if (watchdogStaleCountOn(world, appendingSessionId) !== 0) {
      throw new Error('watchdog-stale: control A was reported stale (false positive)');
    }
    if (requireSession(world, appendingSessionId).needsAttention !== null) {
      throw new Error('watchdog-stale: control A acquired attention it should never have');
    }

    // ── CONTROL B: a gate-blocked run silent past the band is NEVER reported ──
    // The 10-hour human-wait protection (D30 condition 1), and the profile's
    // most important assertion: a run parked on a permission prompt is NOT a
    // stall no matter how long it waits.
    const gateTaskId = 'task-gate-1';
    const gateSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/gate' });
    const gateHandle = world.registry.spawn('sdk', gateSessionId);
    // The gate raises needsAttention:'gate' AND (as a transcript append) sets the
    // heartbeat — so the run has appended, then blocked on a person.
    world.fakeSdk.run(gateHandle, [{ kind: 'gate', prompt: 'apply destructive migration?' }]);
    {
      const session = requireSession(world, gateSessionId);
      if (session.needsAttention?.reason !== 'gate') {
        throw new Error('watchdog-stale: control B did not block on a gate');
      }
      if (session.lastAppendAt === undefined || session.lastAppendAt === null) {
        throw new Error('watchdog-stale: control B never set a heartbeat');
      }
      const gateVerdict = sweepOnce(
        world,
        gateSessionId,
        gateTaskId,
        minutesAfter(session.lastAppendAt, 90), // 90 min ≫ band, but human-blocked
      );
      if (gateVerdict.verdict !== 'healthy' || gateVerdict.reason !== 'awaiting-human') {
        throw new Error('watchdog-stale: control B (gate-blocked) was not healthy/awaiting-human');
      }
    }
    if (watchdogStaleCountOn(world, gateSessionId) !== 0) {
      throw new Error(
        'watchdog-stale: control B (gate-blocked, silent 90 min) was reported stale — the named finding',
      );
    }

    // No restart: return nothing. runScenario then runs the standing asserts
    // (orphanScan empty, liveness edges legal, attention-batch, I6, cross-stream
    // commutativity) over the log that now CONTAINS the watchdog_stale records.
  },
};

export { watchdogStaleProfile };
