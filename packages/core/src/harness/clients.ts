import type { EventRecord } from '../schemas.js';
import type { World } from './world.js';

interface ReceivedTuple {
  seq: number;
  type: string;
  eventId: string;
}

// A subscribing client over one stream. A dropped/returning client is just
// disconnect() then connect(lastSeq) — the same one router path for any gap
// length (I2). No buffering lives anywhere but the log.
export class FakeClient {
  private readonly received: ReceivedTuple[] = [];
  private unsubscribe: (() => void) | null = null;

  connect(world: World, stream: string, lastSeq: number): void {
    if (this.unsubscribe !== null) {
      throw new Error('FakeClient.connect called while already connected');
    }
    this.unsubscribe = world.router.subscribe(stream, lastSeq, (event: EventRecord) => {
      this.received.push({ seq: event.seq, type: event.type, eventId: event.eventId });
    });
  }

  disconnect(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  receivedSeqs(): number[] {
    return this.received.map((tuple) => tuple.seq);
  }

  lastReceivedSeq(): number {
    return this.received.length === 0 ? 0 : this.received[this.received.length - 1]!.seq;
  }

  // Assert the FULL received history is exactly expectedFirstSeq, +1, +2, ...
  // contiguous, with no duplicate and no gap (I2). Throws on any violation.
  assertContiguousFrom(expectedFirstSeq: number): void {
    const seqs = this.receivedSeqs();
    for (let index = 0; index < seqs.length; index += 1) {
      const expected = expectedFirstSeq + index;
      if (seqs[index] !== expected) {
        throw new Error(
          `FakeClient delivery not contiguous from ${expectedFirstSeq}: expected ${expected} at index ${index}, got ${seqs[index]} (full: ${seqs.join(',')})`,
        );
      }
    }
    if (new Set(seqs).size !== seqs.length) {
      throw new Error(`FakeClient received a duplicate seq (full: ${seqs.join(',')})`);
    }
  }
}
