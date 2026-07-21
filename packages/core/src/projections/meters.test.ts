import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import { meterRecordSchema, type MeterRecord } from '../schemas.js';
import {
  MemorySnapshotStore,
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
} from './projection.js';
import {
  METER_HISTORY_LIMIT,
  meterHistory,
  meterSample,
  metersProjection,
  type MetersState,
} from './meters.js';

// A percent-only record: exactly what the authoritative endpoint gives (U1/D26)
// — no absolutes anywhere.
function percentOnlyMeter(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    meterId: 'session',
    kind: 'rolling-window',
    scope: null,
    percent: 29,
    severity: 'normal',
    isActive: true,
    resetsAt: '2026-07-21T18:00:00.000Z',
    source: 'endpoint',
    observedAt: '2026-07-21T15:00:00.000Z',
    ...overrides,
  };
}

// A slice-0-era record: absolutes, the closed scope enum, the stored `stale`
// flag. It must keep validating byte-for-byte unchanged (backwards compat).
function legacyAbsoluteMeter(overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    meterId: 'window-5h',
    kind: 'rolling-window',
    scope: 'all-models',
    modelFamily: null,
    used: 200,
    limit: 1000,
    unit: 'tokens',
    resetsAt: null,
    source: 'jsonl',
    observedAt: '2026-01-01T00:00:00.000Z',
    stale: false,
    ...overrides,
  };
}

function newStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

function foldStore(store: MemoryEventStore): MetersState {
  return replayFromEmpty(metersProjection, readAllStreamsGrouped(store));
}

describe('meterRecordSchema (D26 — percent + unit, absolutes never invented)', () => {
  it('accepts a percent-only record with no used/limit at all', () => {
    const parsed = meterRecordSchema.safeParse(percentOnlyMeter());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.percent).toBe(29);
    // The absolutes stay ABSENT — never manufactured as used=29/limit=100.
    expect(parsed.success && parsed.data.used).toBeUndefined();
    expect(parsed.success && parsed.data.limit).toBeUndefined();
    expect(parsed.success && parsed.data.unit).toBeUndefined();
  });

  it('still accepts a legacy used/limit record unchanged (backwards compat)', () => {
    const legacy = legacyAbsoluteMeter();
    const parsed = meterRecordSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    // Every legacy field round-trips identically, and no new key is injected.
    expect(parsed.success && parsed.data).toEqual(legacy);
    expect(parsed.success && JSON.stringify(parsed.data)).toBe(JSON.stringify(legacy));
  });

  it('carries the endpoint-supplied judgement fields (severity, isActive, scope)', () => {
    const parsed = meterRecordSchema.safeParse(
      percentOnlyMeter({ meterId: 'weekly_scoped:Opus', kind: 'weekly-cap', scope: 'claude-opus-4-8', severity: 'warning', isActive: false }),
    );
    expect(parsed.success && parsed.data.scope).toBe('claude-opus-4-8');
    expect(parsed.success && parsed.data.severity).toBe('warning');
    expect(parsed.success && parsed.data.isActive).toBe(false);
  });

  it('rejects a record missing observedAt (freshness must always be derivable)', () => {
    const { observedAt: _dropped, ...withoutObservedAt } = percentOnlyMeter();
    expect(meterRecordSchema.safeParse(withoutObservedAt).success).toBe(false);
  });
});

