import Database from 'better-sqlite3';
import { canonicalJson } from '@vimes/core';
import type { ProjectionSnapshot, SnapshotStore } from '@vimes/core';

// A projection snapshot cache over the SAME sqlite db file as the event log. This
// is NOT the event log: overwrite is allowed (a snapshot is a fold of the log,
// rebuildable at any time), so there are no append-only triggers here and the
// events triggers are untouched. State and lastAppliedSeq are stored as canonical
// JSON text and parsed back on load.
const SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  projectionId TEXT PRIMARY KEY,
  lastAppliedSeq TEXT NOT NULL,
  state TEXT NOT NULL,
  savedAt TEXT NOT NULL
);
`;

interface SnapshotRow {
  projectionId: string;
  lastAppliedSeq: string;
  state: string;
  savedAt: string;
}

export class SqliteSnapshotStore implements SnapshotStore {
  private readonly database: Database.Database;
  private readonly saveStatement: Database.Statement;
  private readonly loadStatement: Database.Statement;

  constructor(options: { path: string }) {
    this.database = new Database(options.path);
    if (options.path !== ':memory:') {
      this.database.pragma('journal_mode = WAL');
    }
    this.database.pragma('synchronous = NORMAL');
    // A second connection to the same file (the event store owns the other);
    // wait rather than fail if the two briefly contend on a write lock.
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(SNAPSHOT_SCHEMA);

    this.saveStatement = this.database.prepare(
      `INSERT INTO snapshots (projectionId, lastAppliedSeq, state, savedAt)
       VALUES (@projectionId, @lastAppliedSeq, @state, @savedAt)
       ON CONFLICT(projectionId) DO UPDATE SET
         lastAppliedSeq = excluded.lastAppliedSeq,
         state = excluded.state,
         savedAt = excluded.savedAt`,
    );
    this.loadStatement = this.database.prepare(
      'SELECT projectionId, lastAppliedSeq, state, savedAt FROM snapshots WHERE projectionId = ?',
    );
  }

  save(snapshot: ProjectionSnapshot): void {
    this.saveStatement.run({
      projectionId: snapshot.projectionId,
      lastAppliedSeq: canonicalJson(snapshot.lastAppliedSeq),
      state: canonicalJson(snapshot.state),
      savedAt: snapshot.savedAt,
    });
  }

  load(projectionId: string): ProjectionSnapshot | null {
    const row = this.loadStatement.get(projectionId) as SnapshotRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      projectionId: row.projectionId,
      lastAppliedSeq: JSON.parse(row.lastAppliedSeq) as Record<string, number>,
      state: JSON.parse(row.state) as unknown,
      savedAt: row.savedAt,
    };
  }

  dispose(): void {
    this.database.close();
  }
}
