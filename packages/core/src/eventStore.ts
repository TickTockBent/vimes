import type { EventInput, EventRecord } from './schemas.js';

export interface EventStore {
  append(events: EventInput[]): EventRecord[];
  read(stream: string, fromSeq: number, toSeq?: number): EventRecord[];
  head(stream: string): number;
  streams(): string[];
  schemaVersion(): number;
}