describe('metersProjection (upsert + bounded history)', () => {
  it('upserts the latest record by meterId and keeps meters separate', () => {
    const store = newStore();
    store.append([meterSample(percentOnlyMeter({ percent: 29 }))]);
    store.append([meterSample(percentOnlyMeter({ percent: 41, observedAt: '2026-07-21T15:30:00.000Z' }))]);
    store.append([meterSample(percentOnlyMeter({ meterId: 'weekly_all', kind: 'weekly-cap', percent: 12 }))]);

    const state = foldStore(store);
    expect(Object.keys(state.meters).sort()).toEqual(['session', 'weekly_all']);
    expect(state.meters['session']?.percent).toBe(41);
    expect(meterHistory(state, 'session').map((sample) => sample.percent)).toEqual([29, 41]);
    expect(meterHistory(state, 'weekly_all')).toHaveLength(1);
  });

  it('records a null percent for a record that carries none (never derived from used/limit)', () => {
    const store = newStore();
    store.append([meterSample(legacyAbsoluteMeter())]);
    expect(meterHistory(foldStore(store), 'window-5h')).toEqual([
      { observedAt: '2026-01-01T00:00:00.000Z', percent: null },
    ]);
  });

  it('bounds history at METER_HISTORY_LIMIT, dropping the oldest first', () => {
    const store = newStore();
    const totalSamples = METER_HISTORY_LIMIT + 10;
    for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
      store.append([
        meterSample(
          percentOnlyMeter({
            percent: sampleIndex,
            observedAt: new Date(Date.parse('2026-07-21T00:00:00.000Z') + sampleIndex * 60_000).toISOString(),
          }),
        ),
      ]);
    }
    const history = meterHistory(foldStore(store), 'session');
    expect(history).toHaveLength(METER_HISTORY_LIMIT);
    // Oldest dropped: the retained window is the newest METER_HISTORY_LIMIT.
    expect(history[0]?.percent).toBe(totalSamples - METER_HISTORY_LIMIT);
    expect(history[history.length - 1]?.percent).toBe(totalSamples - 1);
  });

  it('never mutates the state it is given (snapshots share references)', () => {
    const firstState = metersProjection.apply(metersProjection.init(), {
      eventId: 'e1',
      stream: 'usage',
      seq: 1,
      ts: '2026-07-21T15:00:00.000Z',
      type: 'meter_sample',
      payload: percentOnlyMeter({ percent: 10 }),
    });
    const firstSerialized = metersProjection.serialize(firstState);
    const secondState = metersProjection.apply(firstState, {
      eventId: 'e2',
      stream: 'usage',
      seq: 2,
      ts: '2026-07-21T15:01:00.000Z',
      type: 'meter_sample',
      payload: percentOnlyMeter({ percent: 20, observedAt: '2026-07-21T15:01:00.000Z' }),
    });
    expect(metersProjection.serialize(firstState)).toBe(firstSerialized);
    expect(meterHistory(firstState, 'session')).toHaveLength(1);
    expect(meterHistory(secondState, 'session')).toHaveLength(2);
  });

  it('ignores non-meter events and unparseable meter payloads', () => {
    const initialState = metersProjection.init();
    const afterOtherType = metersProjection.apply(initialState, {
      eventId: 'e1',
      stream: 'usage',
      seq: 1,
      ts: '2026-07-21T15:00:00.000Z',
      type: 'something_else',
      payload: {},
    });
    expect(afterOtherType).toBe(initialState);
    const afterGarbage = metersProjection.apply(initialState, {
      eventId: 'e2',
      stream: 'usage',
      seq: 2,
      ts: '2026-07-21T15:00:00.000Z',
      type: 'meter_sample',
      payload: { meterId: 'session' },
    });
    expect(afterGarbage).toBe(initialState);
  });

  it('snapshot + tail replay is byte-identical to a full replay (I6)', () => {
    const store = newStore();
    const percents = [5, 17, 42, 8, 19];
    for (let sampleIndex = 0; sampleIndex < percents.length; sampleIndex += 1) {
      store.append([
        meterSample(
          percentOnlyMeter({
            percent: percents[sampleIndex]!,
            observedAt: new Date(Date.parse('2026-07-21T12:00:00.000Z') + sampleIndex * 600_000).toISOString(),
          }),
        ),
      ]);
    }
    store.append([meterSample(legacyAbsoluteMeter())]);

    const allRecords = readAllStreamsGrouped(store);
    const fullReplaySerialized = metersProjection.serialize(replayFromEmpty(metersProjection, allRecords));

    for (let cutIndex = 0; cutIndex <= allRecords.length; cutIndex += 1) {
      const snapshotStore = new MemorySnapshotStore();
      snapshotStore.save(
        snapshotAfter(metersProjection, allRecords.slice(0, cutIndex), new SteppingClock('2026-07-21T13:00:00.000Z', 1000)),
      );
      const booted = metersProjection.serialize(bootFromSnapshot(metersProjection, snapshotStore, store));
      expect(booted).toBe(fullReplaySerialized);
    }
  });
});
