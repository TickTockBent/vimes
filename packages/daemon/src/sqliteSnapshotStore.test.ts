import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MemorySnapshotStore, type ProjectionSnapshot, type SnapshotStore } from '@vimes/core';
import { SqliteSnapshotStore } from './sqliteSnapshotStore.js';

// The version every row written before D86 implicitly carries — the only
// version that existed. Spelled here so the migration's backfill is asserted
// against a named fact rather than a bare `1` that could mean anything.
const SNAPSHOT_VERSION_BEFORE_D86 = 1;

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-snapshot-conformance-'));
let databaseFileCounter = 0;

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `snapshot-${databaseFileCounter}.db`);
}

interface DisposableSnapshotStore extends SnapshotStore {
  dispose?: () => void;
}

function snapshot(projectionId: string, used: number, version = 1): ProjectionSnapshot {
  return {
    projectionId,
    version,
    lastAppliedSeq: { alpha: used, beta: used * 2 },
    state: { count: used, nested: { label: `v${used}`, flags: [true, false] } },
    savedAt: `2026-01-01T00:00:${String(used).padStart(2, '0')}.000Z`,
  };
}

// Mirrors MemorySnapshotStore's behavior: run the identical contract against both
// implementations so the sqlite cache is byte-for-byte substitutable.
function registerSnapshotStoreConformance(
  name: string,
  makeStore: () => DisposableSnapshotStore,
): void {
  describe(`SnapshotStore conformance: ${name}`, () => {
    it('round-trips a saved snapshot on load', () => {
      const store = makeStore();
      try {
        const saved = snapshot('sessions', 7);
        store.save(saved);
        expect(store.load('sessions')).toEqual(saved);
      } finally {
        store.dispose?.();
      }
    });

    it('returns null for a projectionId that was never saved', () => {
      const store = makeStore();
      try {
        expect(store.load('never-saved')).toBeNull();
      } finally {
        store.dispose?.();
      }
    });

    it('overwrite replaces the prior snapshot for the same projectionId', () => {
      const store = makeStore();
      try {
        store.save(snapshot('sessions', 1));
        store.save(snapshot('sessions', 42));
        expect(store.load('sessions')).toEqual(snapshot('sessions', 42));
      } finally {
        store.dispose?.();
      }
    });

    it('keeps distinct projectionIds independent', () => {
      const store = makeStore();
      try {
        store.save(snapshot('sessions', 3));
        store.save(snapshot('tasks', 9));
        expect(store.load('sessions')).toEqual(snapshot('sessions', 3));
        expect(store.load('tasks')).toEqual(snapshot('tasks', 9));
      } finally {
        store.dispose?.();
      }
    });

    // ── D86 ──────────────────────────────────────────────────────────────────
    it('round-trips the projection VERSION verbatim, and the overwrite re-stamps it', () => {
      const store = makeStore();
      try {
        store.save(snapshot('projects', 5, 1));
        expect(store.load('projects')!.version).toBe(1);
        // The overwrite is the migration: a projection that bumped its version
        // and replayed saves through this same path, and the row's stamp has to
        // move with it or the next boot replays again forever.
        store.save(snapshot('projects', 5, 2));
        expect(store.load('projects')!.version).toBe(2);
        expect(store.load('projects')).toEqual(snapshot('projects', 5, 2));
      } finally {
        store.dispose?.();
      }
    });

    it('does not conflate the version with any other field', () => {
      // Two rows, same everything except the stamp — a store that dropped the
      // column or read it off the wrong row would pass every case above.
      const store = makeStore();
      try {
        store.save(snapshot('alpha', 4, 1));
        store.save(snapshot('beta', 4, 9));
        expect(store.load('alpha')!.version).toBe(1);
        expect(store.load('beta')!.version).toBe(9);
      } finally {
        store.dispose?.();
      }
    });
  });
}

registerSnapshotStoreConformance('memory', () => new MemorySnapshotStore());
registerSnapshotStoreConformance('sqlite', () => new SqliteSnapshotStore({ path: nextDatabasePath() }));

