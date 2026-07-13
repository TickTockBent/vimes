import { message } from '../../events.js';
import { FakeClient } from '../clients.js';
import type { ScenarioProfile } from '../scenario.js';

// flaky-mobile (spec §7.2, degraded-realist): one client, repeated drops and
// returns, a gate firing while offline. Every return is served from the log by
// the one subscribe path — short gap or very long gap, no dup/loss (I2).
const LONG_GAP_EVENT_COUNT = 300;

export const flakyMobile: ScenarioProfile = {
  name: 'flaky-mobile',
  run(world) {
    const appSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/phone' });
    const handle = world.registry.spawn('sdk', appSessionId);

    // Subscribes from the very start (replays session_created + spawn).
    const client = new FakeClient();
    client.connect(world, appSessionId, 0);

    world.fakeSdk.run(handle, [
      { kind: 'message', role: 'user', content: 'start the build' },
      { kind: 'message', role: 'assistant', content: 'Building.' },
    ]);

    // Drop mid-stream; a gate fires while the client is offline (its
    // notification_trigger is still evented into the log).
    client.disconnect();
    world.fakeSdk.run(handle, [{ kind: 'gate', prompt: 'overwrite config.json?' }]);

    // Short-gap return: served exactly lastSeq+1..head from the log.
    client.connect(world, appSessionId, client.lastReceivedSeq());
    client.assertContiguousFrom(1);

    // More traffic while connected.
    world.fakeSdk.run(handle, [
      { kind: 'message', role: 'user', content: 'yes, overwrite' },
      { kind: 'message', role: 'assistant', content: 'Overwritten.' },
    ]);

    // VERY long gap: hundreds of events accumulate while offline; the return is
    // the same one-path replay, exact delivery.
    client.disconnect();
    for (let index = 0; index < LONG_GAP_EVENT_COUNT; index += 1) {
      world.router.emit([
        message({ appSessionId, role: 'assistant', content: `progress line ${index}` }),
      ]);
    }
    client.connect(world, appSessionId, client.lastReceivedSeq());
    client.assertContiguousFrom(1);

    // Backpressure drop (real bufferedAmount threshold is slice 1, finding E):
    // a forced disconnect recovers through the identical resubscribe path.
    client.disconnect();
    world.fakeSdk.run(handle, [{ kind: 'message', role: 'assistant', content: 'final line' }]);
    client.connect(world, appSessionId, client.lastReceivedSeq());
    client.assertContiguousFrom(1);
  },
};
