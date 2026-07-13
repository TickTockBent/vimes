import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import type { Clock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventStore } from '../eventStore.js';
import {
  billingBucketObserved,
  gateFired,
  hostStarted,
  livenessChanged,
  seen,
  sessionCreated,
  withNotificationTrigger,
} from '../events.js';
import type { MeterRecord } from '../schemas.js';
import {
  MemorySnapshotStore,
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
  type Projection,
} from './projection.js';
import { sessionsProjection } from './sessions.js';
import { metersProjection, meterSample } from './meters.js';
import { tasksProjection } from './tasks.js';

const APP_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const APP_2 = 'aaaaaaaa-0000-4000-8000-000000000002';

function meter(meterId: string, used: number): MeterRecord {
  return {
    meterId,
    kind: 'rolling-window',
    scope: 'all-models',
    modelFamily: null,
    used,
    limit: null,
    unit: 'tokens',
    resetsAt: null,
    source: 'jsonl',
    observedAt: '2026-01-01T00:00:00.000Z',
    stale: false,
  };
}

// A synthetic multi-stream log across three streams: two app sessions, 'usage',
// and 'system'.
function buildMultiStreamStore(): MemoryEventStore {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
  store.append([
    sessionCreated({ appSessionId: APP_1, channel: 'sdk', cwd: '/home/user/a', name: null, forkedFrom: null, taskRef: null }),
  ]);
  store.append([meterSample(meter('window-5h', 100))]);
  store.append([livenessChanged({ appSessionId: APP_1, to: 'running', cause: 'spawned' })]);
  store.append([hostStarted()]);
  store.append(withNotificationTrigger(gateFired({ appSessionId: APP_1, prompt: 'approve?' })));
  store.append([meterSample(meter('window-5h', 250))]); // upsert same meterId
  store.append([seen({ appSessionId: APP_1 })]);
  store.append([
    sessionCreated({ appSessionId: APP_2, channel: 'pty', cwd: '/home/user/b', name: 'second', forkedFrom: null, taskRef: null }),
  ]);
  store.append([billingBucketObserved({ appSessionId: APP_1, bucket: 'interactive' })]);
  store.append([meterSample(meter('weekly-cap', 42))]);
  return store;
}

// I6: at several cut points (start, mid, head), boot from snapshot + tail equals
// replay-from-empty, byte-identical.
function assertBootEqualsReplayAtCuts<StateType>(
  projection: Projection<StateType>,
  store: EventStore,
  clock: Clock,
): void {
  const groupedRecords = readAllStreamsGrouped(store);
  const fullReplaySerialized = projection.serialize(replayFromEmpty(projection, groupedRecords));

  const cutPoints = [0, Math.floor(groupedRecords.length / 2), groupedRecords.length];
  for (const cutPoint of cutPoints) {
    const snapshotStore = new MemorySnapshotStore();
    snapshotStore.save(snapshotAfter(projection, groupedRecords.slice(0, cutPoint), clock));
    const bootedSerialized = projection.serialize(bootFromSnapshot(projection, snapshotStore, store));
    expect(bootedSerialized, `cut ${cutPoint} for ${projection.id}`).toBe(fullReplaySerialized);
  }
}

describe('projection I6 — boot(snapshot+tail) equals replay-from-empty', () => {
  it('holds for the sessions projection at every cut point', () => {
    const store = buildMultiStreamStore();
    assertBootEqualsReplayAtCuts(sessionsProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
  });

  it('holds for the meters stub projection at every cut point', () => {
    const store = buildMultiStreamStore();
    assertBootEqualsReplayAtCuts(metersProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
  });

  it('holds for the tasks stub projection at every cut point', () => {
    const store = buildMultiStreamStore();
    assertBootEqualsReplayAtCuts(tasksProjection, store, new SteppingClock('2026-02-01T00:00:00.000Z', 1000));
  });

  it('meters stub actually folds meter_sample (upsert by meterId)', () => {
    const store = buildMultiStreamStore();
    const state = replayFromEmpty(metersProjection, readAllStreamsGrouped(store));
    expect(state.meters['window-5h']!.used).toBe(250);
    expect(state.meters['weekly-cap']!.used).toBe(42);
  });

  it('a null snapshot boots identically to a from-empty replay', () => {
    const store = buildMultiStreamStore();
    const emptySnapshotStore = new MemorySnapshotStore();
    const booted = sessionsProjection.serialize(bootFromSnapshot(sessionsProjection, emptySnapshotStore, store));
    const replayed = sessionsProjection.serialize(replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store)));
    expect(booted).toBe(replayed);
  });
});
