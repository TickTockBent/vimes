import type { EventStore } from './eventStore.js';
import type { EventInput, EventRecord } from './schemas.js';

export type OnEvent = (event: EventRecord) => void;

interface Subscription {
  stream: string;
  callback: OnEvent;
  active: boolean;
  deliveredThrough: number;
}

export class EventRouter {
  private readonly store: EventStore;
  private readonly afterAppend: (() => void) | undefined;
  private readonly subscriptions = new Set<Subscription>();
  private readonly pendingBroadcasts: EventRecord[] = [];
  private isDispatching = false;

  constructor(store: EventStore, options?: { afterAppend?: () => void }) {
    this.store = store;
    this.afterAppend = options?.afterAppend;
  }

  emit(events: EventInput[]): EventRecord[] {
    const appendedRecords = this.store.append(events);
    if (this.afterAppend !== undefined) {
      this.afterAppend();
    }
    for (const record of appendedRecords) {
      this.pendingBroadcasts.push(record);
    }
    this.drainBroadcasts();
    return appendedRecords;
  }

  subscribe(stream: string, lastSeq: number, callback: OnEvent): () => void {
    const currentHead = this.store.head(stream);
    const replayRecords = lastSeq < currentHead ? this.store.read(stream, lastSeq + 1, currentHead) : [];
    for (const record of replayRecords) {
      callback(record);
    }

    // Replay above covers up to currentHead. Events already committed but still
    // sitting in pendingBroadcasts (reentrant emits during a dispatch this
    // subscribe call happens inside of) must not be replayed AND delivered live
    // (I2): the dispatch loop skips anything at or below deliveredThrough.
    const subscription: Subscription = { stream, callback, active: true, deliveredThrough: currentHead };
    this.subscriptions.add(subscription);
    return () => {
      subscription.active = false;
      this.subscriptions.delete(subscription);
    };
  }

  private drainBroadcasts(): void {
    if (this.isDispatching) {
      return;
    }
    this.isDispatching = true;
    const dispatchErrors: unknown[] = [];
    try {
      while (this.pendingBroadcasts.length > 0) {
        const record = this.pendingBroadcasts.shift()!;
        for (const subscription of [...this.subscriptions]) {
          if (!subscription.active || subscription.stream !== record.stream) {
            continue;
          }
          if (record.seq <= subscription.deliveredThrough) {
            continue;
          }
          try {
            subscription.callback(record);
          } catch (thrown) {
            dispatchErrors.push(thrown);
          }
        }
      }
    } finally {
      this.isDispatching = false;
    }
    if (dispatchErrors.length > 0) {
      throw new AggregateError(dispatchErrors, 'EventRouter subscriber callback(s) threw during dispatch');
    }
  }
}
