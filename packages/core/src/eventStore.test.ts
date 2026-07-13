import { describe, expect, it } from 'vitest';
import type { EventStore } from './eventStore.js';
import { CountingIdSource, SteppingClock } from './ids.js';
import { MemoryEventStore } from './memoryEventStore.js';
import { registerEventStoreConformance } from './testing/storeConformance.js';

registerEventStoreConformance(
  'memory',
  () =>
    new MemoryEventStore({
      clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
      ids: new CountingIdSource(),
    }),
);

describe('EventStore I12 append-only (type-level)', () => {
  it('admits no update/delete members on the interface', () => {
    const store: EventStore = new MemoryEventStore({
      clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
      ids: new CountingIdSource(),
    });

    // @ts-expect-error EventStore admits no `update` member (I12)
    store.update;
    // @ts-expect-error EventStore admits no `delete` member (I12)
    store.delete;
    // @ts-expect-error EventStore admits no `deleteEvents` member (I12)
    store.deleteEvents;

    expect(typeof store.append).toBe('function');
  });
});