// ─── D86: the additive column migration, against a PRE-D86 table ─────────────
//
// ⚠ **THE ONLY WAY TO TEST THIS IS TO BUILD THE OLD TABLE BY HAND.** Every live
// db (motherbrain's included) already has a `snapshots` table created without a
// `version` column, and `CREATE TABLE IF NOT EXISTS` is a NO-OP against it — so
// the new column arrives via `ALTER TABLE` or it never arrives at all, and the
// store's first `INSERT … (…, version)` fails on a real deployment. This case
// reproduces that db shape exactly rather than trusting the guard by reading it.
//
// The live db at ~/.vimes/events.db is never opened here, in any mode: these
// are throwaway files under a temp directory.
const PRE_D86_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  projectionId TEXT PRIMARY KEY,
  lastAppliedSeq TEXT NOT NULL,
  state TEXT NOT NULL,
  savedAt TEXT NOT NULL
);
`;

function buildPreD86Database(path: string): void {
  const legacyDatabase = new Database(path);
  legacyDatabase.exec(PRE_D86_SNAPSHOT_SCHEMA);
  legacyDatabase
    .prepare(
      `INSERT INTO snapshots (projectionId, lastAppliedSeq, state, savedAt)
       VALUES (?, ?, ?, ?)`,
    )
    .run('projects', '{"projects":3}', '{"projects":{}}', '2026-08-01T00:00:00.000Z');
  legacyDatabase.close();
}

describe('D86 — the snapshots table gains its version column additively', () => {
  it('adds the column to a table that predates it, and pre-existing rows read as version 1', () => {
    const databasePath = nextDatabasePath();
    buildPreD86Database(databasePath);

    const store = new SqliteSnapshotStore({ path: databasePath });
    try {
      const migrated = store.load('projects');
      // The row survives — nothing is dropped or rewritten by the migration...
      expect(migrated).toEqual({
        projectionId: 'projects',
        version: 1,
        lastAppliedSeq: { projects: 3 },
        state: { projects: {} },
        savedAt: '2026-08-01T00:00:00.000Z',
      });
      // ...and 1 is the TRUTH rather than a guess: every row written before D86
      // was written by a projection at the only version that existed. A
      // projection that has since bumped to 2 therefore finds a legible
      // mismatch and replays, which is the intended outcome.
      expect(migrated!.version).toBe(SNAPSHOT_VERSION_BEFORE_D86);
    } finally {
      store.dispose();
    }
  });

  it('writes and reads the new column on the migrated table, and re-opening is idempotent', () => {
    const databasePath = nextDatabasePath();
    buildPreD86Database(databasePath);

    const firstStore = new SqliteSnapshotStore({ path: databasePath });
    try {
      // The overwrite that follows a replay: same row, new stamp.
      firstStore.save(snapshot('projects', 11, 2));
      expect(firstStore.load('projects')!.version).toBe(2);
    } finally {
      firstStore.dispose();
    }

    // A second boot must not try to add the column again (sqlite has no
    // `ADD COLUMN IF NOT EXISTS`; a re-run without the guard throws).
    const secondStore = new SqliteSnapshotStore({ path: databasePath });
    try {
      expect(secondStore.load('projects')).toEqual(snapshot('projects', 11, 2));
      secondStore.save(snapshot('sessions', 1, 1));
      expect(secondStore.load('sessions')!.version).toBe(1);
    } finally {
      secondStore.dispose();
    }
  });

  it('the column really is absent before the store opens the file (the fixture is honest)', () => {
    // Guards the guard: if `buildPreD86Database` ever drifted into creating the
    // NEW schema, the two cases above would pass while testing nothing.
    const databasePath = nextDatabasePath();
    buildPreD86Database(databasePath);
    const legacyDatabase = new Database(databasePath);
    const columnNames = (legacyDatabase.pragma('table_info(snapshots)') as Array<{ name: string }>).map(
      (column) => column.name,
    );
    legacyDatabase.close();
    expect(columnNames).not.toContain('version');

    const store = new SqliteSnapshotStore({ path: databasePath });
    try {
      const reopened = new Database(databasePath);
      const migratedColumnNames = (
        reopened.pragma('table_info(snapshots)') as Array<{ name: string }>
      ).map((column) => column.name);
      reopened.close();
      expect(migratedColumnNames).toContain('version');
    } finally {
      store.dispose();
    }
  });
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});
