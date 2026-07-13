import { CountingIdSource, SteppingClock, type Clock, type IdSource } from '../ids.js';
import { MemoryEventStore } from '../memoryEventStore.js';
import type { EventStore } from '../eventStore.js';
import { EventRouter } from '../router.js';
import type { EventRecord } from '../schemas.js';
import { MemorySnapshotStore, type SnapshotStore } from '../projections/projection.js';
import { sessionsProjection, type SessionsState } from '../projections/sessions.js';
import { metersProjection, type MetersState } from '../projections/meters.js';
import { tasksProjection, type TasksState } from '../projections/tasks.js';
import { RunRegistry } from './registry.js';
import { FakeSdk } from './fakeSdk.js';
import { FakePty } from './fakePty.js';

// The three domain streams that are not app-session streams. The projection host
// subscribes them up front so events landing there fold into live state even
// before the stream has any record (a fresh store reports no streams at all).
export const STATIC_STREAMS = ['system', 'tasks', 'usage'] as const;

export interface WorldSeed {
  epochIso: string;
  stepMs: number;
}

// A fixed, deterministic default: both double-run passes build over the identical
// seed, so eventIds (counter-based) and timestamps (fixed-epoch stepping) match.
export const DEFAULT_WORLD_SEED: WorldSeed = {
  epochIso: '2026-01-01T00:00:00.000Z',
  stepMs: 1000,
};

// Live, emit-order fold of the three projections over every stream. Cross-stream
// interleaving does not affect any projection's serialize (settled step-3
// commutativity), so this equals a grouped replay of the same log byte-for-byte.
export class ProjectionHost {
  private readonly router: EventRouter;
  private readonly subscribedStreams = new Set<string>();
  private readonly unsubscribes: Array<() => void> = [];
  private sessions: SessionsState = sessionsProjection.init();
  private meters: MetersState = metersProjection.init();
  private tasks: TasksState = tasksProjection.init();

  constructor(router: EventRouter, store: EventStore) {
    this.router = router;
    for (const stream of STATIC_STREAMS) {
      this.ensureStream(stream);
    }
    // Streams already present in the store (the restart case): subscribing at
    // lastSeq 0 replays each stream in full, rebuilding live state from the log.
    for (const stream of store.streams()) {
      this.ensureStream(stream);
    }
  }

  ensureStream(stream: string): void {
    if (this.subscribedStreams.has(stream)) {
      return;
    }
    this.subscribedStreams.add(stream);
    this.unsubscribes.push(
      this.router.subscribe(stream, 0, (event) => this.foldLive(event)),
    );
  }

  private foldLive(event: EventRecord): void {
    this.sessions = sessionsProjection.apply(this.sessions, event);
    this.meters = metersProjection.apply(this.meters, event);
    this.tasks = tasksProjection.apply(this.tasks, event);
  }

  sessionsState(): SessionsState {
    return this.sessions;
  }

  metersState(): MetersState {
    return this.meters;
  }

  serializeAll(): Record<string, string> {
    return {
      [sessionsProjection.id]: sessionsProjection.serialize(this.sessions),
      [metersProjection.id]: metersProjection.serialize(this.meters),
      [tasksProjection.id]: tasksProjection.serialize(this.tasks),
    };
  }
}

export interface World {
  clock: Clock;
  ids: IdSource;
  store: EventStore;
  router: EventRouter;
  registry: RunRegistry;
  fakeSdk: FakeSdk;
  fakePty: FakePty;
  projectionHost: ProjectionHost;
  snapshots: SnapshotStore;
}

// Build a fresh World over a new MemoryEventStore. The registry and adapters take
// the World by reference; they touch its router/projectionHost only at call time,
// after every field below is wired.
export function createWorld(seed: WorldSeed = DEFAULT_WORLD_SEED): World {
  const clock = new SteppingClock(seed.epochIso, seed.stepMs);
  const ids = new CountingIdSource();
  const store = new MemoryEventStore({ clock, ids });
  return assembleWorld({ clock, ids, store, snapshots: new MemorySnapshotStore() });
}

// The daemon-death simulator. The log (store), physics (clock/ids), and the
// snapshot cache survive; the router and every in-memory live handle drop. The
// fresh projection host rebuilds live state by replaying the surviving store.
// Restart itself emits nothing — recovery emission is recoveryRoutine's job.
export function restart(world: World): World {
  return assembleWorld({
    clock: world.clock,
    ids: world.ids,
    store: world.store,
    snapshots: world.snapshots,
  });
}

function assembleWorld(parts: {
  clock: Clock;
  ids: IdSource;
  store: EventStore;
  snapshots: SnapshotStore;
}): World {
  const router = new EventRouter(parts.store);
  const projectionHost = new ProjectionHost(router, parts.store);
  const world: World = {
    clock: parts.clock,
    ids: parts.ids,
    store: parts.store,
    router,
    projectionHost,
    snapshots: parts.snapshots,
    // Reassigned immediately below once the World reference exists.
    registry: undefined as unknown as RunRegistry,
    fakeSdk: undefined as unknown as FakeSdk,
    fakePty: undefined as unknown as FakePty,
  };
  world.fakeSdk = new FakeSdk(world);
  world.fakePty = new FakePty(world);
  world.registry = new RunRegistry(world);
  return world;
}
