import { describe, expect, it } from 'vitest';
import type { EventStore } from '../eventStore.js';
import type { EventInput, EventRecord } from '../schemas.js';
import { EventRouter } from '../router.js';

type DisposableStore = EventStore & { dispose?: () => void };

function rangeInclusive(lowerBound: number, upperBound: number): number[] {
  const values: number[] = [];
  for (let value = lowerBound; value <= upperBound; value += 1) {
    values.push(value);
  }
  return values;
}

function makeEventInputs(stream: string, count: number, type = 'event'): EventInput[] {
  return Array.from({ length: count }, () => ({ stream, type, payload: {} }));
}

export function registerEventStoreConformance(name: string, makeStore: () => DisposableStore): void {
  describe(`EventStore conformance: ${name}`, () => {
    it('assigns per-stream gapless seqs starting at 1, incrementing each stream independently', () => {
      const store = makeStore();
      try {
        const appendedRecords = store.append([
          { stream: 'alpha', type: 'event', payload: {} },
          { stream: 'alpha', type: 'event', payload: {} },
          { stream: 'beta', type: 'event', payload: {} },
          { stream: 'alpha', type: 'event', payload: {} },
          { stream: 'beta', type: 'event', payload: {} },
        ]);

        expect(appendedRecords.map((record) => [record.stream, record.seq])).toEqual([
          ['alpha', 1],
          ['alpha', 2],
          ['beta', 1],
          ['alpha', 3],
          ['beta', 2],
        ]);
        expect(store.head('alpha')).toBe(3);
        expect(store.head('beta')).toBe(2);
        expect(store.schemaVersion()).toBe(1);
      } finally {
        store.dispose?.();
      }
    });

    it('rejects the whole batch atomically when any event fails validation (empty stream), store unchanged', () => {
      const store = makeStore();
      try {
        store.append([{ stream: 'alpha', type: 'seed', payload: {} }]);

        expect(() =>
          store.append([
            { stream: 'alpha', type: 'would-commit', payload: {} },
            { stream: '', type: 'invalid', payload: {} },
          ]),
        ).toThrow();

        expect(store.head('alpha')).toBe(1);
        expect(store.read('alpha', 1).map((record) => record.type)).toEqual(['seed']);
      } finally {
        store.dispose?.();
      }
    });

    it('reads inclusive ranges and reports head/streams; empty stream reads as []', () => {
      const store = makeStore();
      try {
        store.append(makeEventInputs('stream-s', 5));
        store.append(makeEventInputs('stream-z', 1));

        expect(store.read('stream-s', 2, 4).map((record) => record.seq)).toEqual([2, 3, 4]);
        expect(store.read('stream-s', 1).map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(store.read('stream-s', 5, 5).map((record) => record.seq)).toEqual([5]);
        expect(store.head('stream-s')).toBe(5);
        expect(store.streams()).toEqual(['stream-s', 'stream-z']);
        expect(store.read('never-written', 1)).toEqual([]);
        expect(store.head('never-written')).toBe(0);
      } finally {
        store.dispose?.();
      }
    });

    it('I2: for every lastSeq 0..head, subscribe delivers exactly lastSeq+1..head, then live, no dup/loss', { timeout: 30_000 }, () => {
      const logLength = 40;
      for (let lastSeq = 0; lastSeq <= logLength; lastSeq += 1) {
        const store = makeStore();
        try {
          store.append(makeEventInputs('noise', 1, 'noise'));
          store.append(makeEventInputs('main', logLength));
          store.append(makeEventInputs('noise', 1, 'noise'));

          const head = store.head('main');
          expect(head).toBe(logLength);

          const router = new EventRouter(store);
          const receivedSeqs: number[] = [];
          const receivedIds: string[] = [];
          router.subscribe('main', lastSeq, (event) => {
            receivedSeqs.push(event.seq);
            receivedIds.push(event.eventId);
          });

          expect(receivedSeqs).toEqual(rangeInclusive(lastSeq + 1, head));

          const liveRecords = router.emit(makeEventInputs('main', 3));

          expect(receivedSeqs).toEqual(rangeInclusive(lastSeq + 1, head + 3));
          expect(receivedIds.slice(-3)).toEqual(liveRecords.map((record) => record.eventId));
          expect(new Set(receivedIds).size).toBe(receivedIds.length);
        } finally {
          store.dispose?.();
        }
      }
    });

    it('I13: every delivery tick is strictly after the delivered event commit tick (replay and live)', () => {
      const store = makeStore();
      try {
        let globalTick = 0;
        const commitTickByEventId = new Map<string, number>();
        const originalAppend = store.append.bind(store);
        store.append = (events: EventInput[]): EventRecord[] => {
          const records = originalAppend(events);
          globalTick += 1;
          for (const record of records) {
            commitTickByEventId.set(record.eventId, globalTick);
          }
          return records;
        };

        store.append(makeEventInputs('main', 4));

        const router = new EventRouter(store);
        const violations: string[] = [];
        const recordDelivery = (event: EventRecord): void => {
          globalTick += 1;
          const deliveryTick = globalTick;
          const commitTick = commitTickByEventId.get(event.eventId);
          if (commitTick === undefined || deliveryTick <= commitTick) {
            violations.push(event.eventId);
          }
        };

        router.subscribe('main', 0, recordDelivery);
        router.emit(makeEventInputs('main', 3));

        expect(violations).toEqual([]);
      } finally {
        store.dispose?.();
      }
    });

    it('I13 crash-sim: crash between commit and broadcast delivers nothing; committed event later delivered exactly once', () => {
      const store = makeStore();
      try {
        let shouldCrash = false;
        const router = new EventRouter(store, {
          afterAppend: () => {
            if (shouldCrash) {
              throw new Error('simulated crash between commit and broadcast');
            }
          },
        });

        const receivedSeqs: number[] = [];
        router.subscribe('main', 0, (event) => receivedSeqs.push(event.seq));

        router.emit(makeEventInputs('main', 1));
        expect(receivedSeqs).toEqual([1]);

        shouldCrash = true;
        expect(() => router.emit(makeEventInputs('main', 1))).toThrow('simulated crash');
        expect(receivedSeqs).toEqual([1]);
        expect(store.head('main')).toBe(2);

        shouldCrash = false;
        const recoveredSeqs: number[] = [];
        router.subscribe('main', 1, (event) => recoveredSeqs.push(event.seq));
        expect(recoveredSeqs).toEqual([2]);
      } finally {
        store.dispose?.();
      }
    });

    it('reentrancy: a subscriber may emit; both subscribers see every event exactly once in seq order', () => {
      const store = makeStore();
      try {
        const router = new EventRouter(store);
        const receivedByA: number[] = [];
        const receivedByB: number[] = [];
        let hasReentered = false;

        router.subscribe('main', 0, (event) => {
          receivedByA.push(event.seq);
          if (!hasReentered && event.type === 'first') {
            hasReentered = true;
            router.emit([{ stream: 'main', type: 'second', payload: {} }]);
          }
        });
        router.subscribe('main', 0, (event) => {
          receivedByB.push(event.seq);
        });

        router.emit([{ stream: 'main', type: 'first', payload: {} }]);

        expect(receivedByA).toEqual([1, 2]);
        expect(receivedByB).toEqual([1, 2]);
        expect(store.read('main', 1).map((record) => record.type)).toEqual(['first', 'second']);
      } finally {
        store.dispose?.();
      }
    });

    it('normalizes an omitted/undefined payload to null on both the returned record and a subsequent read', () => {
      const store = makeStore();
      try {
        const [appendedRecord] = store.append([{ stream: 'main', type: 'no-payload', payload: undefined }]);

        expect(appendedRecord!.payload).toBeNull();
        expect(store.read('main', 1, 1)[0]!.payload).toBeNull();
      } finally {
        store.dispose?.();
      }
    });

    it('I2: a subscriber created during dispatch (from a reentrant emit) receives replay + live exactly once each', () => {
      const store = makeStore();
      try {
        const router = new EventRouter(store);
        const receivedByA: number[] = [];
        const receivedByC: number[] = [];
        let hasReentered = false;

        router.subscribe('main', 0, (event) => {
          receivedByA.push(event.seq);
          if (!hasReentered && event.type === 'first') {
            hasReentered = true;
            router.emit([{ stream: 'main', type: 'second', payload: {} }]);
            router.subscribe('main', 0, (reentrantEvent) => {
              receivedByC.push(reentrantEvent.seq);
            });
          }
        });

        router.emit([{ stream: 'main', type: 'first', payload: {} }]);

        expect(receivedByC).toEqual([1, 2]);
        expect(receivedByA).toEqual([1, 2]);
      } finally {
        store.dispose?.();
      }
    });

    it('throwing subscriber does not starve others; emit surfaces AggregateError; log retains events', () => {
      const store = makeStore();
      try {
        const router = new EventRouter(store);
        const receivedByA: number[] = [];
        router.subscribe('main', 0, (event) => receivedByA.push(event.seq));
        router.subscribe('main', 0, () => {
          throw new Error('subscriber B always throws');
        });

        let caughtError: unknown;
        try {
          router.emit(makeEventInputs('main', 2));
        } catch (thrown) {
          caughtError = thrown;
        }

        expect(caughtError).toBeInstanceOf(AggregateError);
        expect((caughtError as AggregateError).errors).toHaveLength(2);
        expect(receivedByA).toEqual([1, 2]);
        expect(store.head('main')).toBe(2);
      } finally {
        store.dispose?.();
      }
    });
  });
}
