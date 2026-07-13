import { attentionCleared, EVENT_TYPES } from '../../events.js';
import { readAllStreamsGrouped, replayFromEmpty } from '../../projections/projection.js';
import { sessionsProjection } from '../../projections/sessions.js';
import { FakeClient } from '../clients.js';
import type { ScenarioProfile } from '../scenario.js';

// concurrent-clash (spec §7.3): two clients on one session, a resume refused
// mid-run (I11 shape), an explicit fork (I3 shape), and a simultaneous
// clear-attention that transitions once (I5 idempotence).
export const concurrentClash: ScenarioProfile = {
  name: 'concurrent-clash',
  run(world) {
    const appSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/shared' });
    const handle = world.registry.spawn('sdk', appSessionId);

    const clientOne = new FakeClient();
    const clientTwo = new FakeClient();
    clientOne.connect(world, appSessionId, 0);
    clientTwo.connect(world, appSessionId, 0);

    world.fakeSdk.run(handle, [
      { kind: 'message', role: 'user', content: 'run the migration' },
      { kind: 'gate', prompt: 'apply destructive migration?' },
    ]);

    // Resume attempted while a run is live -> refused before any process spawns,
    // and the refusal is evented (transition_rejected). Real-transcript assertion
    // lands slice 1.
    const resumeResult = world.registry.resumeSession(appSessionId);
    if (!resumeResult.refused) {
      throw new Error('concurrent-clash: resume against a live run was not refused (I11)');
    }
    if (world.registry.listOwned().filter((h) => h.appSessionId === appSessionId).length !== 1) {
      throw new Error('concurrent-clash: refused resume must not spawn a second process (I11)');
    }

    // Explicit fork mints a new appSessionId with forkedFrom set; the source
    // session is untouched (I3 shape).
    const sessionsBeforeFork = world.projectionHost.sessionsState().sessions;
    const sourceBefore = JSON.stringify(sessionsBeforeFork[appSessionId]);
    const forkedAppSessionId = world.registry.forkSession(appSessionId);
    const sessionsAfterFork = world.projectionHost.sessionsState().sessions;
    if (sessionsAfterFork[forkedAppSessionId]?.forkedFrom !== appSessionId) {
      throw new Error('concurrent-clash: forked session missing forkedFrom (I3)');
    }
    if (JSON.stringify(sessionsAfterFork[appSessionId]) !== sourceBefore) {
      throw new Error('concurrent-clash: fork mutated the source session (I3)');
    }

    // Simultaneous clear-attention: two attention_cleared events in ONE batch.
    // The projection transitions once; the second is a state no-op.
    world.router.emit([
      attentionCleared({ appSessionId, cause: 'gate_answered' }),
      attentionCleared({ appSessionId, cause: 'gate_answered' }),
    ]);
    if (world.projectionHost.sessionsState().sessions[appSessionId]?.needsAttention !== null) {
      throw new Error('concurrent-clash: attention not cleared');
    }

    // Idempotence: replaying with one of the two clears removed yields a
    // byte-identical sessions projection (single clear == double clear).
    const grouped = readAllStreamsGrouped(world.store);
    let droppedOne = false;
    const withSingleClear = grouped.filter((record) => {
      if (!droppedOne && record.type === EVENT_TYPES.attentionCleared && record.stream === appSessionId) {
        droppedOne = true;
        return false;
      }
      return true;
    });
    const doubleClearSerialized = sessionsProjection.serialize(replayFromEmpty(sessionsProjection, grouped));
    const singleClearSerialized = sessionsProjection.serialize(
      replayFromEmpty(sessionsProjection, withSingleClear),
    );
    if (doubleClearSerialized !== singleClearSerialized) {
      throw new Error('concurrent-clash: double clear not idempotent with single clear (I5)');
    }

    // Both clients saw the identical stream, contiguously.
    clientOne.assertContiguousFrom(1);
    clientTwo.assertContiguousFrom(1);
    if (JSON.stringify(clientOne.receivedSeqs()) !== JSON.stringify(clientTwo.receivedSeqs())) {
      throw new Error('concurrent-clash: the two clients did not receive the identical stream');
    }
  },
};
