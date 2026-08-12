import Database from 'better-sqlite3';
import { canonicalJson } from '@vimes/core';
import type { ProjectionSnapshot, SnapshotStore } from '@vimes/core';

// A projection snapshot cache over the SAME sqlite db file as the event log. This
// is NOT the event log: overwrite is allowed (a snapshot is a fold of the log,
// rebuildable at any time), so there are no append-only triggers here and the
// events triggers are untouched. State and lastAppliedSeq are stored as canonical
// JSON text and parsed back on load.
//
// ⚠ **`version` IS D86's SHAPE STAMP, PERSISTED AND NOTHING MORE.** This store
// writes it and reads it back verbatim; it does NOT decide what a mismatch
// means. That rule lives in exactly one place — `bootFromSnapshot` in
// packages/core — which is the seam holding both the loaded row and the
// projection that will fold on top of it. A cache that started refusing its own
// rows would be a second opinion about snapshot validity, and the day it
// disagreed with core is the day a projection boots from a shape it did not
// write.
const SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  projectionId TEXT PRIMARY KEY,
  lastAppliedSeq TEXT NOT NULL,
  state TEXT NOT NULL,
  savedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
`;

// ⚠ **THE ADDITIVE MIGRATION, FOR TABLES THAT PREDATE D86.** `CREATE TABLE IF
// NOT EXISTS` is a no-op against a live db whose `snapshots` table was created
// before the column existed, so the column has to be added explicitly, guarded
// by a column-existence check (sqlite has no `ADD COLUMN IF NOT EXISTS`).
//
// `DEFAULT 1` is the load-bearing half: every row written before D86 was
// written by a projection at version 1 — the only version that existed — so
// backfilling 1 states the truth rather than guessing it. The first projection
// to bump past 1 therefore finds a legible mismatch and replays, which is
// exactly the intended outcome. Nothing is deleted here: the overwrite that
// follows the replay re-stamps the row in place.
const SNAPSHOT_VERSION_COLUMN_DEFAULT = 1;

interface SnapshotRow {
  projectionId: string;
  lastAppliedSeq: string;
  state: string;
  savedAt: string;
  version: number;
}

interface TableColumnRow {
  name: string;
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
    this.addVersionColumnIfMissing();

    this.saveStatement = this.database.prepare(
      `INSERT INTO snapshots (projectionId, lastAppliedSeq, state, savedAt, version)
       VALUES (@projectionId, @lastAppliedSeq, @state, @savedAt, @version)
       ON CONFLICT(projectionId) DO UPDATE SET
         lastAppliedSeq = excluded.lastAppliedSeq,
         state = excluded.state,
         savedAt = excluded.savedAt,
         version = excluded.version`,
    );
    this.loadStatement = this.database.prepare(
      'SELECT projectionId, lastAppliedSeq, state, savedAt, version FROM snapshots WHERE projectionId = ?',
    );
  }

  // Idempotent: safe on a fresh table (the column is already in SNAPSHOT_SCHEMA),
  // safe on a pre-D86 table (adds it, backfilling 1), and safe on every boot
  // thereafter. `PRAGMA table_info` is the only portable way to ask.
  private addVersionColumnIfMissing(): void {
    const columns = this.database.pragma('table_info(snapshots)') as TableColumnRow[];
    if (columns.some((column) => column.name === 'version')) {
      return;
    }
    this.database.exec(
      `ALTER TABLE snapshots ADD COLUMN version INTEGER NOT NULL DEFAULT ${SNAPSHOT_VERSION_COLUMN_DEFAULT}`,
    );
  }

  save(snapshot: ProjectionSnapshot): void {
    this.saveStatement.run({
      projectionId: snapshot.projectionId,
      lastAppliedSeq: canonicalJson(snapshot.lastAppliedSeq),
      state: canonicalJson(snapshot.state),
      savedAt: snapshot.savedAt,
      version: snapshot.version,
    });
  }

  load(projectionId: string): ProjectionSnapshot | null {
    const row = this.loadStatement.get(projectionId) as SnapshotRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      projectionId: row.projectionId,
      version: row.version,
      lastAppliedSeq: JSON.parse(row.lastAppliedSeq) as Record<string, number>,
      state: JSON.parse(row.state) as unknown,
      savedAt: row.savedAt,
    };
  }

  dispose(): void {
    this.database.close();
  }
}
