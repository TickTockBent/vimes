import type { Clock } from '../ids.js';
import type { EventStore } from '../eventStore.js';
import type { EventRecord, ProjectionSnapshot } from '../schemas.js';

// A projection is a pure fold over the event log (slice-0.md core interfaces).
// `apply` MUST be pure — it may not mutate `state` — because snapshots share
// references with live state and boot replays a snapshot forward.
export interface Projection<StateType> {
  id: string;
  init(): StateType;
  apply(state: StateType, event: EventRecord): StateType;
  serialize(state: StateType): string; // canonicalJson, deterministic
}

// A snapshot store is NOT the event log: overwrite is allowed (it is a cache of
// a fold, rebuildable from the log at any time).
export interface SnapshotStore {
  save(snapshot: ProjectionSnapshot): void;
  load(projectionId: string): ProjectionSnapshot | null;
}

// In-memory snapshot store for slice 0. Clones on save and on load so a stored
// snapshot can never be aliased by later boots (sqlite snapshots that serialize
// to text land with their consumer — the boot path — in slice 1).
export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshotsByProjectionId = new Map<string, ProjectionSnapshot>();

  save(snapshot: ProjectionSnapshot): void {
    this.snapshotsByProjectionId.set(snapshot.projectionId, structuredClone(snapshot));
  }

  load(projectionId: string): ProjectionSnapshot | null {
    const stored = this.snapshotsByProjectionId.get(projectionId);
    return stored === undefined ? null : structuredClone(stored);
  }
}

// Per-stream high-water marks over a record list (for a snapshot's lastAppliedSeq).
export function streamHighWaterMarks(records: EventRecord[]): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const record of records) {
    const priorMark = marks[record.stream] ?? 0;
    if (record.seq > priorMark) {
      marks[record.stream] = record.seq;
    }
  }
  return marks;
}

// Read every stream from a store, grouped by sorted stream name, each in seq
// order. Deterministic total order used by both replay and boot so the two
// paths fold identical sequences (I6).
export function readAllStreamsGrouped(store: EventStore): EventRecord[] {
  const records: EventRecord[] = [];
  for (const stream of store.streams()) {
    for (const record of store.read(stream, 1)) {
      records.push(record);
    }
  }
  return records;
}

export function replayFromEmpty<StateType>(
  projection: Projection<StateType>,
  records: EventRecord[],
): StateType {
  let state = projection.init();
  for (const record of records) {
    state = projection.apply(state, record);
  }
  return state;
}

// Capture a snapshot of the projection after folding `prefixRecords`.
export function snapshotAfter<StateType>(
  projection: Projection<StateType>,
  prefixRecords: EventRecord[],
  clock: Clock,
): ProjectionSnapshot {
  return {
    projectionId: projection.id,
    lastAppliedSeq: streamHighWaterMarks(prefixRecords),
    state: replayFromEmpty(projection, prefixRecords),
    savedAt: clock.now(),
  };
}

// Boot: load the snapshot (or init from empty), then replay only the tail —
// per stream, events with seq > lastAppliedSeq[stream], read from the store.
export function bootFromSnapshot<StateType>(
  projection: Projection<StateType>,
  snapshotStore: SnapshotStore,
  store: EventStore,
): StateType {
  const snapshot = snapshotStore.load(projection.id);
  let state: StateType;
  const highWaterByStream: Record<string, number> = {};
  if (snapshot === null) {
    state = projection.init();
  } else {
    state = snapshot.state as StateType;
    for (const [stream, mark] of Object.entries(snapshot.lastAppliedSeq)) {
      highWaterByStream[stream] = mark;
    }
  }
  for (const stream of store.streams()) {
    const fromSeq = (highWaterByStream[stream] ?? 0) + 1;
    for (const record of store.read(stream, fromSeq)) {
      state = projection.apply(state, record);
    }
  }
  return state;
}
