import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonicalJson.js';
import { gateFired, withNotificationTrigger } from '../events.js';
import { createWorld, restart } from './world.js';
import { orphanScan, recoveryRoutine, type ProcessHandle } from './registry.js';
import { runScenario } from './scenario.js';
import { ALL_PROFILES } from './profiles/index.js';

describe('scenario harness — six profiles, deterministic double-run', () => {
  it('ships exactly the six spec §7 profiles', () => {
    expect(ALL_PROFILES.map((profile) => profile.name)).toEqual([
      'happy-path-desktop',
      'flaky-mobile',
      'concurrent-clash',
      'cold-restart',
      'hostile-input',
      'budget-wall',
    ]);
  });

  for (const profile of ALL_PROFILES) {
    it(`${profile.name}: runs green, then a fresh identical run is byte-identical`, () => {
      // runScenario throws on any standing-assert violation; returning proves green.
      const first = runScenario(profile);
      const second = runScenario(profile);

      expect(second.eventLog).toBe(first.eventLog);
      expect(second.projections).toEqual(first.projections);
      // Every projection string individually byte-identical.
      for (const projectionId of Object.keys(first.projections)) {
        expect(second.projections[projectionId]).toBe(first.projections[projectionId]);
      }
    });
  }
});

describe('registry (I4 ownership, I11 refusal, I3 fork, recovery)', () => {
  it('orphanScan catches a hand-planted unowned process, and is empty otherwise', () => {
    const world = createWorld();
    const appSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/x' });
    world.registry.spawn('sdk', appSessionId);
    expect(orphanScan(world)).toEqual([]);

    // Plant a live process directly in the adapter table, bypassing the registry.
    const plantedHandle: ProcessHandle = {
      processId: 'planted-orphan-1',
      kind: 'sdk',
      appSessionId,
    };
    world.fakeSdk.markLive(plantedHandle);
    expect(orphanScan(world)).toEqual(['planted-orphan-1']);
  });

  it('resumeSession refuses when a process is live and events the rejection (I11)', () => {
    const world = createWorld();
    const appSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/x' });
    world.registry.spawn('sdk', appSessionId);

    const result = world.registry.resumeSession(appSessionId);
    expect(result.refused).toBe(true);
    // No second process spawned.
    expect(world.registry.listOwned().filter((h) => h.appSessionId === appSessionId)).toHaveLength(1);
    // The refusal is in the log as transition_rejected.
    const rejections = world.store
      .read(appSessionId, 1)
      .filter((record) => record.type === 'transition_rejected');
    expect(rejections).toHaveLength(1);
  });

  it('forkSession mints a NEW appSessionId with forkedFrom set, source untouched (I3)', () => {
    const world = createWorld();
    const source = world.registry.createSession({ channel: 'sdk', cwd: '/x', name: 'src' });
    const sourceBefore = canonicalJson(world.projectionHost.sessionsState().sessions[source]);

    const forked = world.registry.forkSession(source);
    expect(forked).not.toBe(source);

    const sessions = world.projectionHost.sessionsState().sessions;
    expect(sessions[forked]?.forkedFrom).toBe(source);
    expect(canonicalJson(sessions[source])).toBe(sourceBefore);
  });

  it('recoveryRoutine marks running sessions interrupted and preserves attention (I5)', () => {
    const world = createWorld();
    const appSessionId = world.registry.createSession({ channel: 'sdk', cwd: '/x' });
    const handle = world.registry.spawn('sdk', appSessionId);
    world.router.emit(withNotificationTrigger(gateFired({ appSessionId, prompt: 'confirm?' })));

    const attentionBefore = canonicalJson(
      world.projectionHost.sessionsState().sessions[appSessionId]!.needsAttention,
    );
    void handle;

    const revived = restart(world);
    recoveryRoutine(revived);

    const recovered = revived.projectionHost.sessionsState().sessions[appSessionId]!;
    expect(recovered.liveness).toBe('interrupted');
    expect(canonicalJson(recovered.needsAttention)).toBe(attentionBefore);
    expect(orphanScan(revived)).toEqual([]);
  });
});
