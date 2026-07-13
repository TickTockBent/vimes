import Database from 'better-sqlite3';
import { canonicalJson, eventInputSchema } from '@vimes/core';
import type { Clock, EventInput, EventRecord, EventStore, IdSource } from '@vimes/core';

const SCHEMA_STATEMENTS = `
CREATE TABLE IF NOT EXISTS events (
  eventId TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(stream, seq)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TRIGGER IF NOT EXISTS events_no_update
  BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only (I12)'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete
  BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only (I12)'); END;
`;

interface EventRow {
  eventId: string;
  stream: string;
  seq: number;
  ts: string;
  type: string;
  payload: string;
}

function rowToEventRecord(row: EventRow): EventRecord {
  return {
    eventId: row.eventId,
    seq: row.seq,
    stream: row.stream,
    ts: row.ts,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
  };
}

export class SqliteEventStore implements EventStore {
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly database: Database.Database;
  private readonly insertStatement: Database.Statement;
  private readonly headStatement: Database.Statement;
  private readonly readStatement: Database.Statement;
  private readonly streamsStatement: Database.Statement;
  private readonly schemaVersionStatement: Database.Statement;
  private readonly appendTransaction: (validatedInputs: EventInput[]) => EventRecord[];

  constructor(options: { path: string; clock: Clock; ids: IdSource }) {
    this.clock = options.clock;
    this.ids = options.ids;
    this.database = new Database(options.path);
    if (options.path !== ':memory:') {
      this.database.pragma('journal_mode = WAL');
    }
    this.database.pragma('synchronous = NORMAL');
    this.database.exec(SCHEMA_STATEMENTS);
    this.database
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run('1');

    this.insertStatement = this.database.prepare(
      'INSERT INTO events (eventId, stream, seq, ts, type, payload) VALUES (@eventId, @stream, @seq, @ts, @type, @payload)',
    );
    this.headStatement = this.database.prepare(
      'SELECT MAX(seq) AS maxSeq FROM events WHERE stream = ?',
    );
    this.readStatement = this.database.prepare(
      'SELECT eventId, stream, seq, ts, type, payload FROM events WHERE stream = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC',
    );
    this.streamsStatement = this.database.prepare(
      'SELECT DISTINCT stream FROM events ORDER BY stream ASC',
    );
    this.schemaVersionStatement = this.database.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );

    this.appendTransaction = this.database.transaction((validatedInputs: EventInput[]): EventRecord[] => {
      const assignedSeqByStream = new Map<string, number>();
      const appendedRecords: EventRecord[] = [];
      for (const validatedInput of validatedInputs) {
        const priorSeq = assignedSeqByStream.get(validatedInput.stream) ?? this.head(validatedInput.stream);
        const assignedSeq = priorSeq + 1;
        assignedSeqByStream.set(validatedInput.stream, assignedSeq);
        const record: EventRecord = {
          eventId: this.ids.uuid(),
          seq: assignedSeq,
          stream: validatedInput.stream,
          ts: this.clock.now(),
          type: validatedInput.type,
          payload: validatedInput.payload ?? null,
        };
        this.insertStatement.run({
          eventId: record.eventId,
          stream: record.stream,
          seq: record.seq,
          ts: record.ts,
          type: record.type,
          payload: canonicalJson(record.payload),
        });
        appendedRecords.push(record);
      }
      return appendedRecords;
    });
  }

  append(events: EventInput[]): EventRecord[] {
    const validatedInputs = events.map((candidate) => eventInputSchema.parse(candidate));
    return this.appendTransaction(validatedInputs);
  }

  read(stream: string, fromSeq: number, toSeq?: number): EventRecord[] {
    const upperBound = toSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.readStatement.all(stream, fromSeq, upperBound) as EventRow[];
    return rows.map(rowToEventRecord);
  }

  head(stream: string): number {
    const row = this.headStatement.get(stream) as { maxSeq: number | null };
    return row.maxSeq ?? 0;
  }

  streams(): string[] {
    const rows = this.streamsStatement.all() as Array<{ stream: string }>;
    return rows.map((row) => row.stream);
  }

  schemaVersion(): number {
    const row = this.schemaVersionStatement.get() as { value: string } | undefined;
    return row === undefined ? 1 : Number(row.value);
  }

  dispose(): void {
    this.database.close();
  }
}
