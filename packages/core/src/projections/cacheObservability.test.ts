import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput } from '../schemas.js';
import { sessionRenamed, usageBlock } from '../events.js';
import {
  MemorySnapshotStore,
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
} from './projection.js';
import { cacheObservabilityProjection } from './cacheObservability.js';

const APP_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

// The real Spike-C usage shape (docs/calibration.md): 1h-tier, ~93% warm.
const spikeCUsage = {
  cache_creation: { ephemeral_1h_input_tokens: 2909, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 2909,
  cache_read_input_tokens: 39044,
  input_tokens: 2,
  output_tokens: 2,
  service_tier: 'standard',
};

function makeStore(): MemoryEventStore {
  return new MemoryEventStore({
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

function stateFromLog(batches: EventInput[][]): ReturnType<typeof cacheObservabilityProjection.init> {
  const store = makeStore();
  for (const batch of batches) {
    store.append(batch);
  }
  return replayFromEmpty(cacheObservabilityProjection, readAllStreamsGrouped(store));
}

describe('cacheObservabilityProjection', () => {
  it('accumulates a single usage_block into a per-session record', () => {
    const state = stateFromLog([
      [usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'msg-1' })],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record).toBeDefined();
    expect(record.sampleCount).toBe(1);
    expect(record.cacheReadTokens).toBe(39044);
    expect(record.cacheCreateTokens).toBe(2909);
    expect(record.inputTokens).toBe(2);
    expect(record.outputTokens).toBe(2);
    expect(record.ttlTier).toBe('1h');
    expect(record.serviceTier).toBe('standard');
    expect(record.cacheHitRate).toBeCloseTo(39044 / (39044 + 2909 + 2), 10);
    expect(record.countedMessageIds).toEqual(['msg-1']);
  });

  // ——— D17 HEADLINE: identical snapshots repeating under one message.id count ONCE ———
  it('D17: two usage_blocks with the SAME messageId count ONCE (no double-count)', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    // Counted once: tokens are NOT doubled, sampleCount stays 1, one id recorded.
    expect(record.sampleCount).toBe(1);
    expect(record.cacheReadTokens).toBe(39044);
    expect(record.cacheCreateTokens).toBe(2909);
    expect(record.inputTokens).toBe(2);
    expect(record.countedMessageIds).toEqual(['turn-a']);
    // The repeat still refreshes the (identical) latest classification.
    expect(record.ttlTier).toBe('1h');
    expect(record.serviceTier).toBe('standard');
  });

  it('two DIFFERENT messageIds each fold in (tokens sum)', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-b' }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record.sampleCount).toBe(2);
    expect(record.cacheReadTokens).toBe(39044 * 2);
    expect(record.cacheCreateTokens).toBe(2909 * 2);
    expect(record.inputTokens).toBe(4);
    expect(record.countedMessageIds).toEqual(['turn-a', 'turn-b']);
  });

  it('blocks with NO messageId (harness/PTY) each count individually', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage }),
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record.sampleCount).toBe(2);
    expect(record.cacheReadTokens).toBe(39044 * 2);
    // No messageIds are dedupe-tracked for id-less blocks.
    expect(record.countedMessageIds).toEqual([]);
  });

  it('is a no-op on non-usage_block events', () => {
    const state = stateFromLog([
      [sessionRenamed({ appSessionId: APP_SESSION_ID, name: 'renamed' })],
    ]);
    expect(state.perSession).toEqual({});
  });

  it('ignores a usage_block whose payload fails schema validation', () => {
    const store = makeStore();
    // usage MUST be an object; a malformed payload is dropped by safeParse.
    store.append([
      { stream: APP_SESSION_ID, type: 'usage_block', payload: { appSessionId: APP_SESSION_ID } },
    ]);
    const state = replayFromEmpty(cacheObservabilityProjection, readAllStreamsGrouped(store));
    expect(state.perSession).toEqual({});
  });

  it('snapshot + tail replay is byte-identical to replay-from-empty (I6)', () => {
    const store = makeStore();
    store.append([
      usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
    ]);
    store.append([
      usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
      usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-b' }),
    ]);
    const grouped = readAllStreamsGrouped(store);
    const replaySerialized = cacheObservabilityProjection.serialize(
      replayFromEmpty(cacheObservabilityProjection, grouped),
    );

    const snapshotStore = new MemorySnapshotStore();
    const midCut = Math.floor(grouped.length / 2);
    snapshotStore.save(
      snapshotAfter(cacheObservabilityProjection, grouped.slice(0, midCut), {
        now: () => '2026-01-01T00:00:10.000Z',
      }),
    );
    const bootSerialized = cacheObservabilityProjection.serialize(
      bootFromSnapshot(cacheObservabilityProjection, snapshotStore, store),
    );
    expect(bootSerialized).toBe(replaySerialized);
  });
});
