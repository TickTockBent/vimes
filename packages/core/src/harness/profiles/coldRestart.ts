import { canonicalJson } from '../../canonicalJson.js';
import {
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
  type Projection,
} from '../../projections/projection.js';
import { sessionsProjection } from '../../projections/sessions.js';
import { metersProjection } from '../../projections/meters.js';
import { tasksProjection } from '../../projections/tasks.js';
import { orphanScan, recoveryRoutine } from '../registry.js';
import { restart } from '../world.js';
import type { ScenarioProfile } from '../scenario.js';

const ALL_PROJECTIONS: ReadonlyArray<Projection<unknown>> = [
  sessionsProjection as Projection<unknown>,
  metersProjection as Projection<unknown>,
  tasksProjection as Projection<unknown>,
];

// cold-restart (spec §7.4, the flagship): host dies mid-run with 3 live sessions
// (one needing attention) plus a 4th still 'spawning' (never reached 'running'
// before the crash). Restart rediscovers, marks all four 'interrupted' — D13's
// spawning->interrupted edge covers the 4th — attention badge intact (I5);
// dormant-resume chains lineage (I3/I4); snapshot taken BEFORE the restart +
// tail boot equals from-empty replay (I6).
export const coldRestart: ScenarioProfile = {
  name: 'cold-restart',
  run(world) {
    const sessionAlpha = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/a' });
    const sessionBravo = world.registry.createSession({ channel: 'pty', cwd: '/home/wes/b' });
    const sessionCharlie = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/c' });

    const handleAlpha = world.registry.spawn('sdk', sessionAlpha);
    world.registry.spawn('pty', sessionBravo);
    world.registry.spawn('sdk', sessionCharlie);

    // Alpha is mid-gate when the host dies.
    world.fakeSdk.run(handleAlpha, [
      { kind: 'message', role: 'user', content: 'deploy to prod' },
      { kind: 'gate', prompt: 'confirm prod deploy?' },
    ]);

    // Delta is created but never spawned — session_created fires (liveness born
    // 'spawning', per INITIAL_LIVENESS) and the host dies before anything drives
    // it to 'running'. D13's edge exercises recovery of exactly this session.
    const sessionDelta = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/d' });

    const attentionBeforeRestart = canonicalJson(
      world.projectionHost.sessionsState().sessions[sessionAlpha]!.needsAttention,
    );

    // Snapshot every projection BEFORE the restart (the flagship I6 cut).
    const preRestartRecords = readAllStreamsGrouped(world.store);
    for (const projection of ALL_PROJECTIONS) {
      world.snapshots.save(snapshotAfter(projection, preRestartRecords, world.clock));
    }

    // ——— the daemon dies ———
    const revived = restart(world);

    // Recovery: the three running sessions, plus the spawning-at-crash one,
    // all become 'interrupted'; attention intact.
    recoveryRoutine(revived);

    const revivedSessions = revived.projectionHost.sessionsState().sessions;
    for (const appSessionId of [sessionAlpha, sessionBravo, sessionCharlie]) {
      if (revivedSessions[appSessionId]?.liveness !== 'interrupted') {
        throw new Error(`cold-restart: ${appSessionId} not interrupted after recovery`);
      }
    }
    const attentionAfterRestart = canonicalJson(revivedSessions[sessionAlpha]!.needsAttention);
    if (attentionAfterRestart !== attentionBeforeRestart) {
      throw new Error('cold-restart: attention not byte-identical across restart (I5)');
    }

    if (orphanScan(revived).length !== 0) {
      throw new Error('cold-restart: orphan scan non-empty after recovery (I4)');
    }

    // D13: the spawning-at-crash session recovers to 'interrupted' too, via the
    // machine — no transition_rejected on its stream.
    if (revivedSessions[sessionDelta]?.liveness !== 'interrupted') {
      throw new Error(
        `cold-restart: spawning-at-crash session ${sessionDelta} not interrupted after recovery (D13)`,
      );
    }
    const deltaRejections = revived.store
      .read(sessionDelta, 1)
      .filter((record) => record.type === 'transition_rejected');
    if (deltaRejections.length !== 0) {
      throw new Error('cold-restart: spawning-at-crash recovery emitted transition_rejected (D13)');
    }

    // Dormant-resume one interrupted session: interrupted -> spawning -> running,
    // same appSessionId, lineage a single chain (forkedFrom stays null; I3/I4).
    const resumeResult = revived.registry.resumeSession(sessionAlpha);
    if (resumeResult.refused) {
      throw new Error('cold-restart: resume of an interrupted session was refused');
    }
    const resumedAlpha = revived.projectionHost.sessionsState().sessions[sessionAlpha]!;
    if (resumedAlpha.liveness !== 'running') {
      throw new Error('cold-restart: resumed session did not reach running');
    }
    if (resumedAlpha.forkedFrom !== null) {
      throw new Error('cold-restart: resume forked lineage (I3)');
    }

    // Chain the recovered D13 edge: interrupted -> spawning -> running for the
    // session that was spawning at the moment of the crash, proving the
    // recovered edge is not just legal but actually resumable end to end.
    const deltaResumeResult = revived.registry.resumeSession(sessionDelta);
    if (deltaResumeResult.refused) {
      throw new Error('cold-restart: resume of the recovered spawning-at-crash session was refused');
    }
    const resumedDelta = revived.projectionHost.sessionsState().sessions[sessionDelta]!;
    if (resumedDelta.liveness !== 'running') {
      throw new Error('cold-restart: recovered spawning-at-crash session did not reach running (D13)');
    }
    if (resumedDelta.forkedFrom !== null) {
      throw new Error('cold-restart: spawning-at-crash resume forked lineage (I3)');
    }

    // Flagship I6: pre-restart snapshot + post-restart tail == from-empty replay.
    const finalRecords = readAllStreamsGrouped(revived.store);
    for (const projection of ALL_PROJECTIONS) {
      const bootSerialized = projection.serialize(
        bootFromSnapshot(projection, revived.snapshots, revived.store),
      );
      const replaySerialized = projection.serialize(replayFromEmpty(projection, finalRecords));
      if (bootSerialized !== replaySerialized) {
        throw new Error(`cold-restart: snapshot+tail != from-empty for ${projection.id} (I6)`);
      }
    }

    return revived;
  },
};
