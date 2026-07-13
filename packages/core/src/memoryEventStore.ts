import type { Clock, IdSource } from './ids.js';
import type { EventStore } from './eventStore.js';
import { eventInputSchema, type EventInput, type EventRecord } from './schemas.js';

export class MemoryEventStore implements EventStore {
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly eventsByStream = new Map<string, EventRecord[]>();

  constructor(dependencies: { clock: Clock; ids: IdSource }) {
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
  }

  append(events: EventInput[]): EventRecord[] {
    const validatedInputs = events.map((candidate) => eventInputSchema.parse(candidate));

    const assignedSeqByStream = new Map<string, number>();
    const appendedRecords: EventRecord[] = [];
    for (const validatedInput of validatedInputs) {
      const priorSeq = assignedSeqByStream.get(validatedInput.stream) ?? this.head(validatedInput.stream);
      const assignedSeq = priorSeq + 1;
      assignedSeqByStream.set(validatedInput.stream, assignedSeq);
      appendedRecords.push({
        eventId: this.ids.uuid(),
        seq: assignedSeq,
        stream: validatedInput.stream,
        ts: this.clock.now(),
        type: validatedInput.type,
        payload: validatedInput.payload ?? null,
      });
    }

    for (const record of appendedRecords) {
      const streamLog = this.eventsByStream.get(record.stream) ?? [];
      streamLog.push(record);
      this.eventsByStream.set(record.stream, streamLog);
    }

    return appendedRecords;
  }

  read(stream: string, fromSeq: number, toSeq?: number): EventRecord[] {
    const streamLog = this.eventsByStream.get(stream) ?? [];
    const upperBound = toSeq ?? Number.POSITIVE_INFINITY;
    return streamLog.filter((record) => record.seq >= fromSeq && record.seq <= upperBound);
  }

  head(stream: string): number {
    const streamLog = this.eventsByStream.get(stream);
    if (streamLog === undefined || streamLog.length === 0) {
      return 0;
    }
    return streamLog[streamLog.length - 1]!.seq;
  }

  streams(): string[] {
    return [...this.eventsByStream.keys()].sort();
  }

  schemaVersion(): number {
    return 1;
  }
}
