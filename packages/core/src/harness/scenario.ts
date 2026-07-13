import { canonicalJson } from '../canonicalJson.js';
import type { EventRecord } from '../schemas.js';
import type { EventStore } from '../eventStore.js';
import { EVENT_TYPES } from '../events.js';
import { assertAttentionBatchRule, assertLogRespectsEdges } from '../sessionMachine.js';
import {
  MemorySnapshotStore,
  bootFromSnapshot,
  readAllStreamsGrouped,
  replayFromEmpty,
  snapshotAfter,
  type Projection,
} from '../projections/projection.js';
import { sessionsProjection } from '../projections/sessions.js';
import { metersProjection } from '../projections/meters.js';
import { tasksProjection } from '../projections/tasks.js';
import { orphanScan } from './registry.js';
import { createWorld, type World, type WorldSeed } from './world.js';

// The three projections the harness folds, in a fixed order.
const PROJECTIONS: ReadonlyArray<Projection<unknown>> = [
  sessionsProjection as Projection<unknown>,
  metersProjection as Projection<unknown>,
  tasksProjection as Projection<unknown>,
];

// A scenario is a deterministic script over a World. run() may restart the world;
// when it does it returns the post-restart world so the harness serializes the
// live host that survived. Non-restart profiles return nothing.
export interface ScenarioProfile {
  name: string;
  seed?: WorldSeed;
  run(world: World): World | void;
}

export interface ScenarioCounters {
  eventsPerStream: Record<string, number>;
  quarantines: number;
  rawBytes: number;
  snapshotBytes: number;
}

export interface ScenarioArtifact {
  name: string;
  eventLog: string;
  projections: Record<string, string>;
  counters: ScenarioCounters;
}

// readAllStreamsGrouped folds streams in sorted order; this is the SAME log with
// streams grouped in reversed-sort order. Cross-stream commutativity requires
// every projection to serialize identically over both (settled step-3).
function readAllStreamsReversedGrouped(store: EventStore): EventRecord[] {
  const records: EventRecord[] = [];
  for (const stream of [...store.streams()].reverse()) {
    for (const record of store.read(stream, 1)) {
      records.push(record);
    }
  }
  return records;
}

function eventsPerStream(records: EventRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.stream] = (counts[record.stream] ?? 0) + 1;
  }
  return counts;
}

// The event-log dump: one canonical object per record, over the grouped log.
function serializeEventLog(records: EventRecord[]): string {
  return canonicalJson(
    records.map((record) => ({
      stream: record.stream,
      seq: record.seq,
      ts: record.ts,
      type: record.type,
      eventId: record.eventId,
      payload: record.payload,
    })),
  );
}

export function runScenario(profile: ScenarioProfile): ScenarioArtifact {
  const initialWorld = createWorld(profile.seed);
  const returnedWorld = profile.run(initialWorld);
  const finalWorld: World = returnedWorld ?? initialWorld;
  const restarted = returnedWorld !== undefined && returnedWorld !== initialWorld;

  const store = finalWorld.store;
  const grouped = readAllStreamsGrouped(store);
  const reversedGrouped = readAllStreamsReversedGrouped(store);
  const midCut = Math.floor(grouped.length / 2);

  // ——— standing asserts (every profile, after run) ———
  const orphans = orphanScan(finalWorld);
  if (orphans.length !== 0) {
    throw new Error(`[${profile.name}] orphan scan found unowned processes: ${orphans.join(', ')}`);
  }

  const livenessScan = assertLogRespectsEdges(grouped);
  if (livenessScan.violations.length !== 0) {
    throw new Error(
      `[${profile.name}] liveness edge violations: ${JSON.stringify(livenessScan.violations)}`,
    );
  }

  const attentionScan = assertAttentionBatchRule(grouped);
  if (attentionScan.violations.length !== 0) {
    throw new Error(
      `[${profile.name}] attention batch violations: ${JSON.stringify(attentionScan.violations)}`,
    );
  }

  const projections: Record<string, string> = {};
  let snapshotBytes = 0;
  const liveSerialized = finalWorld.projectionHost.serializeAll();

  for (const projection of PROJECTIONS) {
    const replaySerialized = projection.serialize(replayFromEmpty(projection, grouped));
    projections[projection.id] = replaySerialized;

    // Cross-stream commutativity: reversed-stream grouping must serialize identically.
    const reversedSerialized = projection.serialize(replayFromEmpty(projection, reversedGrouped));
    if (reversedSerialized !== replaySerialized) {
      throw new Error(
        `[${profile.name}] cross-stream commutativity failed for ${projection.id}`,
      );
    }

    // I6: snapshot at ~mid-log then boot == replay-from-empty, byte-identical.
    const snapshotStore = new MemorySnapshotStore();
    const snapshot = snapshotAfter(projection, grouped.slice(0, midCut), finalWorld.clock);
    snapshotStore.save(snapshot);
    snapshotBytes += canonicalJson(snapshot).length;
    const bootSerialized = projection.serialize(bootFromSnapshot(projection, snapshotStore, store));
    if (bootSerialized !== replaySerialized) {
      throw new Error(`[${profile.name}] I6 snapshot+tail != replay for ${projection.id}`);
    }

    // The live emit-order fold must match the grouped replay for profiles that did
    // not restart (a restarted world's live host is a fresh replay of the store,
    // covered by the profile's own I6 assertions).
    if (!restarted && liveSerialized[projection.id] !== replaySerialized) {
      throw new Error(
        `[${profile.name}] live projection host != grouped replay for ${projection.id}`,
      );
    }
  }

  const counters: ScenarioCounters = {
    eventsPerStream: eventsPerStream(grouped),
    quarantines: grouped.filter((record) => record.type === EVENT_TYPES.lineQuarantined).length,
    rawBytes: finalWorld.fakePty.totalRawBytes(),
    snapshotBytes,
  };

  return {
    name: profile.name,
    eventLog: serializeEventLog(grouped),
    projections,
    counters,
  };
}
