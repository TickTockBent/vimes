import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CountingIdSource, SteppingClock } from '@vimes/core';
import { registerEventStoreConformance } from '@vimes/core/testing';
import { SqliteEventStore } from './sqliteEventStore.js';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-sqlite-conformance-'));
let databaseFileCounter = 0;

function nextDatabasePath(label: string): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `${label}-${databaseFileCounter}.db`);
}

function makeFileStore(path: string): SqliteEventStore {
  return new SqliteEventStore({
    path,
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });
}

registerEventStoreConformance('sqlite', () => makeFileStore(nextDatabasePath('conformance')));

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('SqliteEventStore append-only triggers and persistence', () => {
  it('I12: raw UPDATE and DELETE on events both throw the append-only message', () => {
    const databasePath = nextDatabasePath('raw-mutation');
    const store = makeFileStore(databasePath);
    store.append([{ stream: 'session', type: 'spawn', payload: {} }]);
    store.dispose();

    const rawDatabase = new Database(databasePath);
    try {
      expect(() => rawDatabase.prepare("UPDATE events SET type = 'x'").run()).toThrow(
        /append-only \(I12\)/,
      );
      expect(() => rawDatabase.prepare('DELETE FROM events').run()).toThrow(/append-only \(I12\)/);
    } finally {
      rawDatabase.close();
    }
  });

  it('resumes seq numbering gaplessly after reopening the same file', () => {
    const databasePath = nextDatabasePath('reopen');
    // A persistent id source spans the daemon restart so eventIds stay unique;
    // seq continuity is recovered from the database itself.
    const persistentIds = new CountingIdSource();

    const firstStore = new SqliteEventStore({
      path: databasePath,
      clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
      ids: persistentIds,
    });
    firstStore.append([
      { stream: 'session', type: 'a', payload: {} },
      { stream: 'session', type: 'b', payload: {} },
    ]);
    firstStore.dispose();

    const secondStore = new SqliteEventStore({
      path: databasePath,
      clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
      ids: persistentIds,
    });
    try {
      const appendedRecords = secondStore.append([{ stream: 'session', type: 'c', payload: {} }]);
      expect(appendedRecords.map((record) => record.seq)).toEqual([3]);
      expect(secondStore.head('session')).toBe(3);
      expect(secondStore.read('session', 1).map((record) => record.seq)).toEqual([1, 2, 3]);
    } finally {
      secondStore.dispose();
    }
  });

  it('records schema_version = 1 in meta', () => {
    const store = makeFileStore(nextDatabasePath('schema-version'));
    try {
      expect(store.schemaVersion()).toBe(1);
    } finally {
      store.dispose();
    }
  });

  it('never violates UNIQUE(stream, seq) under interleaved batches', () => {
    const store = makeFileStore(nextDatabasePath('interleaved'));
    try {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        store.append([
          { stream: 'session', type: 'event', payload: {} },
          { stream: 'tasks', type: 'event', payload: {} },
        ]);
        store.append([{ stream: 'session', type: 'event', payload: {} }]);
      }

      const sessionSeqs = store.read('session', 1).map((record) => record.seq);
      expect(sessionSeqs).toEqual(Array.from({ length: sessionSeqs.length }, (_, index) => index + 1));
      expect(new Set(sessionSeqs).size).toBe(sessionSeqs.length);
      expect(store.head('session')).toBe(20);
      expect(store.head('tasks')).toBe(10);
    } finally {
      store.dispose();
    }
  });
});
