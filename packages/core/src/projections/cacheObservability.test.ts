import { describe, expect, it } from 'vitest';
import { CountingIdSource, SteppingClock } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventInput } from '../schemas.js';
import { compactionObserved, sessionRenamed, usageBlock } from '../events.js';
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

// A DIFFERENT, larger block — used to prove latestContextTokens is latest-wins
// (a fresh block REPLACES it), never accumulated across blocks.
const largerContextUsage = {
  cache_creation: { ephemeral_1h_input_tokens: 5000, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 5000,
  cache_read_input_tokens: 118000,
  input_tokens: 40,
  output_tokens: 900,
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

  // ——— Q4 §A: latestBlockAt — the observed ts of the latest usage_block ———
  it('§A: latestBlockAt is the event ts of the observed block (count path, assertion 1)', () => {
    const state = stateFromLog([
      [usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'msg-1' })],
    ]);
    // First appended event is stamped '2026-01-01T00:00:00.000Z' (SteppingClock).
    expect(state.perSession[APP_SESSION_ID]!.latestBlockAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('§A: a counted-repeat REFRESHES latestBlockAt to the later observation (assertion 2)', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    // Counted ONCE (tokens not doubled) but the repeat is still activity, so the
    // "last observed block" advances to the second event's ts (+1000ms).
    expect(record.sampleCount).toBe(1);
    expect(record.latestBlockAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('§A: a new messageId advances latestBlockAt to its own ts', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-b' }),
      ],
    ]);
    expect(state.perSession[APP_SESSION_ID]!.latestBlockAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('§A: latestBlockAt is deterministic across two replays of the same log (I6 — no clock read, assertion 4)', () => {
    const batches = [
      [usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' })],
      [usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-b' })],
    ];
    const first = stateFromLog(batches);
    const second = stateFromLog(batches);
    expect(second.perSession[APP_SESSION_ID]!.latestBlockAt).toBe(
      first.perSession[APP_SESSION_ID]!.latestBlockAt,
    );
  });

  // ——— §A: latestContextTokens — the input-side counts of the latest block ———
  it('§A: latestContextTokens is set on the count path from the observed block (input-side only)', () => {
    const state = stateFromLog([
      [usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'msg-1' })],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record.latestContextTokens).toEqual({
      inputTokens: 2,
      cacheReadTokens: 39044,
      cacheCreationTokens: 2909,
    });
    // OUTPUT is excluded — it is generated, not resident context.
    expect(record.latestContextTokens).not.toHaveProperty('outputTokens');
  });

  it('§A: latestContextTokens and latestBlockAt are BOTH-present (one block sets both)', () => {
    const state = stateFromLog([
      [usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'msg-1' })],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record.latestBlockAt).not.toBeNull();
    expect(record.latestContextTokens).not.toBeNull();
  });

  it('§A: a counted-repeat REFRESHES latestContextTokens on the repeat path', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    // Identical usage, so the value is unchanged — but it IS set from the repeat
    // block (both fold paths populate the field).
    expect(record.latestContextTokens).toEqual({
      inputTokens: 2,
      cacheReadTokens: 39044,
      cacheCreationTokens: 2909,
    });
  });

  it('§A: a fresh block REPLACES latestContextTokens (latest-wins, NOT accumulated — sabotage guard)', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
        usageBlock({ appSessionId: APP_SESSION_ID, usage: largerContextUsage, messageId: 'turn-b' }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    // latestContextTokens is the SECOND block alone — if it accumulated it would
    // read 39044+118000 read etc. The accumulated TOTALS (below) DO sum; these
    // two facts are deliberately distinct.
    expect(record.latestContextTokens).toEqual({
      inputTokens: 40,
      cacheReadTokens: 118000,
      cacheCreationTokens: 5000,
    });
    // The accumulated totals, by contrast, DO sum across both blocks.
    expect(record.cacheReadTokens).toBe(39044 + 118000);
  });

  it('§A: a session with no usage_block has no record → latestContextTokens is null via emptyRecord', () => {
    const state = stateFromLog([
      [sessionRenamed({ appSessionId: APP_SESSION_ID, name: 'renamed' })],
    ]);
    // No usage_block observed → no record at all (degrades to "unknown" in the
    // UI, never a fabricated 0).
    expect(state.perSession[APP_SESSION_ID]).toBeUndefined();
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

// ─── S8·4a — latestCompaction fold (latest-wins) ──────────────────────────────
describe('cacheObservabilityProjection — latestCompaction (S8·4a)', () => {
  it('a session with no compaction_observed has no latestCompaction key (absent until observed)', () => {
    const state = stateFromLog([
      [usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'msg-1' })],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record).not.toHaveProperty('latestCompaction');
  });

  it('one compaction_observed sets latestCompaction with the observed numbers (real SP8·1 values)', () => {
    const state = stateFromLog([
      [compactionObserved({ appSessionId: APP_SESSION_ID, trigger: 'manual', preTokens: 37645, postTokens: 1534, durationMs: 16849 })],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record.latestCompaction).toEqual({
      trigger: 'manual',
      preTokens: 37645,
      postTokens: 1534,
      durationMs: 16849,
    });
  });

  it('a compaction_observed with no session record yet still creates one via emptyRecord (sample/cache fields stay at their empty defaults)', () => {
    const state = stateFromLog([
      [compactionObserved({ appSessionId: APP_SESSION_ID, trigger: 'manual' })],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record.sampleCount).toBe(0);
    expect(record.cacheReadTokens).toBe(0);
    expect(record.latestCompaction).toEqual({ trigger: 'manual' });
  });

  it('a SECOND compaction_observed REPLACES latestCompaction — latest-wins, not accumulated (sabotage guard)', () => {
    const state = stateFromLog([
      [
        compactionObserved({ appSessionId: APP_SESSION_ID, trigger: 'manual', preTokens: 37645, postTokens: 1534, durationMs: 16849 }),
        compactionObserved({ appSessionId: APP_SESSION_ID, trigger: 'auto', preTokens: 90000, postTokens: 2000, durationMs: 9000 }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    // The SECOND compaction alone — if it accumulated, trigger or the numbers
    // would somehow reflect both observations rather than replacing cleanly.
    expect(record.latestCompaction).toEqual({
      trigger: 'auto',
      preTokens: 90000,
      postTokens: 2000,
      durationMs: 9000,
    });
  });

  it('latestCompaction and the usage_block totals are independent — a compaction never touches cache token accumulation', () => {
    const state = stateFromLog([
      [
        usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
        compactionObserved({ appSessionId: APP_SESSION_ID, trigger: 'manual', preTokens: 37645, postTokens: 1534 }),
      ],
    ]);
    const record = state.perSession[APP_SESSION_ID]!;
    expect(record.sampleCount).toBe(1);
    expect(record.cacheReadTokens).toBe(39044);
    expect(record.latestCompaction).toEqual({ trigger: 'manual', preTokens: 37645, postTokens: 1534 });
  });

  it('ignores a compaction_observed whose payload fails schema validation (missing appSessionId)', () => {
    const store = makeStore();
    store.append([{ stream: APP_SESSION_ID, type: 'compaction_observed', payload: { trigger: 'manual' } }]);
    const state = replayFromEmpty(cacheObservabilityProjection, readAllStreamsGrouped(store));
    expect(state.perSession).toEqual({});
  });

  it('is a no-op on a hostile/malformed compaction_observed payload, never throws', () => {
    const store = makeStore();
    expect(() =>
      store.append([{ stream: APP_SESSION_ID, type: 'compaction_observed', payload: 'not-an-object' }]),
    ).not.toThrow();
    expect(() =>
      replayFromEmpty(cacheObservabilityProjection, readAllStreamsGrouped(store)),
    ).not.toThrow();
  });

  it('snapshot + tail replay is byte-identical to replay-from-empty across a usage_block + compaction mix (I6)', () => {
    const store = makeStore();
    store.append([
      usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-a' }),
    ]);
    store.append([
      compactionObserved({ appSessionId: APP_SESSION_ID, trigger: 'manual', preTokens: 37645, postTokens: 1534, durationMs: 16849 }),
      usageBlock({ appSessionId: APP_SESSION_ID, usage: spikeCUsage, messageId: 'turn-b' }),
      compactionObserved({ appSessionId: APP_SESSION_ID, trigger: 'auto', preTokens: 90000 }),
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

    // Replaying the SAME log twice from empty is also byte-identical (the
    // standard I6 double-fold check for the new event type).
    const secondReplaySerialized = cacheObservabilityProjection.serialize(
      replayFromEmpty(cacheObservabilityProjection, readAllStreamsGrouped(store)),
    );
    expect(secondReplaySerialized).toBe(replaySerialized);
  });
});
