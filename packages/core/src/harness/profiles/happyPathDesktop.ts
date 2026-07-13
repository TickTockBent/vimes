import { attentionCleared, seen } from '../../events.js';
import { FakeClient } from '../clients.js';
import type { SdkFeedStep } from '../fakeSdk.js';
import type { ScenarioProfile } from '../scenario.js';

// happy-path-desktop (spec §7.1): spawn an SDK session, converse (messages +
// usage), complete -> attention 'completed' + trigger, seen, cleared. A client is
// subscribed throughout. This is the baseline projection instrument.
const CONVERSATION: SdkFeedStep[] = [
  { kind: 'message', role: 'user', content: 'refactor the auth module' },
  { kind: 'message', role: 'assistant', content: 'On it — reading the current code.' },
  { kind: 'usage', usage: { input_tokens: 1200, output_tokens: 340 } },
  { kind: 'message', role: 'assistant', content: 'Done. Extracted the token check into a guard.' },
  { kind: 'usage', usage: { input_tokens: 1500, output_tokens: 610 } },
  { kind: 'complete' },
];

export const happyPathDesktop: ScenarioProfile = {
  name: 'happy-path-desktop',
  run(world) {
    const appSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/proj' });
    const handle = world.registry.spawn('sdk', appSessionId);

    // A desktop client watching the whole run from the first event.
    const client = new FakeClient();
    client.connect(world, appSessionId, 0);

    world.fakeSdk.run(handle, CONVERSATION);

    // Viewing does not clear attention; a deliberate action does.
    world.router.emit([seen({ appSessionId })]);
    world.router.emit([attentionCleared({ appSessionId, cause: 'dismissed' })]);

    client.assertContiguousFrom(1);
  },
};
